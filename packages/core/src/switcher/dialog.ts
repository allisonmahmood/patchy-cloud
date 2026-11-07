/// <reference lib="dom" />
/**
 * The switcher's dialog as other shell UI sees it. The starting cover waits while the switcher is
 * open, and never takes focus from it, so it reads whether it is open and hears when it closes.
 */

/** The switcher dialog's id, unique on the page. */
export const SWITCHER_ID = "patchy-switcher";

/** Fired on `window` once the switcher has closed and put focus back. */
export const SWITCHER_CLOSED = "patchy:switcher-closed";

/** Whether the page's switcher is open. */
export const switcherOpen = (page: Document): boolean => {
  const dialog = page.getElementById(SWITCHER_ID);
  return dialog instanceof HTMLDialogElement && dialog.open;
};
