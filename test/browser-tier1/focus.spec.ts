import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Frame, Locator, Page } from "@playwright/test";
import { generateClient } from "../../packages/sdk/src/generateClient.js";
import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, open } from "./fixtures.js";

// Keys go to the focused document, so a patch hears them only once the shell hands it focus.
// Nothing here clicks the patch: a click would focus its frame on its own.
const counter = `<!doctype html><html><head><title>Key counter</title></head><body><h1>Key counter</h1><p id="keys">0</p><script>
addEventListener("keydown", () => {
  const keys = document.getElementById("keys");
  keys.textContent = String(Number(keys.textContent) + 1);
});
</script></body></html>`;
const keys = (page: Page) => page.frameLocator("#patch").locator("#keys");

test("a patch hears the keyboard once its frame loads", async ({ page, instance }) => {
  const patch = await instance.publish("company", counter, undefined, {
    tier: 1,
    tables: {},
    files: {}
  });
  // The shell's load follows its frame's.
  await page.goto(patch.address);
  await page.keyboard.press("ArrowDown");
  await expect(keys(page)).toHaveText("1");
});

test("a key pressed before the frame's load event still reaches the patch", async ({
  page,
  instance
}) => {
  const patch = await instance.publish("company", counter, undefined, {
    tier: 1,
    tables: {},
    files: {}
  });
  // A patch can be on screen and listening before its frame's load event, which waits on the
  // patch's last subresource. Withholding that event from the shell holds the gap open.
  await page.addInitScript(() => {
    document.addEventListener(
      "load",
      (event) => {
        if (event.target instanceof HTMLIFrameElement) event.stopImmediatePropagation();
      },
      true
    );
  });
  await page.goto(patch.address);
  await page.keyboard.press("ArrowDown");
  await expect(keys(page)).toHaveText("1");
});

test("shell UI that holds focus before the frame loads keeps it", async ({ page, instance }) => {
  const patch = await instance.publish("company", counter, undefined, {
    tier: 1,
    tables: {},
    files: {}
  });
  const content = Promise.withResolvers<void>();
  await page.route("**/~content/**", async (route) => {
    await content.promise;
    await route.continue();
  });
  await page.goto(patch.address, { waitUntil: "domcontentloaded" });
  // Stands in for Patchy's own UI, such as a download card, focused while the frame loads.
  await page.evaluate(() => {
    const control = Object.assign(document.createElement("button"), { textContent: "Shell" });
    document.body.append(control);
    control.focus();
  });
  content.resolve();
  await page.waitForLoadState("load");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: "Shell" })).toBeFocused();
  await expect(keys(page)).toHaveText("0");
});

