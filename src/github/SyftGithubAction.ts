import * as fs from "fs";
import * as os from "os";
import path from "path";
import * as exec from "@actions/exec";
import * as cache from "@actions/tool-cache";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Release } from "@octokit/webhooks-types";
import { Syft, SyftErrorImpl, SyftOptions, SyftOutput } from "../syft/Syft";
import { GithubActionLog } from "./GithubActionLog";
import { getClient } from "./GithubClient";
import {
  deleteReleaseAsset,
  listReleaseAssets,
  uploadReleaseAsset,
} from "./Releases";
import { Log } from "../syft/Log";
import {
  listWorkflowArtifacts,
  downloadArtifact,
  uploadArtifact,
} from "./WorkflowArtifacts";

export const SYFT_BINARY_NAME = "syft";
export const SYFT_VERSION = "v0.21.0";

export class SyftGithubAction implements Syft {
  log: Log;

  constructor(logger: Log) {
    this.log = logger;
  }

  async execute({ input, format }: SyftOptions): Promise<SyftOutput> {
    let outStream = "";
    let errStream = "";

    const cmd = await this.getSyftCommand();

    const env: { [key: string]: string } = {
      SYFT_CHECK_FOR_APP_UPDATE: "false",
    };

    // https://github.com/anchore/syft#configuration
    let args = ["packages"];

    if ("image" in input && input.image) {
      args = [...args, `docker:${input.image}`];
    } else if ("path" in input && input.path) {
      args = [...args, `dir:${input.path}`];
    } else {
      throw new Error("Invalid input, no image or path specified");
    }

    args = [...args, "-o", format];

    let error: unknown;
    try {
      const exitCode = await core.group("Syft Output", async () => {
        core.info(`Executing: ${cmd} ${args.join(" ")}`);
        return exec.exec(cmd, args, {
          env,
          // outStream,
          // errStream,
          listeners: {
            stdout(buffer) {
              outStream += buffer.toString();
            },
            stderr(buffer) {
              errStream += buffer.toString();
            },
            debug(message) {
              errStream += message.toString();
            },
          },
        });
      });

      if (exitCode > 0) {
        error = new Error("An error occurred running Syft");
      } else {
        const client = getClient(core.getInput("github_token"));
        const { repo, job, action, sha, runId } = github.context;

        const suffix = `${job}-${action}-${sha}`;
        const fileName = `sbom-${suffix}.${format}`;

        const writeFile = true;
        if (writeFile) {
          const tempPath = fs.mkdtempSync(
            path.join(os.tmpdir(), "sbom-action-")
          );
          const filePath = `${tempPath}/${fileName}`;
          fs.writeFileSync(filePath, outStream);
          core.setOutput("file", filePath);

          const artifacts = await listWorkflowArtifacts({
            client,
            repo,
            run: runId,
          });

          core.info("Workflow artifacts associated with run:");
          core.info(JSON.stringify(artifacts));

          try {
            const existingSbom = await downloadArtifact({
              client,
              // repo,
              name: fileName,
            });

            core.info("Existing SBOM artifact:");
            core.info(JSON.stringify(existingSbom));
          } catch (e) {
            core.info(`${e}`);
          }

          await uploadArtifact({
            client,
            repo,
            run: runId,
            file: filePath,
            name: fileName,
          });
        }

        return {
          report: outStream,
        };
      }
    } catch (e) {
      this.log.error(e);
      error = e;
    }
    throw new SyftErrorImpl({
      error,
      out: outStream,
      err: errStream,
    });
  }

  async download(): Promise<string> {
    const name = SYFT_BINARY_NAME;
    const version = SYFT_VERSION;

    const url = `https://raw.githubusercontent.com/anchore/${name}/main/install.sh`;

    this.log.debug(`Installing ${name} ${version}`);

    // Download the installer, and run
    const installPath = await cache.downloadTool(url);

    // Make sure the tool's executable bit is set
    await exec.exec(`chmod +x ${installPath}`);

    const cmd = `${installPath} -b ${installPath}_${name} ${version}`;
    await exec.exec(cmd);
    const syftBinary = `${installPath}_${name}/${name}`;

    // Cache the downloaded file
    return cache.cacheFile(syftBinary, name, name, version);
  }

  async getSyftCommand(): Promise<string> {
    const name = SYFT_BINARY_NAME;

    let syftBinary = cache.find(name, SYFT_VERSION);
    if (!syftBinary) {
      // Not found, install it
      syftBinary = await this.download();
    }

    // Add tool to path for this and future actions to use
    core.addPath(syftBinary);
    return name;
  }
}

