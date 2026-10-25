/** Publish a real tier 1 patch to this worktree only. No provider credentials enter this process. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRequire } from "node:module";
import { customers } from "./customers.ts";
import { catalog, isKey } from "./catalog.ts";
import { loadPiece } from "./adapter.ts";

const args = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--company", "--piece", "--handle", "--action", "--inputs"].includes(args[i]) ||
    !args[i + 1] ||
    options.has(args[i])
  )
    throw new Error(
      "Use --company <handle> --piece <piece> --handle <connection> --action <action> [--inputs <JSON text fields>]"
    );
  options.set(args[i], args[i + 1]);
}
const customer = customers.find((item) => item.handle === options.get("--company"));
const key = options.get("--piece");
const actionName = options.get("--action");
const handle = options.get("--handle");
if (
  !customer ||
  !isKey(key ?? "") ||
  !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(handle ?? "") ||
  !Object.hasOwn(catalog[key].actions, actionName ?? "")
)
  throw new Error(
    "Choose a seeded local company, admitted piece/action and existing connection handle."
  );
const root = fileURLToPath(new URL("../../../", import.meta.url));
const here = fileURLToPath(new URL("./", import.meta.url));
const state = join(root, ".local/dev");
const plan = JSON.parse(readFileSync(join(state, "plan.json"), "utf8"));
const mode = JSON.parse(readFileSync(join(state, "activepieces-mode.json"), "utf8"));
if (
  new URL(plan.apiUrl).hostname !== "127.0.0.1" ||
  plan.worktree !== root.replace(/\/$/, "") ||
  mode.mode !== "community-catalog"
)
  throw new Error("Start this worktree with local:catalog first.");
const entry = catalog[key];
const require = createRequire(import.meta.url);
const piece = await loadPiece(
  {
    modulePath: require.resolve(entry.package),
    exportName: entry.exportName,
    authType: entry.authType
  },
  [actionName]
);
const action = piece.metadata.actionDetails.find((item) => item.name === actionName);
const fields = (entry.actions[actionName].inputs ?? []).map((name) =>
  action.fields.find((field) => field.name === name)
);
const defaults = JSON.parse(options.get("--inputs") ?? "{}");
if (
  !defaults ||
  typeof defaults !== "object" ||
  Array.isArray(defaults) ||
  Object.entries(defaults).some(
    ([name, value]) =>
      !fields.some((field) => field.name === name) ||
      typeof value !== "string" ||
      value.length > 4096
  )
)
  throw new Error("Defaults must contain only admitted text inputs, never credentials.");
const dir = join(state, "community-patches", customer.handle);
const cli = join(root, "packages/patchy/src/index.ts");
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  PATCHY_API_URL: plan.apiUrl,
  PATCHY_API_TOKEN: `local-machine-${customer.handle}`,
  PATCHY_STATE_DIR: join(state, "cli", customer.handle)
};
const run = (command, cwd = dir) =>
  execFileSync(process.execPath, ["--import", "tsx", "--conditions=development", cli, ...command], {
    cwd,
    env,
    stdio: "inherit"
  });
mkdirSync(dir, { recursive: true });
if (!existsSync(join(dir, "patchy.json")))
  run(
    [
      "init",
      dir,
      "--tier",
      "1",
      "--purpose",
      "Read an existing community connection through Patchy"
    ],
    root
  );
cpSync(join(here, "community-patch"), dir, { recursive: true });
writeFileSync(
  join(dir, "patchy.config.ts"),
  `import { defineConfig } from "patchy/config";\nexport default defineConfig(${JSON.stringify({ name: "community-demo", tier: 1, uses: { external: { kind: "community", piece: key, handle, version: entry.version, actions: [actionName] } } }, null, 2)});\n`
);
writeFileSync(
  join(dir, "src/action.ts"),
  `export const action = ${JSON.stringify({ name: actionName, displayName: action.displayName, provider: piece.metadata.displayName, fields, defaults }, null, 2)} as const;\n`
);
run(["refresh", "--json"]);
run(["publish", "--json"]);
console.log(`Local patch: ${plan.apiUrl}/${customer.handle}/community-demo`);
console.log(
  `Sign in: ${plan.apiUrl}/dev/sign-in?as=${encodeURIComponent(customer.email)}&return=${encodeURIComponent(`/${customer.handle}/community-demo`)}`
);
