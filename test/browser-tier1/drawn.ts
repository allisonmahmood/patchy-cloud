import type { Page } from "@playwright/test";

/**
 * Waits until the shell has drawn itself as it now stands: its patch's frame shown and out from
 * under a dialog, and anything of its own it just put over the frame, such as a download card.
 * Desktop Chromium gives the frame its own process and sends a press there or to the shell by what
 * the shell last drew, so a click the moment either changes in the DOM lands on the other one. A
 * person can't click what isn't drawn yet; a test can, so one that does waits for this first.
 */
export const frameDrawn = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
