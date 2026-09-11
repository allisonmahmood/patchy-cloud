// @effect-diagnostics nodeBuiltinImport:off
// A real child keeps its working directory open across starter activation.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { activateStarter, writeInitialGeneration } from "./initProject.js";

const directories: string[] = [];
async function temporaryDirectory() {
  const root = await mkdtemp(join(tmpdir(), "patchy-init-"));
  directories.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

it("keeps an already-running caller in the initialized directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchy-init-cwd-"));
  const destination = join(root, "project");
  const staging = join(root, "staging");
  await mkdir(destination);
  await mkdir(staging);
  const contents = '{"name":"initialized-project"}\n';
  await writeFile(join(staging, "package.json"), contents);
  const caller = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { readFileSync } from "node:fs"; process.stdin.once("data", () => process.stdout.write(readFileSync("package.json"))); process.stdout.write("ready");'
    ],
    { cwd: destination, stdio: ["pipe", "pipe", "pipe"] }
  );
  const closed = once(caller, "close");
  try {
    await once(caller.stdout, "data");
    const output: Buffer[] = [];
    caller.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    await activateStarter(staging, destination);
    caller.stdin.end("read");
    const [code] = await closed;
    expect(code).toBe(0);
    expect(Buffer.concat(output).toString()).toBe(contents);
  } finally {
    caller.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses existing content and symbolic-link destinations without touching them", async () => {
  const root = await temporaryDirectory();
  const staging = join(root, "staging");
  const destination = join(root, "project");
  await mkdir(staging);
  await mkdir(destination);
  await writeFile(join(staging, "package.json"), "new package");
  await writeFile(join(destination, "package.json"), "existing package");
  await expect(activateStarter(staging, destination)).rejects.toThrow();
  expect(await readFile(join(destination, "package.json"), "utf8")).toBe("existing package");
  const linked = join(root, "linked");
  const empty = join(root, "empty");
  await mkdir(empty);
  await symlink(empty, linked);
  await expect(activateStarter(staging, linked)).rejects.toThrow();
  expect(await readdir(empty)).toEqual([]);
});

it.each([true, false])(
  "removes a failed activation's files without deleting a caller-owned root (existing: %s)",
  async (existing) => {
    const root = await temporaryDirectory();
    const staging = join(root, "staging");
    const destination = join(root, "project");
    await mkdir(staging);
    if (existing) await mkdir(destination);
    await writeFile(join(staging, "package.json"), "staged package");
    await mkdir(join(staging, "src"));
    await writeFile(join(staging, "src/main.ts"), "staged source");
    // A socket is not a project file and makes activation fail after encountering real entries.
    const socket = createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(join(staging, "unsupported.sock"), resolve);
    });
    try {
      await expect(activateStarter(staging, destination)).rejects.toThrow();
      if (existing) {
        expect(await readdir(destination)).toEqual([]);
        await writeFile(join(destination, "author.txt"), "caller can still use this directory");
        expect(await readFile(join(destination, "author.txt"), "utf8")).toBe(
          "caller can still use this directory"
        );
      } else {
        await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        socket.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
);

it("writes initial generated files and a local manifest while preserving existing fixtures", async () => {
  const staging = await temporaryDirectory();
  await mkdir(join(staging, "fixtures"));
  await writeFile(join(staging, "fixtures/.gitkeep"), "");
  await writeFile(join(staging, "fixtures/postgres-existing.sql"), "-- authored fixture\n");
  const changed = await writeInitialGeneration(
    staging,
    [
      { path: "patchy/_generated/client.ts", contents: "export const client = {};\n" },
      { path: ".agents/skills/patchy-loop/SKILL.md", contents: "# Build loop\n" },
      { path: "fixtures/postgres-new.sql", contents: "-- new fixture\n" },
      { path: "fixtures/postgres-existing.sql", contents: "-- replacement stub\n" }
    ],
    '{"release":"local-manifest"}\n'
  );
  expect(changed).toEqual({
    generated: ["patchy/_generated/client.ts", "patchy/_generated/manifest.json"],
    skills: ["patchy-loop"],
    fixtures: ["fixtures/postgres-new.sql"]
  });
  expect(await readFile(join(staging, "patchy/_generated/client.ts"), "utf8")).toBe(
    "export const client = {};\n"
  );
  expect(await readFile(join(staging, "patchy/_generated/manifest.json"), "utf8")).toBe(
    '{"release":"local-manifest"}\n'
  );
  expect(await readFile(join(staging, ".agents/skills/patchy-loop/SKILL.md"), "utf8")).toBe(
    "# Build loop\n"
  );
  expect(await readFile(join(staging, "fixtures/postgres-new.sql"), "utf8")).toBe(
    "-- new fixture\n"
  );
  expect(await readFile(join(staging, "fixtures/postgres-existing.sql"), "utf8")).toBe(
    "-- authored fixture\n"
  );
  expect(await readFile(join(staging, "fixtures/.gitkeep"), "utf8")).toBe("");
});

it.each([
  ["a traversal", "patchy/_generated/../../outside.ts"],
  ["a server manifest", "patchy/_generated/manifest.json"],
  ["a duplicate", "patchy/_generated/client.ts"]
])("rejects %s before writing generated output", async (_, rejectedPath) => {
  const staging = await temporaryDirectory();
  await expect(
    writeInitialGeneration(
      staging,
      [
        { path: "patchy/_generated/client.ts", contents: "valid first file" },
        { path: rejectedPath, contents: "invalid second file" }
      ],
      "{}"
    )
  ).rejects.toThrow();
  expect(await readdir(staging)).toEqual([]);
});

it("refuses generated output through a symbolic link", async () => {
  const root = await temporaryDirectory();
  const staging = join(root, "staging");
  const outside = join(root, "outside");
  await mkdir(staging);
  await mkdir(outside);
  await symlink(outside, join(staging, "patchy"));
  await expect(
    writeInitialGeneration(
      staging,
      [{ path: "patchy/_generated/client.ts", contents: "must stay inside staging" }],
      "{}"
    )
  ).rejects.toThrow();
  expect(await readdir(outside)).toEqual([]);
});
