// Seed or append sample updates to this worktree's dev instance only.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const plan = JSON.parse(await readFile(resolve(root, ".local/dev/plan.json"), "utf8"));
const url = new URL(plan.apiUrl);
if (
  resolve(plan.worktree) !== root ||
  plan.signIn !== "personas" ||
  url.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(url.hostname)
)
  throw new Error("Sample updates can only be written to this worktree's loopback dev instance.");

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--simulate-deployment"))
  throw new Error("Usage: pnpm updates:seed [--simulate-deployment]");
const file = resolve(root, ".local/dev/storage/platform-updates/history.json");
let history;
try {
  history = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  history = { version: 1, entries: [] };
}
if (history.source?.kind === "github-actions-deploy")
  throw new Error("This history contains real Deploy Action entries; refusing to add samples.");

const now = Date.now();
const publish = (sequence, title, summary, changes) => ({
  sequence,
  publishedAt: new Date(now + sequence).toISOString(),
  simulation: true,
  title,
  summary,
  changes
});
let sequence = Math.max(
  history.lastSequence ?? 0,
  ...history.entries.map((entry) => entry.sequence),
  0
);
if (args.includes("--simulate-deployment")) {
  sequence += 1;
  history.entries.push(
    publish(
      sequence,
      "A new Patchy update is available",
      "Try the update bell and read controls.",
      [
        {
          kind: "Improved",
          title: "Keep track of new changes",
          detail:
            "Open this update to mark it read, or mark all updates as read from the top of the list."
        }
      ]
    )
  );
} else if (history.entries.length === 0) {
  for (const [title, summary] of [
    ["Share tools with your team", "Choose who can use the tools your team builds."],
    ["See recent activity", "Find recent changes to the tools shared with your team."],
    ["Track agent work", "Review what your agents changed and published."]
  ]) {
    sequence += 1;
    history.entries.push(publish(sequence, title, summary, []));
  }
}
history.lastSequence = Math.max(history.lastSequence ?? 0, sequence);
history.simulation = { kind: "local", lastSequence: sequence };
await mkdir(dirname(file), { recursive: true });
await writeFile(file + ".tmp", JSON.stringify(history, null, 2));
await rename(file + ".tmp", file);
console.log(`${url.origin}/updates`);
