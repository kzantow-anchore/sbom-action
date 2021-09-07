import * as fs from "fs";
import path from "path";
import * as artifact from "@actions/artifact";
import * as core from "@actions/core";
import { GithubClientProp, GithubRepo } from "./GithubClient";
import { DownloadHttpClient } from "@actions/artifact/lib/internal/download-http-client";

export type WorkflowArtifactProps = GithubClientProp & {
  repo: GithubRepo;
  run: number;
};

export interface Artifact {
  // id: number;
  // node_id: string;
  name: string;
  // size_in_bytes: number;
  // url: string;
  // archive_download_url: string;
  // expired: boolean;
  // created_at: string | null;
  // expires_at: string | null;
  // updated_at: string | null;
}

export async function listWorkflowArtifacts({
  client,
  repo,
  run,
}: WorkflowArtifactProps): Promise<Artifact[]> {
  const useInternalClient = true;
  if (useInternalClient) {
    const downloadClient = new DownloadHttpClient();
    const response = await downloadClient.listArtifacts();
    return response.value;
    // .map((a) => ({
    //   name: a.name,
    //   // url: a.url,
    // }));
  }
  const response = await client.rest.actions.listWorkflowRunArtifacts({
    ...repo,
    run_id: run,
    per_page: 100,
    page: 1,
  });

  core.info("------------------ listWorkflowRunArtifacts ------------------ ");
  core.info(JSON.stringify(response));

  if (response.status >= 400) {
    throw new Error("Unable to retrieve listWorkflowRunArtifacts");
  }

  return response.data.artifacts;
}

export type UploadArtifactProps = WorkflowArtifactProps & {
  name: string;
  file: string;
};

export async function uploadArtifact({
  name,
  file,
}: UploadArtifactProps): Promise<void> {
  const rootDirectory = path.dirname(file);
  const client = artifact.create();
  core.info("-------------------------- Artifact Upload ---------------------");
  core.info(`${name} //// ${file}  //// ${rootDirectory}`);
  core.info(`Dir contains: ${JSON.stringify(fs.readdirSync(rootDirectory))}`);
  const info = await client.uploadArtifact(name, [file], rootDirectory, {});
  core.info("-------------------------- Artifact Upload ---------------------");
  core.info(JSON.stringify(info));
}
