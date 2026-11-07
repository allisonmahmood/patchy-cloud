/**
 * The viewer's single-key shortcut setting, as `patchy/hotkeys` obeys it. Internal: `hotkeys.ts`
 * reads it as each key arrives, and its sheet shows and changes it.
 *
 * The shell names the patch's frame `patchy:shortcuts=on` or `patchy:shortcuts=off` before the
 * frame's document loads, so the value is read as this module evaluates, from an eager import or
 * a dynamic one, with nothing held off waiting. Any other name is a shell that doesn't say, and
 * shortcuts stay on. Only the shell changes it, in its own dialog: the sheet asks with
 * `shortcuts.setting`, and the answer is the value in this tab from then on.
 */
import { getHotkeyManager } from "@tanstack/preact-hotkeys";
import { getDocumentTransport } from "./clientTransport.js";

export interface ShortcutSetting {
  /** Whether character shortcuts fire. */
  readonly on: boolean;
  /** Whether the sheet shows its row: the shell named the frame, and this document can ask it. */
  readonly shown: boolean;
}

const named = /^patchy:shortcuts=(on|off)$/.exec(globalThis.window?.name ?? "");
let current: ShortcutSetting = { on: named?.[1] !== "off", shown: false };
const listeners = new Set<() => void>();
const update = (next: ShortcutSetting) => {
  current = next;
  for (const listener of listeners) listener();
};

// Where the shell named the frame, the document's transport, made here when no client has made it
// yet. One made after the shell's bootstrap never gets its port, so the row stays hidden while the
// named value still applies. Under a shell that doesn't name it, nothing here talks to the shell.
const transport = named === null ? undefined : getDocumentTransport();
void transport?.ready().then(
  () => update({ ...current, shown: true }),
  () => {}
);

/** The setting now, the same object until it changes. */
export const shortcutSetting = (): ShortcutSetting => current;

/** Calls `listener` after each change, until the returned function is called. */
export const subscribeShortcutSetting = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Asks the shell to change the setting, which it confirms in its own dialog, and takes its answer
 * for this tab. It waits on the viewer, so no reply deadline applies. A sequence part-way through
 * when the value changes starts again.
 */
export const askShell = async (): Promise<void> => {
  if (transport === undefined) return;
  const answer = await transport.call("shortcuts.setting", {});
  if (typeof answer !== "boolean" || answer === current.on) return;
  getHotkeyManager().resetSequenceProgress();
  update({ ...current, on: answer });
};
