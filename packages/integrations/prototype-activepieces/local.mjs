import { spawn, execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  existsSync,
  cpSync
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { customers } from "./customers.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const here = fileURLToPath(new URL("./", import.meta.url));
const state = join(root, ".local/dev");
const dev = join(root, "scripts/dev/src/main.ts");
const args = ["--import", "tsx", "--conditions=development"];
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const run = (file, command = [], options = {}) =>
  execFileSync(process.execPath, [...args, file, ...command], {
    cwd: root,
    env: baseEnv,
    encoding: "utf8",
    ...options
  });
const plan = JSON.parse(run(dev, ["--dry-run", "--json"]));
if (plan.environment || new URL(plan.apiUrl).hostname !== "127.0.0.1")
  throw new Error("Use a plain loopback dev instance for this prototype.");
const markerFile = join(state, "activepieces-mode.json");
const community = process.argv.includes("--catalog") || process.argv.includes("--slack");
const mode = community ? "community-catalog" : "posthog-mock";
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
if (plan.pids && alive(plan.pids.supervisor)) {
  const marker = existsSync(markerFile) ? JSON.parse(readFileSync(markerFile, "utf8")) : {};
  if (marker.supervisor !== plan.pids.supervisor || marker.mode !== mode)
    throw new Error(
      "A different dev instance is running. Stop it with pnpm dev stop before starting the prototype."
    );
} else {
  mkdirSync(state, { recursive: true });
  run(join(root, "scripts/build-serving-broker.mjs"));
  writeFileSync(join(state, "plan.json"), JSON.stringify(plan));
  const log = openSync(join(state, "activepieces-launcher.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [...args, join(here, "localSupervisor.ts"), ...(community ? ["--catalog"] : [])],
    {
      cwd: root,
      env: baseEnv,
      detached: true,
      stdio: ["ignore", log, log]
    }
  );
  child.unref();
  closeSync(log);
  writeFileSync(
    join(state, "plan.json"),
    JSON.stringify({ ...plan, pids: { supervisor: child.pid } })
  );
  writeFileSync(markerFile, JSON.stringify({ supervisor: child.pid, mode }));
}
let ready = false;
for (let attempt = 0; attempt < 480; attempt++) {
  try {
    if ((await fetch(`${plan.apiUrl}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) {
      ready = true;
      break;
    }
  } catch {
    /* startup */
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ready)
  throw new Error(`Local startup failed. See ${state}/dev.log and activepieces-launcher.log`);
console.log(
  community
    ? "Local Patchy is running. Preparing two test companies…"
    : "Local Patchy is running. Seeding the two simulated customer connections…"
);
run(join(here, "localSeed.ts"), community ? ["--catalog"] : []);
if (community) {
  console.log(
    "Connector catalog inside local Patchy (REAL provider requests; no credentials preloaded):"
  );
  for (const customer of customers)
    console.log(
      `${customer.name}: ${plan.apiUrl}/dev/sign-in?as=${encodeURIComponent(customer.email)}&return=${encodeURIComponent("/company/connections/community")}`
    );
  console.log(
    "Choose Resend (API key) or Slack (existing app token). Separate browser profiles keep companies signed in independently."
  );
  process.exit(0);
}
const cli = join(root, "packages/patchy/src/index.ts");
mkdirSync(join(state, "activepieces-patches"), { recursive: true });
for (const customer of customers) {
  const dir = join(state, "activepieces-patches", customer.handle);
  const env = {
    ...baseEnv,
    PATCHY_API_URL: plan.apiUrl,
    PATCHY_API_TOKEN: `local-machine-${customer.handle}`,
    PATCHY_STATE_DIR: join(state, "cli", customer.handle)
  };
  if (!existsSync(join(dir, "patchy.json"))) {
    console.log(`Building ${customer.name}'s demo patch…`);
    run(
      cli,
      [
        "init",
        dir,
        "--tier",
        "1",
        "--purpose",
        "Try the existing Activepieces action on simulated company data"
      ],
      { env }
    );
  }
  cpSync(join(here, "patch"), dir, { recursive: true });
  run(cli, ["refresh", "--json"], { cwd: dir, env });
  run(cli, ["publish", "--json"], { cwd: dir, env });
  const target = `/${customer.handle}/activepieces-demo`;
  console.log(
    `${customer.name}: ${plan.apiUrl}/dev/sign-in?as=${encodeURIComponent(customer.email)}&return=${encodeURIComponent(target)}`
  );
}
console.log("SIMULATED provider only. Use separate browser profiles for the two companies.");
console.log(
  "Manage with: npm --prefix packages/integrations/prototype-activepieces run local:status (or local:logs / local:stop)"
);
