import { assert, describe, it } from "@effect/vitest";
import { NodeCryptography } from "@patchy/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { WINDOW_MAX_UIDS } from "./Bounds.js";
import * as Cursor from "./Cursor.js";
import {
  listMessages,
  scanMessages,
  searchMessages,
  searchQuery,
  type Criteria,
  type Mailbox,
  type Source
} from "./Plan.js";
import { uidRange } from "./Refs.js";

class Deadline extends Schema.TaggedError<Deadline>()("Deadline", {}) {}

interface Summary {
  readonly uid: number;
}

/**
 * A folder behind the session commands a planner reads through. Every command is logged; each
 * message has an internal date, and `match` stands in for the server's other criteria.
 */
class Folder {
  readonly log: string[] = [];
  readonly days = new Map<number, string>();
  uidValidity = 7;
  uidNext: number;
  esearch = true;
  match: (uid: number, criteria: Criteria) => boolean = () => true;
  /** Runs before each fetch, as mail expunged or delivered between commands. */
  beforeFetch: () => void = () => {};
  /** Time each search takes, to spend a call's time budget. */
  searchMillis = 0;
  failSearch = false;

  constructor(uids: Iterable<number>, day: (uid: number) => string = () => "2026-01-01") {
    for (const uid of uids) this.days.set(uid, day(uid));
    this.uidNext = Math.max(0, ...this.days.keys()) + 1;
  }

  get mailbox(): Mailbox {
    return { uidValidity: this.uidValidity, uidNext: this.uidNext, messages: this.days.size };
  }
  deliver(uids: Iterable<number>, day = "2026-06-01") {
    for (const uid of uids) this.days.set(uid, day);
    this.uidNext = Math.max(this.uidNext, ...this.days.keys()) + 1;
  }
  /** The searches' UID windows, as IMAP sequence sets. */
  windows(): string[] {
    return this.log.filter((line) => line.startsWith("search ")).map((line) => line.split(" ")[1]!);
  }

  matching(low: number, high: number, criteria: Criteria) {
    return [...this.days]
      .filter(
        ([uid, day]) =>
          uid >= low &&
          uid <= high &&
          (criteria.since === undefined || day >= criteria.since) &&
          (criteria.before === undefined || day < criteria.before) &&
          this.match(uid, criteria)
      )
      .map(([uid]) => uid);
  }

  get source(): Source<Summary, Deadline, never> {
    return {
      esearch: this.esearch,
      search: (range, criteria) =>
        Effect.gen({ self: this }, function* () {
          const { uid, ...rest } = searchQuery(range, criteria);
          this.log.push(`search ${uid} ${JSON.stringify(rest)}`);
          if (this.searchMillis > 0) yield* TestClock.adjust(this.searchMillis);
          if (this.failSearch) return yield* new Deadline({});
          return this.matching(range.low, range.high, criteria).reverse();
        }),
      searchMin: (range, criteria) =>
        Effect.sync(() => {
          this.log.push(`min ${searchQuery(range, criteria).uid} ${JSON.stringify(criteria)}`);
          const found = this.matching(range.low, range.high, criteria);
          return found.length === 0 ? undefined : Math.min(...found);
        }),
      uidAt: (sequence) =>
        Effect.sync(() => {
          this.log.push(`uidAt ${sequence}`);
          return [...this.days.keys()].sort((a, b) => a - b)[sequence - 1];
        }),
      fetch: (uids) =>
        Effect.sync(() => {
          this.log.push(`fetch ${uids.length}`);
          this.beforeFetch();
          return uids.filter((uid) => this.days.has(uid)).map((uid) => ({ uid }));
        })
    };
  }

  withoutEsearch() {
    this.esearch = false;
    return this;
  }
}

const target = { connection: "con_invoices", folder: "INBOX" };
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const uids = (page: { readonly messages: ReadonlyArray<Summary> }) =>
  page.messages.map((m) => m.uid);
const checkpointUid = (folder: Folder, checkpoint: string) =>
  Cursor.readCheckpoint(checkpoint, target, folder.uidValidity);

/** Every page of a scan, following its cursor. */
const scanAll = (folder: Folder, args: { readonly since?: string; readonly after?: string } = {}) =>
  Effect.gen(function* () {
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = yield* scanMessages({
        ...target,
        ...args,
        ...(cursor === undefined ? {} : { cursor }),
        mailbox: folder.mailbox,
        source: folder.source
      });
      pages.push(page);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined && pages.length < 200);
    return pages;
  });

/** No window is `n:*`, runs backwards or is wider than the bound. */
const assertBoundedWindows = (folder: Folder) => {
  for (const window of folder.windows()) {
    assert.notInclude(window, "*");
    const [low, high = low] = window.split(":").map(Number) as [number, number?];
    assert.isAtMost(low, high, window);
    assert.isAtMost(high - low + 1, WINDOW_MAX_UIDS, window);
  }
};

