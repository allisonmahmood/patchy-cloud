import type { Locator, Page, Request } from "@playwright/test";
import {
  type CheckContext,
  type CheckOutcome,
  GraderTrouble,
  type Opened,
  type RunPerson,
  type Task
} from "../task.js";
import {
  type ViewMemo,
  around,
  chooseField,
  chooseFieldHolding,
  fillRest,
  formAround,
  holdWhile,
  reveal,
  settle,
  visibleText
} from "./page.js";

/** One person's standup for the day. */
interface Entry {
  readonly yesterday: string;
  readonly today: string;
  readonly blockers: string;
}

/**
 * Where each part of an entry is written, by what its field's label or
 * placeholder says, most specific first: a label naming its day comes
 * before one that only says what, so "What will you get done today?" is
 * never taken for yesterday.
 */
export const YESTERDAY = [/yesterday/i, /did|done|accomplish|complet|finish|last|previous/i];
export const TODAY = [/today/i, /doing|plan|working on|will|next|focus|up to/i];
export const BLOCKERS = [/block/i, /imped|stuck|obstacle|in (your|the) way|help|risk|concern/i];

/** What opens a form to write an entry in, when none is open, most specific first. */
const OPENERS = [/stand.?up|check.?in/i, /\b(write|post|add|new|start|fill)\b/i, /^\s*\+\s*$/];
/** What sends an entry, most specific first; posting again can be an Update. */
const POSTS = [
  /post/i,
  /submit/i,
  /share/i,
  /save/i,
  /send/i,
  /add/i,
  /publish/i,
  /done/i,
  /update/i
];
/** What saves a fix, most specific first. */
const SAVES = [/save/i, /update/i, /done/i, /submit/i, /post/i, /confirm/i, /send/i];
/** What opens one's own entry to fix it: Edit first, then the other verbs. */
const EDITS = [/edit|✎|✏/i, /^\s*(change|fix|update|modify)\b/i];
/** What opens an entry's own view from a list: Details, View, Open, More. */
const DETAILS = /detail|\bview\b|\bopen\b|\bmore\b|expand/i;

/** How long a field a press opens, or the call a press sends, may take to come. */
const OPENS_MS = 5_000;
/** How long a page with no button to press may take after the last keystroke to save, whatever else it sends. */
const SAVE_GRACE_MS = 5_000;
const POLL_MS = 500;

/** A write a person has found the way to make, run in a deliberate window: why it couldn't be made, or null once sent. */
type Write = () => Promise<string | null>;

/** The first field a person writes `words` in: each pattern in turn, so the most specific wins. */
const firstField = async (frame: Opened["frame"], words: ReadonlyArray<RegExp>) => {
  for (const each of words) {
    const field = await chooseField(frame, each);
    if (field !== undefined) return field;
  }
  return undefined;
};

/** The first visible, enabled control among `candidates`, most specific first. */
const firstUsable = async (candidates: ReadonlyArray<Locator>) => {
  for (const each of candidates)
    for (const control of await each.all())
      if (
        (await control.isVisible().catch(() => false)) &&
        (await control.isEnabled().catch(() => false))
      )
        return control;
  return undefined;
};

/**
 * Writes in `fields` as a person types, then sends it: counts every call the
 * page sends Patchy from the first keystroke, so a page that saves as they
 * type has saved before any button. Presses the button of the form around
 * the fields, once anything else it holds is filled in; with no such button,
 * leaves the field and waits a while for the page to save, however much
 * else it sends meanwhile. Why it couldn't, or null once the page has sent
 * Patchy something.
 */
