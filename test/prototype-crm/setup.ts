// PROTOTYPE for #315: the same builds as the tier 1 acceptance suite, before the instance starts.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup() {
  if (process.env.PATCHY_PROTOTYPE_SKIP_BUILD === "1") return;
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  execFileSync("pnpm", ["--filter", "@patchy/server...", "build"], { cwd, stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/build-patchy-package.mjs", "--stage-for-server"], {
    cwd,
    stdio: "inherit"
  });
}