export async function runSyftAction(): Promise<void> {
  try {
    const start = new Date();
    core.debug(`-------------------------------------------------------------`);
    core.debug(`Running SBOM action: ${start.toTimeString()}`);
    core.info(`Got github context:`);
    core.info(JSON.stringify(github.context));

    const syft = new SyftGithubAction(new GithubActionLog());
    const output = await syft.execute({
      input: {
        path: core.getInput("path"),
        image: core.getInput("image"),
      },
      format: (core.getInput("format") as SyftOptions["format"]) || "spdx",
      outputFile: core.getInput("outputFile"),
    });
    core.debug(
      `SBOM action completed in: ${
        (new Date().getMilliseconds() - start.getMilliseconds()) / 1000
      }s`
    );
    core.debug(`-------------------------------------------------------------`);

    if ("report" in output) {
      // need to escape multiline strings a specific way:
      // https://github.community/t/set-output-truncates-multiline-strings/16852/5
      const content = output.report
        .replace("%", "%25")
        .replace("\n", "%0A")
        .replace("\r", "%0D");
      core.setOutput("sbom", content);
    } else {
      core.error(JSON.stringify(output));
    }
  } catch (e: unknown) {
    if (e instanceof SyftErrorImpl) {
      core.setFailed(`ERROR executing Syft: ${e.message}
      Caused by: ${e.error}
      STDOUT: ${e.out}
      STDERR: ${e.err}`);
    } else if (e instanceof Error) {
      core.setFailed(e.message);
    } else if (e instanceof Object) {
      core.setFailed(e.toString());
    } else {
      core.setFailed("An unknown error occurred");
    }
    throw e;
  }
}

export async function runPostBuildAction(): Promise<void> {
  try {
    const start = new Date();
    core.debug(`-------------------------------------------------------------`);
    core.debug(`Running POST SBOM action: ${start.toTimeString()}`);
    core.info(`Got github context:`);
    core.info(JSON.stringify(github.context));

    const client = getClient(core.getInput("github_token"));
    const { eventName, ref, payload, repo, runId } = github.context;

    const artifacts = await listWorkflowArtifacts({
      client,
      repo,
      run: runId,
    });

    core.info("Workflow artifacts associated with run:");
    core.info(JSON.stringify(artifacts));

    let release: Release | undefined = undefined;

    // FIXME: what's the right way to detect a release?
    if (eventName === "release") {
      release = payload as Release;
    } else {
      const isRefPush = eventName === "push" && /^refs\/tags\/.*/.test(ref);
      if (isRefPush) {
        const tag = ref.replace(/^refs\/tags\//, "");
        core.info(`Getting release by tag: ${tag}`);

        const response = await client.rest.repos.getReleaseByTag({
          ...repo,
          tag,
        });
        release = response.data as Release;
      }
    }

    if (release) {
      core.info("Running release, attaching SBOMs");
      for (const artifact of artifacts) {
        core.info(`Found artifact: ${artifact.name}`);
        if (/^sbom-.*/.test(artifact.name)) {
          core.info(`Found SBOM artifact: ${artifact.name}`);
          const file = await downloadArtifact({
            client,
            name: artifact.name,
          });
          core.info(`Got SBOM file: ${JSON.stringify(file)}`);
          const contents = fs.readFileSync(file);
          const fileName = path.basename(file);

          try {
            const assets = await listReleaseAssets({
              client,
              repo,
              release,
            });

            const asset = assets.find((a) => a.name === fileName);
            if (asset) {
              await deleteReleaseAsset({
                client,
                repo,
                release,
                asset,
              });
            }

            await uploadReleaseAsset({
              client,
              repo,
              release,
              fileName,
              contents: contents.toString(),
              label: "sbom",
              contentType: "text/plain",
            });
          } catch (e) {
            core.warning(`Unable to upload asset: ${artifact.name}`);
            core.warning(`${e}`);
          }
        }
      }
    }
  } catch (e: unknown) {
    if (e instanceof SyftErrorImpl) {
      core.setFailed(`ERROR executing Syft: ${e.message}
      Caused by: ${e.error}
      STDOUT: ${e.out}
      STDERR: ${e.err}`);
    } else if (e instanceof Error) {
      core.setFailed(e.message);
    } else if (e instanceof Object) {
      core.setFailed(e.toString());
    } else {
      core.setFailed("An unknown error occurred");
    }
    throw e;
  }
}
