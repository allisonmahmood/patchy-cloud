import type { Locator, Request } from "@playwright/test";
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

/** How long a field a press opens, or the call a press sends, may take to come. */
const OPENS_MS = 5_000;
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
 * Sends what the person wrote: presses the button of the form around the
 * fields they chose, once anything else it holds is filled in, or with no
 * such button leaves the field, as an autosaving page saves. Why it couldn't,
 * or null once the page has sent Patchy something.
 */
const send = async (view: Opened, names: ReadonlyArray<RegExp>) => {
  const { frame, page } = view;
  const form = await formAround(frame, names);
  const pressed =
    form === undefined ? "" : (await form.send.innerText().catch(() => "")).trim() || "send";
  let sent = 0;
  const count = (request: Request) => {
    if (request.url().includes("/api/runtime/call")) sent++;
  };
  page.on("request", count);
  try {
    if (form === undefined) await page.keyboard.press("Tab");
    else {
      await fillRest(form.scope);
      await form.send.click();
    }
    for (let waited = 0; sent === 0 && waited < OPENS_MS; waited += POLL_MS)
      await page.waitForTimeout(POLL_MS);
  } finally {
    page.off("request", count);
  }
  if (sent > 0) return null;
  return form === undefined
    ? "found no button to save with, and leaving the field saved nothing"
    : `pressed ${pressed}, but the page sent Patchy nothing`;
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
  const fields = [yesterday, today, blockers] as const;
  return async () => {
    await settle(view);
    await fields[0].fill(entry.yesterday);
    await fields[1].fill(entry.today);
    await fields[2].fill(entry.blockers);
    return send(view, POSTS);
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
 * How a person fixes their entry to say `today` instead: in the field
 * holding its words, wherever the page shows it or once the entry's own
 * Edit opens it; with nothing to edit, by posting the entry again, as a page
 * that keeps one a person a day takes it. The write, or why they can't.
 */
const fixing = async (view: Opened, entry: Entry, today: string): Promise<Write | string> => {
  let field = await chooseFieldHolding(view.frame, entry.today);
  if (field === undefined) {
    const edit = await ownEdit(view, entry.today);
    if (edit !== undefined) {
      await edit.click({ timeout: 5_000 }).catch(() => undefined);
      for (let waited = 0; field === undefined && waited < OPENS_MS; waited += POLL_MS) {
        await view.page.waitForTimeout(POLL_MS);
        field = await chooseFieldHolding(view.frame, entry.today);
      }
    }
  }
  if (field === undefined) return posting(view, { ...entry, today });
  const chosen = field;
  return async () => {
    await chosen.fill(today);
    return send(view, SAVES);
  };
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
 * nearest ancestor that names anyone, the card, row or section it sits in.
 * A showing nobody is named around has none.
 */
const whose = (view: Opened, text: string, people: ReadonlyArray<RunPerson>) =>
  view.frame.locator("body").evaluate(
    (body, { text, names }) => {
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
          for (let at: Element | null = element; at !== null; at = at.parentElement) {
            const words = at.textContent ?? "";
            const keys = names.flatMap(([key, pattern]) =>
              new RegExp(pattern).test(words) ? [key] : []
            );
            if (keys.length > 0) return keys;
          }
          return [];
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

/** `key` posts `entry` from a page of their own: the check's failure when they couldn't, or it never showed for them. */
const posted = async (ctx: CheckContext, key: string, entry: Entry) => {
  const view = await ctx.open(key);
  const who = ctx.person(key).name;
  const write = await posting(view, entry);
  const refused = typeof write === "string" ? write : await view.barrier.deliberately(write);
  const shown = refused === null && (await reveal(view, entry.today));
  await view.close();
  if (refused !== null) return { ok: false, reason: `${who} ${refused}.` } as const;
  return shown
    ? null
    : ({
        ok: false,
        reason: `${who} posted an entry, but it never showed up for them on their starting view or behind its tabs and view toggles.`
      } as const);
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

/**
 * A written standup with a rule no page can keep alone: each entry is its
 * author's to fix, and nobody else's. Ben posts and Cleo sees all of it as
 * his; Cleo fixes hers and Ben sees the fix; then Ada fixes hers while each
 * call her fix sends is held and sent as Ben and as Cleo first, from their
 * own pages, and her entry must not change until her own call goes through.
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
    "Tier 2: an entry is its author's to change, a rule kept against the viewer, which only server handlers can do; at tier 1 every viewer's page can write every row, so hiding Edit on other people's entries protects nothing.",
    "One owned table of entries: the author from `ctx.viewer` (never an argument), the day it is for, what they did yesterday, what they're doing today and what's blocking them, and when it was last changed. One entry per person per day, kept by a unique index on author and day, so posting again or editing changes that entry rather than adding another.",
    "A mutation saves the viewer's own entry for today, validating its parts and refusing with declared errors; any change finds the entry by its author being the viewer, so nobody, admins included, can change someone else's. 'Today' means the same day to the page and the server.",
    "The page reads today's entries with a live query and shows the whole team's, each with whose it is, blockers easy to spot, and Edit only on the viewer's own; who hasn't posted yet is a plus.",
    "Clear empty states and errors, in the company look; no extra dependencies."
  ].join("\n"),
  checks: [
    {
      name: "Ben posts his standup, and Cleo sees all of it as his",
      run: async (ctx) => {
        const entry = entryOf("ben", ctx.code);
        const refused = await posted(ctx, "ben", entry);
        if (refused !== null) return refused;
        const cleo = await ctx.open("cleo");
        if (!(await reveal(cleo, entry.today)))
          return {
            ok: false,
            reason:
              "Cleo doesn't see Ben's entry on her starting view or behind its tabs and view toggles."
          };
        const missing = async () => {
          const text = await visibleText(cleo);
          return [
            { words: entry.yesterday, said: "what Ben did yesterday" },
            { words: entry.blockers, said: "what's blocking Ben" }
          ].flatMap(({ words, said }) => (text.includes(words) ? [] : [said]));
        };
        // A list can show a summary that opens on a click; opening it only looks.
        if ((await missing()).length > 0) {
          await cleo.frame
            .getByText(entry.today)
            .first()
            .click({ timeout: 5_000 })
            .catch(() => undefined);
          await cleo.page.waitForTimeout(1_500);
        }
        const unseen = await missing();
        if (unseen.length > 0)
          return {
            ok: false,
            reason: `Cleo sees what Ben is doing today, but not ${unseen.join(" or ")}.`
          };
        const owners = await whose(cleo, entry.today, ctx.people);
        if (owners.some((keys) => keys.length === 1 && keys[0] === "ben")) return { ok: true };
        const named = [...new Set(owners.flat())].map((key) => ctx.person(key).name);
        return {
          ok: false,
          reason:
            named.length === 0
              ? "Cleo sees Ben's entry, but nothing beside it says it's his."
              : `Cleo sees Ben's entry, but beside ${named.join(" and ")}, not as Ben's alone.`
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
        const cleo = await ctx.open("cleo");
        if (!(await reveal(cleo, entry.today)))
          return { ok: false, reason: "Cleo can't find the entry she posted." };
        const write = await fixing(cleo, entry, fixed);
        if (typeof write === "string") return { ok: false, reason: `Cleo ${write}.` };
        const failed = await cleo.barrier.deliberately(write);
        if (failed !== null) return { ok: false, reason: `Cleo ${failed}.` };
        await cleo.close();
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
      name: "only Ada can change her entry, even when others call the patch directly",
      run: async (ctx): Promise<CheckOutcome> => {
        const ada = ctx.person("ada");
        const entry = entryOf("ada", ctx.code);
        const refused = await posted(ctx, "ada", entry);
        if (refused !== null) return refused;
        const fixed = `Moved to hiring, roadmap is on Friday ${ctx.code}`;
        const benWay: ViewMemo = {};
        /** What Ben sees of Ada's entry, from a fresh page. */
        const benSees = () => seenBy(ctx, "ben", ada, entry, fixed, benWay);
        const before = await benSees();
        if (before !== "first")
          return {
            ok: false,
            reason: `Before Ada fixed anything, Ben sees her entry ${SAID[before]}.`
          };
        const view = await ctx.open("ada");
        if (!(await reveal(view, entry.today)))
          return { ok: false, reason: "Ada can't find the entry she posted." };
        const write = await fixing(view, entry, fixed);
        if (typeof write === "string") return { ok: false, reason: `Ada ${write}.` };
        let seen: Shown = before;
        const outcome = await holdWhile(view, write, {
          probe: async (call) => {
            // What Ben sees with Ada's call held: her earlier calls may already have made the fix.
            seen = await benSees();
            if (seen !== "first")
              return `Ben saw Ada's entry ${SAID[seen]} before her last call: her fix went through something the grader couldn't hold, so it couldn't try it as anyone else.`;
            for (const key of ["ben", "cleo"]) {
              const other = await ctx.open(key);
              const answer = await call.tryAs(other, ctx.person(key));
              await other.close();
              // Patchy refusing for any reason but the patch's own handler failing says nothing of the patch.
              if (!answer.ok && !answer.byHandler && !PATCH_FAILED.has(answer.code))
                throw new GraderTrouble({
                  what: `Patchy itself refused the grader's try as ${ctx.person(key).name} (${answer.code}).`
                });
              const after = await benSees();
              if (after !== seen)
                return `${ctx.person(key).name} sent Ada's fix${call.handler === null ? "" : ` (${call.handler})`} as their own, ${answer.ok ? "and" : "and was refused, but"} before Ada's own call went through, her entry showed ${SAID[after]}.`;
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
          took: async () => (seen = await benSees()) === "fixed"
        });
        if ("refused" in outcome) return { ok: false, reason: `Ada ${outcome.refused}.` };
        if (outcome.objection !== null) return { ok: false, reason: outcome.objection };
        await view.close();
        if (outcome.took) return { ok: true };
        return {
          ok: false,
          reason:
            outcome.held === 0
              ? `Ada's fix sent Patchy nothing, and Ben sees her entry ${SAID[seen]}.`
              : `Ada's fix never took effect through a call the grader could try as someone else: Ben sees her entry ${SAID[seen]}.`
        };
      }
    }
  ]
} satisfies Task;
