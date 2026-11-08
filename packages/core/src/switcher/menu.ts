/// <reference lib="dom" />
// @effect-diagnostics globalTimers:off globalDate:off
// This browser module owns the menu's DOM, its frozen clock and one deferred close.
/**
 * The switcher's menu: a command list (`command-list.ts`) in a modal dialog over the page, the
 * same flat scrim as the starting cover. Opening is synchronous and paints whatever the client
 * has; a refresh that lands while it is open keeps the rows already shown in place.
 *
 * Keys: ↑ and ↓ wrap, Home and End jump, ↵ opens the lit row, ⌘/Ctrl-↵ opens it in a new tab,
 * Escape closes. The mouse works once it is open: hovering lights a row, a click opens it, a
 * modified click opens a new tab, and a click on the scrim closes.
 *
 * Closing puts focus back where it opened from. Over a patch that is the frame, whose relay then
 * restores the exact field and selection; else the shell control that held focus, or the
 * starting cover while it is still up. On an app page, the element that held focus. Focus leaving
 * the page while it is open closes it the same way, so it never shows while typing goes elsewhere.
 */
import { commandGroup, commandIcon, commandList, commandRow, enterKey } from "../command-list.js";
import { patchMark } from "../patch-marks.js";
import type { SwitcherClient } from "./client.js";
import { SWITCHER_CLOSED, SWITCHER_ID } from "./dialog.js";
import { icons } from "./icons.js";
import { switcherMessage } from "./messages.js";
import { allPatchesRow, hold, litAtOpen, type Row, sections } from "./rows.js";

export interface SwitcherMenu {
  /** Opens the menu; a no-op while it is open. */
  readonly open: () => void;
  /** Closes the menu and puts focus back; a no-op while it is closed. */
  readonly close: () => void;
  readonly toggle: () => void;
}

const markOf = (row: Row) =>
  "patch" in row.mark
    ? patchMark(row.mark.patch.name, row.mark.patch.tier)
    : commandIcon(icons[row.mark.icon]);

