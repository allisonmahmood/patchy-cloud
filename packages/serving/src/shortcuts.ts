/// <reference lib="dom" />
// @effect-diagnostics globalTimers:off globalFetch:off
// The served shell owns its dialog, the save's fetch and the activation poll, without an Effect runtime.
/**
 * The viewer's single-key shortcut setting in the served shell. The shell names the patch's frame
 * `patchy:shortcuts=on` or `=off` as it renders (`shell.ts`), and `patchy/hotkeys` reads that name
 * as the patch starts. A patch's sheet asks to change it with `shortcuts.setting`, which Patchy
 * confirms in its own dialog over the frame, so patch code can't change the setting without the
 * person:
 * - one dialog at a time, and only while the person has just pressed or clicked something;
 * - after a Cancel or Escape, the next dialog needs a fresh press: the one that asked has to lapse
 *   first, a few seconds in practice;
 * - only a real press in the dialog saves, through the same route as the account menu's switch;
 * - once a save is under way, Cancel and Escape wait for it, so the answer is what was stored.
 * The answer is the setting from then on in this tab; other tabs read it when they next open.
 */
import { ShortcutsValue } from "@patchy/api";
import * as Schema from "effect/Schema";
import { shellBottom } from "./stream-status.js";

/** The route's JSON answer, the value it stored. */
const isSaved = Schema.is(Schema.Struct({ value: ShortcutsValue }));
/** `shortcuts.setting` asks with no arguments. */
export const decodeShortcutsQuestion = Schema.decodeUnknownSync(Schema.Struct({}), {
  onExcessProperty: "error"
});

const glyph = () => {
  const element = document.createElement("span");
  element.className = "glyph glyph-sm";
  element.setAttribute("aria-hidden", "true");
  return element;
};
const button = (label: string, className: string) => {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `btn ${className}`;
  element.textContent = label;
  return element;
};

/**
 * The setting the frame was named with, and the dialog that changes it. Undefined for a frame
 * with no name, from a public shell or an older one, which has no setting to change.
 * `starting` is whether tier 2's starting cover is up, or about to be: a question then gets the
 * setting as it is, with no dialog.
 */