describe("scanMessages", () => {
  it.effect("reads an empty folder with no command at all", () =>
    Effect.gen(function* () {
      const fresh = new Folder([]);
      const [page] = yield* scanAll(fresh);
      assert.deepStrictEqual(
        { ...page!, checkpoint: undefined },
        {
          messages: [],
          cursor: null,
          checkpoint: undefined,
          done: true
        }
      );
      assert.strictEqual(yield* checkpointUid(fresh, page!.checkpoint), 0);
      assert.deepStrictEqual(fresh.log, []);

      const emptied = new Folder([]);
      emptied.uidNext = 500;
      const [after] = yield* scanAll(emptied);
      assert.strictEqual(yield* checkpointUid(emptied, after!.checkpoint), 499);
      assert.deepStrictEqual(emptied.log, []);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("imports oldest first in pages, the checkpoint following each page", () =>
    Effect.gen(function* () {
      const folder = new Folder(range(1, 250));
      const pages = yield* scanAll(folder);
      assert.deepStrictEqual(pages.map(uids), [range(1, 100), range(101, 200), range(201, 250)]);
      assert.deepStrictEqual(
        pages.map((page) => page.done),
        [false, false, true]
      );
      assert.isNull(pages[2]!.cursor);
      const checkpoints = [];
      for (const page of pages) checkpoints.push(yield* checkpointUid(folder, page.checkpoint));
      assert.deepStrictEqual(checkpoints, [100, 200, 250]);
      assertBoundedWindows(folder);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect(
    "never chases mail that arrives mid-scan; the next scan from the checkpoint reads it",
    () =>
      Effect.gen(function* () {
        const folder = new Folder(range(1, 150));
        const first = yield* scanMessages({
          ...target,
          mailbox: folder.mailbox,
          source: folder.source
        });
        folder.deliver(range(151, 160));
        const second = yield* scanMessages({
          ...target,
          cursor: first.cursor!,
          mailbox: folder.mailbox,
          source: folder.source
        });
        assert.deepStrictEqual(uids(second), range(101, 150));
        assert.isTrue(second.done);
        assertBoundedWindows(folder);

        const later = yield* scanAll(folder, { after: second.checkpoint });
        assert.deepStrictEqual(later.flatMap(uids), range(151, 160));
        assert.strictEqual(yield* checkpointUid(folder, later.at(-1)!.checkpoint), 160);
      }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("sends nothing when no mail is newer than the checkpoint", () =>
    Effect.gen(function* () {
      const folder = new Folder(range(1, 40));
      const [done] = yield* scanAll(folder);
      folder.log.length = 0;
      const [again] = yield* scanAll(folder, { after: done!.checkpoint });
      assert.deepStrictEqual(uids(again!), []);
      assert.isTrue(again!.done);
      assert.strictEqual(yield* checkpointUid(folder, again!.checkpoint), 40);
      assert.deepStrictEqual(folder.log, []);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("crosses UID gaps in few windows, starting at the folder's first message", () =>
    Effect.gen(function* () {
      const folder = new Folder([...range(700_000, 700_009), ...range(900_000, 900_004)]);
      const pages = yield* scanAll(folder);
      assert.deepStrictEqual(pages.flatMap(uids), [
        ...range(700_000, 700_009),
        ...range(900_000, 900_004)
      ]);
      assert.strictEqual(folder.windows()[0], "700000:701023");
      assert.isBelow(folder.windows().length, 20);
      assertBoundedWindows(folder);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("passes over a message expunged mid-scan", () =>
    Effect.gen(function* () {
      const folder = new Folder(range(1, 150));
      folder.beforeFetch = () => {
        folder.days.delete(50);
        folder.beforeFetch = () => {};
      };
      const pages = yield* scanAll(folder);
      assert.deepStrictEqual(
        uids(pages[0]!),
        range(1, 100).filter((uid) => uid !== 50)
      );
      assert.strictEqual(yield* checkpointUid(folder, pages[0]!.checkpoint), 100);
      assert.deepStrictEqual(uids(pages[1]!), range(101, 150));
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  /** 100 old messages, 50 since February, then one that arrived later with an older date. */
  const dated = () =>
    new Folder(range(1, 151), (uid) =>
      uid === 151 ? "2025-12-31" : uid > 100 ? "2026-03-01" : "2026-01-01"
    );

  it.effect("starts since a date with one RETURN (MIN), then reads every later UID", () =>
    Effect.gen(function* () {
      const folder = dated();
      const pages = yield* scanAll(folder, { since: "2026-02-01" });
      assert.deepStrictEqual(pages.flatMap(uids), range(101, 151));
      assert.deepStrictEqual(
        folder.log.filter((line) => line.startsWith("min ")),
        [`min 1:151 {"since":"2026-02-01"}`]
      );
      assert.isFalse(
        folder.log.some((line) => line.startsWith("search ") && line.includes("since"))
      );
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("without ESEARCH, walks up to the first match instead", () =>
    Effect.gen(function* () {
      const folder = dated().withoutEsearch();
      const pages = yield* scanAll(folder, { since: "2026-02-01" });
      assert.deepStrictEqual(pages.flatMap(uids), range(101, 151));
      assert.isFalse(folder.log.some((line) => line.startsWith("min ")));
      assert.strictEqual(folder.log[1], `search 1:151 {"since":"2026-02-01"}`);
      assert.strictEqual(folder.log[2], `search 101:151 {}`);
      assertBoundedWindows(folder);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("answers an empty, finished page when nothing is since the date", () =>
    Effect.gen(function* () {
      for (const folder of [dated(), dated().withoutEsearch()]) {
        const pages = yield* scanAll(folder, { since: "2027-01-01" });
        assert.deepStrictEqual(pages.flatMap(uids), []);
        assert.isTrue(pages.at(-1)!.done);
        assert.strictEqual(yield* checkpointUid(folder, pages.at(-1)!.checkpoint), 151);
        assert.isFalse(folder.log.some((line) => line.startsWith("fetch")));
      }
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("without ESEARCH, seeks across calls when the first match is far up", () =>
    Effect.gen(function* () {
      const folder = new Folder([1, ...range(1_999_990, 1_999_999)], (uid) =>
        uid === 1 ? "2020-01-01" : "2026-05-01"
      ).withoutEsearch();
      const pages = yield* scanAll(folder, { since: "2026-01-01" });
      assert.deepStrictEqual(uids(pages[0]!), []);
      assert.isFalse(pages[0]!.done);
      assert.isAbove(yield* checkpointUid(folder, pages[0]!.checkpoint), 400_000);
      assert.deepStrictEqual(pages.flatMap(uids), range(1_999_990, 1_999_999));
      assert.isTrue(pages.at(-1)!.done);
      assertBoundedWindows(folder);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("stops starting windows once its time budget is spent", () =>
    Effect.gen(function* () {
      const folder = new Folder([1, 5_000_000]).withoutEsearch();
      folder.searchMillis = 5_000;
      const page = yield* scanMessages({
        ...target,
        since: "2026-02-01",
        mailbox: folder.mailbox,
        source: folder.source
      });
      assert.lengthOf(folder.windows(), 2);
      assert.isFalse(page.done);
      assert.isNotNull(page.cursor);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("refuses a cursor or checkpoint from another call, and a reset folder", () =>
    Effect.gen(function* () {
      const folder = new Folder(range(1, 150));
      const page = yield* scanMessages({
        ...target,
        mailbox: folder.mailbox,
        source: folder.source
      });
      const tagOf = <R>(effect: Effect.Effect<unknown, { readonly _tag: string }, R>) =>
        Effect.map(Effect.flip(effect), (error) => error._tag);
      const scan = { ...target, mailbox: folder.mailbox, source: folder.source };
      assert.strictEqual(
        yield* tagOf(listMessages({ ...scan, cursor: page.cursor! })),
        "ImapInvalidCursor"
      );
      assert.strictEqual(
        yield* tagOf(scanMessages({ ...scan, since: "2026-01-01", cursor: page.cursor! })),
        "ImapInvalidCursor"
      );
      assert.strictEqual(
        yield* tagOf(scanMessages({ ...scan, folder: "Archive", after: page.checkpoint })),
        "ImapInvalidCheckpoint"
      );
      folder.uidValidity = 8;
      const reset = { ...target, mailbox: folder.mailbox, source: folder.source };
      assert.strictEqual(
        yield* tagOf(scanMessages({ ...reset, cursor: page.cursor! })),
        "ImapMailboxReset"
      );
      assert.strictEqual(
        yield* tagOf(scanMessages({ ...reset, after: page.checkpoint })),
        "ImapMailboxReset"
      );
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("fails when a search fails, never answering no matches", () =>
    Effect.gen(function* () {
      const folder = new Folder(range(1, 10));
      folder.failSearch = true;
      const error = yield* Effect.flip(
        scanMessages({ ...target, mailbox: folder.mailbox, source: folder.source })
      );
      assert.strictEqual(error._tag, "Deadline");
    }).pipe(Effect.provide(NodeCryptography.layer))
  );
});

describe("listMessages", () => {
  const listAll = (folder: Folder) =>
    Effect.gen(function* () {
      const pages = [];
      let cursor: string | undefined;
      do {
        const page = yield* listMessages({
          ...target,
          ...(cursor === undefined ? {} : { cursor }),
          mailbox: folder.mailbox,
          source: folder.source
        });
        pages.push(page);
        cursor = page.cursor ?? undefined;
      } while (cursor !== undefined && pages.length < 200);
      return pages;
    });

  it.effect("pages newest first by UID from the folder's newest message", () =>
    Effect.gen(function* () {
      const folder = new Folder(range(1, 250));
      folder.uidNext = 90_000;
      const pages = yield* listAll(folder);
      assert.deepStrictEqual(pages.map(uids), [
        range(151, 250).reverse(),
        range(51, 150).reverse(),
        range(1, 50).reverse()
      ]);
      assert.deepStrictEqual(
        pages.map((page) => page.done),
        [false, false, true]
      );
      assert.strictEqual(folder.log[0], "uidAt 250");
      assert.strictEqual(folder.windows()[0], "1:250");
      assertBoundedWindows(folder);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("reads an empty folder with no command at all", () =>
    Effect.gen(function* () {
      const folder = new Folder([]);
      assert.deepStrictEqual(yield* listAll(folder), [{ messages: [], cursor: null, done: true }]);
      assert.deepStrictEqual(folder.log, []);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );
});

describe("searchMessages", () => {
  const searchAll = (folder: Folder, criteria: Criteria) =>
    Effect.gen(function* () {
      const pages = [];
      let cursor: string | undefined;
      do {
        const page = yield* searchMessages({
          ...target,
          criteria,
          ...(cursor === undefined ? {} : { cursor }),
          mailbox: folder.mailbox,
          source: folder.source
        });
        pages.push(page);
        cursor = page.cursor ?? undefined;
      } while (cursor !== undefined && pages.length < 200);
      return pages;
    });

  it.effect("pages through empty windows, each page moving on", () =>
    Effect.gen(function* () {
      const folder = new Folder([3, 4, 1_999_999]);
      folder.match = (uid) => uid < 10;
      const criteria: Criteria = { subject: "invoice", unseen: true };
      const pages = yield* searchAll(folder, criteria);
      assert.deepStrictEqual(uids(pages[0]!), []);
      assert.isFalse(pages[0]!.done);
      assert.isNotNull(pages[0]!.cursor);
      assert.deepStrictEqual(pages.flatMap(uids), [4, 3]);
      assert.isTrue(pages.at(-1)!.done);
      assert.isTrue(
        folder.log
          .filter((line) => line.startsWith("search "))
          .every((line) => line.endsWith(`{"subject":"invoice","seen":false}`))
      );
      assertBoundedWindows(folder);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("refuses its cursor with other criteria", () =>
    Effect.gen(function* () {
      const folder = new Folder(range(1, 300));
      const first = yield* searchMessages({
        ...target,
        criteria: { from: "billing@example.com" },
        mailbox: folder.mailbox,
        source: folder.source
      });
      const error = yield* Effect.flip(
        searchMessages({
          ...target,
          criteria: { from: "someone@example.com" },
          cursor: first.cursor!,
          mailbox: folder.mailbox,
          source: folder.source
        })
      );
      assert.strictEqual(error._tag, "ImapInvalidCursor");
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("answers since on or after before with no command", () =>
    Effect.gen(function* () {
      const folder = new Folder(range(1, 10));
      const [page] = yield* searchAll(folder, { since: "2026-02-01", before: "2026-02-01" });
      assert.deepStrictEqual(page, { messages: [], cursor: null, done: true });
      assert.deepStrictEqual(folder.log, []);
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it.effect("fails when a search fails, never answering no matches", () =>
    Effect.gen(function* () {
      const folder = new Folder(range(1, 10));
      folder.failSearch = true;
      const error = yield* Effect.flip(searchAll(folder, { text: "quarterly" }));
      assert.strictEqual(error._tag, "Deadline");
    }).pipe(Effect.provide(NodeCryptography.layer))
  );

  it("builds ImapFlow's query with the window always set", () => {
    assert.deepStrictEqual(
      searchQuery(uidRange(5, 9)!, {
        from: "billing@example.com",
        since: "2026-01-02",
        before: "2026-02-01",
        unseen: true
      }),
      {
        uid: "5:9",
        from: "billing@example.com",
        since: "2026-01-02",
        before: "2026-02-01",
        seen: false
      }
    );
    assert.deepStrictEqual(searchQuery(uidRange(5, 5)!, { unseen: false }), {
      uid: "5",
      seen: true
    });
    assert.isUndefined(uidRange(10, 9));
    assert.isUndefined(uidRange(0, 0));
  });
});