export const switcherMenu = (
  client: SwitcherClient,
  /** The company shell's frame and the patch it shows; neither on an app page. */
  here: { readonly frame?: HTMLIFrameElement | undefined; readonly patch?: string | undefined }
): SwitcherMenu => {
  const { frame } = here;
  const listId = `${SWITCHER_ID}-list`;
  const dialog = document.createElement("dialog");
  dialog.id = SWITCHER_ID;
  dialog.className = "shell-scrim switcher";
  dialog.setAttribute("aria-label", "Go to");
  dialog.innerHTML = commandList({ id: listId, label: "Go to", placeholder: "Go to…", rows: "" });
  document.body.append(dialog);
  const input = dialog.querySelector("input")!;
  const listbox = dialog.querySelector<HTMLElement>(`#${listId}`)!;
  const empty = dialog.querySelector<HTMLElement>(".command-empty")!;
  const keycap = document.createRange().createContextualFragment(enterKey).firstElementChild!;

  let showing = false;
  let query = "";
  // Frozen while open, so "4 min" never ticks under the pointer.
  let now = 0;
  let rows: Row[] = [];
  let selected = 0;
  let opener: Element | null = null;
  // Whether the rows on show came from a list, and whether the person has typed, moved the
  // selection or pointed since the menu opened. Until both, a list that lands is drawn as if it
  // had been there at open: the patch to flip back to first and lit.
  let filled = false;
  let touched = false;

  const options = () => [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];

  const select = (index: number) => {
    const all = options();
    for (const option of all) option.setAttribute("aria-selected", "false");
    selected = Math.max(0, Math.min(index, all.length - 1));
    const option = all[selected];
    if (option === undefined) return input.removeAttribute("aria-activedescendant");
    option.setAttribute("aria-selected", "true");
    option.append(keycap);
    input.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  };

  /** Draws the rows for the query; `refresh` keeps those already shown in place. */
  const render = (refresh: boolean) => {
    const lit = rows[selected]?.key;
    const shown = refresh ? rows.map((row) => row.key) : [];
    let next = sections(
      client.kept(),
      { patch: here.patch, path: location.pathname },
      query,
      now,
      shown
    );
    if (refresh) next = hold(next, shown);
    const none = next.length === 0;
    if (none) next = [{ rows: [allPatchesRow()] }];
    empty.textContent = none ? `No patches match “${query.trim()}”` : "";
    let index = 0;
    listbox.innerHTML = next
      .map((section, at) => {
        const markup = section.rows
          .map((row) =>
            commandRow({
              id: `${SWITCHER_ID}-row-${index++}`,
              href: row.href,
              mark: markOf(row),
              title: row.title,
              detail: row.detail,
              dot: row.dot === true ? "New changes" : undefined
            })
          )
          .join("");
        return section.label === undefined
          ? markup
          : commandGroup({
              id: `${SWITCHER_ID}-group-${at}`,
              label: section.label,
              rows: markup,
              patchy: section.label === "Patchy"
            });
      })
      .join("");
    const previous = selected;
    filled = client.kept().list !== undefined;
    rows = next.flatMap((section) => section.rows);
    const still = refresh ? rows.findIndex((row) => row.key === lit) : litAtOpen(next);
    select(still >= 0 ? still : previous);
  };

  /** Focus back where the menu opened from. */
  const putFocusBack = () => {
    const back = opener;
    opener = null;
    // A control that left, or sat in a cover that has since closed, can't take it back.
    const usable =
      back instanceof HTMLElement &&
      back !== document.body &&
      back.isConnected &&
      back.closest("dialog:not([open])") === null;
    if (frame !== undefined && (!usable || back === frame)) {
      const toFrame = () => {
        frame.focus();
        frame.contentWindow?.focus();
      };
      toFrame();
      // The relay puts the cursor back in the field the key found it in, once the frame has focus.
      frame.contentWindow?.postMessage(switcherMessage("closed"), "*");
      // Firefox won't hand a frame focus during the key event that closed the menu, such as its
      // Escape: the frame takes it once that is over, unless the person has put focus somewhere
      // of their own meanwhile.
      setTimeout(() => {
        const active = document.activeElement;
        if (showing || active === frame) return;
        if (active === null || active === document.body || dialog.contains(active)) toFrame();
      });
    } else if (usable) back.focus({ preventScroll: true });
  };

  /** A key the menu acts on in its field; false for any other. */
  const act = (key: string, mod: boolean): boolean => {
    const last = rows.length - 1;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) touched = true;
    if (key === "ArrowDown") select(selected === last ? 0 : selected + 1);
    else if (key === "ArrowUp") select(selected === 0 ? last : selected - 1);
    else if (key === "Home") select(0);
    else if (key === "End") select(last);
    else if (key === "Enter") go(rows[selected], mod);
    else if (key === "Escape") close();
    // The field is the dialog's one stop.
    else return key === "Tab";
    return true;
  };

  const open = () => {
    if (showing) return;
    showing = true;
    opener = document.activeElement;
    now = Date.now();
    query = "";
    input.value = "";
    rows = [];
    touched = false;
    // Focus first, so a key pressed while the rows draw lands in the field.
    dialog.showModal();
    input.focus();
    render(false);
    client.freshen();
  };

  const close = () => {
    if (!showing) return;
    showing = false;
    if (dialog.open) dialog.close();
    putFocusBack();
    dispatchEvent(new Event(SWITCHER_CLOSED));
  };

  const go = (row: Row | undefined, newTab: boolean) => {
    if (row === undefined) return;
    if (!newTab) return location.assign(row.href);
    window.open(row.href, "_blank", "noopener");
    close();
  };

  const optionAt = (target: EventTarget | null) => {
    const option = target instanceof Element ? target.closest('[role="option"]') : null;
    return option === null ? -1 : options().findIndex((candidate) => candidate === option);
  };

  input.addEventListener("input", () => {
    touched = true;
    query = input.value;
    render(false);
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (act(event.key, event.metaKey || event.ctrlKey)) event.preventDefault();
  });
  // Hovering lights a row, as the arrows do.
  listbox.addEventListener("pointermove", (event) => {
    const index = optionAt(event.target);
    if (index < 0) return;
    // Pointing at a row, the lit one included, is choosing it: a list that lands won't move it.
    touched = true;
    if (index !== selected) select(index);
  });
  // A row is a link, so a click follows it. A modified click opens a new tab, which the menu
  // steps aside for once the browser has taken it.
  listbox.addEventListener("click", (event) => {
    if (optionAt(event.target) >= 0 && (event.metaKey || event.ctrlKey || event.shiftKey))
      setTimeout(close);
  });
  // A press anywhere but the field's own text, rows, glyph, panel and scrim alike, leaves focus in
  // the field, so the keys keep working; a click on a row still follows it.
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === input) return;
    event.preventDefault();
    input.focus();
  });
  // The scrim is the dialog itself, around the list.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  // A close the browser made itself, such as a second Escape it no longer asks about. The event
  // comes a task later, after a fast press may have opened the menu again, so it counts only
  // while the dialog is still closed.
  dialog.addEventListener("close", () => {
    if (!dialog.open) close();
  });
  // Leaving with it open, back-forward cache included, finds the page as it was.
  addEventListener("pagehide", close);
  // Focus leaving the dialog while it is open, to the patch, another window or the browser's own
  // UI, closes it, so Go to never shows while typing goes elsewhere. Firefox doesn't blur the
  // window when its frame takes focus, so the field losing it counts too; a move within the
  // dialog doesn't.
  const leftIt = () => {
    if (showing && (!document.hasFocus() || !dialog.contains(document.activeElement))) close();
  };
  addEventListener("blur", (event) => {
    if (event.target === window) leftIt();
  });
  input.addEventListener("blur", () => setTimeout(leftIt));
  client.onChange(() => {
    if (showing) render(filled || touched);
  });

  return { open, close, toggle: () => (showing ? close() : open()) };
};
