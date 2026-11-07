/** Publish the existing scenario verbatim through the local instance's released CLI. */
import { spawn } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Published } from "../browser-tier1/instance.js";

export async function publishSpend(directory: string, origin: string) {
  const repo = join(directory, "spend");
  const env = {
    // oxlint-disable-next-line no-restricted-properties -- forward executable lookup, not ambient credentials.
    PATH: process.env.PATH,
    PATCHY_API_URL: origin,
    PATCHY_API_TOKEN: "patchy-dev-token",
    PATCHY_STATE_DIR: join(directory, "cli-state"),
    pnpm_config_store_dir: join(directory, "pnpm-store"),
    pnpm_config_cache_dir: join(directory, "pnpm-cache")
  };
  const command = async (executable: string, args: string[], cwd: string) => {
    process.stdout.write(
      `Local Spend Requests: ${executable === process.execPath ? args[1] : args[0]}\n`
    );
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(
                  `Local spend ${args[0]} failed: ${stderr.slice(-3000)} ${stdout.slice(-1000)}`
                )
              )
        );
      });
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  };
  const cli = (entry: string, args: string[], cwd: string) =>
    command(process.execPath, [entry, ...args, "--json"], cwd);
  await cli(
    join(process.cwd(), "packages/patchy/dist/index.js"),
    [
      "init",
      repo,
      "--tier",
      "2",
      "--purpose",
      "Review and approve a test spend request inside the team app"
    ],
    directory
  );
  // Replace the starter's builder-owned sources, as the scenario dev runner does.
  for (const folder of ["src", "server", "agent", "helpers", "fixtures"])
    await rm(join(repo, folder), { recursive: true, force: true });
  await cp("scenarios/brightline/patches/spend", repo, { recursive: true });
  const pinned = join(repo, "node_modules/patchy/dist/index.js");
  await cli(pinned, ["refresh"], repo);
  await command("pnpm", ["typecheck"], repo);
  const republish = async () => JSON.parse(await cli(pinned, ["publish"], repo)) as Published;
  return { patch: await republish(), republish };
}
