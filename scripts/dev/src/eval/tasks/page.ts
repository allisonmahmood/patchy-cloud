/**
 * What checks do in a person's browser without knowing the page's layout:
 * find a field by what its label or placeholder says, find the innermost part
 * of the page holding some words and a control, wait for words to show, read
 * a request's decision from the words around it, and see what the page sends
 * Patchy and what Patchy serves it.
 *
 * A page's handler calls and table writes go through its shell as
 * `POST /api/runtime/call`, with the person's session cookie as the only
 * authority. Holding one back, a check can send the same change as someone
 * else from their own signed-in page, which is how it tries a rule against
 * the server and not merely against what the page shows.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { FrameLocator, Locator, Route } from "@playwright/test";
import type { Opened, RunPerson } from "../task.js";

const POLL_MS = 500;

/** Whether `text` shows in the patch's frame within `ms`, as a person would wait for it. */
export const shows = async (view: Opened, text: string, ms = 10_000) => {
  for (let waited = 0; waited <= ms; waited += POLL_MS) {
    const seen = await view.frame
      .locator("body")
      .innerText({ timeout: POLL_MS })
      .catch(() => "");
    if (seen.includes(text)) return true;
    await view.page.waitForTimeout(POLL_MS);
  }
  return false;
};

/**
 * Whether `text` shows, looking under the page's tabs and its All or Mine
 * filters as a person would when it isn't on the first one: All first. The
 * tab it showed under stays picked.
 */
export const reveal = async (view: Opened, text: string) => {
  if (await shows(view, text, 3_000)) return true;
  const tabs = [
    ...(await view.frame.getByRole("tab").all()),
    ...(await view.frame
      .getByRole("button", { name: /^\s*(all|everything|mine|my \w+|history)\b/i })
      .all())
  ];
  const names = await Promise.all(tabs.map((tab) => tab.innerText().catch(() => "")));
  const order = tabs
    .map((tab, index) => ({ tab, all: /\ball\b/i.test(names[index] ?? "") }))
    .sort((a, b) => Number(b.all) - Number(a.all));
  for (const { tab } of order) {
    if (!(await tab.isVisible().catch(() => false))) continue;
    await tab.click().catch(() => undefined);
    if (await shows(view, text, 2_000)) return true;
  }
  return shows(view, text, 5_000);
};

/** Everything the patch's frame shows, as visible text. */
export const visibleText = (view: Opened) => view.frame.locator("body").innerText();

/**
 * The innermost element holding `text` and, when given, a part `has`
 * matches or words `hasText` matches: a row, card or drawer, however the
 * page lays them out. Ancestors come before descendants in document order,
 * so the last match is the innermost.
 */
export const around = (
  frame: FrameLocator,
  text: string,
  also: { readonly has?: Locator; readonly hasText?: RegExp | string } = {}
) => frame.locator("body *").filter({ hasText: text }).filter(also).last();

const typed = (field: Locator) =>
  field.evaluate(
    (element) =>
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLInputElement &&
        !["file", "checkbox", "radio", "hidden", "submit", "button", "date", "range"].includes(
          element.type
        ))
  );

/** Marks a field a check has chosen, so it isn't chosen twice. */
const CHOSEN = "data-eval-chosen";

/**
 * The first visible field a person types into whose label, placeholder or
 * accessible name says `words` and that the check hasn't chosen already,
 * marked as chosen. A value already in it, such as a prefilled 0, is the
 * person's to replace.
 */
export const chooseField = async (frame: FrameLocator, words: RegExp) => {
  for (const candidates of [
    frame.getByLabel(words),
    frame.getByPlaceholder(words),
    frame.getByRole("textbox", { name: words }),
    frame.getByRole("spinbutton", { name: words })
  ])
    for (const field of await candidates.all())
      if (
        (await field.isVisible()) &&
        (await field.isEditable().catch(() => false)) &&
        (await typed(field).catch(() => false)) &&
        (await field.getAttribute(CHOSEN).catch(() => "")) === null
      ) {
        await field.evaluate((element, mark) => element.setAttribute(mark, ""), CHOSEN);
        return field;
      }
  return undefined;
};

