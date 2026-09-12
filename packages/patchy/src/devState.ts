// @effect-diagnostics nodeBuiltinImport:off -- Daemon identity needs process birth time and no-follow filesystem checks.
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { Identity } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { LocalError } from "./CliError.js";
import { safePath } from "./ManagedProject.js";

export const Daemon = Schema.Struct({
  root: Schema.String,
  instance: Schema.String,
  release: Schema.String,
  identity: Identity,
  nonce: Schema.String,
  pid: Schema.Int,
  birth: Schema.String,
  url: Schema.optionalKey(Schema.String)
});
export type Daemon = typeof Daemon.Type;
const decodeDaemon = Schema.decodeUnknownSync(Schema.fromJsonString(Daemon));
const Owner = Schema.Struct({ pid: Schema.Int, birth: Schema.String, nonce: Schema.String });
const decodeOwner = Schema.decodeUnknownSync(Schema.fromJsonString(Owner));
const execute = promisify(execFile);
const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));
const missingProcess = Schema.is(Schema.Struct({ code: Schema.Literals(["ENOENT", "ESRCH"]) }));
const occupied = Schema.is(Schema.Struct({ code: Schema.Literals(["EEXIST", "ENOTEMPTY"]) }));

export const io = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new LocalError({ message, cause }) });

/** A PID alone is never authority to signal a process or reclaim its startup lock. */
export async function birth(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") return undefined;
      const boot = await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8");
      return `${boot.trim()}:${fields[19]}`;
    } catch (error) {
      // A process can exit after procfs opens its stat file but before the read.
      if (missingProcess(error)) return undefined;
      throw error;
    }
  }
  try {
    const result = await execute("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="]);
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export const sameProcess = async (record: Pick<Daemon, "pid" | "birth">) =>
  (await birth(record.pid)) === record.birth;

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

/** A nonempty directory selects one complete owner; cleanup can only unlink that owner's key. */
export const lock = (stateDir: string) =>
  Effect.acquireRelease(
    io("Another dev command is starting or stopping this repo. Retry shortly.", async () => {
      const slot = await safePath(stateDir, "lock");
      const owner = { pid: process.pid, birth: await birth(process.pid), nonce: randomUUID() };
      if (!owner.birth) throw new Error("Could not identify this process.");
      const staging = await safePath(stateDir, `lock-${owner.nonce}`);
      await fs.mkdir(staging, { mode: 0o700 });
      try {
        await fs.writeFile(path.join(staging, `${owner.nonce}.json`), JSON.stringify(owner), {
          flag: "wx",
          mode: 0o600
        });
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            await fs.rename(staging, slot);
            return { slot, nonce: owner.nonce };
          } catch (error) {
            if (!occupied(error)) throw error;
            const names = await fs.readdir(slot);
            if (names.length > 1) throw error;
            const name = names[0];
            if (!name) continue;
            const file = await safePath(slot, name);
            let previous: typeof Owner.Type;
            try {
              previous = decodeOwner(await fs.readFile(file, "utf8"));
            } catch (readError) {
              if (missing(readError)) continue;
              throw readError;
            }
            if (name !== `${previous.nonce}.json` || (await sameProcess(previous))) throw error;
            await fs.rm(file, { force: true });
            await fs.rmdir(slot).catch((cause: unknown) => {
              if (!missing(cause) && !occupied(cause)) throw cause;
            });
          }
        }
        throw new Error("Dev state is busy.");
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    }),
    ({ slot, nonce }) =>
      Effect.promise(async () => {
        await fs.rm(path.join(slot, `${nonce}.json`), { force: true });
        await fs.rmdir(slot).catch((cause: unknown) => {
          if (!missing(cause) && !occupied(cause)) throw cause;
        });
      })
  );

export const logPath = (stateDir: string) => path.join(stateDir, "dev.log");
