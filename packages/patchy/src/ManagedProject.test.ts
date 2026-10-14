// @effect-diagnostics nodeBuiltinImport:off
// Real files exercise command ownership across an author's later saves.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ManagedProject, ProjectLocked } from "./ManagedProject.js";

const directories: string[] = [];
const originalPackage = '{\n  "devDependencies": { "patchy": "old-release" }\n}\n';
const project = async () => {
  const root = await mkdtemp(join(tmpdir(), "patchy-managed-"));
  directories.push(root);
  await writeFile(join(root, "package.json"), originalPackage);
  await writeFile(join(root, "patchy.config.ts"), "original config");
  return root;
};
const bytes = async (directory: string): Promise<Record<string, Buffer>> => {
  const result: Record<string, Buffer> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [name, contents] of Object.entries(await bytes(join(directory, entry.name))))
        result[`${entry.name}/${name}`] = contents;
    } else result[entry.name] = await readFile(join(directory, entry.name));
  }
  return result;
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

it("leaves an author's config save alone when plain refresh fails", async () => {
  const root = await project();
  const transaction = await ManagedProject.begin(root);
  await writeFile(join(root, "patchy.config.ts"), "author's saved config");
  await transaction.finish(false);
  expect(await readFile(join(root, "patchy.config.ts"), "utf8")).toBe("author's saved config");
});

it("undoes only its package pin while retaining later scripts and formatting", async () => {
  const root = await project();
  const transaction = await ManagedProject.begin(root);
  await transaction.setPin("patchy", "old-release", "new-release");
  const authored =
    '{\n\t"scripts" : { "build": "my-build" },\n  "devDependencies": { "patchy": "new-release" }\n}\n';
  await writeFile(join(root, "package.json"), authored);
  await transaction.finish(false);
  expect(await readFile(join(root, "package.json"), "utf8")).toBe(
    authored.replace("new-release", "old-release")
  );
});

it("preserves a malformed author package saved after its pin edit", async () => {
  const root = await project();
  const transaction = await ManagedProject.begin(root);
  await transaction.setPin("patchy", "old-release", "new-release");
  const authored = '{ "devDependencies": { "patchy": "author-release" }';
  await writeFile(join(root, "package.json"), authored);
  await transaction.finish(false);
  expect(await readFile(join(root, "package.json"), "utf8")).toBe(authored);
});

it.each([undefined, "old-engine"])(
  "rolls back the engine pin %s and release without discarding an author's later dependency",
  async (previous) => {
    const root = await project();
    const initial = JSON.stringify({
      devDependencies: { patchy: "old-release", ...(previous ? { workerd: previous } : {}) }
    });
    await writeFile(join(root, "package.json"), initial);
    const transaction = await ManagedProject.begin(root);
    await transaction.setPin("patchy", "old-release", "new-release");
    await transaction.setPin("workerd", previous, "new-engine");
    const current = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    current.devDependencies.typescript = "^6.0.3";
    await writeFile(join(root, "package.json"), JSON.stringify(current));
    await transaction.finish(false);
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual({
      devDependencies: {
        patchy: "old-release",
        ...(previous ? { workerd: previous } : {}),
        typescript: "^6.0.3"
      }
    });
  }
);

it("restores a removed engine pin byte-for-byte when a tier downgrade fails", async () => {
  const root = await project();
  const initial = '{\n  "devDependencies": { "patchy": "old-release", "workerd": "engine" }\n}\n';
  await writeFile(join(root, "package.json"), initial);
  const transaction = await ManagedProject.begin(root);
  await transaction.setPin("workerd", "engine", undefined);
  expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual({
    devDependencies: { patchy: "old-release" }
  });
  await transaction.finish(false);
  expect(await readFile(join(root, "package.json"), "utf8")).toBe(initial);
});

it.each(["", " ", "\n    ", "\r\n\t"])(
  "preserves package bytes across committed engine pin changes with whitespace %j",
  async (whitespace) => {
    const root = await project();
    const initial = `{"scripts":{"build":"author-build"},"devDependencies":{${whitespace}"patchy":"release",${whitespace}"typescript":"^6.0.3"${whitespace}}}\n`;
    await writeFile(join(root, "package.json"), initial);
    const upgrade = await ManagedProject.begin(root);
    await upgrade.setPin("workerd", undefined, "engine");
    await upgrade.finish(true);
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual({
      scripts: { build: "author-build" },
      devDependencies: { workerd: "engine", patchy: "release", typescript: "^6.0.3" }
    });
    const downgrade = await ManagedProject.begin(root);
    await downgrade.setPin("workerd", "engine", undefined);
    await downgrade.finish(true);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(initial);
  }
);

it("restores every generated byte after activation fails without enrolling config", async () => {
  const root = await project();
  const generated = join(root, "patchy/_generated");
  await mkdir(join(generated, "nested"), { recursive: true });
  await writeFile(join(generated, "old.ts"), "old generated\r\n");
  await writeFile(join(generated, "nested/index.json"), '{"old":true}\n');
  const before = await bytes(generated);
  const transaction = await ManagedProject.begin(root);
  await transaction.activate(
    [{ path: "patchy/_generated/client.ts", contents: "new generated\n" }],
    "{}"
  );
  await writeFile(join(root, "patchy.config.ts"), "author's saved config");
  await transaction.finish(false);
  expect(await bytes(generated)).toEqual(before);
  expect(await readFile(join(root, "patchy.config.ts"), "utf8")).toBe("author's saved config");
});

