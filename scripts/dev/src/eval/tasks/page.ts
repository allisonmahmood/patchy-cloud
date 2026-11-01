/**
 * What checks do in a person's browser without knowing the page's layout:
 * find a field by what its label or placeholder says, find the innermost part
 * of the page holding some words and a control, wait for words to show, and
 * read a request's decision from the words around it.
 */
import type { FrameLocator, Locator } from "@playwright/test";
import type { Opened } from "../task.js";

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

/**
 * The first visible field a person types into whose label, placeholder or
 * accessible name says `words` and which is still empty, so a field already
 * filled isn't picked twice.
 */
export const emptyField = async (frame: FrameLocator, words: RegExp) => {
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
        (await field.inputValue().catch(() => "-")) === ""
      )
        return field;
  return undefined;
};

/**
 * The part of the page a form lives in, the innermost one holding `field` and
 * a button that sends it, and that button: its most specific name first, the
 * last of them, since a dialog's comes after the page's own.
 */
export const formAround = async (frame: FrameLocator, field: Locator) => {
  for (const name of [/submit/i, /send/i, /save/i, /create/i, /request/i, /add/i, /done/i]) {
    const scope = frame
      .locator("body *")
      .filter({ has: field })
      .filter({ has: frame.getByRole("button", { name }) })
      .last();
    if ((await scope.count()) === 0) continue;
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

const APPROVE = /^\s*approve\b/i;

/**
 * Approves the request holding `text` the way a person would: its own
 * Approve button, or the one in whatever opens when they click it, then a
 * dialog's confirmation if one asks. False when they found none to press.
 * A part holding more than one Approve isn't the request's own.
 */
export const approve = async (view: Opened, text: string) => {
  const { frame, page } = view;
  const own = async () => {
    const part = around(frame, text, { has: frame.getByRole("button", { name: APPROVE }) });
    const buttons = part.getByRole("button", { name: APPROVE });
    return (await part.count()) > 0 && (await buttons.count()) === 1 ? buttons : undefined;
  };
  let button = await own();
  if (button === undefined) {
    await frame.getByText(text).first().click();
    await page.waitForTimeout(1_000);
    button = await own();
  }
  if (button === undefined || !(await button.isVisible()) || !(await button.isEnabled()))
    return false;
  await button.click();
  await page.waitForTimeout(1_000);
  const confirm = frame
    .getByRole("dialog")
    .getByRole("button", { name: /^\s*(approve|confirm|yes)\b/i });
  if ((await confirm.count()) > 0 && (await confirm.first().isVisible()))
    await confirm.first().click();
  await page.waitForTimeout(2_000);
  return true;
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
