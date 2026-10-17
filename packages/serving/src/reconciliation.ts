// @effect-diagnostics globalTimers:off
// The shell's document stream owns this browser timer without an Effect runtime.
import { registry } from "@patchy/limits/registry";

/**
 * Where a connected document stream's desired set stands: the server has not admitted its
 * latest sequence, it has but some subscriptions are unanswered, or every one is answered.
 */
export type ReconciliationState = "unadmitted" | "unanswered" | "reconciled";

/**
 * The timer that re-sends a document stream's whole desired set when reconciliation stalls.
 * The stream reports its state with `update` after every change, calls `stop` when it
 * disconnects, suspends or closes, and re-sends the set from `replace` when the timer fires.
 *
 * An unadmitted set is repaired fast, after 1 s, 2 s, 4 s and so on up to the reconcile
 * interval: it is what a lost POST or a lost admitted frame leaves behind. Missing answers are
 * the slow path and wait for the full interval. Once the server has admitted the set, its
 * unanswered subscriptions are queued or running, and a load of several slow queries takes
 * seconds; a replace then only makes the server run them again. A lost stream, a drained host
 * or a replaced document recovers through EOF and a new hello instead.
 */
export function createReconciliation(replace: () => void) {
  const interval = registry["subscriptions.reconcile.interval"].default;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fast = false;
  // Fast replaces since the server last caught up; each one doubles the next delay.
  let attempts = 0;
  const arm = (delay: number) => {
    timer = setTimeout(() => {
      timer = undefined;
      replace();
    }, delay);
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    attempts = 0;
  };
  return {
    update(state: ReconciliationState) {
      if (state === "reconciled") stop();
      else if (state === "unanswered") {
        // Admission cancels a fast timer; a pending slow timer keeps its deadline.
        if (timer !== undefined && !fast) return;
        stop();
        fast = false;
        arm(interval);
      } else {
        // A new unadmitted delta shortens a pending slow timer.
        if (timer !== undefined && fast) return;
        clearTimeout(timer);
        fast = true;
        arm(Math.min(interval, 1_000 * 2 ** Math.min(attempts++, 5)));
      }
    },
    stop
  };
}
