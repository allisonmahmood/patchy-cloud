// @effect-diagnostics nodeBuiltinImport:off
// Real filesystem edits exercise the transaction's concurrent-author boundary.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ManagedProject } from "./ManagedProject.js";

const directories: string[] = [];
const project = async () => {
  const root = await mkdtemp(join(tmpdir(), "patchy-package-edit-"));
  directories.push(root);
  await writeFile(join(root, "package.json"), "original package");
  return root;
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

it("refuses a stale pin write without rolling back the author's newer package", async () => {
  const root = await project();
  const transaction = await ManagedProject.begin(root);
  try {
    await writeFile(join(root, "package.json"), "author's newer package");
    await expect(
      transaction.write("package.json", "new pin", "original package")
    ).rejects.toThrow();
  } finally {
    await transaction.finish(false);
  }
  expect(await readFile(join(root, "package.json"), "utf8")).toBe("author's newer package");
});

it("restores the package read for the pin edit, not a stale pre-transaction version", async () => {
  const root = await project();
  const transaction = await ManagedProject.begin(root);
  try {
    await writeFile(join(root, "package.json"), "author's newer package");
    const current = await readFile(join(root, "package.json"), "utf8");
    await transaction.write("package.json", "new pin with author's metadata", current);
  } finally {
    await transaction.finish(false);
  }
  expect(await readFile(join(root, "package.json"), "utf8")).toBe("author's newer package");
});
