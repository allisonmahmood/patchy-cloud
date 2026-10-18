import { renderNoticePage } from "./shell.js";

/**
 * The HTML 404 for every address nothing answers, patch or not. A missing, disabled or another
 * company's patch reads the same, so the copy names what a reader can act on, never which applies.
 */
export function renderNotFound(): string {
  return renderNoticePage({
    kicker: "Not found",
    title: "This page isn't available",
    message:
      "Check the address for a typo. If someone sent you this link, the patch may have been deleted or disabled, or it isn't shared with you. Ask them for a new link.",
    action: { label: "Go to Patchy", href: "/" }
  });
}
