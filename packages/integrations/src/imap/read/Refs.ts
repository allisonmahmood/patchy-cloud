/**
 * How IMAP reads name messages and UID ranges. The ref itself is the wire's `ImapMessageRef`; its
 * `connection` is the declaration's connection id, stable across password changes and new when
 * a connection is deleted and recreated.
 */
import { IMAP_MAX_UID, type ImapMessageRef } from "@patchy/api";
import { canonicalArgs } from "@patchy/api/canonical-args";

/** IMAP's nz-number: UIDs and UIDVALIDITY are unsigned 32-bit and never 0. */
export const MAX_UID = IMAP_MAX_UID;
export type MessageRef = ImapMessageRef;

/** A ref as a map key: equal refs, equal keys. */
export const refKey = (ref: MessageRef): string =>
  canonicalArgs([ref.connection, ref.folder, ref.uidValidity, ref.uid]);

/**
 * A closed UID range, `low` through `high`. Made only by `uidRange`, so every range a planner asks
 * for is explicit and non-empty: IMAP's `n:*` matches the highest UID even when it is below `n`.
 */
export interface UidRange {
  readonly low: number;
  readonly high: number;
}

/** The range `low` through `high`, or `undefined` when it holds no UID. */
export const uidRange = (low: number, high: number): UidRange | undefined => {
  const from = Math.max(1, low);
  const to = Math.min(MAX_UID, high);
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from <= to
    ? { low: from, high: to }
    : undefined;
};

/** The range as an IMAP sequence set, such as `120:239`. Never `*`. */
export const sequenceSet = (range: UidRange): string =>
  range.low === range.high ? `${range.low}` : `${range.low}:${range.high}`;

/**
 * UIDs as one IMAP sequence set for `UID FETCH`, in ascending runs such as `3:5,9`. Never `*`;
 * `undefined` when there is no valid UID to name.
 */
export const uidSet = (uids: ReadonlyArray<number>): string | undefined => {
  const sorted = [...new Set(uids)]
    .filter((uid) => Number.isInteger(uid) && uid >= 1 && uid <= MAX_UID)
    .sort((a, b) => a - b);
  const runs: string[] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end += 1;
    runs.push(sequenceSet({ low: sorted[start]!, high: sorted[end]! }));
    start = end + 1;
  }
  return runs.length === 0 ? undefined : runs.join(",");
};
