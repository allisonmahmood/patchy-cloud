// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off -- private on-disk records and Linux process identity belong to the local provider, not the supervisor protocol.
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Management from "@patchy/api/management";
import * as Schema from "effect/Schema";

export const Request = Schema.Struct({
  taskId: Schema.String,
  deploymentRevision: Schema.String,
  callbackUrls: Schema.Array(Schema.String),
  secret: Schema.String,
  path: Schema.String,
  startupTimeout: Schema.Number,
  cleanupTimeout: Schema.Number,
  startedAt: Schema.Number
});
export type Request = typeof Request.Type;
const Process = Schema.Struct({ pid: Schema.Number, identity: Schema.String });
export type Process = typeof Process.Type;
export const Record = Schema.Struct({
  task: Schema.Struct({
    taskId: Schema.String,
    deploymentRevision: Schema.String,
    state: Schema.Literals(["running", "stopped"]),
    startedAt: Schema.Number,
    readyAt: Schema.Number,
    stoppedAt: Schema.NullOr(Schema.Number)
  }),
  owner: Process,
  child: Schema.NullOr(Process),
  url: Schema.NullOr(Schema.String),
  bindingEpoch: Schema.Number,
  finalStats: Schema.optionalKey(Management.StatsReply)
});
export type Record = typeof Record.Type;
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(Request));
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(Record));
export const Ready = Schema.Struct({ url: Schema.String });
export const Final = Schema.Struct({
  bindingEpoch: Schema.Number,
  finalStats: Management.StatsReply
});

export const missing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
/** A process can exit after procfs opens its stat file but before the read, or before a signal lands. */
export const missingProcess = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "ESRCH");
export const taskDirectory = (directory: string, taskId: string) =>
  join(directory, createHash("sha256").update(taskId).digest("hex"));

export async function readRequest(directory: string): Promise<Request | undefined> {
  try {
    return decodeRequest(await readFile(join(directory, "request.json"), "utf8"));
  } catch (cause) {
    if (missing(cause)) return undefined;
    throw cause;
  }
}
export async function readRecord(directory: string): Promise<Record | undefined> {
  try {
    return decodeRecord(await readFile(join(directory, "record.json"), "utf8"));
  } catch (cause) {
    if (missing(cause)) return undefined;
    throw cause;
  }
}
export async function writeRecord(directory: string, record: Record): Promise<void> {
  const temporary = join(directory, `record-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, join(directory, "record.json"));
}

/** link is the identity commit. A cancelled or competing start cannot replace this request. */
export async function createRequest(directory: string, request: Request): Promise<Request> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `request-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(request), { mode: 0o600 });
  try {
    await link(temporary, join(directory, "request.json"));
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
  } finally {
    await rm(temporary, { force: true });
  }
  return (await readRequest(directory))!;
}

/** A PID alone is not evidence: it can refer to a different process after a restart. */
export async function processIdentity(pid: number): Promise<Process | null> {
  try {
    const [stat, boot] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ]);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return null;
    return { pid, identity: `${boot.trim()}:${fields[19]}` };
  } catch (cause) {
    if (missingProcess(cause)) return null;
    throw cause;
  }
}
export async function alive(process: Process): Promise<boolean> {
  return (await processIdentity(process.pid))?.identity === process.identity;
}

/** Reaping the supervisor alone is not enough when a workerd child outlives a crashed supervisor. */
export async function groupMembers(group: Process): Promise<readonly Process[]> {
  const leader = await processIdentity(group.pid);
  if (leader !== null && leader.identity !== group.identity) return [];
  const members: Process[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (
        fields[0] === "Z" ||
        fields[0] === "X" ||
        Number(fields[2]) !== group.pid ||
        Number(fields[3]) !== group.pid
      )
        continue;
      const identity = await processIdentity(Number(entry));
      if (identity !== null) members.push(identity);
    } catch (cause) {
      if (!missingProcess(cause)) throw cause;
    }
  }
  return members;
}
