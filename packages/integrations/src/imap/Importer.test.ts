import { assert, it } from "@effect/vitest";
import * as ImapTest from "../test/imap.js";

/**
 * The `patchy-imap` skill's reference importer is the one the `imap` scenario publishes and the
 * live tier runs: its config and its action, word for word.
 */
it("the skill's reference importer is the imap scenario's, word for word", () => {
  for (const [label, path] of [
    ["`patchy.config.ts`:", "scenarios/imap/patches/invoice-inbox/patchy.config.ts"],
    ["`server/importer.ts`:", "scenarios/imap/patches/invoice-inbox/server/importer.ts"]
  ] as const)
    assert.strictEqual(ImapTest.skillBlock(label), ImapTest.repoFile(path).trimEnd(), path);
});
