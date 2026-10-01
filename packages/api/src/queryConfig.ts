import { registry } from "@patchy/limits/registry";

/** Browser-safe handler policy; the limits registry is the release contract. */
export const queryRemountGraceMs = registry["stream.remount.grace"].default;

/** Allow startup admission, the longest handler, settlement, and message delivery. */
export const serverReplyTimeoutMs =
  registry["execution.pool.wait"].default +
  registry["tier2.action.deadline"].default +
  registry["tier2.settlement.cleanup"].default +
  5_000;
