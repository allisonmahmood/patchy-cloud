import type { Page } from "@playwright/test";

/**
 * Runs `act`, which loads a dialog page (a link to one, or a submission it refuses), and resolves
 * once that page's script listens. Escape, the close link and the dialog's place in history come
 * from `/assets/ui.js`, which loads with `defer` and so runs just before DOMContentLoaded. Autofocus,
 * the dialog and a refusal can all show sooner, and a key pressed then does nothing.
 */
export async function loadDialog(page: Page, act: () => Promise<unknown>): Promise<void> {
  await Promise.all([page.waitForEvent("domcontentloaded"), act()]);
}
