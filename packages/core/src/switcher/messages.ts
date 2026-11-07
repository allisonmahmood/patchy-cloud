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

/**
 * What a loaded switcher installs as `window.patchySwitcher`. A patch's frame can only ever reach
 * `open`; only a press of the chord in the page itself reaches `toggle`.
 */
export interface Switcher {
  /** Opens the switcher; one already open stays open. */
  readonly open: () => void;
  /** Opens the switcher, or closes it when open. */
  readonly toggle: () => void;
}

declare global {
  interface Window {
    /**
     * This page's switcher. Until one loads, `true` holds a request to open it, which it takes as
     * it starts; a press or frame message before then sets nothing more. A switcher that loads
     * replaces it with itself.
     */
    patchySwitcher?: true | Switcher;
  }
}

type Page = Pick<Window, "patchySwitcher">;

/** Opens this page's switcher, idempotently, holding the request until one loads: a frame's `open`. */
export const openSwitcher = (page: Page) => {
  if (typeof page.patchySwitcher === "object") page.patchySwitcher.open();
  else page.patchySwitcher = true;
};

/**
 * Opens this page's switcher, or closes it when open, holding the request until one loads: the
 * chord pressed in the page itself, which the open menu's own focus guarantees is the person's.
 */
export const toggleSwitcher = (page: Page) => {
  if (typeof page.patchySwitcher === "object") page.patchySwitcher.toggle();
  else page.patchySwitcher = true;
};
