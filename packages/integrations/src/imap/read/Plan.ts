/**
 * How `scanMessages`, `listMessages` and `searchMessages` page through a folder, over the session
 * commands a `Source` injects. Every search the planners ask for names an explicit UID window of at
 * most `WINDOW_MAX_UIDS`, so no answer holds more numbers than its window is wide, and no range is
 * ever `n:*`. A call searches windows until its page is full, the folder is covered, or its scan
 * budget is spent; then it answers what it has, and a cursor when there is more. A page can come
 * back empty and still have moved on. A command that fails, such as one past its deadline, fails
 * the call: it is never read as "no matches".
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CALL_SCAN_MILLIS,
  CALL_WINDOWS,
  PAGE_MESSAGES,
  SEARCH_VALUE_CHARACTERS,
  WINDOW_MAX_UIDS,
  WINDOW_UIDS
} from "./Bounds.js";
import * as Cursor from "./Cursor.js";
import { MAX_UID, sequenceSet, uidRange, type UidRange } from "./Refs.js";

// ---------- arguments ----------

const isCalendarDay = (day: string) => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year >= 1 && days !== undefined && date >= 1 && date <= days;
};
/** A calendar day, `YYYY-MM-DD`, compared with messages' internal dates as IMAP does. */
export const Day = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((day) => isCalendarDay(day) || "Not a calendar day.")
);
const SearchValue = Schema.String.check(
  Schema.isBetweenLength(1, SEARCH_VALUE_CHARACTERS),
  Schema.makeFilter((value) => !/[\0-\x1F\x7F]/.test(value) || "A search value has no controls.")
);

/**
 * What a search matches, ANDed. `from`, `to`, `subject` and `text` are IMAP's case-insensitive
 * substring matches; `since` is on or after a day and `before` strictly before one, by internal
 * date; `unseen` true matches unread mail and false read mail.
 */
export const Criteria = Schema.Struct({
  from: Schema.optionalKey(SearchValue),
  to: Schema.optionalKey(SearchValue),
  subject: Schema.optionalKey(SearchValue),
  text: Schema.optionalKey(SearchValue),
  since: Schema.optionalKey(Day),
  before: Schema.optionalKey(Day),
  unseen: Schema.optionalKey(Schema.Boolean)
});
export type Criteria = typeof Criteria.Type;

/**
 * The ImapFlow `SearchObject` for a window and criteria, with `uid` always set. Days go as
 * `YYYY-MM-DD` strings, which ImapFlow reads as UTC midnight: a `Date` at any other time would
 * shift `before` to the next day.
 */
export interface SearchQuery {
  readonly uid: string;
  readonly from?: string;
  readonly to?: string;
  readonly subject?: string;
  readonly text?: string;
  readonly since?: string;
  readonly before?: string;
  readonly seen?: boolean;
}
export const searchQuery = (range: UidRange, criteria: Criteria): SearchQuery => {
  const { unseen, ...matches } = criteria;
  return {
    uid: sequenceSet(range),
    ...matches,
    ...(unseen === undefined ? {} : { seen: !unseen })
  };
};

// ---------- the session ----------

/** The folder as this call's fresh `EXAMINE` found it. */
export interface Mailbox {
  readonly uidValidity: number;
  readonly uidNext: number;
  /** `EXISTS`: how many messages the folder holds. */
  readonly messages: number;
}

/** The session commands a planner reads through. Each runs on the examined folder. */
export interface Source<M, E, R> {
  /** Whether the server offers ESEARCH. Without it, ImapFlow answers `RETURN (MIN)` in full. */
  readonly esearch: boolean;
  /** `UID SEARCH` of `searchQuery(range, criteria)`: the matching UIDs, in any order. */
  readonly search: (
    range: UidRange,
    criteria: Criteria
  ) => Effect.Effect<ReadonlyArray<number>, E, R>;
  /** `UID SEARCH RETURN (MIN)` of the same. Asked only when `esearch` is true. */
  readonly searchMin: (
    range: UidRange,
    criteria: Criteria
  ) => Effect.Effect<number | undefined, E, R>;
  /** `FETCH n (UID)`: the UID of the folder's `n`th message, or `undefined` when there is none. */
  readonly uidAt: (sequence: number) => Effect.Effect<number | undefined, E, R>;
  /** `UID FETCH` of these UIDs' summaries. One expunged meanwhile is simply missing. */
  readonly fetch: (uids: ReadonlyArray<number>) => Effect.Effect<ReadonlyArray<M>, E, R>;
}

/** A page of a list or search, newest first. */
export interface Page<M> {
  readonly messages: ReadonlyArray<M>;
  readonly cursor: string | null;
  readonly done: boolean;
}
/** A page of a scan, oldest first, and the checkpoint its rows bring the patch to. */
export interface ScanPage<M> extends Page<M> {
  readonly checkpoint: string;
}

// ---------- windows ----------

