/** Pid facts the runner and the supervisor share. */
import * as Effect from "effect/Effect";

/** Signal 0 probes without sending: true while the pid exists and is ours to signal. */
export const alive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

/** Sends `name`; a pid that is already gone is not an error. */
export const signal = (pid: number, name: "SIGTERM"): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone; nothing to stop.
    }
  });
