import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { RESULT_BYTES, ROW_BYTES } from "./Bounds.js";
import { refKey, type MessageRef } from "./Refs.js";
import type { Message } from "./Message.js";
import { answerGetMessages, planGetMessages, type Outcome } from "./Results.js";

const ref = (uid: number, folder = "INBOX", uidValidity = 7): MessageRef => ({
  connection: "con_invoices",
  folder,
  uidValidity,
  uid
});
const message = (uid: number, text = "hello"): Message => ({
  ref: ref(uid),
  from: [],
  to: [],
  cc: [],
  recipientsTruncated: false,
  subject: null,
  date: null,
  internalDate: null,
  size: text.length,
  flags: [],
  messageId: null,
  inReplyTo: null,
  references: [],
  hasAttachments: false,
  replyTo: [],
  text,
  truncated: false,
  parts: [],
  encrypted: null
});
const failureTag = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure._tag : "ok";

describe("planGetMessages", () => {
  it("groups refs by folder in the order asked, each UID once", () => {
    const plan = planGetMessages(
      [ref(9), ref(3, "Archive", 12), ref(4), ref(9), ref(1, "Archive", 12)],
      "con_invoices"
    );
    assert.deepStrictEqual(Result.getOrThrow(plan), [
      { folder: "INBOX", uidValidity: 7, uids: [4, 9] },
      { folder: "Archive", uidValidity: 12, uids: [1, 3] }
    ]);
  });

  it("refuses before upstream: too many refs, another connection, two UIDVALIDITY values", () => {
    const many = Array.from({ length: 26 }, (_, index) => ref(index + 1));
    assert.strictEqual(failureTag(planGetMessages(many, "con_invoices")), "InvalidRequest");
    assert.strictEqual(failureTag(planGetMessages(many.slice(0, 25), "con_invoices")), "ok");
    assert.strictEqual(
      failureTag(planGetMessages([ref(1), { ...ref(2), connection: "con_other" }], "con_invoices")),
      "ImapForeignRef"
    );
    const reset = planGetMessages([ref(1), ref(2, "INBOX", 8)], "con_invoices");
    assert.strictEqual(failureTag(reset), "ImapMailboxReset");
  });
});

describe("answerGetMessages", () => {
  it("answers each ref in the order asked, a missing one not_found", () => {
    const refs = [ref(3), ref(1), ref(2), ref(3)];
    const found = new Map<string, Outcome>([
      [refKey(ref(1)), message(1)],
      [refKey(ref(3)), message(3)],
      [refKey(ref(2)), { error: "malformed" }]
    ]);
    assert.deepStrictEqual(Result.getOrThrow(answerGetMessages(refs, found)), [
      message(3),
      message(1),
      { error: "malformed" },
      message(3)
    ]);
    assert.deepStrictEqual(Result.getOrThrow(answerGetMessages([ref(5)], found)), [
      { error: "not_found" }
    ]);
  });

  it("answers too_large for a message past one row, keeping the rest", () => {
    const big = message(2, "x".repeat(ROW_BYTES));
    const found = new Map<string, Outcome>([
      [refKey(ref(1)), message(1)],
      [refKey(ref(2)), big]
    ]);
    assert.deepStrictEqual(Result.getOrThrow(answerGetMessages([ref(1), ref(2)], found)), [
      message(1),
      { error: "too_large" }
    ]);
  });

  it("refuses the call past the result bound, dropping nothing", () => {
    // Nine messages that each fit a row are more than the result bound together.
    const text = "x".repeat(ROW_BYTES - 1000);
    const refs = Array.from({ length: 9 }, (_, index) => ref(index + 1));
    const found = new Map<string, Outcome>(
      refs.map((each) => [refKey(each), message(each.uid, text)])
    );
    const result = answerGetMessages(refs, found);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.strictEqual(result.failure.code, "too_large");
      assert.strictEqual(result.failure.refs, 9);
      assert.isAbove(result.failure.bytes, RESULT_BYTES);
      assert.include(result.failure.message, "Ask for fewer refs");
    }
    assert.isTrue(Result.isSuccess(answerGetMessages(refs.slice(0, 8), found)));
  });
});
