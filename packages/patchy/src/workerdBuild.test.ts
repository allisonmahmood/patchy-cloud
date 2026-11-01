import { expect, it } from "vitest";
import { withWorkerdBuildDeclined } from "./workerdBuild.js";

// packed-tier2-e2e.mjs proves pnpm 12 then installs a scaffolded tier 2 repo.
const edited = (source: string) => {
  const result = withWorkerdBuildDeclined(source);
  if (!("source" in result)) throw new Error(`Expected an edit, got: ${result.notice}`);
  return result.source;
};
const declined = edited("");
const addKey = "Add the top-level line `allowBuilds: { workerd: false }` to pnpm-workspace.yaml";
const addEntry = "Add `workerd: false` under `allowBuilds` in pnpm-workspace.yaml";

it("writes a file that only declines workerd's build script, and leaves it alone after", () => {
  expect(declined).toMatch(/^allowBuilds:\n {2}workerd: false\n$/m);
  expect(edited(declined)).toBe(declined);
});

it.each([
  ["other settings", "minimumReleaseAge: 1440\n", `minimumReleaseAge: 1440\n${declined}`],
  ["no final newline", "minimumReleaseAge: 1440", `minimumReleaseAge: 1440\n${declined}`],
  ["only a comment", "# settings\n", `# settings\n${declined}`],
  [
    "a block mapping",
    "allowBuilds:\n    esbuild: true # keep\n\nminimumReleaseAge: 1440\n",
    "allowBuilds:\n    workerd: false\n    esbuild: true # keep\n\nminimumReleaseAge: 1440\n"
  ],
  [
    "a quoted key",
    '"allowBuilds":\n  esbuild: true\n',
    '"allowBuilds":\n  workerd: false\n  esbuild: true\n'
  ],
  [
    "a one-line flow mapping",
    "allowBuilds: { esbuild: true } # keep\n",
    "allowBuilds: { workerd: false, esbuild: true } # keep\n"
  ],
  ["an empty flow mapping", "allowBuilds: {}\n", "allowBuilds: { workerd: false }\n"],
  [
    "Windows line endings",
    "allowBuilds:\r\n  esbuild: true\r\n",
    "allowBuilds:\r\n  workerd: false\r\n  esbuild: true\r\n"
  ]
])("declines workerd's build script beside %s", (_, source, expected) => {
  expect(edited(source)).toBe(expected);
});

it.each([
  ["a block workerd: true", "allowBuilds:\n  esbuild: true\n  workerd: true\n"],
  ["a quoted key's workerd: false", "'allowBuilds':\n  # off\n  \"workerd\": false\n"],
  ["a flow workerd", 'allowBuilds: { esbuild: true, "workerd": true }\n'],
  ["a choice for one workerd version", "allowBuilds:\n  workerd@1.20260924.1: true\n"],
  ["an aliased workerd key", "pkg: &w workerd\nallowBuilds:\n  *w : true\n"],
  ["an aliased allowBuilds mapping", "base: &b\n  workerd: true\nallowBuilds: *b\n"],
  ["a merged workerd: true", "base: &b\n  workerd: true\nallowBuilds:\n  <<: *b\n  esbuild: true\n"]
])("keeps %s as the repo wrote it", (_, own) => {
  expect(withWorkerdBuildDeclined(own)).toEqual({ source: own });
});

// Splicing into these could change what other lines mean, so the person adds the line.
it.each([
  ["a document end marker", "minimumReleaseAge: 1440\n...\n", addKey],
  ["an anchored first key", "allowBuilds: { &pkg esbuild: true }\n", addEntry],
  ["explicit keys", "allowBuilds:\n  ? esbuild\n  : true\n", addEntry],
  ["an aliased allowBuilds key", "key: &k allowBuilds\n*k :\n  esbuild: true\n", addEntry],
  ["an aliased mapping without workerd", "base: &b\n  esbuild: true\nallowBuilds: *b\n", addEntry],
  ["a merge key", "allowBuilds:\n  <<: { esbuild: true }\n  sharp: true\n", addEntry],
  ["an empty value", "allowBuilds: # chosen\nminimumReleaseAge: 1440\n", addEntry],
  ["a null value", "allowBuilds: null\n", addEntry],
  ["an indented root", "  minimumReleaseAge: 1440\n", addKey],
  ["a flow root", "{ minimumReleaseAge: 1440 }\n", addKey],
  ["a flow mapping over lines", "allowBuilds: { # keep me\n}\n", addEntry],
  ["a tag", "allowBuilds: !!map\n  esbuild: true\n", addEntry],
  ["two documents", "a: 1\n---\nallowBuilds:\n  esbuild: true\n", addKey],
  ["a duplicate key", "allowBuilds:\n  esbuild: true\nallowBuilds:\n  sharp: true\n", addEntry]
])("leaves a file with %s as written, and says what to add", (_, source, action) => {
  const result = withWorkerdBuildDeclined(source);
  expect(result).not.toHaveProperty("source");
  expect(result).toHaveProperty("notice", expect.stringContaining(action));
});