test("a tier 2 patch hears the keyboard on load and again once its starting cover clears", async ({
  page,
  instance
}) => {
  const server = await build({
    stdin: {
      contents: 'import { createGuest } from "patchy/server"; export default createGuest({});',
      resolveDir: fileURLToPath(new URL("../../packages/patchy", import.meta.url))
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm"
  });
  const patch = await instance.publish(
    "company",
    counter,
    undefined,
    { tier: 2, tables: {}, files: {}, uses: {}, handlers: {} },
    { server: server.outputFiles[0]!.text }
  );
  instance.holdStreamFrames(true);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.goto(patch.address);
  await page.keyboard.press("ArrowDown");
  await expect(keys(page)).toHaveText("1");
  const cover = page.getByRole("dialog", { name: "Starting your tools" });
  await page.clock.fastForward(2_000);
  await expect(cover).toBeFocused();
  await page.clock.resume();
  instance.holdStreamFrames(false);
  await expect(cover).toBeHidden();
  await page.keyboard.press("ArrowDown");
  await expect(keys(page)).toHaveText("2");
});

/** Counts the keys the fixture page hears from now on. */
async function keyCounter(frame: Frame) {
  await frame.evaluate(() => {
    const host = window as unknown as { keys: number };
    host.keys = 0;
    addEventListener("keydown", () => host.keys++);
  });
  return () => frame.evaluate(() => (window as unknown as { keys: number }).keys);
}
/**
 * Once the shell has handed focus back to the patch's frame, the next key reaches the patch, so
 * its count is `expected`. It waits for the frame first: a hand-back's second try is a task
 * away, and Chromium runs input ahead of it.
 */
async function nextKeyReaches(page: Page, heard: () => Promise<number>, expected: number) {
  await expect(page.locator("#patch")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect.poll(heard).toBe(expected);
}
// A person's press: a click, or Enter or Space once the button has focus. Enter presses a
// button on keydown and Space on keyup.
const presses = ["click", "Enter", "Space"] as const;
async function press(page: Page, button: Locator, how: (typeof presses)[number]) {
  if (how === "click") return button.click();
  await button.focus();
  await page.keyboard.press(how);
}
const pressed = (how: (typeof presses)[number]) =>
  how === "click" ? "clicked" : `pressed with ${how}`;
/** Stands in for Patchy's own UI, such as another card, holding focus. */
async function shellControl(page: Page) {
  await page.evaluate(() => {
    const control = Object.assign(document.createElement("button"), { textContent: "Shell" });
    document.body.append(control);
    control.focus();
  });
  return page.getByRole("button", { name: "Shell", exact: true });
}
/**
 * Makes the shell's next `frame.focus()` miss, as Firefox's does during the key event that
 * pressed a button, so the hand-back's second try runs in any browser. With `moveTo`, the miss
 * focuses that shell control instead, as a person might before the second try.
 */
const missNextFrameFocus = (page: Page, moveTo?: string) =>
  page.evaluate((moveTo) => {
    const frame = document.querySelector<HTMLIFrameElement>("#patch")!;
    // An own property over the prototype's method, gone after its one call.
    frame.focus = () => {
      Reflect.deleteProperty(frame, "focus");
      if (moveTo !== undefined)
        [...document.querySelectorAll("button")]
          .find((button) => button.textContent === moveTo)
          ?.focus();
    };
  }, moveTo);

test("the next key reaches the patch after the new-version bar's Not now or Hide, clicked or pressed", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const frame = await open(page, patch);
  const heard = await keyCounter(frame);
  await page.keyboard.press("ArrowDown");
  await expect.poll(heard).toBe(1);
  const bar = page.getByText(/^A new version of .+ is available\.$/);
  const nextVersion = async () => {
    await instance.publish("company", instance.html, patch.patchId);
    await expect(bar).toBeVisible();
  };
  let expected = 1;
  for (const name of ["Not now", "Hide"] as const) {
    for (const how of presses) {
      await test.step(`${name}, ${pressed(how)}`, async () => {
        await nextVersion();
        await press(page, page.getByRole("button", { name, exact: true }), how);
        await expect(bar).toBeHidden();
        await nextKeyReaches(page, heard, ++expected);
      });
    }
  }

  await test.step("a first try that misses is made again once the press is over", async () => {
    await nextVersion();
    await missNextFrameFocus(page);
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(bar).toBeHidden();
    await nextKeyReaches(page, heard, ++expected);
  });

  await test.step("a press that moves no focus leaves it on the shell control that has it", async () => {
    await nextVersion();
    const control = await shellControl(page);
    // dispatchEvent presses Not now without moving focus to it.
    await page.getByRole("button", { name: "Not now", exact: true }).dispatchEvent("click");
    await expect(bar).toBeHidden();
    await expect(control).toBeFocused();
  });

  await test.step("focus moved to another shell control between the two tries stays there", async () => {
    await nextVersion();
    await missNextFrameFocus(page, "Shell");
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(bar).toBeHidden();
    const control = page.getByRole("button", { name: "Shell", exact: true });
    await expect(control).toBeFocused();
    // Past the second try's task.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
    await expect(control).toBeFocused();
  });
});

test("the next key reaches the patch after a download card's Download, Not now or Dismiss, clicked or pressed", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const frame = await open(page, patch);
  const heard = await keyCounter(frame);
  const cards = page.locator(".shell-corner");
  // Over the download limit, the card is a refusal with Dismiss instead of Download and Not now.
  const offer = async (name: string, refused: boolean) => {
    await frame.evaluate(
      ({ name, size }) => {
        void (window as unknown as FixtureWindow).harness.client
          .download(name, new Uint8Array(size))
          .catch(() => {});
      },
      { name, size: refused ? 21 * 1024 * 1024 : 3 }
    );
    const card = cards.getByRole("region", { name, exact: true });
    await expect(card).toBeVisible();
    return card;
  };
  let expected = 0;
  for (const name of ["Download", "Not now", "Dismiss"] as const) {
    for (const how of presses) {
      await test.step(`${name}, ${pressed(how)}`, async () => {
        const card = await offer(`${name} ${how}.bin`, name === "Dismiss");
        const downloaded = name === "Download" ? page.waitForEvent("download") : undefined;
        await press(page, card.getByRole("button", { name, exact: true }), how);
        await downloaded;
        await expect(card).toHaveCount(0);
        await nextKeyReaches(page, heard, ++expected);
      });
    }
  }

  await test.step("a press that moves no focus leaves it on the shell control that has it", async () => {
    const card = await offer("elsewhere.bin", false);
    const control = await shellControl(page);
    // dispatchEvent presses Not now without moving focus to it; Download ignores a script's click.
    await card.getByRole("button", { name: "Not now", exact: true }).dispatchEvent("click");
    await expect(card).toHaveCount(0);
    await expect(control).toBeFocused();
  });
});

