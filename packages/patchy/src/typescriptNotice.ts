import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import satisfies from "semver/functions/satisfies.js";
import type { ReleaseToolchain } from "@patchy/api";

/** The compiler publish runs, relative to the repo root. */
export const typescriptManifest = "node_modules/typescript/package.json";

const decodeVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
);

/**
 * Why this release won't publish the repo's TypeScript, or nothing when it will, given the text of
 * the repo's `typescriptManifest`. Without one, publish's typecheck reports that instead. Publish
 * refuses with it and dev warns; refresh hears it from the installed release's toolchain child.
 * Patches moved to TypeScript 7, beside which typescript-eslint can't run, hence the lint step.
 */
export const typescriptNotice = (
  manifest: string | undefined,
  versions: typeof ReleaseToolchain.Type
) => {
  if (manifest === undefined) return undefined;
  const version = Option.getOrUndefined(decodeVersion(manifest))?.version;
  const { accepted, testedAgainst } = versions.typescript;
  if (version !== undefined && satisfies(version, accepted)) return undefined;
  return `This repo has TypeScript ${version ?? "of an unknown version"}; this release publishes only TypeScript ${accepted} (tested against ${testedAgainst}). Run: pnpm add --save-dev 'typescript@${accepted}'. typescript-eslint doesn't run beside TypeScript 7: if the lint script runs ESLint, move it to Oxlint as .agents/skills/patchy-loop/SKILL.md says.`;
};
