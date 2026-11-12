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
 * - once a dialog closes, confirmed or dismissed, the next one needs a fresh press: the one that
 *   answered it has to lapse first, a few seconds in practice;
 * - only a real press in the dialog saves, through the same route as the account menu's switch;
 * - Cancel and Escape close the dialog at once, even mid-save. A save under way keeps the one slot
 *   until it answers, and the answer is what it stored, or the setting as it was if it failed.
 * The answer is the setting from then on in this tab; other tabs read it when they next open.
 */
import { ShortcutsValue } from "@patchy/api";
import { switcherOpen } from "@patchy/core/switcher";
import * as Schema from "effect/Schema";
import { handBackFocus } from "./hand-back-focus.js";
import { shellBottom } from "./stream-status.js";

/** The route's JSON answer, the value it stored. */
const isSaved = Schema.is(Schema.Struct({ value: ShortcutsValue }));
/**
 * `shortcuts.setting` asks with no arguments: `{}` and nothing else. An empty `Schema.Struct`
 * would take any non-null value, so the question is a record that can hold no keys.
 */
export const decodeShortcutsQuestion = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Never)
);

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
  // Set whenever a dialog closes, confirmed or dismissed. The press that answered it may still
  // count as one, so it clears only once activation has read as lapsed.
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
      // The setting as it is, after the question; the question already says it to a screen reader.
      const state = document.createElement("span");
      state.className = "tag";
      state.setAttribute("aria-hidden", "true");
      state.textContent = on ? "On" : "Off";
      title.append(glyph(), question, state);
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
      // The dialog is up; it goes as soon as the person dismisses it, even mid-save.
      let shown = true;
      // The question is answered; until then it holds the one slot, so no other dialog opens.
      let settled = false;
      // However it closes, the next dialog needs a fresh press, so a patch can't ask again on this one.
      const hide = () => {
        if (!shown) return;
        shown = false;
        watchLapse();
        // The dialog holds focus while it is up, so focus found nowhere was still its to give back.
        const handBack = handBackFocus(frame, dialog, { pressed: true });
        dialog.close();
        dialog.remove();
        // The switcher, opened over the dialog, keeps focus and hands it back when it closes.
        if (!switcherOpen(document)) handBack();
      };
      const settle = () => {
        if (settled) return;
        settled = true;
        open = undefined;
        hide();
        resolve(on);
      };
      // Cancel, Escape, or the browser closing it, as a second Escape with no press between can:
      // the dialog goes at once. A save under way still answers, with what it stored or, failing,
      // the setting as it was.
      const dismiss = () => {
        if (!shown) return;
        if (saving) hide();
        else settle();
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
        if (saved || !shown) return settle();
        panel.className = "note note-float note-warn";
        error.textContent = "Couldn't save. Nothing changed.";
        error.hidden = false;
        confirm.textContent = "Try again";
      };
      // Patch code can't reach this document, but only a person's own press saves.
      confirm.addEventListener("click", (event) => {
        if (event.isTrusted && shown && !saving) void save();
      });
      cancel.addEventListener("click", dismiss);
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        dismiss();
      });
      dialog.addEventListener("close", dismiss);
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
     * The person's answer once they choose, or the setting as it is, with no dialog, while an
     * earlier question is unanswered (its dialog up, or its save under way after a dismissal),
     * the cover or the switcher is up, nothing was just pressed, or the press that closed the last
     * dialog hasn't lapsed.
     */
    ask(): Promise<boolean> {
      if (
        open !== undefined ||
        dismissed ||
        starting() ||
        switcherOpen(document) ||
        !navigator.userActivation.isActive
      )
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
    const handBack = handBackFocus(frame, note, { pressed: true });
    try {
      localStorage.setItem(key, "dismissed");
    } catch {
      // As above: dismissed for this page only.
    }
    note.remove();
    handBack();
  });
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(dismiss);
  note.append(content, actions);
  shellBottom().prepend(note);
}