/**
 * The part of the page a form lives in, the innermost one holding every field
 * the check chose and a button that sends it, and that button: its most
 * specific name first, the last of them, since a dialog's comes after the
 * page's own.
 */
export const formAround = async (frame: FrameLocator) => {
  const chosen = await frame.locator(`[${CHOSEN}]`).count();
  for (const name of [/submit/i, /send/i, /save/i, /create/i, /request/i, /add/i, /done/i]) {
    const holders = frame
      .locator("body *")
      .filter({ has: frame.getByRole("button", { name }) })
      .filter({ has: frame.locator(`[${CHOSEN}]`) });
    // The innermost holding them all: ancestors come first, so the last that holds as many.
    let scope: Locator | undefined;
    for (const each of (await holders.all()).reverse())
      if ((await each.locator(`[${CHOSEN}]`).count()) === chosen) {
        scope = each;
        break;
      }
    if (scope === undefined) continue;
    for (const send of (await scope.getByRole("button", { name }).all()).reverse())
      if ((await send.isVisible()) && (await send.isEnabled())) return { scope, send };
  }
  return undefined;
};

/**
 * Fills whatever else a form holds and is still empty, with plain values, as
 * a person in a hurry would: a choice's first option, a date, a number, some
 * words, and the first of any choices nothing is picked from.
 */
export const fillRest = async (scope: Locator) => {
  for (const field of await scope
    .locator(
      "input:not([type=file]):not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select"
    )
    .all()) {
    if (
      !(await field.isVisible()) ||
      !(await field.isEditable().catch(() => false)) ||
      (await field.inputValue().catch(() => "-")) !== ""
    )
      continue;
    const kind = await field.evaluate((element) =>
      element instanceof HTMLSelectElement
        ? "select"
        : element instanceof HTMLInputElement
          ? element.type
          : "text"
    );
    if (kind === "select") {
      const options = await field
        .locator("option")
        .evaluateAll((all) =>
          all.flatMap((option) =>
            option instanceof HTMLOptionElement && option.value !== "" ? [option.value] : []
          )
        );
      if (options[0] !== undefined) await field.selectOption(options[0]);
    } else
      await field.fill(
        kind === "date"
          ? "2026-01-15"
          : kind === "number"
            ? "1"
            : kind === "email"
              ? "someone@example.com"
              : "For the team"
      );
  }
  for (const group of await scope.getByRole("radiogroup").all()) {
    const radios = await group.getByRole("radio").all();
    const picked = await Promise.all(radios.map((radio) => radio.isChecked().catch(() => false)));
    if (radios[0] !== undefined && !picked.includes(true)) await radios[0].click();
  }
};

/** The runtime operations that only read; every other one a page sends changes something. */
const READS = new Set([
  "me",
  "tables.get",
  "tables.getMany",
  "tables.list",
  "members.list",
  "members.search",
  "members.get",
  "members.getMany"
]);

/** A runtime call's envelope as a page's shell sends it. */
const RuntimeCall = Schema.Struct({
  patchId: Schema.String,
  versionId: Schema.String,
  wire: Schema.Number,
  op: Schema.String,
  args: Schema.optionalKey(Schema.Unknown)
});
const decodeCall = Schema.decodeUnknownOption(Schema.fromJsonString(RuntimeCall));
const ServerArgs = Schema.Struct({ handler: Schema.String });
const decodeServerArgs = Schema.decodeUnknownOption(ServerArgs);
const RuntimeReply = Schema.Struct({
  ok: Schema.Boolean,
  value: Schema.optionalKey(Schema.Unknown),
  source: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String)
});
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(RuntimeReply));

/** Where and how a page reaches Patchy: enough to call it again as anyone signed in. */
export interface Envelope {
  readonly url: string;
  readonly origin: string;
  readonly patchId: string;
  readonly versionId: string;
  readonly wire: number;
}

/** A refusal, or a handler's answer. */
export type RuntimeAnswer =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly byHandler: boolean; readonly code: string };

/**
 * Sends one runtime operation as `person`, from their own signed-in page, as
 * their shell would. The error a failed send throws never carries the
 * request, which holds their session cookie.
 */
