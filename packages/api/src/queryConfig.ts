import { registry } from "@patchy/limits/registry";

/** Browser-safe query policy; the limits registry is the release contract. */
export const queryRemountGraceMs = registry["stream.remount.grace"].default;