const writeAndSend = async (
  view: Opened,
  fields: ReadonlyArray<readonly [Locator, string]>,
  names: ReadonlyArray<RegExp>
) => {
  const { frame, page } = view;
  const calls = callsFrom(page);
  try {
    for (const [field, words] of fields) await field.fill(words);
    const form = await formAround(frame, names);
    const pressed =
      form === undefined ? "" : (await form.send.innerText().catch(() => "")).trim() || "send";
    if (form === undefined) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(SAVE_GRACE_MS);
    } else {
      await fillRest(form.scope);
      await form.send.click();
      for (let waited = 0; calls.sent() === 0 && waited < OPENS_MS; waited += POLL_MS)
        await page.waitForTimeout(POLL_MS);
    }
    if (calls.sent() > 0) return null;
    return form === undefined
      ? "found no button to save with, and writing and leaving the field saved nothing"
      : `pressed ${pressed}, but the page sent Patchy nothing`;
  } finally {
    calls.stop();
  }
};

/** Counts the calls `page` sends Patchy from now until `stop`. */
const callsFrom = (page: Page) => {
  let sent = 0;
  const count = (request: Request) => {
    if (request.url().includes("/api/runtime/call")) sent++;
  };
  page.on("request", count);
  return { sent: () => sent, stop: () => void page.off("request", count) };
};

/**
 * How a person writes `entry`: opens the form if one waits behind a button,
 * then finds where each part goes. The write, which fills them in and sends
 * it, or why they can't. Only looking, so whatever it presses can't write.
 */
const posting = async (view: Opened, entry: Entry): Promise<Write | string> => {
  const { frame, page } = view;
  // A form can stay disabled until the page has loaded what it shows.
  await settle(view);
  let yesterday = await firstField(frame, YESTERDAY);
  if (yesterday === undefined) {
    const opener = await firstUsable(
      OPENERS.flatMap((name) => [
        frame.getByRole("button", { name }),
        frame.getByRole("link", { name })
      ])
    );
    if (opener === undefined)
      return "found no field for what they did yesterday, or button to start an entry";
    await opener.click();
    for (let waited = 0; yesterday === undefined && waited < OPENS_MS; waited += POLL_MS) {
      await page.waitForTimeout(POLL_MS);
      yesterday = await firstField(frame, YESTERDAY);
    }
  }
  if (yesterday === undefined) return "found no field for what they did yesterday";
  const today = await firstField(frame, TODAY);
  if (today === undefined) return "found no field for what they're doing today";
  const blockers = await firstField(frame, BLOCKERS);
  if (blockers === undefined) return "found no field for what's blocking them";
  const fields = [
    [yesterday, entry.yesterday],
    [today, entry.today],
    [blockers, entry.blockers]
  ] as const;
  return async () => {
    await settle(view);
    return writeAndSend(view, fields, POSTS);
  };
};

/**
 * The one control that opens the entry holding `text` to edit, its own;
 * none when it has none, or several. Edit only ever opens something; the
 * other verbs, such as Update, in a part that also holds fields to type in
 * send the form beside the entry, so they're never taken for its own.
 */
const ownEdit = async (view: Opened, text: string) => {
  const { frame } = view;
  for (const [index, name] of EDITS.entries()) {
    const controls = (scope: Opened["frame"] | Locator) =>
      scope.getByRole("button", { name }).or(scope.getByRole("link", { name }));
    const part = around(frame, text, { has: controls(frame) });
    if ((await part.count()) === 0) continue;
    if (index > 0 && (await part.getByRole("textbox").count()) > 0) continue;
    const own = controls(part);
    if ((await own.count()) === 1 && (await own.isVisible().catch(() => false))) return own;
  }
  return undefined;
};

/**
 * The field that edits the entry holding `text`, holding its words: shown
 * already, or once the entry's own Edit opens it. Only looking.
 */