export const callAs = async (
  view: Opened,
  envelope: Envelope,
  person: RunPerson,
  op: string,
  args: unknown
): Promise<RuntimeAnswer> => {
  const principal = { userId: person.id };
  const response = await view.page.request
    .post(envelope.url, {
      headers: {
        "Content-Type": "application/json",
        "X-Patchy-Wire": String(envelope.wire),
        "X-Patchy-Principal": JSON.stringify(principal),
        Origin: envelope.origin
      },
      data: JSON.stringify({
        patchId: envelope.patchId,
        versionId: envelope.versionId,
        principal,
        wire: envelope.wire,
        op,
        args
      })
    })
    .catch((cause: unknown) => {
      throw new Error(`The grader's call as ${person.name} didn't reach Patchy.`, { cause });
    });
  const reply = decodeReply(await response.text().catch(() => ""));
  if (Option.isNone(reply))
    throw new Error(
      `Patchy answered the grader's call as ${person.name} with HTTP ${response.status()}.`
    );
  return reply.value.ok
    ? { ok: true, value: reply.value.value }
    : {
        ok: false,
        byHandler: reply.value.source === "handler",
        code: reply.value.code ?? "refused"
      };
};

/** The envelope of the first runtime call `view` sends while `act` runs, or none. */
export const envelopeOf = async (view: Opened, act: () => Promise<void>) => {
  let seen: Envelope | undefined;
  const watch = (request: { url: () => string; postData: () => string | null }) => {
    if (seen !== undefined || !request.url().endsWith("/api/runtime/call")) return;
    const call = decodeCall(request.postData() ?? "");
    if (Option.isSome(call))
      seen = { url: request.url(), origin: new URL(view.page.url()).origin, ...call.value };
  };
  view.page.on("request", watch);
  await act();
  view.page.off("request", watch);
  return seen;
};

/**
 * A change a page sent that the grader holds back, to send the same change
 * as someone else first: a check's way of trying a rule against the server.
 */
export interface HeldChange {
  /** The page's handler it calls; null for a table write. */
  readonly handler: string | null;
  /** Sends the same change as `person`, from `view`, their own signed-in page, with a key of its own. */
  readonly tryAs: (view: Opened, person: RunPerson) => Promise<RuntimeAnswer>;
  /** Lets the held change through, and gives the page time to show it. */
  readonly release: () => Promise<void>;
}

/**
 * A change key for `person` beside a page's own: the same time, and a token
 * of theirs in the 22 characters Patchy's keys have.
 */
export const keyFor = (key: string, person: RunPerson) => {
  const dash = key.indexOf("-");
  return `${key.slice(0, dash)}-${`${person.key}${key.slice(dash + 1)}`.slice(0, 22)}`;
};

const holding = (owner: Opened, route: Route): HeldChange | undefined => {
  const call = decodeCall(route.request().postData() ?? "");
  if (Option.isNone(call)) return undefined;
  const { op, args } = call.value;
  const handler =
    op === "server.call"
      ? Option.getOrNull(Option.map(decodeServerArgs(args), (a) => a.handler))
      : null;
  const envelope = {
    url: route.request().url(),
    origin: new URL(owner.page.url()).origin,
    ...call.value
  };
  return {
    handler,
    tryAs: (view, person) =>
      callAs(
        view,
        envelope,
        person,
        op,
        // A change key of its own, so Patchy doesn't take it for a retry of the held one.
        typeof args === "object" && args !== null && "mutationKey" in args
          ? { ...args, mutationKey: keyFor(String(args.mutationKey), person) }
          : args
      ),
    release: async () => {
      await route.continue();
      await owner.page.waitForTimeout(2_000);
    }
  };
};

const DECISION_BUTTONS = {
  approve: /^\s*approve\b/i,
  reject: /^\s*(reject|decline|deny)\b/i
} as const;

/**
 * Decides on the request holding `text` the way a person would: fills in
 * any words its part of the page asks for, such as why, presses its own
 * Approve (or Reject), or the one in whatever opens when they click it, then
 * answers a dialog that opens to ask, filling in any words it wants.
 * A part holding more than one such button isn't the request's own. With
 * `hold`, the first change the page sends is held back and returned. Null
 * when there was nothing to press.
 */