export function createShortcutSetting(frame: HTMLIFrameElement, starting: () => boolean) {
  const named = /^patchy:shortcuts=(on|off)$/.exec(frame.getAttribute("name") ?? "");
  if (named === null) return undefined;
  let on = named[1] === "on";
  // The open dialog, and how to end it at once when the document stops.
  let open: { readonly abandon: () => void } | undefined;
  // Set by a Cancel or an Escape. The press that opened that dialog may still count as one, so it
  // clears only once activation has read as lapsed.
  let dismissed = false;
  let lapse: number | undefined;
  const watchLapse = () => {
    dismissed = true;
    clearInterval(lapse);
    lapse = window.setInterval(() => {
      if (navigator.userActivation.isActive) return;
      dismissed = false;
      clearInterval(lapse);
      lapse = undefined;
    }, 250);
  };

  const ask = () =>
    new Promise<boolean>((resolve) => {
      // What the switch covers. A public patch's shell carries no setting, so it keeps them.
      const question = `Turn ${on ? "off" : "on"} single-key shortcuts in every patch except public ones?`;
      const dialog = document.createElement("dialog");
      dialog.className = "shell-scrim";
      dialog.setAttribute("aria-label", question);
      const panel = document.createElement("section");
      panel.className = "note note-float note-info";
      const title = document.createElement("p");
      title.className = "note-title";
      const pill = document.createElement("span");
      pill.className = on ? "pill pill-done" : "pill";
      pill.setAttribute("aria-hidden", "true");
      pill.textContent = on ? "On" : "Off";
      title.append(glyph(), question, pill);
      const error = document.createElement("p");
      error.setAttribute("role", "alert");
      error.hidden = true;
      const confirm = button(on ? "Turn off" : "Turn on", "btn-primary");
      const cancel = button("Cancel", "btn-quiet");
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(confirm, cancel);
      panel.append(title, error, actions);
      dialog.append(panel);
      let saving = false;
      let settled = false;
      // The browser closed the dialog during a save, as a second Escape with no press between
      // can make it; the save's answer settles it then.
      let closedWhileSaving = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        open = undefined;
        dialog.close();
        dialog.remove();
        frame.focus();
        resolve(on);
      };
      const dismiss = () => {
        // A save under way decides the answer; ending now would lose what it stores.
        if (settled || saving) return;
        watchLapse();
        settle();
      };
      const save = async () => {
        saving = true;
        const value = on ? "off" : "on";
        let saved = false;
        try {
          const response = await fetch("/api/me/shortcuts", {
            method: "POST",
            credentials: "same-origin",
            // A redirect is a sign-in or a refresh, not a save.
            redirect: "error",
            // Keeps the exact Origin the route admits despite the shell's no-referrer policy.
            referrerPolicy: "same-origin",
            headers: { accept: "application/json" },
            body: new URLSearchParams({ value }),
            signal: AbortSignal.timeout(35_000)
          });
          const answer: unknown = response.ok ? await response.json() : undefined;
          // A 200 without the value, as a body cut off at the route's size limit is, saved nothing.
          if (isSaved(answer)) {
            // What is stored is the answer, whatever happened to the dialog meanwhile.
            on = answer.value === "on";
            saved = true;
          }
        } catch {
          // Refused, cut off or timed out: nothing was saved.
        }
        saving = false;
        if (saved) return settle();
        if (closedWhileSaving) return dismiss();
        if (settled) return;
        panel.className = "note note-float note-warn";
        error.textContent = "Couldn't save. Nothing changed.";
        error.hidden = false;
        confirm.textContent = "Try again";
      };
      // Patch code can't reach this document, but only a person's own press saves.
      confirm.addEventListener("click", (event) => {
        if (event.isTrusted && !saving) void save();
      });
      cancel.addEventListener("click", dismiss);
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        dismiss();
      });
      // A browser that closes it anyway, as on a second Escape without a press between, cancelled,
      // unless a save is under way.
      dialog.addEventListener("close", () => {
        if (saving) closedWhileSaving = true;
        else dismiss();
      });
      dialog.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        event.preventDefault();
        (document.activeElement === confirm ? cancel : confirm).focus();
      });
      open = { abandon: settle };
      document.body.append(dialog);
      dialog.showModal();
      confirm.focus();
    });

  return {
    get on() {
      return on;
    },
    /**
     * The person's answer once they choose, or the setting as it is, with no dialog, when one is
     * open, the cover is up, nothing was just pressed, or the last dialog's press hasn't lapsed.
     */
    ask(): Promise<boolean> {
      if (open !== undefined || dismissed || starting() || !navigator.userActivation.isActive)
        return Promise.resolve(on);
      return ask();
    },
    /** Ends an open dialog with the setting as it is: the document is stopping. */
    close() {
      open?.abandon();
      clearInterval(lapse);
    }
  };
}

/**
 * Tells a viewer who turned single-key shortcuts off that this version's still fire, until they
 * dismiss it for this patch on this device. It sits with the page's other state at the bottom,
 * takes no focus, and its action follows the frame in Tab order.
 */
export function showShortcutsNote(frame: HTMLIFrameElement, patchId: string) {
  const key = `patchy:shortcuts-note:${patchId}`;
  try {
    if (localStorage.getItem(key) !== null) return;
  } catch {
    // Storage the browser refuses leaves the note up until this page closes.
  }
  const note = document.createElement("div");
  note.className = "note note-info note-float note-inline";
  note.setAttribute("role", "status");
  const content = document.createElement("div");
  content.className = "note-inline-text";
  const heading = document.createElement("span");
  heading.className = "note-title";
  heading.append(glyph(), "This patch's single-key shortcuts still work until it's updated.");
  content.append(heading);
  const dismiss = button("Dismiss", "btn-quiet");
  dismiss.addEventListener("click", () => {
    try {
      localStorage.setItem(key, "dismissed");
    } catch {
      // As above: dismissed for this page only.
    }
    note.remove();
    frame.focus();
  });
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(dismiss);
  note.append(content, actions);
  shellBottom().prepend(note);
}
