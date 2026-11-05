/**
 * Page cursors and scan checkpoints, as Attio's cursors are made: versioned JSON in base64url,
 * carrying a SHA-256 binding of the call so one from another call is refused. They are stateless
 * and unsealed: a forged one can only name UIDs of a folder the caller can already read, and every
 * field is checked before it is used.
 *
 * - A cursor carries one call's progress: its UIDVALIDITY, the upper bound its first page fixed,
 *   the position reached and the next window's width. It lasts as long as the call pages.
 * - A checkpoint is the durable mark a scan answers on every page: the highest UID covered, under
 *   the folder's UIDVALIDITY. A patch stores it after the rows it covers, and a later scan resumes
 *   after it with a fresh bound. Patches keep checkpoints in their tables, so their encoding must
 *   stay readable across releases: add a version, never change version 1.
 */
import { canonicalArgs } from "@patchy/api/canonical-args";
import { Cryptography } from "@patchy/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WINDOW_MAX_UIDS, WINDOW_UIDS } from "./Bounds.js";
import { InvalidCheckpoint, InvalidCursor, MailboxReset } from "./Errors.js";
import { MAX_UID, UidValidity } from "./Refs.js";

export type Operation = "imap.scanMessages" | "imap.listMessages" | "imap.searchMessages";

/** The folder a call reads, on its connection. */
export interface Target {
  readonly connection: string;
  readonly folder: string;
}

/** The call a cursor pages through. A cursor made for any other is refused. */
export interface Call extends Target {
  readonly operation: Operation;
  /** The call's other arguments, normalized: a scan's `since` and `after`, a search's filters. */
  readonly filters: Schema.Json;
}

const Count = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }));

/** Where a call's pages have reached. */
const Progress = Schema.Struct({
  uidValidity: UidValidity,
  /** The highest UID the call reads, fixed by its first page so it never chases new mail. */
  bound: Count(MAX_UID),
  /** Ascending, the highest UID covered; newest first, the lowest. */
  position: Count(MAX_UID + 1),
  /** The width of the next UID window. */
  window: Schema.Int.check(Schema.isBetween({ minimum: WINDOW_UIDS, maximum: WINDOW_MAX_UIDS })),
  /** A scan from `since`, on a server without ESEARCH, still walking up to its first match. */
  seeking: Schema.Boolean
});
export type Progress = typeof Progress.Type;

const CursorJson = Schema.fromJsonString(
  Schema.Struct({ v: Schema.Literal(1), binding: Schema.String, ...Progress.fields })
);
const CheckpointJson = Schema.fromJsonString(
  Schema.Struct({
    v: Schema.Literal(1),
    binding: Schema.String,
    uidValidity: UidValidity,
    uid: Count(MAX_UID)
  })
);
const encodeCursor = Schema.encodeSync(CursorJson);
const decodeCursor = Schema.decodeUnknownEffect(CursorJson, { onExcessProperty: "error" });
const encodeCheckpoint = Schema.encodeSync(CheckpointJson);
const decodeCheckpoint = Schema.decodeUnknownEffect(CheckpointJson, { onExcessProperty: "error" });

/** Longer than any cursor or checkpoint this module makes. */
const MAX_LENGTH = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const base64url = (json: string) => Buffer.from(json, "utf8").toString("base64url");
const json = (value: string) =>
  value.length <= MAX_LENGTH && BASE64URL.test(value)
    ? Buffer.from(value, "base64url").toString("utf8")
    : undefined;

const binding = Effect.fnUntraced(function* (parts: Schema.Json) {
  const cryptography = yield* Cryptography.Cryptography;
  return yield* cryptography.sha256(canonicalArgs(parts));
});
const callBinding = (call: Call) =>
  binding(["cursor", 1, call.connection, call.operation, call.folder, call.filters]);
const targetBinding = (target: Target) =>
  binding(["checkpoint", 1, target.connection, target.folder]);

/** The cursor that continues `call` from `progress`. */
export const writeCursor = Effect.fnUntraced(function* (call: Call, progress: Progress) {
  return base64url(encodeCursor({ v: 1, binding: yield* callBinding(call), ...progress }));
});

/**
 * The progress a cursor carries, when it was made for `call`. One made under another UIDVALIDITY
 * than the folder's now fails `mailbox_reset`.
 */
export const readCursor = Effect.fnUntraced(function* (
  cursor: string,
  call: Call,
  uidValidity: number
) {
  const text = json(cursor);
  if (text === undefined) return yield* new InvalidCursor({});
  const decoded = yield* decodeCursor(text).pipe(Effect.mapError(() => new InvalidCursor({})));
  if (decoded.binding !== (yield* callBinding(call)) || decoded.position > decoded.bound + 1)
    return yield* new InvalidCursor({});
  if (decoded.uidValidity !== uidValidity) return yield* new MailboxReset({ folder: call.folder });
  const progress: Progress = {
    uidValidity: decoded.uidValidity,
    bound: decoded.bound,
    position: decoded.position,
    window: decoded.window,
    seeking: decoded.seeking
  };
  return progress;
});

/** The checkpoint at `uid`: every message of the folder up to it is covered. */
export const writeCheckpoint = Effect.fnUntraced(function* (
  target: Target,
  uidValidity: number,
  uid: number
) {
  return base64url(
    encodeCheckpoint({ v: 1, binding: yield* targetBinding(target), uidValidity, uid })
  );
});

/**
 * The UID a checkpoint covers up to, when it was made for `target`. One made under another
 * UIDVALIDITY than the folder's now fails `mailbox_reset`.
 */
export const readCheckpoint = Effect.fnUntraced(function* (
  checkpoint: string,
  target: Target,
  uidValidity: number
) {
  const text = json(checkpoint);
  if (text === undefined) return yield* new InvalidCheckpoint({});
  const decoded = yield* decodeCheckpoint(text).pipe(
    Effect.mapError(() => new InvalidCheckpoint({}))
  );
  if (decoded.binding !== (yield* targetBinding(target))) return yield* new InvalidCheckpoint({});
  if (decoded.uidValidity !== uidValidity)
    return yield* new MailboxReset({ folder: target.folder });
  return decoded.uid;
});