test("the next key reaches the patch after the single-key shortcuts dialog closes, by its buttons clicked or pressed, Escape or mid-save", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const dialog = page.getByRole("dialog", {
    name: /^Turn o(n|ff) single-key shortcuts in every patch except public ones\?$/
  });
  const confirm = dialog.getByRole("button", { name: /^Turn o(n|ff)$/ });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  let asked = 0;
  // A fresh load for each, so the press that closed the last dialog needn't lapse first.
  const openDialog = async () => {
    const frame = await open(page, patch);
    const heard = await keyCounter(frame);
    // The dialog opens only on a press, as on a row of the patch's sheet.
    await frame.locator("h1").click();
    await frame.evaluate(
      ({ wire, id }) =>
        (window as unknown as FixtureWindow).harness.raw({
          v: wire,
          id,
          op: "shortcuts.setting",
          args: {}
        }),
      { wire: instance.wire, id: `ask-${++asked}` }
    );
    await expect(dialog).toBeVisible();
    return heard;
  };
  const keyReaches = async (heard: () => Promise<number>) => {
    await expect(dialog).toHaveCount(0);
    await nextKeyReaches(page, heard, 1);
  };
  // Holds the dialog's save at the route until the step lets it through.
  const holdSave = async () => {
    const held = Promise.withResolvers<void>();
    const go = Promise.withResolvers<void>();
    const through = Promise.withResolvers<void>();
    await page.route("**/api/me/shortcuts", async (route) => {
      held.resolve();
      await go.promise;
      await route.continue();
      through.resolve();
    });
    return {
      held: held.promise,
      async release() {
        go.resolve();
        await through.promise;
        await page.unroute("**/api/me/shortcuts");
      }
    };
  };

  for (const [name, button] of [
    ["Turn on or off", confirm],
    ["Cancel", cancel]
  ] as const) {
    for (const how of presses) {
      await test.step(`${name}, ${pressed(how)}`, async () => {
        const heard = await openDialog();
        await press(page, button, how);
        await keyReaches(heard);
      });
    }
  }

  await test.step("Escape", async () => {
    const heard = await openDialog();
    await page.keyboard.press("Escape");
    await keyReaches(heard);
  });

  await test.step("a click on its backdrop leaves it open, and Escape then closes it", async () => {
    const heard = await openDialog();
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await keyReaches(heard);
  });

  for (const how of ["click", "Enter", "Space", "Escape"] as const) {
    await test.step(`mid-save, ${how === "Escape" ? "Escape" : `Cancel ${pressed(how)}`}`, async () => {
      const save = await holdSave();
      const heard = await openDialog();
      await confirm.click();
      await save.held;
      if (how === "Escape") await page.keyboard.press("Escape");
      else await press(page, cancel, how);
      await keyReaches(heard);
      await save.release();
    });
  }

  await test.step("a save that answers under the switcher leaves focus in the switcher", async () => {
    const save = await holdSave();
    await openDialog();
    await confirm.click();
    await save.held;
    await page.keyboard.press("ControlOrMeta+Shift+K");
    const search = page
      .getByRole("dialog", { name: "Go to" })
      .getByRole("combobox", { name: "Go to" });
    await expect(search).toBeFocused();
    await save.release();
    await expect(dialog).toHaveCount(0);
    await expect(search).toBeFocused();
  });
});

test("the next key reaches the patch after Dismiss on an older version's note, clicked or pressed", async ({
  page,
  instance
}) => {
  // A viewer with single-key shortcuts off sees the note on a version built before the setting,
  // as a single file is.
  await instance.platform.query(
    "UPDATE users SET single_key_shortcuts = false WHERE id = 'usr_dev'"
  );
  const dismiss = page.getByRole("button", { name: "Dismiss", exact: true });
  // Dismiss lasts for that patch on this device, so each press gets a patch of its own.
  const openNote = async () => {
    const frame = await open(page, await instance.publish());
    await expect(dismiss).toBeVisible();
    return keyCounter(frame);
  };
  for (const how of presses) {
    await test.step(`Dismiss, ${pressed(how)}`, async () => {
      const heard = await openNote();
      await press(page, dismiss, how);
      await expect(dismiss).toHaveCount(0);
      await nextKeyReaches(page, heard, 1);
    });
  }

  await test.step("a press that moves no focus leaves it on the shell control that has it", async () => {
    await openNote();
    const control = await shellControl(page);
    // dispatchEvent presses Dismiss without moving focus to it.
    await dismiss.dispatchEvent("click");
    await expect(dismiss).toHaveCount(0);
    await expect(control).toBeFocused();
  });
});

const packageRoot = fileURLToPath(new URL("../../packages/patchy", import.meta.url));

/**
 * A page's script bundled against the built patchy package, as a patch build bundles it, with
 * `./patchy/_generated/client.js` the client the SDK generates for a tier 1 repo.
 */
