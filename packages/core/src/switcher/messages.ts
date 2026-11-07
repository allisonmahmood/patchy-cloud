/// <reference lib="dom" />
/**
 * The relay's window messages between a patch's frame and its shell, apart from the broker's
 * MessageChannel. Each is `{ patchy: "switcher", v: 1, kind }` and nothing more: no list, query,
 * viewer data or authority, so a patch that posts one itself gains nothing. Either side ignores a
 * version or kind it doesn't know, and neither waits for a reply, so any mix of releases does no
 * worse than the key doing nothing.
 */

/** From a frame to its shell: `hello` once its relay runs, `open` on an activating press. */
export type FrameMessage = "hello" | "open";
/** From a shell to its frame: the switcher closed, so the relay puts focus back. */
export type ShellMessage = "closed";

export const switcherMessage = <Kind extends FrameMessage | ShellMessage>(kind: Kind) =>
  ({ patchy: "switcher", v: 1, kind }) as const;

/** The kind of a switcher message, when it is one of `kinds`; anything else is undefined. */
export const switcherMessageKind = <Kind extends FrameMessage | ShellMessage>(
  data: unknown,
  kinds: ReadonlyArray<Kind>
): Kind | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  if (!("patchy" in data && data.patchy === "switcher" && "v" in data && data.v === 1))
    return undefined;
  return "kind" in data ? kinds.find((kind) => kind === data.kind) : undefined;
};

declare global {
  interface Window {
    /**
     * The page's switcher. A switcher that loads installs itself here as the function the chord
     * calls, toggling it; until one does, `true` records that the chord asked for it, so it
     * opens as soon as it starts.
     */
    patchySwitcher?: true | (() => void);
  }
}

/** Asks this document's switcher to open, or to close when open, holding the request until one loads. */
export const requestSwitcher = (page: Window) => {
  if (typeof page.patchySwitcher === "function") page.patchySwitcher();
  else page.patchySwitcher = true;
};