type Direction = "up" | "down";

interface Budget {
  windows: number;
  readonly started: number;
}

const nextWindow = (progress: Cursor.Progress, direction: Direction) =>
  direction === "up"
    ? uidRange(progress.position + 1, Math.min(progress.bound, progress.position + progress.window))
    : uidRange(progress.position - progress.window, progress.position - 1);

/** Whether the call may search no further window. The first always runs, so every call moves. */
const spent = Effect.fnUntraced(function* (budget: Budget) {
  if (budget.windows === 0) return false;
  if (budget.windows >= CALL_WINDOWS) return true;
  return (yield* Clock.currentTimeMillis) - budget.started >= CALL_SCAN_MILLIS;
});

/** `uids` within `range`, once each, in the walk's order. */
const ordered = (uids: ReadonlyArray<number>, range: UidRange, direction: Direction) =>
  [...new Set(uids)]
    .filter((uid) => Number.isInteger(uid) && uid >= range.low && uid <= range.high)
    .sort((a, b) => (direction === "up" ? a - b : b - a));

/**
 * Up to `room` UIDs from `progress` on, window by window, and the progress past them. A window that
 * comes up short doubles the next; one with more than the page has room for leaves its rest for
 * the next page and starts the width again.
 */
const collect = Effect.fnUntraced(function* <E, R>(
  start: Cursor.Progress,
  direction: Direction,
  room: number,
  search: (range: UidRange) => Effect.Effect<ReadonlyArray<number>, E, R>,
  budget: Budget
) {
  let progress = start;
  const taken: number[] = [];
  while (taken.length < room) {
    const range = nextWindow(progress, direction);
    if (range === undefined || (yield* spent(budget))) break;
    budget.windows += 1;
    const found = ordered(yield* search(range), range, direction);
    const need = room - taken.length;
    if (found.length > need) {
      taken.push(...found.slice(0, need));
      progress = { ...progress, position: found[need - 1]!, window: WINDOW_UIDS };
    } else {
      taken.push(...found);
      progress = {
        ...progress,
        position: direction === "up" ? range.high : range.low,
        window:
          found.length < need ? Math.min(WINDOW_MAX_UIDS, progress.window * 2) : progress.window
      };
    }
  }
  return { taken, progress };
});

/** The messages fetched for `taken`, once each and in its order. */
const arranged = <M extends { readonly uid: number }>(
  fetched: ReadonlyArray<M>,
  taken: ReadonlyArray<number>
): ReadonlyArray<M> => {
  const byUid = new Map<number, M>();
  for (const message of fetched) if (!byUid.has(message.uid)) byUid.set(message.uid, message);
  return taken.flatMap((uid) => {
    const message = byUid.get(uid);
    return message === undefined ? [] : [message];
  });
};

const fetchTaken = <M extends { readonly uid: number }, E, R>(
  source: Source<M, E, R>,
  taken: ReadonlyArray<number>
) =>
  taken.length === 0
    ? Effect.succeed<ReadonlyArray<M>>([])
    : Effect.map(source.fetch(taken), (fetched) => arranged(fetched, taken));

const boundOf = (mailbox: Mailbox) => Math.max(0, Math.min(MAX_UID, mailbox.uidNext - 1));

// ---------- scanMessages ----------

export interface ScanInput<M, E, R> extends Cursor.Target {
  readonly since?: string;
  /** A checkpoint an earlier scan of this folder answered. */
  readonly after?: string;
  readonly cursor?: string;
  readonly mailbox: Mailbox;
  readonly source: Source<M, E, R>;
}

/**
 * The ascending, resumable import. The first page fixes the bound at `UIDNEXT - 1` and starts past
 * `after`, at the folder's first message if that is later. `since` becomes a lower UID bound once,
 * on the first page or while seeking: ESEARCH's `RETURN (MIN)` where the server has it, otherwise
 * the first window that holds a match on the way up. From there every UID is read whatever its
 * date, so a later message with an older internal date is included. Later pages follow the cursor
 * and search for `since` no more.
 */