async function bundled(source: string): Promise<string> {
  const result = await build({
    stdin: { contents: source, loader: "tsx", resolveDir: packageRoot, sourcefile: "page.tsx" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    jsxImportSource: "patchy/preact",
    define: { "import.meta.env.DEV": "false" },
    plugins: [
      {
        name: "generated-client",
        setup(builder) {
          builder.onResolve({ filter: /_generated\/client\.js$/ }, () => ({
            path: "client.ts",
            namespace: "generated"
          }));
          builder.onResolve({ filter: /^\.\/manifest\.json$/ }, () => ({
            path: "manifest.json",
            namespace: "generated"
          }));
          builder.onLoad({ filter: /^client\.ts$/, namespace: "generated" }, () => ({
            contents: generateClient(),
            loader: "ts",
            resolveDir: packageRoot
          }));
          builder.onLoad({ filter: /^manifest\.json$/, namespace: "generated" }, () => ({
            contents: JSON.stringify({ tables: {}, files: {}, uses: {} }),
            loader: "json"
          }));
        }
      }
    ]
  });
  return result.outputFiles[0]!.text.replaceAll("</script", "<\\/script");
}

// A framework-free page's modal dialogs. Task is plain: common controls, with controls Tab skips
// after them, and Discard opens a plain dialog over it that comes first in the page. Slow's first
// field takes a quarter of a second to handle its focus. Sheltered is plain inside an inert
// container, whose inertness a modal dialog escapes. The rest each hold something that leaves
// Tab to the browser: a control that takes Tab, a date input's fields, a closed shadow root, a
// radio group, positive tabindex, a popover, a `display: contents` shadow host, an unseen editable
// region with a stop inside that shows, an image map, a dialog that scrolls, `reading-flow`, a
// `<details>` without its own summary, SVG that draws a link through `<use>`, a control made inert
// by CSS, and an option given a tabindex.
const dialogsBody = `<main>
<h1>Dialogs</h1>
<button id="open-task">New task</button>
<button id="open-notice">Notice</button>
<button id="open-notes">Notes</button>
<button id="open-dates">Dates</button>
<button id="open-component">Component</button>
<button id="open-choice">Choice</button>
<button id="open-taken">Taken</button>
<button id="open-positive">Positive</button>
<button id="open-slow">Slow</button>
<button id="open-popped">Popped</button>
<button id="open-contents">Contents</button>
<button id="open-editable">Editable</button>
<button id="open-mapped">Mapped</button>
<button id="open-scrolling">Scrolling</button>
<button id="open-flow">Flow</button>
<button id="open-folded">Folded</button>
<button id="open-drawn">Drawn</button>
<button id="open-dimmed">Dimmed</button>
<button id="open-listed">Listed</button>
<button id="open-sheltered">Sheltered</button>
</main>
<div inert><dialog id="sheltered" aria-label="Sheltered"><button id="sheltered-a">A</button><button id="sheltered-b">B</button></dialog></div>
<dialog id="confirm" aria-label="Discard the task?"><button id="yes">Yes</button><button id="no">No</button></dialog>
<dialog id="task" aria-label="New task">
<input id="title" aria-label="Title">
<select id="priority" aria-label="Priority"><option>Low</option><option>High</option></select>
<label><input id="urgent" type="checkbox"> Urgent</label>
<a id="help" href="#help">Help</a>
<button id="add">Add row</button>
<button id="discard">Discard</button>
<button id="close">Close</button>
<ul id="rows"></ul>
<button hidden>Hidden</button>
<button style="visibility: hidden">Invisible</button>
<button disabled>Disabled</button>
<div inert><button>Inert</button></div>
</dialog>
<dialog id="notice" aria-label="Saved"><p>Saved.</p></dialog>
<dialog id="notes-dialog" aria-label="Notes"><textarea id="notes" aria-label="Notes"></textarea><button id="notes-done">Done</button></dialog>
<dialog id="dates" aria-label="Due date"><button id="dates-first">Today</button><input id="due" type="date" aria-label="Due"></dialog>
<dialog id="component" aria-label="Component"><button id="component-first">First</button><closed-pair id="pair"></closed-pair></dialog>
<dialog id="choice" aria-label="Choice">
<input type="radio" name="pick" id="pick-1" aria-label="One">
<button id="choice-button">Neither</button>
<input type="radio" name="pick" id="pick-2" aria-label="Two" checked>
</dialog>
<dialog id="taken" aria-label="Taken"><button id="taken-1">One</button><button id="taken-2">Two</button></dialog>
<dialog id="positive" aria-label="Positive">
<button id="positive-second" tabindex="2">Second</button>
<button id="positive-first" tabindex="1">First</button>
<button id="positive-last">Last</button>
</dialog>
<dialog id="slow" aria-label="Slow"><input id="slow-first" aria-label="Name"><button id="slow-last">Save</button></dialog>
<dialog id="popped" aria-label="Popped">
<div popover id="tip"><button id="tip-button">In the popover</button></div>
<button id="popped-first">First</button>
<button id="popped-invoker" popovertarget="tip">More</button>
</dialog>
<dialog id="contents" aria-label="Contents"><button id="contents-first">First</button><div id="contents-host" style="display: contents"></div></dialog>
<dialog id="editable" aria-label="Editable">
<button id="editable-first">First</button>
<div contenteditable="true" aria-label="Notes" style="visibility: hidden"><span tabindex="0" id="editable-chip" style="visibility: visible">Chip</span></div>
</dialog>
<dialog id="mapped" aria-label="Mapped">
<button id="mapped-first">First</button>
<img usemap="#spots" alt="Spots" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
<map name="spots"><area id="spot" href="#spot" shape="rect" coords="0,0,40,40" alt="Spot"></map>
</dialog>
<dialog id="scrolling" aria-label="Scrolling" style="max-height: 160px">
<button id="scrolling-first">First</button><div style="height: 600px"></div><button id="scrolling-last">Last</button>
</dialog>
<dialog id="flow" aria-label="Flow">
<div style="display: flex; flex-direction: row-reverse; reading-flow: flex-visual">
<button id="flow-a">A</button><button id="flow-b">B</button><button id="flow-c">C</button>
</div>
</dialog>
<dialog id="folded" aria-label="Folded"><button id="folded-first">First</button><details><p>More</p></details></dialog>
<dialog id="drawn" aria-label="Drawn">
<svg width="40" height="40"><defs><a id="drawn-link" href="#drawn"><rect width="40" height="40"></rect></a></defs><use href="#drawn-link"></use></svg>
<button id="drawn-button">Button</button>
</dialog>
<dialog id="dimmed" aria-label="Dimmed"><button id="dimmed-cold" style="interactivity: inert">Cold</button><button id="dimmed-last">Last</button></dialog>
<dialog id="listed" aria-label="Listed">
<button id="listed-first">First</button>
<select id="listed-select" aria-label="Tags"><option>One</option><option tabindex="0">Two</option></select>
</dialog>`;
const dialogsScript = `// A framework-free page imports its generated client, whatever it uses of it.
import "./patchy/_generated/client.js";

const byId = (id: string) => document.getElementById(id)!;
const dialog = (id: string) => byId(id) as HTMLDialogElement;
const opens = (button: string, id: string, focus?: string) =>
  byId(button).addEventListener("click", () => {
    dialog(id).showModal();
    if (focus !== undefined) byId(focus).focus();
  });
opens("open-task", "task", "title");
opens("discard", "confirm", "yes");
opens("open-notice", "notice");
opens("open-notes", "notes-dialog", "notes");
opens("open-dates", "dates", "due");
opens("open-component", "component", "component-first");
opens("open-choice", "choice", "pick-2");
opens("open-taken", "taken", "taken-2");
opens("open-positive", "positive", "positive-last");
opens("open-slow", "slow", "slow-last");
opens("open-popped", "popped", "popped-first");
opens("open-contents", "contents", "contents-first");
opens("open-editable", "editable", "editable-first");
opens("open-mapped", "mapped", "mapped-first");
opens("open-scrolling", "scrolling", "scrolling-first");
opens("open-flow", "flow", "flow-c");
opens("open-folded", "folded", "folded-first");
opens("open-drawn", "drawn", "drawn-button");
opens("open-dimmed", "dimmed", "dimmed-last");
opens("open-listed", "listed", "listed-select");
opens("open-sheltered", "sheltered", "sheltered-a");
// A shadow host laid out as display: contents, its button after the dialog's.
byId("contents-host").attachShadow({ mode: "open" }).innerHTML = '<button>In the shadow root</button>';
// Each row's button removes its row, and the focus with it.
byId("add").addEventListener("click", () => {
  const rows = byId("rows");
  const row = document.createElement("li");
  const name = "Row " + (rows.children.length + 1);
  const button = Object.assign(document.createElement("button"), { id: "row-" + (rows.children.length + 1), textContent: name });
  button.addEventListener("click", () => row.remove());
  row.append(button);
  rows.append(row);
});
byId("close").addEventListener("click", () => dialog("task").close());
dialog("task").addEventListener("close", () => byId("rows").replaceChildren());
// An editor that indents takes Tab for itself, and leaves Shift+Tab alone.
byId("notes").addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || event.shiftKey) return;
  event.preventDefault();
  const notes = event.target as HTMLTextAreaElement;
  notes.setRangeText("\\t", notes.selectionStart, notes.selectionEnd, "end");
});
// A window listener the page adds after the SDK's, which takes Tab while Taken is open.
addEventListener("keydown", (event) => {
  if (event.key === "Tab" && dialog("taken").open) event.preventDefault();
});
// A quarter of a second's work as Slow's first field takes focus.
byId("slow-first").addEventListener("focus", () => {
  const until = performance.now() + 250;
  while (performance.now() < until);
});
// Two buttons in a closed shadow root; only the page itself can see which has focus.
let closedRoot: ShadowRoot | undefined;
customElements.define("closed-pair", class extends HTMLElement {
  constructor() {
    super();
    closedRoot = this.attachShadow({ mode: "closed" });
    closedRoot.innerHTML = '<button>X</button><button>Y</button>';
  }
});
// The last Tab, read once it has been dispatched: whether anything took it.
let lastTab: KeyboardEvent | undefined;
addEventListener("keydown", (event) => { if (event.key === "Tab") lastTab = event; }, true);
Object.assign(window, {
  closedFocus: () => closedRoot?.activeElement?.textContent ?? null,
  lastTabTaken: () => lastTab?.defaultPrevented ?? null
});
`;

// The patchy-hotkeys skill's Native <dialog>, with a field before its Close button.
const preactDialogScript = `import { render, useLayoutEffect, useRef, useState } from "patchy/preact";
import { HotkeyScope } from "patchy/hotkeys";

function Dialog(props: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    title.current?.focus();
    return () => element?.close();
  }, []);
  return (
    <HotkeyScope>
      <dialog ref={dialog} id="dialog" aria-label="New task" onCancel={props.close}>
        <input ref={title} id="title" aria-label="Title" />
        <button type="button" id="close" onClick={props.close}>Close</button>
      </dialog>
    </HotkeyScope>
  );
}

function App() {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" id="open" onClick={() => setOpen(true)}>New task</button>
      {open && <Dialog close={() => setOpen(false)} />}
    </main>
  );
}
render(<App />, document.getElementById("app")!);
`;

const pageHtml = async (body: string, script: string) =>
  `<!doctype html><html><head><title>Dialogs</title></head><body>${body}<script>${await bundled(script)}</script></body></html>`;

type Tab = readonly ["Tab" | "Shift+Tab", string];
/**
 * Presses each key in turn; after each, focus is on its element in the patch's frame, and the frame
 * still has it.
 */
async function tabsTo(page: Page, steps: ReadonlyArray<Tab>) {
  const view = page.frameLocator("#patch");
  for (const [key, selector] of steps) {
    await page.keyboard.press(key);
    await expect(view.locator(selector)).toBeFocused();
    await expect(page.locator("#patch")).toBeFocused();
  }
}
/**
 * Stands in for Patchy's own UI on either side of the patch's frame, such as its bar or a card,
 * where Tab out of the frame lands: the shell controls that kept Escape from reaching a patch's
 * dialog. Like those, they sit over the page, where a click reaches them.
 */
const shellAroundFrame = (page: Page) =>
  page.evaluate(() => {
    const control = (id: string, side: "left" | "right") => {
      const button = Object.assign(document.createElement("button"), { id, textContent: "Shell" });
      button.style.cssText = `position: fixed; bottom: 8px; ${side}: 8px;`;
      return button;
    };
    const frame = document.getElementById("patch")!;
    frame.before(control("shell-before", "left"));
    frame.after(control("shell-after", "right"));
  });
/** Past a slow handler and any task a hand-back could wait for. */
const settled = (page: Page) =>
  page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)));

