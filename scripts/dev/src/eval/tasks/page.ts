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
import type { ElementHandle, FrameLocator, Locator, Route } from "@playwright/test";
import { GraderTrouble, type Opened, type RunPerson } from "../task.js";

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
 * A control's name as a view's: without counts, badges, parentheticals or
 * punctuation, lowercased, so "Review (admin) 3" reads as "review".
 */
export const viewName = (name: string) =>
  name
    .replace(/\(.*?\)/g, " ")
    .replace(/[^\p{L}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Names that are views of a list and nothing else, a whole name each: all
 * of it, someone's own, a team's, an inbox or queue. Pressed wherever they
 * appear.
 */
export const VIEW_NOUNS =
  /^(all|all \p{L}+|everything|everyone|mine|my \p{L}+( \p{L}+)?|team|team \p{L}+|inbox|queue|history|requests|approvals|recent)$/u;

/**
 * Statuses, a whole name each. Alone, a button so named can be an action,
 * such as Paid for "mark as paid", Done for "finish" or Review for "start a
 * review"; one is pressed only where it is plainly a filter (`inFilterBar`).
 */
export const VIEW_STATUSES =
  /^(open|pending|waiting|in review|review|reviews|to review|to approve|needs? (my )?(approval|review)|awaiting( my)? (approval|review)|approved|rejected|declined|decided|paid|done|closed|completed|archived|submitted|sent|received|active)$/u;

/**
 * Whether a name says to do something rather than which view to show: it
 * holds a verb that changes data, or leads with a verb and names its object,
 * as "Open request" or "New request" do. Read with its asides too, so "Review
 * (submit)" can't hide its action in parentheses.
 */
export const actionShaped = (name: string) =>
  [name.toLowerCase(), viewName(name)].some(
    (words) =>
      /\b(approve|reject|decline|deny|accept|withdraw|delete|remove|trash|archive|discard|clear|reset|submit|send|save|create|new|add|lend|give|thank|react|like|favou?rite|star|pin|follow|watch|subscribe|mute|bookmark|flag|vote|pay|mark|assign|move|transfer|publish|share|invite|upload|import|load|cancel|confirm|undo|restore|return|back|sign out|log out|leave|join|edit|rename|update|duplicate|copy|close|dismiss)\b/u.test(
        words
      ) ||
      /^(open|new|add|create|view|show|start|request|upload|download|export|print|compose|write|ask|apply|book|schedule|report|record|log) \p{L}/u.test(
        words
      )
  );

/** A control a search for a view might press, as found on the page. */
export interface Control {
  /** Its accessible name: its label, its title, or its text. */
  readonly name: string;
  readonly tab: boolean;
  /** It carries `aria-selected` or `aria-current`: a selection or a place, as views are. */
  readonly selection: boolean;
  /** A button that would submit the form it belongs to. */
  readonly submitsForm: boolean;
  readonly shown: boolean;
  /**
   * The names of the other controls grouped with it: under the same parent,
   * or in the same tablist, radio group, toolbar or `nav`.
   */
  readonly peers: ReadonlyArray<string>;
}

/** The most views a search for one tries. */
const MAX_TRIES = 20;

/** Whether a name is a view's, a noun or a status, and not an action's. */
const viewNamed = (name: string) => {
  const words = viewName(name);
  return (VIEW_NOUNS.test(words) || VIEW_STATUSES.test(words)) && !actionShaped(name);
};

/**
 * Whether a control sits in a filter bar: grouped with another control named
 * for a view, and with nothing named for an action, as a row of a request's
 * buttons would be.
 */
export const inFilterBar = (control: Control) =>
  control.peers.some(viewNamed) && !control.peers.some(actionShaped);

/**
 * Whether a control is a view by its role or state, and so safe to press:
 * a tab; a selection or a place whose name isn't action-shaped; a control
 * named for a view noun; or one named for a status that is plainly a filter.
 * Never a hidden control, nor one that submits a form. Anything else could
 * change data, so a search for a view never presses it, even if that means
 * not finding a list only an unusual control shows.
 */
export const isViewControl = (control: Control) => {
  if (!control.shown || control.submitsForm) return false;
  if (control.tab) return true;
  const words = viewName(control.name);
  if (words === "" || actionShaped(control.name)) return false;
  if (control.selection || VIEW_NOUNS.test(words)) return true;
  return VIEW_STATUSES.test(words) && inFilterBar(control);
};

/** Which controls to try, by index: the views among them, All first, at most `MAX_TRIES`. */
export const viewCandidates = (controls: ReadonlyArray<Control>) =>
  controls
    .map((control, index) => ({ control, index }))
    .filter(({ control }) => isViewControl(control))
    .sort(
      (a, b) =>
        Number(!/^all\b/.test(viewName(a.control.name))) -
          Number(!/^all\b/.test(viewName(b.control.name))) || a.index - b.index
    )
    .slice(0, MAX_TRIES)
    .map(({ index }) => index);

const CONTROLS =
  'button, a[href], [role="tab"], [role="button"], [role="link"], [aria-pressed], [aria-selected], [aria-current]';

/**
 * What a search for a view reads of one control, in the page: its name, its
 * role and state, whether it's shown, and the names of the controls grouped
 * with it. Run in the page, so it stays self-contained.
 */
const readControl = (element: Element, selector: string): Control => {
  const nameOf = (each: Element) =>
    (
      each.getAttribute("aria-label") ??
      each.getAttribute("title") ??
      (each instanceof HTMLElement ? each.innerText : (each.textContent ?? ""))
    ).trim();
  const group = element.closest('[role="tablist"], [role="radiogroup"], [role="toolbar"], nav');
  const peers = [...element.ownerDocument.querySelectorAll(selector)].filter(
    (other) =>
      other !== element &&
      (other.parentElement === element.parentElement || (group !== null && group.contains(other)))
  );
  return {
    name: nameOf(element),
    tab: element.getAttribute("role") === "tab",
    selection: element.hasAttribute("aria-selected") || element.hasAttribute("aria-current"),
    submitsForm:
      element instanceof HTMLButtonElement && element.form !== null && element.type === "submit",
    shown:
      element.isConnected &&
      element.getClientRects().length > 0 &&
      (element instanceof HTMLElement ? getComputedStyle(element).visibility !== "hidden" : true),
    peers: peers.map(nameOf)
  };
};

/** Every control on the patch's page, each with the handle to its very element and what it reads. */
const controlsOf = async (view: Opened) => {
  const handles = await view.frame.locator(CONTROLS).elementHandles();
  const read = await Promise.all(
    handles.map((handle) => handle.evaluate(readControl, CONTROLS).catch(() => undefined))
  );
  return handles.flatMap((handle, index) => {
    const control = read[index];
    return control === undefined ? [] : [{ handle, control }];
  });
};

const SETTLE_MS = 500;
const SETTLE_CAP_MS = 10_000;
const SETTLE_POLL_MS = 100;

/**
 * Waits for the page to settle, as a person waits for it to finish loading:
 * no "Loading" in its text, and nothing changing for half a second; at most
 * ten seconds.
 */
export const settle = async (view: Opened) => {
  let last = "";
  for (let waited = 0, still = 0; waited < SETTLE_CAP_MS; waited += SETTLE_POLL_MS) {
    const now = await view.frame
      .locator("body")
      .evaluate(
        (body) =>
          `${body.querySelectorAll("*").length}|${body instanceof HTMLElement ? body.innerText : body.textContent}`
      )
      .catch(() => "");
    still = now === last && !/\bloading\b/i.test(now) ? still + SETTLE_POLL_MS : 0;
    if (still >= SETTLE_MS) return;
    last = now;
    await view.page.waitForTimeout(SETTLE_POLL_MS);
  }
};

/** The view a search found a request under, by its control's name, to go straight back to. */
export interface ViewMemo {
  via?: string;
}

/** A control's name as its identity: as shown, spaces collapsed, so "Tab 2" isn't "Tab 3". */
const named = (name: string) => name.replace(/\s+/g, " ").trim();

/** The whole names a dialog's own dismissal goes by; nothing with more words, such as "Cancel request". */
export const DISMISSAL = /^\s*(close|cancel|dismiss|×|✕)\s*$/i;

/**
 * Closes a dialog a view's press opened anyway: Escape, then the dialog's own
 * dismissal, a control whose whole name is Close, Cancel, Dismiss or ×.
 * Nothing else is pressed, so a dialog that offers only more actions stays
 * open; whether it closed.
 */
const dismiss = async (view: Opened, before: number) => {
  const dialogs = view.frame.getByRole("dialog");
  await view.page.keyboard.press("Escape");
  await settle(view);
  if ((await dialogs.count()) <= before) return true;
  const own = dialogs
    .last()
    .locator('button, [role="button"]')
    .filter({ hasText: DISMISSAL })
    .or(dialogs.last().locator('[aria-label="Close" i]'));
  for (const handle of await own.elementHandles()) {
    const name = await handle
      .evaluate((element) =>
        element instanceof Element
          ? (element.getAttribute("aria-label") ?? element.textContent ?? "").trim()
          : ""
      )
      .catch(() => "");
    if (!DISMISSAL.test(name)) continue;
    await handle.click({ timeout: 2_000 }).catch(() => undefined);
    await settle(view);
    if ((await dialogs.count()) <= before) return true;
  }
  return false;
};

/**
 * Presses one vetted control, by its very element: just before the click it
 * must still be in the page and still read as the view it was vetted as, and
 * a click that can't reach that element is abandoned, never redirected to
 * whatever has taken its place. A press that opens a dialog is undone and
 * isn't the view; "stuck" when that dialog couldn't be closed safely.
 */
const press = async (
  view: Opened,
  chosen: { readonly handle: ElementHandle; readonly control: Control }
): Promise<"pressed" | "skipped" | "stuck"> => {
  const now = await chosen.handle.evaluate(readControl, CONTROLS).catch(() => undefined);
  if (now === undefined || !isViewControl(now) || named(now.name) !== named(chosen.control.name))
    return "skipped";
  const dialogs = view.frame.getByRole("dialog");
  const before = await dialogs.count();
  const clicked = await chosen.handle.click({ timeout: 2_000 }).then(
    () => true,
    () => false
  );
  await settle(view);
  if ((await dialogs.count()) > before) return (await dismiss(view, before)) ? "skipped" : "stuck";
  return clicked ? "pressed" : "skipped";
};

/**
 * The view control to press for `name`: the one so named, or failing that
 * one whose view name reads the same, as "Pending 2" does after "Pending 3".
 */
const viewFor = async (view: Opened, name: string) => {
  const controls = (await controlsOf(view)).filter(({ control }) => isViewControl(control));
  return (
    controls.find(({ control }) => named(control.name) === name) ??
    controls.find(({ control }) => viewName(control.name) === viewName(name))
  );
};

/**
 * Whether `text` shows, on the starting view or behind the page's tabs and
 * view toggles, found as a person would look: the controls that are views by
 * their role or state (`isViewControl`), All first, one at a time, from
 * wherever the last left the page. It presses nothing else, so it can miss
 * a list only an unusual control shows; that's a visible failure, never a
 * changed request. A dialog it can't close safely ends the search. With
 * `memo`, a view it found the text under before is pressed first, one
 * click, and the view it finds is remembered.
 */
export const reveal = async (view: Opened, text: string, memo?: ViewMemo) => {
  await settle(view);
  if (await shows(view, text, 1_000)) return true;
  if (memo?.via !== undefined) {
    const remembered = await viewFor(view, memo.via);
    const pressed = remembered === undefined ? "skipped" : await press(view, remembered);
    if (pressed === "stuck") return false;
    if (pressed === "pressed" && (await shows(view, text, 1_000))) return true;
  }
  const tried = new Set<string>();
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const controls = await controlsOf(view);
    const next = viewCandidates(controls.map(({ control }) => control))
      .map((index) => controls[index]!)
      .find(({ control }) => !tried.has(named(control.name)));
    if (next === undefined) break;
    tried.add(named(next.control.name));
    const pressed = await press(view, next);
    if (pressed === "stuck") return false;
    if (pressed === "pressed" && (await shows(view, text, 1_000))) {
      if (memo !== undefined) memo.via = named(next.control.name);
      return true;
    }
  }
  return false;
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

/** A refusal, or a handler's answer; `at` is when Patchy answered, from its `Date` header. */
export type RuntimeAnswer = { readonly at: string | null } & (
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly byHandler: boolean; readonly code: string }
);

/**
 * Sends one runtime operation as `person`, from their own signed-in page, as
 * their shell would. Patchy not answering, or answering in a shape that
 * isn't a reply, throws `GraderTrouble`; its message never carries the
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
      throw new GraderTrouble({
        what: `The grader's call as ${person.name} didn't reach Patchy.`,
        cause
      });
    });
  const reply = decodeReply(await response.text().catch(() => ""));
  if (Option.isNone(reply))
    throw new GraderTrouble({
      what: `Patchy answered the grader's call as ${person.name} with HTTP ${response.status()}.`
    });
  const at = response.headers()["date"] ?? null;
  return reply.value.ok
    ? { at, ok: true, value: reply.value.value }
    : {
        at,
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
 * A call a page sent that the grader holds back, to send the same call as
 * someone else first: a check's way of trying a rule against the server.
 */
export interface HeldCall {
  /** The page's handler it calls; null for a table operation. */
  readonly handler: string | null;
  /** Sends the same call as `person`, from `view`, their own signed-in page, with a key of its own. */
  readonly tryAs: (view: Opened, person: RunPerson) => Promise<RuntimeAnswer>;
}

/**
 * A change key for `person` beside a page's own: the same time, and a token
 * of theirs in the 22 characters Patchy's keys have.
 */
export const keyFor = (key: string, person: RunPerson) => {
  const dash = key.indexOf("-");
  return `${key.slice(0, dash)}-${`${person.key}${key.slice(dash + 1)}`.slice(0, 22)}`;
};

const holding = (owner: Opened, route: Route): HeldCall | undefined => {
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
      )
  };
};

