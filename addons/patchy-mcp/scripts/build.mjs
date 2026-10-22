import { spawnSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
const result = spawnSync("tsc", [], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync("dist/cli.js", 0o755);
