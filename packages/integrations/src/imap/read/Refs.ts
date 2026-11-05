/**
 * The values IMAP reads name messages and folders by. These are local stand-ins: when the reads
 * are wired, `ConnectionId` meets the declaration's `id` from #1251 and the schemas move to the
 * wire in `packages/api`.
 */
import { canonicalArgs } from "@patchy/api/canonical-args";
import * as Schema from "effect/Schema";
import { FOLDER_CHARACTERS } from "./Bounds.js";

/** IMAP's nz-number: UIDs and UIDVALIDITY are unsigned 32-bit and never 0. */
export const MAX_UID = 4_294_967_295;
const NzNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_UID }));

/** A connection's id from its declaration: stable across password changes, new on recreate. */
export const ConnectionId = Schema.String.check(Schema.isBetweenLength(1, 128));
/** A folder's full path, decoded from modified UTF-7, as `listFolders` answers it. */
export const Folder = Schema.String.check(
  Schema.isBetweenLength(1, FOLDER_CHARACTERS),
  Schema.makeFilter((path) => !/[\0\r\n]/.test(path) || "A folder path has no NUL, CR or LF.")
);
export const UidValidity = NzNumber;
export const Uid = NzNumber;

/**
 * One message: its UID within the folder under one UIDVALIDITY. Message-ID is threading metadata,
 * never identity.
 */
export const MessageRef = Schema.Struct({
  connection: ConnectionId,
  folder: Folder,
  uidValidity: UidValidity,
  uid: Uid
});
export type MessageRef = typeof MessageRef.Type;

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