it("refuses a staged uses edit after an author save, keeping config and generated bytes", async () => {
  const root = await project();
  const generated = join(root, "patchy/_generated");
  await mkdir(generated, { recursive: true });
  await writeFile(join(generated, "client.ts"), "old generated");
  const before = await bytes(generated);
  const transaction = await ManagedProject.begin(root);
  await writeFile(join(root, "patchy.config.ts"), "author's saved config");
  try {
    await expect(
      transaction.activate(
        [{ path: "patchy/_generated/client.ts", contents: "new generated" }],
        "{}",
        [],
        { before: "original config", after: "config with added uses" }
      )
    ).rejects.toThrow();
  } finally {
    await transaction.finish(false);
  }
  expect(await readFile(join(root, "patchy.config.ts"), "utf8")).toBe("author's saved config");
  expect(await bytes(generated)).toEqual(before);
});

it("creates a missing shared-store fixture directory once and preserves authored directories", async () => {
  const root = await project();
  const fixture = { path: "fixtures/shared-assets/README.md", contents: "Invent files here.\n" };
  const first = await ManagedProject.begin(root);
  expect((await first.activate([fixture], "{}")).fixtures).toEqual([fixture.path]);
  await first.finish(true);
  const authored = Buffer.from([0, 255, 13, 10]);
  await mkdir(join(root, "fixtures/shared-assets/nested"));
  await writeFile(join(root, "fixtures/shared-assets/nested/photo.bin"), authored);
  await rm(join(root, fixture.path));
  const refresh = await ManagedProject.begin(root);
  expect((await refresh.activate([fixture], "{}")).fixtures).toEqual([]);
  await refresh.finish(true);
  expect(await bytes(join(root, "fixtures/shared-assets"))).toEqual({
    "nested/photo.bin": authored
  });
});

it("removes a newly created fixture on rollback without deleting later authored bytes", async () => {
  const root = await project();
  const transaction = await ManagedProject.begin(root);
  await transaction.activate(
    [{ path: "fixtures/shared-assets/README.md", contents: "Invent files here.\n" }],
    "{}"
  );
  const authored = Buffer.from([0, 255]);
  await writeFile(join(root, "fixtures/shared-assets/authored.bin"), authored);
  await transaction.finish(false);
  expect(await bytes(join(root, "fixtures/shared-assets"))).toEqual({ "authored.bin": authored });
});

const lockSlot = (root: string) => join(root, ".patchy/refresh-lock");
const hold = async (root: string, owners: Record<string, string>) => {
  await mkdir(lockSlot(root), { recursive: true });
  for (const [name, contents] of Object.entries(owners))
    await writeFile(join(lockSlot(root), name), contents);
};
// This PID is alive, so only the birth mismatch can prove its recorded owner gone.
const deadOwner = JSON.stringify({ pid: process.pid, birth: "stale", nonce: "dead" });

it("refuses a second transaction while the first is alive, then admits the next", async () => {
  const root = await project();
  const first = await ManagedProject.begin(root);
  await expect(ManagedProject.begin(root)).rejects.toEqual(new ProjectLocked({ holder: "live" }));
  await first.finish(true);
  await (await ManagedProject.begin(root)).finish(true);
});

it("reclaims a dead owner's lock and clears its transaction only after a reinstall", async () => {
  const root = await project();
  await hold(root, { "dead.json": deadOwner });
  await mkdir(join(root, ".patchy/refresh-orphan/node_modules"), { recursive: true });
  const dev = await ManagedProject.begin(root);
  expect(dev.interrupted).toBe(true);
  await dev.finish(true);
  expect(await readdir(join(root, ".patchy"))).toEqual(["refresh-orphan"]);
  const refresh = await ManagedProject.begin(root);
  expect(refresh.interrupted).toBe(true);
  await refresh.prepareInstall();
  await refresh.finish(true);
  expect(await readdir(join(root, ".patchy"))).toEqual([]);
});

it.each([
  ["an empty slot", {}],
  ["a malformed owner", { "dead.json": "{" }],
  [
    "an owner without a birth",
    { "dead.json": JSON.stringify({ pid: process.pid, nonce: "dead" }) }
  ],
  ["two owners", { "dead.json": deadOwner, "other.json": deadOwner }]
])("never reclaims %s", async (_, owners) => {
  const root = await project();
  await hold(root, owners);
  const error = await ManagedProject.begin(root).catch((cause: unknown) => cause);
  expect(error).toEqual(new ProjectLocked({ holder: "unknown" }));
  expect((error as ProjectLocked).message).toContain(".patchy/refresh-lock");
  expect(await bytes(lockSlot(root))).toEqual(
    Object.fromEntries(Object.entries(owners).map(([name, text]) => [name, Buffer.from(text)]))
  );
});

it("releases without removing a replacement owner's claim", async () => {
  const root = await project();
  const transaction = await ManagedProject.begin(root);
  // Simulate another owner replacing the slot before this transaction finishes.
  await rm(lockSlot(root), { recursive: true });
  await hold(root, { "replacement.json": "replacement" });
  await transaction.finish(true);
  expect(await readFile(join(lockSlot(root), "replacement.json"), "utf8")).toBe("replacement");
});
