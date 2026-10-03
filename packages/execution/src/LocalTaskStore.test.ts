// @effect-diagnostics nodeBuiltinImport:off -- Real processes and procfs reproduce the kernel's exit race.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import type * as Fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as Store from "./localTaskStore.js";

// A process reaped after procfs opens its stat file fails the read with ESRCH, not ENOENT.
// The store has no layer to swap, so this mock only times a real reap; the kernel raises the error.
const reapMidRead = vi.hoisted(() => new Map<string, ChildProcess>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const [path, options] = args;
      if (typeof path !== "string") return fs.readFile(...args);
      const child = reapMidRead.get(path);
      if (child === undefined) return fs.readFile(...args);
      reapMidRead.delete(path);
      const handle = await fs.open(path);
      try {
        child.kill("SIGKILL");
        await once(child, "exit");
        return await handle.readFile(options);
      } finally {
        await handle.close();
      }
    }
  };
});

const children: ChildProcess[] = [];
const sleeper = (detached = false) => {
  const child = spawn("sleep", ["60"], { detached, stdio: "ignore" });
  children.push(child);
  return child;
};
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

it.skipIf(process.platform !== "linux")(
  "reads a process reaped between open and read as gone",
  async () => {
    const child = sleeper();
    reapMidRead.set(`/proc/${child.pid}/stat`, child);
    expect(await Store.processIdentity(child.pid!)).toBeNull();
    expect(reapMidRead.size).toBe(0);
  }
);

it.skipIf(process.platform !== "linux")(
  "skips a bystander reaped while scanning a group",
  async () => {
    const leader = sleeper(true);
    const group = (await Store.processIdentity(leader.pid!))!;
    const bystander = sleeper();
    reapMidRead.set(`/proc/${bystander.pid}/stat`, bystander);
    expect(await Store.groupMembers(group)).toEqual([group]);
    expect(reapMidRead.size).toBe(0);
  }
);
