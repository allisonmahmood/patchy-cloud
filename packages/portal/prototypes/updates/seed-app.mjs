// Local-only document publisher for the integrated app preview. Never calls GitHub or S3.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initialState, prepareActionPayload } from "./deploy-action.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const plan = JSON.parse(await readFile(resolve(root, ".local/dev/plan.json"), "utf8"));
const url = new URL(plan.apiUrl);
if (
  plan.worktree !== root.replace(/\/$/, "") ||
  plan.signIn !== "personas" ||
  url.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(url.hostname)
)
  throw new Error("Use a loopback pnpm dev instance with dev personas for this simulation.");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--deploy"))
  throw new Error("Usage: pnpm prototype:updates:seed [--deploy]");
const file = resolve(root, ".local/dev/storage/platform-updates/history.json");
let history;
try {
  history = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  history = {
    version: 1,
    entries: initialState().entries.map(({ sequence, completedAt, notes }) => ({
      sequence,
      publishedAt: completedAt,
      ...notes
    }))
  };
}
if (args.includes("--deploy")) {
  const sequence = Math.max(0, ...history.entries.map((entry) => entry.sequence)) + 1;
  const payload = prepareActionPayload(sequence);
  history.entries.push({ sequence, publishedAt: payload.completedAt, ...payload.notes });
}
await mkdir(dirname(file), { recursive: true });
await writeFile(file + ".tmp", JSON.stringify(history, null, 2));
await rename(file + ".tmp", file);
console.log(
  `Shared local history: ${history.entries.length} sample updates\n${plan.apiUrl}/updates\n${file}`
);