test("Tab stays inside a modal dialog of a page on the generated client, and Escape still closes it", async ({
  page,
  instance,
  browserName
}) => {
  const patch = await instance.publish("company", await pageHtml(dialogsBody, dialogsScript));
  await page.goto(patch.address);
  await shellAroundFrame(page);
  const view = page.frameLocator("#patch");
  const closes = async (dialog: string) => {
    await page.keyboard.press("Escape");
    await expect(view.locator(dialog)).toBeHidden();
  };
  // Where focus may have left the frame, the dialog closes without a key.
  const closeOpen = () =>
    view
      .locator("dialog[open]")
      .evaluateAll((dialogs: HTMLDialogElement[]) => dialogs.reverse().forEach((d) => d.close()));
  // The browser moves focus for a Tab the helper leaves alone, exactly as without it: nothing took
  // the key.
  const leftAlone = async (key: "Tab" | "Shift+Tab") => {
    await page.keyboard.press(key);
    expect(
      await view
        .locator("body")
        .evaluate(() => (window as unknown as { lastTabTaken(): boolean | null }).lastTabTaken())
    ).toBe(false);
  };
  // Firefox stops on a modal dialog itself, ahead of what it holds, so Shift+Tab from its first
  // control gets there first: the browser's move, inside the dialog.
  const itself = (dialog: string): ReadonlyArray<Tab> =>
    browserName === "firefox" ? [["Shift+Tab", dialog]] : [];

  await test.step("both ways round its controls, past the ones Tab skips", async () => {
    await view.locator("#open-task").click();
    await expect(view.locator("#title")).toBeFocused();
    await tabsTo(page, [
      ["Tab", "#priority"],
      ["Tab", "#urgent"],
      ["Tab", "#help"],
      ["Tab", "#add"],
      ["Tab", "#discard"],
      ["Tab", "#close"],
      ["Tab", "#title"],
      ...itself("#task"),
      ["Shift+Tab", "#close"],
      ["Shift+Tab", "#discard"],
      ["Tab", "#close"],
      ["Tab", "#title"]
    ]);
    await closes("#task");
  });

  await test.step("with rows added while it is open", async () => {
    await view.locator("#open-task").click();
    await view.locator("#add").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await tabsTo(page, [
      ["Tab", "#discard"],
      ["Tab", "#close"],
      ["Tab", "#row-1"],
      ["Tab", "#row-2"],
      ["Tab", "#title"],
      ...itself("#task"),
      ["Shift+Tab", "#row-2"]
    ]);
    await closes("#task");
  });

  await test.step("in a dialog opened over it, though that one comes first in the page", async () => {
    await view.locator("#open-task").click();
    await view.locator("#discard").focus();
    await page.keyboard.press("Enter");
    await expect(view.locator("#yes")).toBeFocused();
    await tabsTo(page, [
      ["Tab", "#no"],
      ["Tab", "#yes"],
      ...itself("#confirm"),
      ["Shift+Tab", "#no"]
    ]);
    await closes("#confirm");
    await expect(view.locator("#task")).toBeVisible();
    await expect(view.locator("#discard")).toBeFocused();
    await tabsTo(page, [
      ["Tab", "#close"],
      ["Tab", "#title"]
    ]);
    await closes("#task");
  });

  await test.step("on the dialog itself while it has no controls", async () => {
    await view.locator("#open-notice").click();
    await expect(view.locator("#notice")).toBeFocused();
    await tabsTo(page, [
      ["Tab", "#notice"],
      ["Shift+Tab", "#notice"]
    ]);
    await closes("#notice");
  });

  await test.step("after a wrap, a click on Patchy's page keeps focus there", async () => {
    await view.locator("#open-task").click();
    await view.locator("#close").focus();
    await tabsTo(page, [["Tab", "#title"]]);
    const shell = page.locator("#shell-after");
    await shell.click();
    await expect(shell).toBeFocused();
    await settled(page);
    await expect(shell).toBeFocused();
    await closeOpen();
  });

  await test.step("onto a first field that takes a quarter of a second to focus", async () => {
    await view.locator("#open-slow").click();
    await expect(view.locator("#slow-last")).toBeFocused();
    await tabsTo(page, [["Tab", "#slow-first"]]);
    await settled(page);
    await expect(view.locator("#slow-first")).toBeFocused();
    await expect(page.locator("#patch")).toBeFocused();
    await closes("#slow");
  });

  await test.step("in a dialog inside an inert container, whose inertness it escapes", async () => {
    await view.locator("#open-sheltered").click();
    await expect(view.locator("#sheltered-a")).toBeFocused();
    // The browser's own move, as without the SDK, and then the wrap.
    await tabsTo(page, [
      ["Tab", "#sheltered-b"],
      ["Tab", "#sheltered-a"],
      ...itself("#sheltered"),
      ["Shift+Tab", "#sheltered-b"]
    ]);
    await closes("#sheltered");
  });

  await test.step("where a window listener the page added later takes Tab", async () => {
    await view.locator("#open-taken").click();
    await tabsTo(page, [
      ["Tab", "#taken-2"],
      ["Shift+Tab", "#taken-2"]
    ]);
    await closes("#taken");
  });

  // From here, Tab is the browser's, as it is without the SDK: focus may leave the frame.

  await test.step("a control that takes Tab keeps it, and the dialog it starts is the browser's", async () => {
    await view.locator("#open-notes").click();
    await tabsTo(page, [["Tab", "#notes"]]);
    await expect(view.locator("#notes")).toHaveValue("\t");
    await leftAlone("Shift+Tab");
    await closeOpen();
  });

  await test.step("from a focused row that was removed", async () => {
    await view.locator("#open-task").click();
    await view.locator("#add").focus();
    await page.keyboard.press("Enter");
    await view.locator("#row-1").focus();
    await page.keyboard.press("Enter");
    await expect(view.locator("#row-1")).toHaveCount(0);
    await leftAlone("Tab");
    await closeOpen();
  });

  await test.step("from the dialog on top once the one below is written open, and once its focused control is removed", async () => {
    await view.locator("#open-task").click();
    await view.locator("#discard").focus();
    await page.keyboard.press("Enter");
    await tabsTo(page, [["Tab", "#no"]]);
    // A write of `open` on the dialog below, which is open already, leaves the one on top on top.
    await view.locator("#task").evaluate((task: HTMLDialogElement) => (task.open = true));
    await tabsTo(page, [
      ["Tab", "#yes"],
      ["Tab", "#no"]
    ]);
    await view.locator("#no").evaluate((no) => no.remove());
    await leftAlone("Tab");
    await closeOpen();
  });

  await test.step("through every field of a date input that comes last, and on out", async () => {
    await view.locator("#open-dates").click();
    await expect(view.locator("#due")).toBeFocused();
    await tabsTo(page, [["Tab", "#due"]]);
    for (let fields = 1; fields < 8; fields++) {
      await leftAlone("Tab");
      if (!(await view.locator("#due").evaluate((due) => due === document.activeElement))) break;
    }
    await expect(page.locator("#shell-after")).toBeFocused();
    await closeOpen();
  });

  await test.step("through a closed shadow root's controls, and on out", async () => {
    await view.locator("#open-component").click();
    const closedFocus = () =>
      view
        .locator("#pair")
        .evaluate(() => (window as unknown as { closedFocus(): string | null }).closedFocus());
    await tabsTo(page, [["Tab", "#pair"]]);
    expect(await closedFocus()).toBe("X");
    await tabsTo(page, [["Tab", "#pair"]]);
    expect(await closedFocus()).toBe("Y");
    await leftAlone("Tab");
    await closeOpen();
  });

  await test.step("from a radio group's checked radio that comes last", async () => {
    await view.locator("#open-choice").click();
    await expect(view.locator("#pick-2")).toBeFocused();
    await leftAlone("Tab");
    await closeOpen();
  });

  await test.step("where positive tabindex orders the dialog", async () => {
    await view.locator("#open-positive").click();
    await expect(view.locator("#positive-last")).toBeFocused();
    await leftAlone("Tab");
    await closeOpen();
  });

  await test.step("from the control that opened a popover in the dialog", async () => {
    await view.locator("#open-popped").click();
    await view.locator("#popped-invoker").click();
    await expect(view.locator("#tip")).toBeVisible();
    await expect(view.locator("#popped-invoker")).toBeFocused();
    await leftAlone("Tab");
    await view.locator("#tip").evaluate((tip: HTMLElement) => tip.hidePopover());
    await closeOpen();
  });

  await test.step("before a shadow host laid out as display: contents", async () => {
    await view.locator("#open-contents").click();
    await expect(view.locator("#contents-first")).toBeFocused();
    await leftAlone("Tab");
    await closeOpen();
  });

  await test.step("before an editable region with a stop inside that shows", async () => {
    await view.locator("#open-editable").click();
    await expect(view.locator("#editable-first")).toBeFocused();
    await leftAlone("Tab");
    await closeOpen();
  });

  await test.step("before an image map's link", async () => {
    await view.locator("#open-mapped").click();
    await expect(view.locator("#mapped-first")).toBeFocused();
    await leftAlone("Tab");
    await closeOpen();
  });

  await test.step("in a dialog that scrolls", async () => {
    await view.locator("#open-scrolling").click();
    await expect(view.locator("#scrolling-first")).toBeFocused();
    await leftAlone("Shift+Tab");
    await closeOpen();
  });

  await test.step("where reading-flow orders the dialog", async () => {
    await view.locator("#open-flow").click();
    await expect(view.locator("#flow-c")).toBeFocused();
    // Where the browser has reading-flow, C comes first and Tab is the browser's. Without it, as in
    // Firefox, the order is the page's, the dialog is plain, and C is its last stop.
    const reorders = await view
      .locator("#flow")
      .evaluate(() => CSS.supports("reading-flow", "flex-visual"));
    if (reorders) await leftAlone("Tab");
    else await tabsTo(page, [["Tab", "#flow-a"]]);
    await closeOpen();
  });

  await test.step("before a details element whose summary the browser draws", async () => {
    await view.locator("#open-folded").click();
    await expect(view.locator("#folded-first")).toBeFocused();
    await leftAlone("Tab");
    await closeOpen();
  });

  await test.step("after SVG that draws a link through use", async () => {
    await view.locator("#open-drawn").click();
    await expect(view.locator("#drawn-button")).toBeFocused();
    await leftAlone("Tab");
    await closeOpen();
  });

  await test.step("where CSS makes the first control inert", async () => {
    await view.locator("#open-dimmed").click();
    await expect(view.locator("#dimmed-last")).toBeFocused();
    // Where the browser has interactivity, Cold takes no focus and Tab is the browser's. Without it,
    // as in Firefox, Cold is an ordinary button, the dialog is plain, and Tab wraps to it.
    const inerts = await view
      .locator("#dimmed")
      .evaluate(() => CSS.supports("interactivity", "inert"));
    if (inerts) await leftAlone("Tab");
    else await tabsTo(page, [["Tab", "#dimmed-cold"]]);
    await closeOpen();
  });

  await test.step("from a select whose option is given a tabindex", async () => {
    await view.locator("#open-listed").click();
    await expect(view.locator("#listed-select")).toBeFocused();
    await leftAlone("Tab");
    await closeOpen();
  });
});

test("Tab stays inside a modal dialog of a Preact page, and Escape still closes it", async ({
  page,
  instance,
  browserName
}) => {
  const patch = await instance.publish(
    "company",
    await pageHtml('<div id="app"></div>', preactDialogScript)
  );
  await page.goto(patch.address);
  await shellAroundFrame(page);
  const view = page.frameLocator("#patch");
  await view.locator("#open").click();
  await expect(view.locator("#title")).toBeFocused();
  await tabsTo(page, [
    ["Tab", "#close"],
    ["Tab", "#title"],
    ...(browserName === "firefox" ? ([["Shift+Tab", "#dialog"]] as const) : []),
    ["Shift+Tab", "#close"],
    ["Shift+Tab", "#title"]
  ]);
  await page.keyboard.press("Escape");
  await expect(view.locator("dialog")).toHaveCount(0);
});
