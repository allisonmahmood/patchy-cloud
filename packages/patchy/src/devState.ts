// @effect-diagnostics nodeBuiltinImport:off -- Daemon state needs atomic renames and no-follow filesystem checks.
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Identity } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { LocalError } from "./CliError.js";
import { safePath } from "./ManagedProject.js";
import { birth, claim, release } from "./ownerLock.js";

export { birth, sameProcess } from "./ownerLock.js";

export const Daemon = Schema.Struct({
  root: Schema.String,
  instance: Schema.String,
  release: Schema.String,
  identity: Identity,
  nonce: Schema.String,
  pid: Schema.Int,
  birth: Schema.String,
  url: Schema.optionalKey(Schema.String),
  colleagueUrl: Schema.optionalKey(Schema.String),
  logJson: Schema.optionalKey(Schema.Boolean)
});
export type Daemon = typeof Daemon.Type;
const decodeDaemon = Schema.decodeUnknownSync(Schema.fromJsonString(Daemon));
const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

export const io = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new LocalError({ message, cause }) });

export const directory = (root: string, instance: string) =>
  io("Could not open this repo's local dev state.", async () => {
    const canonical = await fs.realpath(root);
    const relative = `.patchy/dev/${createHash("sha256").update(instance).digest("hex").slice(0, 16)}`;
    const stateDir = await safePath(canonical, relative);
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    return { root: canonical, stateDir };
  });

export async function readRecord(stateDir: string): Promise<Daemon | undefined> {
  const file = await safePath(stateDir, "daemon.json");
  try {
    return decodeDaemon(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

export async function atomicJson(stateDir: string, name: string, value: unknown): Promise<void> {
  const target = await safePath(stateDir, name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** One dev command at a time per repo and instance; see `claim` for how a dead owner is reclaimed. */
export const lock = (stateDir: string) =>
  Effect.acquireRelease(
    io("Another dev command is starting or stopping this repo. Retry shortly.", async () => {
      // Dev signals and reclaims by birth, so it never runs without its own.
      if (!(await birth(process.pid))) throw new Error("Could not identify this process.");
      const slot = await safePath(stateDir, "lock");
      const claimed = await claim(slot);
      if ("holder" in claimed) throw new Error(`Dev state is held by a ${claimed.holder} owner.`);
      return { slot, nonce: claimed.nonce };
    }),
    ({ slot, nonce }) => Effect.promise(() => release(slot, nonce))
  );

export const logPath = (stateDir: string) => path.join(stateDir, "dev.log");