const DECISION_BUTTONS = {
  approve: /^\s*approve\b/i,
  reject: /^\s*(reject|decline|deny)\b/i
} as const;

/** How long a press may take, from the click, to make its decision take effect. */
const DECISION_MS = 60_000;
/** The most calls one press may send before the grader stops holding them. */
const MAX_CALLS = 12;
/**
 * How long a call may stay held while the check tries it. The shell gives a
 * server call 110 s (`serverReplyTimeoutMs`) before giving up on it, so past
 * this its release would come too late to count.
 */
const HELD_MS = 90_000;

/** How a check follows a decision's calls: trying each first, and telling when it took. */
export interface DecisionWatch {
  /** Tries a held call as others first; an objection fails the check, leaving the call held. */
  readonly probe: (call: HeldCall) => Promise<string | null>;
  /** Whether the decision has taken effect, asked after each held call has been answered. */
  readonly took: () => Promise<boolean>;
}

/**
 * Decides on the request holding `text` the way a person would: fills in
 * any words its part of the page asks for, such as why, presses its own
 * Approve (or Reject), or the one in whatever opens when they click it, and
 * answers every dialog the press opens, filling in any words it wants. A
 * part holding more than one such button isn't the request's own.
 *
 * With `watch`, every call the press sends Patchy, other than plain reads,
 * is held back in turn and handed to `watch.probe` before it goes through,
 * however long the page waits between calls, until a call's answer makes
 * the decision take effect: that call was the decision, and it was tried
 * first. A query the page asks first doesn't stand in for it, and a quiet
 * spell doesn't end the watch. `took` is false when the decision didn't take
 * effect through a held call within a minute of the press, so the check
 * can't say the decision itself was tried. Answers how many calls were held,
 * whether the decision took, and the first objection, which leaves its call
 * held; null when there was nothing to press.
 */
