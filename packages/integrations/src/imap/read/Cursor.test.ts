import { assert, describe, it } from "@effect/vitest";
import { NodeCryptography } from "@patchy/core";
import * as Effect from "effect/Effect";
import * as Cursor from "./Cursor.js";

const call: Cursor.Call = {
  connection: "con_invoices",
  operation: "imap.searchMessages",
  folder: "INBOX",
  filters: { from: "billing@example.com" }
};
const progress: Cursor.Progress = {
  uidValidity: 7,
  bound: 900,
  position: 400,
  window: 2048,
  seeking: false
};
const tag = <R>(effect: Effect.Effect<unknown, { readonly _tag: string }, R>) =>
  Effect.map(Effect.flip(effect), (error) => error._tag);
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("cursors", () => {
  it.effect("carry a call's progress back to the same call", () =>
    Effect.gen(function* () {
      const cursor = yield* Cursor.writeCursor(call, progress);
      assert.match(cursor, /^[A-Za-z0-9_-]+$/);
      assert.notInclude(Buffer.from(cursor, "base64url").toString(), "billing");
      assert.deepStrictEqual(yield* Cursor.readCursor(cursor, call, 7), progress);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("refuse a cursor from another call", () =>
    Effect.gen(function* () {
      const cursor = yield* Cursor.writeCursor(call, progress);
      for (const other of [
        { ...call, connection: "con_other" },
        { ...call, operation: "imap.listMessages" as const },
        { ...call, folder: "Archive" },
        { ...call, filters: { from: "someone@example.com" } }
      ])
        assert.strictEqual(yield* tag(Cursor.readCursor(cursor, other, 7)), "ImapInvalidCursor");
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("fail mailbox_reset under another UIDVALIDITY", () =>
    Effect.gen(function* () {
      const cursor = yield* Cursor.writeCursor(call, progress);
      const error = yield* Effect.flip(Cursor.readCursor(cursor, call, 8));
      assert.strictEqual(error._tag, "ImapMailboxReset");
      assert.strictEqual(error.code, "mailbox_reset");
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("refuse anything that isn't a cursor this module made", () =>
    Effect.gen(function* () {
      const cursor = yield* Cursor.writeCursor(call, progress);
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<
        string,
        unknown
      >;
      for (const forged of [
        "",
        "not a cursor!",
        "x".repeat(2000),
        base64url("[]"),
        base64url({ ...decoded, v: 2 }),
        base64url({ ...decoded, position: 902 }),
        base64url({ ...decoded, window: 1 }),
        base64url({ ...decoded, bound: 4_294_967_296 }),
        base64url({ ...decoded, extra: true })
      ])
        assert.strictEqual(
          yield* tag(Cursor.readCursor(forged, call, 7)),
          "ImapInvalidCursor",
          forged
        );
    }).pipe(Effect.provide(NodeCryptography.layer))
  );
});

describe("checkpoints", () => {
  const target: Cursor.Target = { connection: "con_invoices", folder: "INBOX" };

  it.effect("carry the UID covered to a later scan of the folder", () =>
    Effect.gen(function* () {
      const checkpoint = yield* Cursor.writeCheckpoint(target, 7, 812);
      assert.strictEqual(yield* Cursor.readCheckpoint(checkpoint, target, 7), 812);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("refuse another connection or folder, and fail mailbox_reset after a reset", () =>
    Effect.gen(function* () {
      const checkpoint = yield* Cursor.writeCheckpoint(target, 7, 812);
      assert.strictEqual(
        yield* tag(Cursor.readCheckpoint(checkpoint, { ...target, folder: "Archive" }, 7)),
        "ImapInvalidCheckpoint"
      );
      assert.strictEqual(
        yield* tag(Cursor.readCheckpoint(checkpoint, { ...target, connection: "con_x" }, 7)),
        "ImapInvalidCheckpoint"
      );
      assert.strictEqual(
        yield* tag(Cursor.readCheckpoint(checkpoint, target, 9)),
        "ImapMailboxReset"
      );
      const cursor = yield* Cursor.writeCursor(
        { ...target, operation: "imap.scanMessages", filters: null },
        progress
      );
      assert.strictEqual(
        yield* tag(Cursor.readCheckpoint(cursor, target, 7)),
        "ImapInvalidCheckpoint"
      );
    }).pipe(Effect.provide(NodeCryptography.layer))
  );
});
