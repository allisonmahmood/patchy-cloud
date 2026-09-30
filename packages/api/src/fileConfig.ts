import { registry } from "@patchy/limits/registry";

/** Byte preflight shared with the server's staged-upload admission. */
export const stagedUploadLimit = {
  limitId: "files.stage.bytes",
  scope: registry["files.stage.bytes"].scope,
  value: registry["files.stage.bytes"].default
} as const;