export const decide = async (
  view: Opened,
  text: string,
  which: keyof typeof DECISION_BUTTONS,
  watch?: DecisionWatch
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
  const held: Array<{ readonly route: Route; readonly at: number }> = [];
  if (watch !== undefined)
    await page.route("**/api/runtime/call", async (route) => {
      const call = decodeCall(route.request().postData() ?? "");
      if (Option.isSome(call) && !READS.has(call.value.op))
        held.push({ route, at: performance.now() });
      else await route.continue();
    });
  const dialogs = await frame.getByRole("dialog").count();
  let answered = 0;
  /** Answers a dialog the press opened since, asking for a reason or a confirmation. */
  const answerDialog = async () => {
    const open = await frame.getByRole("dialog").count();
    if (open <= dialogs + answered) return;
    answered = open - dialogs;
    const dialog = frame.getByRole("dialog").last();
    await fillRest(dialog);
    const confirm = dialog.getByRole("button", {
      name: new RegExp(`${name.source}|^\\s*(confirm|yes)\\b`, "i")
    });
    if ((await confirm.count()) > 0) await confirm.last().click();
  };
  await button.click();
  await page.waitForTimeout(1_000);
  await answerDialog();
  if (watch === undefined) {
    await page.waitForTimeout(2_000);
    return { held: 0, took: true, objection: null };
  }
  let count = 0;
  let took = false;
  // Measured in waits, since the probes between them take time of their own.
  for (let waited = 0; !took && count < MAX_CALLS && waited < DECISION_MS;) {
    const next = held.shift();
    if (next === undefined) {
      await page.waitForTimeout(POLL_MS);
      waited += POLL_MS;
      await answerDialog();
      continue;
    }
    count++;
    const { route, at } = next;
    const call = holding(view, route);
    const objection = call === undefined ? null : await watch.probe(call);
    if (objection !== null) return { held: count, took: false, objection };
    if (performance.now() - at > HELD_MS)
      throw new GraderTrouble({
        what: "Trying one of Ada's calls as members took longer than her browser waits for it."
      });
    await route.continue();
    // Its answer, so the decision it makes has happened before `took` looks.
    await route
      .request()
      .response()
      .catch(() => null);
    await answerDialog();
    took = await watch.took();
  }
  await page.unroute("**/api/runtime/call");
  await page.waitForTimeout(1_000);
  return { held: count, took, objection: null };
};

/** Whether a response is a file Patchy served a page: its bytes, not a refusal. */
export const isFileResponse = (url: string, ok: boolean) =>
  ok && /\/api\/runtime\/(files|file-handles|shared-files)\//.test(url);

/**
 * Whether Patchy serves `view` a file whose bytes are exactly `bytes` while
 * `act` runs: an upload the patch kept whole and lets this person open, not
 * its name or a copy of it in other words.
 */
export const servesFile = async (view: Opened, bytes: Buffer, act: () => Promise<void>) => {
  let served = false;
  const reads: Array<Promise<void>> = [];
  const watch = (response: {
    url: () => string;
    ok: () => boolean;
    body: () => Promise<Buffer>;
  }) => {
    if (!isFileResponse(response.url(), response.ok())) return;
    reads.push(
      response.body().then(
        (body) => {
          if (body.equals(bytes)) served = true;
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
