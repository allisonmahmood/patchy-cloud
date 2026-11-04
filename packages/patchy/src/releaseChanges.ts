// @effect-diagnostics nodeBuiltinImport:off -- The toolchain child, a plain Node process, reads the repo.
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { patchChangesBetween } from "@patchy/core/whatsNew";
import { RELEASE } from "./release.js";

const decodeIndex = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ release: Schema.String }))
);

/** The What's new release a version is named after, `0.<id>.<patch>`. */
const releaseId = (version: string | undefined) => {
  const id = /^0\.(\d+)\.\d+$/.exec(version ?? "")?.[1];
  return id === undefined ? undefined : Number(id);
};

/**
 * What the releases a refresh crosses into this one can change for the repo's patch, one notice
 * each, oldest first. The repo's last generation names the release it was built on: refresh
 * replaces it only after the installed release inspects the repo. Without one, nothing is listed.
 */
export async function crossedPatchChanges(root: string) {
  const index = await readFile(path.join(root, "patchy/_generated/index.json"), "utf8").catch(
    () => undefined
  );
  const from = releaseId(
    index === undefined ? undefined : Option.getOrUndefined(decodeIndex(index))?.release
  );
  const to = releaseId(RELEASE);
  if (from === undefined || to === undefined) return [];
  return patchChangesBetween(from, to).map(
    ({ release, change }) => `Changed in 0.${release}.0: ${change}`
  );
}