const editField = async (view: Opened, text: string) => {
  const shown = await chooseFieldHolding(view.frame, text);
  if (shown !== undefined) return shown;
  const edit = await ownEdit(view, text);
  if (edit === undefined) return undefined;
  await edit.click({ timeout: 5_000 }).catch(() => undefined);
  for (let waited = 0; waited < OPENS_MS; waited += POLL_MS) {
    await view.page.waitForTimeout(POLL_MS);
    const opened = await chooseFieldHolding(view.frame, text);
    if (opened !== undefined) return opened;
  }
  return undefined;
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * How a page names one of the run's people, as a pattern's source: their
 * first name as written, not running on into a longer word ("Ben Ortiz", and
 * "BenYesterday" where a card's text runs together, never "Benefits"), or
 * their email.
 */
export const namePattern = (person: Pick<RunPerson, "name" | "email">) =>
  `${escaped(person.name.split(" ")[0] ?? person.name)}(?![a-z])|${escaped(person.email)}`;

/**
 * Whose each showing of `text` is, as a reader tells: for every innermost
 * visible element holding it, the keys of the run's people named in its
 * nearest ancestor that names anyone, by its text or its `aria-labelledby`
 * or `aria-label`: the card, row or section it sits in. In a table, its
 * cell's headers count too: the cell's `headers`, else the header cells
 * across its rows and above it in its columns, laid out with their row and
 * column spans. Headers and any name inside the cell must agree on one
 * person; anything else names them all, so it's nobody's alone. A showing
 * nobody is named around has none.
 */
const whose = (view: Opened, text: string, people: ReadonlyArray<RunPerson>) =>
  view.frame.locator("body").evaluate(
    (body, { text, names }) => {
      const named = (words: string) =>
        names.flatMap(([key, pattern]) => (new RegExp(pattern).test(words) ? [key] : []));
      const byIds = (ids: string | null) =>
        (ids ?? "")
          .split(/\s+/)
          .map((id) =>
            id === "" ? "" : (body.ownerDocument.getElementById(id)?.textContent ?? "")
          )
          .join(" ");
      const labelOf = (element: Element) =>
        `${byIds(element.getAttribute("aria-labelledby"))} ${element.getAttribute("aria-label") ?? ""}`;
      /** Who names `from`, nearest first, going no higher than `stop`. */
      const nearest = (from: Element, stop: Element | null) => {
        for (let at: Element | null = from; at !== null; at = at.parentElement) {
          const keys = named(`${at.textContent ?? ""} ${labelOf(at)}`);
          if (keys.length > 0 || at === stop) return keys;
        }
        return [];
      };
      /** Who a table cell's headers name, with the table laid out on a grid as its spans place it. */
      const headedBy = (cell: HTMLTableCellElement) => {
        const explicit = byIds(cell.getAttribute("headers"));
        if (explicit.trim() !== "") return named(explicit);
        const table = cell.closest("table");
        if (table === null) return [];
        const grid: Array<Array<HTMLTableCellElement>> = [];
        for (const [top, row] of [...table.rows].entries()) {
          let left = 0;
          for (const each of row.cells) {
            while (grid[top]?.[left] !== undefined) left++;
            const down = each.rowSpan === 0 ? table.rows.length - top : Math.max(1, each.rowSpan);
            const across = Math.max(1, each.colSpan);
            for (let r = top; r < top + down; r++)
              for (let c = left; c < left + across; c++) (grid[r] ??= [])[c] = each;
            left += across;
          }
        }
        const slots = grid.flatMap((cells, r) =>
          cells.flatMap((each, c) => (each === cell ? [[r, c] as const] : []))
        );
        const first = Math.min(...slots.map(([r]) => r));
        const headers = new Set<HTMLTableCellElement>();
        for (const [r, c] of slots) {
          for (const each of grid[r] ?? [])
            if (
              each !== undefined &&
              each !== cell &&
              each.tagName === "TH" &&
              !/^col/.test(each.scope)
            )
              headers.add(each);
          for (let above = 0; above < first; above++) {
            const each = grid[above]?.[c];
            if (each !== undefined && each.tagName === "TH" && !/^row/.test(each.scope))
              headers.add(each);
          }
        }
        return named([...headers].map((each) => each.textContent ?? "").join(" "));
      };
      const holders = [...body.querySelectorAll("*")].filter(
        (element) =>
          !/^(SCRIPT|STYLE|TEMPLATE|TEXTAREA|INPUT|SELECT|OPTION)$/.test(element.tagName) &&
          (element.textContent ?? "").includes(text)
      );
      return holders
        .filter(
          (element) =>
            !holders.some((other) => other !== element && element.contains(other)) &&
            element.checkVisibility()
        )
        .map((element) => {
          const cell = element.closest("td, th");
          const headed = cell instanceof HTMLTableCellElement ? headedBy(cell) : [];
          if (headed.length === 0) return nearest(element, null);
          const inCell = nearest(element, cell);
          return inCell.length === 0 || (headed.length === 1 && inCell.join() === headed.join())
            ? headed
            : [...new Set([...headed, ...inCell])];
        });
    },
    { text, names: people.map((person) => [person.key, namePattern(person)] as const) }
  );

/** What a page shows as one person's entry: as first written, as fixed, both side by side, or neither. */
export type Shown = "first" | "fixed" | "both" | "neither";

/**
 * What shows as `owner`'s, from whose each showing of their first words
 * and of the fixed ones is: only a showing named for them alone is theirs,
 * so a copy in someone else's entry, or words nobody is named around, isn't.
 */
export const shownAs = (
  owner: string,
  first: ReadonlyArray<ReadonlyArray<string>>,
  fixed: ReadonlyArray<ReadonlyArray<string>>
): Shown => {
  const theirs = (showings: ReadonlyArray<ReadonlyArray<string>>) =>
    showings.some((keys) => keys.length === 1 && keys[0] === owner);
  return theirs(first) ? (theirs(fixed) ? "both" : "first") : theirs(fixed) ? "fixed" : "neither";
};

const SAID: Record<Shown, string> = {
  first: "as first written",
  fixed: "with the fix",
  both: "as first written and with the fix, side by side",
  neither: "nowhere as theirs"
};

/**
 * What `observer` sees of `owner`'s entry, from a fresh page: found by any
 * of its words on the starting view, or else by what they did yesterday,
 * which a fix leaves, behind the page's views.
 */
const seenBy = async (
  ctx: CheckContext,
  observer: string,
  owner: RunPerson,
  entry: Entry,
  fixed: string,
  memo: ViewMemo
): Promise<Shown> => {
  const view = await ctx.open(observer);
  await settle(view);
  const shown = await visibleText(view).catch(() => "");
  const found =
    [entry.yesterday, entry.today, entry.blockers, fixed].some((words) => shown.includes(words)) ||
    (await reveal(view, entry.yesterday, memo));
  const seen = found
    ? shownAs(
        owner.key,
        await whose(view, entry.today, ctx.people),
        await whose(view, fixed, ctx.people)
      )
    : "neither";
  await view.close();
  return seen;
};

/**
 * Whether a person finds their own entry holding `text`: in a field the page
 * fills with it to edit, as a page that lists only the others' entries
 * does, or shown on the page or behind its views.
 */
const findsOwn = async (view: Opened, text: string) => {
  await settle(view);
  const inField = await view.frame
    .locator("input:visible, textarea:visible")
    .evaluateAll(
      (fields, text) =>
        fields.some(
          (field) =>
            (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
            field.value.trim() === text
        ),
      text
    )
    .catch(() => false);
  return inField || (await reveal(view, text));
};

/** `key` posts `entry` from a page of their own: the check's failure when they couldn't, or it never showed for them. */
const posted = async (ctx: CheckContext, key: string, entry: Entry) => {
  const view = await ctx.open(key);
  const who = ctx.person(key).name;
  const write = await posting(view, entry);
  const refused = typeof write === "string" ? write : await view.barrier.deliberately(write);
  await view.close();
  if (refused !== null) return { ok: false, reason: `${who} ${refused}.` } as const;
  // From a fresh page, so words typed but never saved don't count.
  const again = await ctx.open(key);
  const found = await findsOwn(again, entry.today);
  await again.close();
  return found
    ? null
    : ({
        ok: false,
        reason: `${who} posted an entry, but a fresh page never showed it to them, on its starting view, behind its tabs and view toggles, or in a field to edit.`
      } as const);
};

/** Whether `part`'s words name nobody among `people` but `owner`, as an entry's own container's do. */
const namesOnly = async (part: Locator, owner: RunPerson, people: ReadonlyArray<RunPerson>) => {
  const words = (await part.textContent().catch(() => null)) ?? "";
  return people.every(
    (person) => person.key === owner.key || !new RegExp(namePattern(person)).test(words)
  );
};

/**
 * The field that edits the entry holding `text`, once the person opens the
 * entry on its own: by clicking the entry itself, then by the one Details,
 * View or Open control in its own container, the smallest part of the page
 * holding its words and naming nobody but `owner`. Only a field holding the
 * entry's own words counts, so opening the wrong entry never edits it. Only
 * looking.
 */
const editByOpening = async (
  view: Opened,
  text: string,
  owner: RunPerson,
  people: ReadonlyArray<RunPerson>
) => {
  const { frame } = view;
  await frame
    .getByText(text)
    .first()
    .click({ timeout: 5_000 })
    .catch(() => undefined);
  await settle(view);
  const opened = await editField(view, text);
  if (opened !== undefined) return opened;
  const controls = (scope: Opened["frame"] | Locator) =>
    scope.getByRole("button", { name: DETAILS }).or(scope.getByRole("link", { name: DETAILS }));
  const part = around(frame, text, { has: controls(frame) });
  if ((await part.count()) === 0 || !(await namesOnly(part, owner, people))) return undefined;
  const own = controls(part);
  if ((await own.count()) !== 1) return undefined;
  await own.click({ timeout: 5_000 }).catch(() => undefined);
  await settle(view);
  return editField(view, text);
};

/**
 * How `key` fixes their entry to say `today` instead, from a page of their
 * own: in the field holding its words, wherever the page shows it, once the
 * entry's own Edit opens it, or once opening the entry shows its Edit. With
 * nothing that edits it, from a fresh page, so nothing opening it left open
 * is in the way, by posting the entry again, as a page that keeps one a
 * person a day takes it. Their page and the write that fixes it there, or
 * why they can't.
 */
const fixingAs = async (
  ctx: CheckContext,
  key: string,
  entry: Entry,
  today: string
): Promise<{ readonly view: Opened; readonly write: Write } | string> => {
  const owner = ctx.person(key);
  const view = await ctx.open(key);
  if (!(await findsOwn(view, entry.today))) {
    await view.close();
    return "can't find the entry they posted";
  }
  const field =
    (await editField(view, entry.today)) ??
    (await editByOpening(view, entry.today, owner, ctx.people));
  if (field !== undefined)
    return { view, write: () => writeAndSend(view, [[field, today]], SAVES) };
  await view.close();
  const fresh = await ctx.open(key);
  const write = await posting(fresh, { ...entry, today });
  if (typeof write !== "string") return { view: fresh, write };
  await fresh.close();
  return write;
};

/** Patchy's codes for a patch's handler failing on a try: the patch's answer, never expected. */
const PATCH_FAILED = new Set(["handler_failed", "handler_timeout"]);

/** Each person's entry, new to this grading. */
const entryOf = (key: "ben" | "cleo" | "ada", code: string): Entry =>
  ({
    ben: {
      yesterday: `Closed out the invoice export bugs ${code}`,
      today: `Starting on the search filters ${code}`,
      blockers: `Waiting on API keys from IT ${code}`
    },
    cleo: {
      yesterday: `Wrote the onboarding emails ${code}`,
      today: `Reviewing the pricing page copy ${code}`,
      blockers: `Nothing blocking right now ${code}`
    },
    ada: {
      yesterday: `Interviewed two designers ${code}`,
      today: `Drafting the quarterly roadmap ${code}`,
      blockers: `Need budget sign-off ${code}`
    }
  })[key];

/** How a check names someone trying a change, their role included when it's an admin's. */
const trier = (person: RunPerson) =>
  person.role === "admin" ? `${person.name}, an admin,` : person.name;

/**
 * A written standup with a rule no page can keep alone: each entry is its
 * author's to fix, and nobody else's, admins included. Ada posts and Ben
 * sees all of it as hers; Cleo fixes hers and Ben sees the fix; then Ben
 * fixes his while each call his fix sends is held and sent as Ada, an
 * admin, and as Cleo first, from their own pages, and his entry must not
 * change until his own call goes through.
 */
export default {
  id: "standup",
  scenario: "team",
  words:
    "Can you set up a written standup for our team? Every morning each of us writes what we did yesterday, what we're doing today and anything that's blocking us, and everyone should see today's entries from the whole team. People can fix their own entry, but nobody can change someone else's. Publish it.",
  target: { create: "repo" },
  tier: 2,
  minutes: 30,
  heldOut: true,
  rubric: [
    "Tier 2: an entry is its author's alone to change, a rule kept against the viewer, which only server handlers can do; at tier 1 every viewer's page can write every row, so hiding Edit on other people's entries protects nothing.",
    "Today's entries are visible to the whole team, each its author's alone to change. An owned table of entries: the author from `ctx.viewer` (never an argument), the day it is for, what they did yesterday, what they're doing today and what's blocking them, and when it was last changed. Either entry model fits the request: one per person per day, kept under concurrent saves (a unique index on author and day, say, or a serializable mutation that looks the entry up, then updates or inserts it), so posting again changes it; or several a day, each changed through its own edit.",
    "Mutations save and change entries, validating their parts and refusing with declared errors; a change to an existing entry checks that its author is the viewer, so nobody, admins included, can change someone else's. 'Today' means the same day to the page and the server.",
    "The page reads today's entries with a live query and shows the whole team's, each with whose it is, blockers easy to spot, and Edit only on the viewer's own; who hasn't posted yet is a plus.",
    "Clear empty states and errors, in the company look; no extra dependencies."
  ].join("\n"),
  checks: [
    {
      name: "Ada posts her standup, and Ben sees all of it as hers",
      run: async (ctx) => {
        const entry = entryOf("ada", ctx.code);
        const refused = await posted(ctx, "ada", entry);
        if (refused !== null) return refused;
        const ben = await ctx.open("ben");
        if (!(await reveal(ben, entry.today)))
          return {
            ok: false,
            reason:
              "Ben doesn't see Ada's entry on his starting view or behind its tabs and view toggles."
          };
        const missing = async () => {
          const text = await visibleText(ben);
          return [
            { words: entry.yesterday, said: "what Ada did yesterday" },
            { words: entry.blockers, said: "what's blocking Ada" }
          ].flatMap(({ words, said }) => (text.includes(words) ? [] : [said]));
        };
        // A list can show a summary that opens on a click; opening it only looks.
        if ((await missing()).length > 0) {
          await ben.frame
            .getByText(entry.today)
            .first()
            .click({ timeout: 5_000 })
            .catch(() => undefined);
          await ben.page.waitForTimeout(1_500);
        }
        const unseen = await missing();
        if (unseen.length > 0)
          return {
            ok: false,
            reason: `Ben sees what Ada is doing today, but not ${unseen.join(" or ")}.`
          };
        const owners = await whose(ben, entry.today, ctx.people);
        if (owners.some((keys) => keys.length === 1 && keys[0] === "ada")) return { ok: true };
        const named = [...new Set(owners.flat())].map((key) => ctx.person(key).name);
        return {
          ok: false,
          reason:
            named.length === 0
              ? "Ben sees Ada's entry, but nothing beside it says it's hers."
              : `Ben sees Ada's entry, but beside ${named.join(" and ")}, not as Ada's alone.`
        };
      }
    },
    {
      name: "Cleo fixes her own entry, and Ben sees the fix",
      run: async (ctx) => {
        const entry = entryOf("cleo", ctx.code);
        const refused = await posted(ctx, "cleo", entry);
        if (refused !== null) return refused;
        const fixed = `Pairing on the checkout flow instead ${ctx.code}`;
        const fix = await fixingAs(ctx, "cleo", entry, fixed);
        if (typeof fix === "string") return { ok: false, reason: `Cleo Shah ${fix}.` };
        const failed = await fix.view.barrier.deliberately(fix.write);
        await fix.view.close();
        if (failed !== null) return { ok: false, reason: `Cleo Shah ${failed}.` };
        const seen = await seenBy(ctx, "ben", ctx.person("cleo"), entry, fixed, {});
        return seen === "fixed"
          ? { ok: true }
          : {
              ok: false,
              reason:
                seen === "both"
                  ? "Ben sees Cleo's first words and her fix as two entries: fixing it added one rather than changing hers."
                  : `Cleo saved a fix, but Ben sees her entry ${SAID[seen]}.`
            };
      }
    },
    {
      name: "only Ben can change his entry, even when an admin or a teammate calls the patch directly",
      run: async (ctx): Promise<CheckOutcome> => {
        const ben = ctx.person("ben");
        const entry = entryOf("ben", ctx.code);
        const refused = await posted(ctx, "ben", entry);
        if (refused !== null) return refused;
        const fixed = `Fixing the export timeout first ${ctx.code}`;
        const cleoWay: ViewMemo = {};
        /** What Cleo sees of Ben's entry, from a fresh page. */
        const cleoSees = () => seenBy(ctx, "cleo", ben, entry, fixed, cleoWay);
        const before = await cleoSees();
        if (before !== "first")
          return {
            ok: false,
            reason: `Before Ben fixed anything, Cleo sees his entry ${SAID[before]}.`
          };
        const fix = await fixingAs(ctx, "ben", entry, fixed);
        if (typeof fix === "string") return { ok: false, reason: `Ben Ortiz ${fix}.` };
        let seen: Shown = before;
        const outcome = await holdWhile(fix.view, fix.write, {
          probe: async (call) => {
            // What Cleo sees with Ben's call held: his earlier calls may already have made the fix.
            seen = await cleoSees();
            if (seen !== "first")
              return `Cleo saw Ben's entry ${SAID[seen]} before his last call: his fix went through something the grader couldn't hold, so it couldn't try it as anyone else.`;
            // Ada is an admin: nobody else may change his entry, admins included.
            for (const key of ["ada", "cleo"]) {
              const other = await ctx.open(key);
              const answer = await call.tryAs(other, ctx.person(key));
              await other.close();
              // Patchy refusing for any reason but the patch's own handler failing says nothing of the patch.
              if (!answer.ok && !answer.byHandler && !PATCH_FAILED.has(answer.code))
                throw new GraderTrouble({
                  what: `Patchy itself refused the grader's try as ${ctx.person(key).name} (${answer.code}).`
                });
              const after = await cleoSees();
              if (after !== seen)
                return `${trier(ctx.person(key))} sent Ben's fix${call.handler === null ? "" : ` (${call.handler})`} as their own, ${answer.ok ? "and" : "and was refused, but"} before Ben's own call went through, his entry showed ${SAID[after]}.`;
              if (!answer.ok && answer.byHandler && call.handler !== null)
                ctx.expectRefusal({
                  person: key,
                  handler: call.handler,
                  code: answer.code,
                  at: answer.at
                });
            }
            return null;
          },
          took: async () => (seen = await cleoSees()) === "fixed"
        });
        if ("refused" in outcome) return { ok: false, reason: `Ben Ortiz ${outcome.refused}.` };
        if (outcome.objection !== null) return { ok: false, reason: outcome.objection };
        await fix.view.close();
        if (outcome.took) return { ok: true };
        return {
          ok: false,
          reason:
            outcome.held === 0
              ? `Ben's fix sent Patchy nothing, and Cleo sees his entry ${SAID[seen]}.`
              : `Ben's fix never took effect through a call the grader could try as someone else: Cleo sees his entry ${SAID[seen]}.`
        };
      }
    }
  ]
} satisfies Task;
