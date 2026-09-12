import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Serial with the rest of the repo: these builds replace shared dist artifacts. */
export default function setup() {
  if (process.env.PATCHY_TIER1_SKIP_BUILD === "1") return;
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  execFileSync("pnpm", ["--filter", "@patchy/server...", "build"], { cwd, stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/build-patchy-package.mjs", "--stage-for-server"], {
    cwd,
    stdio: "inherit"
  });
}
