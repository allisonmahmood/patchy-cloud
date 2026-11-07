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
 * starting cover while it is still up. On an app page, the element that held focus.
 */
import { commandGroup, commandIcon, commandList, commandRow, enterKey } from "../command-list.js";
import { patchMark } from "../patch-marks.js";
import type { SwitcherClient } from "./client.js";
import { SWITCHER_CLOSED, SWITCHER_ID } from "./dialog.js";
import { icons } from "./icons.js";
import { switcherMessage } from "./messages.js";
import { allPatchesRow, hold, type Row, sections } from "./rows.js";

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
    let next = sections(client.kept(), { patch: here.patch, path: location.pathname }, query, now);
    if (refresh)
      next = hold(
        next,
        rows.map((row) => row.key)
      );
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
    rows = next.flatMap((section) => section.rows);
    const still = refresh ? rows.findIndex((row) => row.key === lit) : 0;
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
    const { frame } = here;
    if (frame !== undefined && (!usable || back === frame)) {
      frame.focus();
      frame.contentWindow?.focus();
      // The relay puts the cursor back in the field the key found it in.
      frame.contentWindow?.postMessage(switcherMessage("closed"), "*");
    } else if (usable) back.focus({ preventScroll: true });
  };

  const open = () => {
    if (showing) return;
    showing = true;
    opener = document.activeElement;
    now = Date.now();
    query = "";
    input.value = "";
    rows = [];
    render(false);
    dialog.showModal();
    input.focus();
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
    query = input.value;
    render(false);
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    const last = rows.length - 1;
    if (event.key === "ArrowDown") select(selected === last ? 0 : selected + 1);
    else if (event.key === "ArrowUp") select(selected === 0 ? last : selected - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(last);
    else if (event.key === "Enter") go(rows[selected], event.metaKey || event.ctrlKey);
    else if (event.key === "Escape") close();
    // The field is the dialog's one stop.
    else if (event.key !== "Tab") return;
    event.preventDefault();
  });
  // Rows never take focus from the field; hovering lights one, as the arrows do.
  listbox.addEventListener("mousedown", (event) => event.preventDefault());
  listbox.addEventListener("pointermove", (event) => {
    const index = optionAt(event.target);
    if (index >= 0 && index !== selected) select(index);
  });
  // A row is a link, so a click follows it. A modified click opens a new tab, which the menu
  // steps aside for once the browser has taken it.
  listbox.addEventListener("click", (event) => {
    if (optionAt(event.target) >= 0 && (event.metaKey || event.ctrlKey || event.shiftKey))
      setTimeout(close);
  });
  // The scrim is the dialog itself, around the list.
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) event.preventDefault();
  });
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
  client.onChange(() => {
    if (showing) render(true);
  });

  return { open, close, toggle: () => (showing ? close() : open()) };
};