export const scanMessages = Effect.fnUntraced(function* <M extends { readonly uid: number }, E, R>(
  input: ScanInput<M, E, R>
) {
  const { mailbox, source } = input;
  const target: Cursor.Target = { connection: input.connection, folder: input.folder };
  const call: Cursor.Call = {
    ...target,
    operation: "imap.scanMessages",
    filters: { since: input.since ?? null, after: input.after ?? null }
  };
  const budget: Budget = { windows: 0, started: yield* Clock.currentTimeMillis };
  const answer = Effect.fnUntraced(function* (
    messages: ReadonlyArray<M>,
    progress: Cursor.Progress
  ) {
    const done = nextWindow(progress, "up") === undefined;
    const page: ScanPage<M> = {
      messages,
      cursor: done ? null : yield* Cursor.writeCursor(call, progress),
      checkpoint: yield* Cursor.writeCheckpoint(target, mailbox.uidValidity, progress.position),
      done
    };
    return page;
  });
  /** Nothing to read up to `uid`: an empty, finished page. */
  const covered = (uid: number) =>
    answer([], {
      uidValidity: mailbox.uidValidity,
      bound: uid,
      position: uid,
      window: WINDOW_UIDS,
      seeking: false
    });

  let progress: Cursor.Progress;
  if (input.cursor !== undefined)
    progress = yield* Cursor.readCursor(input.cursor, call, mailbox.uidValidity);
  else {
    const after =
      input.after === undefined
        ? 0
        : yield* Cursor.readCheckpoint(input.after, target, mailbox.uidValidity);
    const bound = boundOf(mailbox);
    if (mailbox.messages === 0 || bound <= after) return yield* covered(Math.max(after, bound));
    let floor = Math.max(after + 1, (yield* source.uidAt(1)) ?? 0);
    const range = uidRange(floor, bound);
    if (range === undefined) return yield* covered(bound);
    let seeking = false;
    if (input.since !== undefined) {
      if (source.esearch) {
        const first = yield* source.searchMin(range, { since: input.since });
        if (first === undefined || first > bound) return yield* covered(bound);
        floor = Math.max(floor, first);
      } else seeking = true;
    }
    progress = {
      uidValidity: mailbox.uidValidity,
      bound,
      position: floor - 1,
      window: WINDOW_UIDS,
      seeking
    };
  }

  const since = input.since;
  if (progress.seeking && since !== undefined) {
    const sought = yield* collect(
      progress,
      "up",
      1,
      (range) => source.search(range, { since }),
      budget
    );
    const first = sought.taken[0];
    // Every UID the seek passed is older than `since`, so the checkpoint can cover it.
    if (first === undefined) return yield* answer([], sought.progress);
    progress = { ...progress, position: first - 1, window: WINDOW_UIDS, seeking: false };
  } else progress = { ...progress, seeking: false };

  const page = yield* collect(
    progress,
    "up",
    PAGE_MESSAGES,
    (range) => source.search(range, {}),
    budget
  );
  return yield* answer(yield* fetchTaken(source, page.taken), page.progress);
});

// ---------- listMessages and searchMessages ----------

export interface ListInput<M, E, R> extends Cursor.Target {
  readonly cursor?: string;
  readonly mailbox: Mailbox;
  readonly source: Source<M, E, R>;
}
export interface SearchInput<M, E, R> extends ListInput<M, E, R> {
  readonly criteria: Criteria;
}

const newestFirst = Effect.fnUntraced(function* <M extends { readonly uid: number }, E, R>(
  operation: "imap.listMessages" | "imap.searchMessages",
  criteria: Criteria,
  input: ListInput<M, E, R>
) {
  const { mailbox, source } = input;
  const call: Cursor.Call = {
    connection: input.connection,
    folder: input.folder,
    operation,
    filters: criteria
  };
  const budget: Budget = { windows: 0, started: yield* Clock.currentTimeMillis };
  const finished: Page<M> = { messages: [], cursor: null, done: true };

  let progress: Cursor.Progress;
  if (input.cursor !== undefined)
    progress = yield* Cursor.readCursor(input.cursor, call, mailbox.uidValidity);
  else {
    if (mailbox.messages === 0) return finished;
    if (
      criteria.since !== undefined &&
      criteria.before !== undefined &&
      criteria.since >= criteria.before
    )
      return finished;
    // The newest message's UID, so a gap below UIDNEXT costs no window.
    const newest = (yield* source.uidAt(mailbox.messages)) ?? MAX_UID;
    const ceiling = Math.min(boundOf(mailbox), newest);
    if (ceiling < 1) return finished;
    progress = {
      uidValidity: mailbox.uidValidity,
      bound: ceiling,
      position: ceiling + 1,
      window: WINDOW_UIDS,
      seeking: false
    };
  }

  const page = yield* collect(
    progress,
    "down",
    PAGE_MESSAGES,
    (range) => source.search(range, criteria),
    budget
  );
  const done = nextWindow(page.progress, "down") === undefined;
  const answer: Page<M> = {
    messages: yield* fetchTaken(source, page.taken),
    cursor: done ? null : yield* Cursor.writeCursor(call, page.progress),
    done
  };
  return answer;
});

/** The folder newest first by UID, which is arrival order, not the sender's `Date`. */
export const listMessages = <M extends { readonly uid: number }, E, R>(input: ListInput<M, E, R>) =>
  newestFirst("imap.listMessages", {}, input);

/**
 * The folder's matches newest first, searched on the server window by window. The cursor binds the
 * criteria, so paging on with other criteria is refused.
 */
export const searchMessages = <M extends { readonly uid: number }, E, R>(
  input: SearchInput<M, E, R>
) => newestFirst("imap.searchMessages", input.criteria, input);
