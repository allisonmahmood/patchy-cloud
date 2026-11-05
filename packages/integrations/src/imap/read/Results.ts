/**
 * `getMessages` around its fetches: the refs checked and grouped by folder before anything goes
 * upstream, then one answer per ref in the order asked, held to the row and result bounds.
 */
import { Runtime } from "@patchy/runtime/core";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { GET_REFS, RESULT_BYTES, ROW_BYTES } from "./Bounds.js";
import { ForeignRef, MailboxReset, ResultTooLarge } from "./Errors.js";
import { refKey, type MessageRef } from "./Refs.js";

/** One folder a call reads: the UIDVALIDITY its refs were made under and their UIDs, ascending. */
export interface FolderRead {
  readonly folder: string;
  readonly uidValidity: number;
  readonly uids: ReadonlyArray<number>;
}

/**
 * The folders `refs` name, in the order they first appear, for a call on `connection`. Refused
 * before upstream: more than `GET_REFS` refs, a ref from another connection, and refs to one folder
 * under two UIDVALIDITY values, one of which must be stale (`mailbox_reset`). Each folder's
 * UIDVALIDITY is checked again against its `EXAMINE`.
 */
export const planGetMessages = (
  refs: ReadonlyArray<MessageRef>,
  connection: string
): Result.Result<ReadonlyArray<FolderRead>, Runtime.InvalidRequest | ForeignRef | MailboxReset> => {
  if (refs.length > GET_REFS) return Result.fail(new Runtime.InvalidRequest({}));
  const folders = new Map<string, { uidValidity: number; uids: Set<number> }>();
  for (const ref of refs) {
    if (ref.connection !== connection) return Result.fail(new ForeignRef({}));
    const read = folders.get(ref.folder);
    if (read === undefined)
      folders.set(ref.folder, { uidValidity: ref.uidValidity, uids: new Set([ref.uid]) });
    else if (read.uidValidity !== ref.uidValidity)
      return Result.fail(new MailboxReset({ folder: ref.folder }));
    else read.uids.add(ref.uid);
  }
  return Result.succeed(
    [...folders].map(([folder, read]) => ({
      folder,
      uidValidity: read.uidValidity,
      uids: [...read.uids].sort((a, b) => a - b)
    }))
  );
};

/** A ref that didn't read as a message. */
export type Unread = { readonly error: "not_found" | "malformed" | "too_large" };
export type Outcome<M> = M | Unread;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const bytes = (value: Schema.Json) => Buffer.byteLength(encodeJson(value), "utf8");
const isUnread = (outcome: Outcome<Schema.Json>): outcome is Unread =>
  typeof outcome === "object" &&
  outcome !== null &&
  !Array.isArray(outcome) &&
  Object.keys(outcome).length === 1 &&
  "error" in outcome;

/**
 * One answer per ref, in `refs`' order, from what the fetches found by `refKey`. A ref found
 * nothing for is `not_found`; a message over `ROW_BYTES` encoded is `too_large`, so each one fits
 * a patch's row. Past `RESULT_BYTES` in all, the call is refused with nothing dropped.
 */
export const answerGetMessages = <M extends Schema.Json>(
  refs: ReadonlyArray<MessageRef>,
  found: ReadonlyMap<string, Outcome<M>>
): Result.Result<ReadonlyArray<Outcome<M>>, ResultTooLarge> => {
  const answers: Outcome<M>[] = [];
  // The brackets, and a comma between answers.
  let total = 2 + Math.max(0, refs.length - 1);
  for (const ref of refs) {
    let outcome: Outcome<M> = found.get(refKey(ref)) ?? { error: "not_found" };
    let size = bytes(outcome);
    if (!isUnread(outcome) && size > ROW_BYTES) {
      outcome = { error: "too_large" };
      size = bytes(outcome);
    }
    answers.push(outcome);
    total += size;
  }
  return total > RESULT_BYTES
    ? Result.fail(new ResultTooLarge({ refs: refs.length, bytes: total }))
    : Result.succeed(answers);
};
