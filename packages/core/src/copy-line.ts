import { escapeAttribute, escapeHtml } from "./html.js";

/** Where the portal serves `copyScript`; "assets" is a reserved company handle. */
export const copyScriptPath = "/assets/copy.js";

/**
 * One line to hand to an agent. A page that shows one loads `copyScriptPath` to reveal its Copy
 * button. `target` names what the button copies ("Copy the setup line"), so a page with two
 * lines never offers two buttons both called Copy.
 */
export const copyLine = (line: string, label: string, target?: string) =>
  `<div class="copy-line"><code aria-label="${escapeAttribute(label)}">${escapeHtml(line)}</code><button type="button" class="btn btn-primary" data-copy="${escapeAttribute(line)}"${target === undefined ? "" : ` aria-label="${escapeAttribute(`Copy ${target}`)}"`} aria-live="polite" hidden>Copy</button></div>`;

/** Reveals each copy button and copies its line; a refused clipboard asks the person to select the line instead. */
export const copyScript = `(() => {
  for (const button of document.querySelectorAll("button[data-copy]")) {
    const label = button.textContent;
    let reset;
    button.hidden = false;
    button.addEventListener("click", () => {
      clearTimeout(reset);
      navigator.clipboard.writeText(button.dataset.copy ?? "").then(
        () => { button.textContent = "Copied"; },
        () => { button.textContent = "Select the line to copy"; }
      ).finally(() => { reset = setTimeout(() => { button.textContent = label; }, 2000); });
    });
  }
})();
`;
