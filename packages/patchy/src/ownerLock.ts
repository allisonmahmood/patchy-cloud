// @effect-diagnostics nodeBuiltinImport:off -- Lock ownership needs process birth time and atomic directory renames.
// oxlint-disable-next-line no-restricted-imports -- Promise code on the lock's process boundary, outside Effect.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import * as Schema from "effect/Schema";

// A process that cannot read its own birth (Windows has no procfs or ps) records none.
const Owner = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  birth: Schema.optionalKey(Schema.String),
  nonce: Schema.String
});
const decodeOwner = Schema.decodeUnknownSync(Schema.fromJsonString(Owner));
const execute = promisify(execFile);
const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));
const missingProcess = Schema.is(Schema.Struct({ code: Schema.Literals(["ENOENT", "ESRCH"]) }));
const noSuchProcess = Schema.is(
  Schema.Struct({ code: Schema.Literal(1), stdout: Schema.Literal(""), stderr: Schema.Literal("") })
);
const occupied = Schema.is(Schema.Struct({ code: Schema.Literals(["EEXIST", "ENOTEMPTY"]) }));
// Windows refuses a rename onto an existing directory with EPERM.
const taken = Schema.is(Schema.Struct({ code: Schema.Literals(["EEXIST", "ENOTEMPTY", "EPERM"]) }));

/**
 * A PID alone is never authority to signal a process or reclaim its lock. Undefined means the
 * process is gone; a throw means its identity cannot be read, which never counts as gone.
 */
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
    const stamp = result.stdout.trim();
    if (!stamp) throw new Error(`ps printed no identity for ${pid}: ${result.stderr.trim()}`);
    return stamp;
  } catch (error) {
    // Only a silent exit 1 means no such process; a diagnostic or any other failure cannot tell.
    if (noSuchProcess(error)) return undefined;
    throw error;
  }
}

export const sameProcess = async (record: { readonly pid: number; readonly birth: string }) =>
  (await birth(record.pid)) === record.birth;

/**
 * Claim the directory `slot` (already resolved with `safePath`) for this process, recording
 * `ownBirth`. The owner file is staged in a hidden sibling and renamed onto the slot, so a held
 * slot always names one complete owner. A held slot is reclaimed only when its owner is proven
 * gone; one whose owner cannot be identified (empty, malformed, recorded without a birth, or
 * unreadable now) is never reclaimed. Returns the nonce `release` needs, or who holds the slot.
 */
export async function claim(
  slot: string,
  ownBirth: string | undefined
): Promise<{ readonly nonce: string } | { readonly holder: "live" | "unknown" }> {
  const nonce = randomUUID();
  const owner = { pid: process.pid, birth: ownBirth, nonce };
  const staging = path.join(path.dirname(slot), `.${path.basename(slot)}-${nonce}`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(staging, `${nonce}.json`), JSON.stringify(owner), {
      flag: "wx",
      mode: 0o600
    });
    let rechecked = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      let names: string[];
      try {
        names = await fs.readdir(slot);
      } catch (error) {
        if (!missing(error)) throw error;
        // A rename replaces an empty directory, so only an absent slot is renamed onto; an older
        // CLI's bare mkdir landing between the readdir and the rename goes unseen.
        try {
          await fs.rename(staging, slot);
          return { nonce };
        } catch (renameError) {
          if (!taken(renameError)) throw renameError;
          continue;
        }
      }
      const name = names[0];
      if (!name) {
        // Releasing and reclaiming empty a slot only for a moment; an older CLI holds it empty.
        if (rechecked) return { holder: "unknown" };
        rechecked = true;
        await setTimeout(200);
        continue;
      }
      if (names.length > 1) return { holder: "unknown" };
      const file = path.join(slot, name);
      let previous: typeof Owner.Type;
      try {
        previous = decodeOwner(await fs.readFile(file, "utf8"));
      } catch (error) {
        if (missing(error)) continue;
        return { holder: "unknown" };
      }
      if (name !== `${previous.nonce}.json` || previous.birth === undefined)
        return { holder: "unknown" };
      let alive: boolean;
      try {
        alive = await sameProcess({ pid: previous.pid, birth: previous.birth });
      } catch {
        return { holder: "unknown" };
      }
      if (alive) return { holder: "live" };
      await fs.rm(file, { force: true });
      await fs.rmdir(slot).catch((cause: unknown) => {
        if (!missing(cause) && !occupied(cause)) throw cause;
      });
    }
    return { holder: "live" };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Remove only this claim's owner file, so a replacement owner's claim survives. */
export async function release(slot: string, nonce: string): Promise<void> {
  await fs.rm(path.join(slot, `${nonce}.json`), { force: true });
  await fs.rmdir(slot).catch((cause: unknown) => {
    if (!missing(cause) && !occupied(cause)) throw cause;
  });
}
