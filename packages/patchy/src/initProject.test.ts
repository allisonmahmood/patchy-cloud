// @effect-diagnostics nodeBuiltinImport:off
// A real child keeps its working directory open across starter activation.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { activateStarter } from "./initProject.js";

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