export const decide = async (
  view: Opened,
  text: string,
  which: keyof typeof DECISION_BUTTONS,
  hold = false
) => {
  const { frame, page } = view;
  const name = DECISION_BUTTONS[which];
  const own = async () => {
    const part = around(frame, text, { has: frame.getByRole("button", { name }) });
    const buttons = part.getByRole("button", { name });
    return (await part.count()) > 0 && (await buttons.count()) === 1 ? buttons : undefined;
  };
  let button = await own();
  if (button === undefined) {
    await frame.getByText(text).first().click();
    await page.waitForTimeout(1_000);
    button = await own();
  }
  if (button === undefined || !(await button.isVisible()) || !(await button.isEnabled()))
    return null;
  // A person deciding writes why where the request asks, such as a note a rejection needs.
  await fillRest(around(frame, text, { has: frame.getByRole("button", { name }) }));
  let caught: Route | undefined;
  if (hold)
    await page.route("**/api/runtime/call", async (route) => {
      const call = decodeCall(route.request().postData() ?? "");
      if (caught === undefined && Option.isSome(call) && !READS.has(call.value.op)) {
        caught = route;
        return;
      }
      await route.continue();
    });
  const dialogs = await frame.getByRole("dialog").count();
  await button.click();
  await page.waitForTimeout(1_000);
  // A dialog the press opened, asking for a reason or a confirmation.
  if ((await frame.getByRole("dialog").count()) > dialogs) {
    const dialog = frame.getByRole("dialog").last();
    await fillRest(dialog);
    const confirm = dialog.getByRole("button", {
      name: new RegExp(`${name.source}|^\\s*(confirm|yes)\\b`, "i")
    });
    if ((await confirm.count()) > 0) await confirm.last().click();
  }
  for (let waited = 0; hold && caught === undefined && waited < 10_000; waited += POLL_MS)
    await page.waitForTimeout(POLL_MS);
  if (!hold) await page.waitForTimeout(2_000);
  return { held: caught === undefined ? undefined : holding(view, caught) };
};

/**
 * Whether a file Patchy serves `view` while `act` runs holds `marker`: an
 * upload the patch kept and lets this person open, not just its name.
 */
export const servesFile = async (view: Opened, marker: string, act: () => Promise<void>) => {
  let served = false;
  const reads: Array<Promise<void>> = [];
  const watch = (response: { url: () => string; body: () => Promise<Buffer> }) => {
    if (!/\/api\/runtime\/(files|file-handles|shared-files)\//.test(response.url())) return;
    reads.push(
      response.body().then(
        (body) => {
          if (body.includes(marker)) served = true;
        },
        () => undefined
      )
    );
  };
  view.page.on("response", watch);
  await act();
  // A preview the page fetches as it renders can come a while after the click.
  for (let waited = 0; !served && waited < 8_000; waited += POLL_MS) {
    await Promise.all(reads);
    if (!served) await view.page.waitForTimeout(POLL_MS);
  }
  view.page.off("response", watch);
  await Promise.all(reads);
  return served;
};

const DECISIONS =
  "approved|rejected|declined|denied|pending|submitted|awaiting|waiting|in review|under review|needs approval";
const DECIDED = new RegExp(`\\b(${DECISIONS})\\b`, "i");
/** For finding the part: Playwright matches its `textContent`, where cells run together. */
const DECIDED_ANYWHERE = new RegExp(DECISIONS, "i");

/** A request's decision, from the words of the part of the page that shows it. */
export const decisionOf = (words: string): "approved" | "rejected" | "undecided" | null =>
  /\b(rejected|declined|denied)\b/i.test(words)
    ? "rejected"
    : /\bapproved\b/i.test(words) && !/\bnot (yet )?approved\b/i.test(words)
      ? "approved"
      : DECIDED.test(words)
        ? "undecided"
        : null;

/** The decision the innermost part holding `text` and a decision's words shows; null for none. */
export const decisionShown = async (view: Opened, text: string) => {
  const part = around(view.frame, text, { hasText: DECIDED_ANYWHERE });
  return (await part.count()) === 0 ? null : decisionOf(await part.innerText());
};
