/** Where the portal serves `uiScript`, outside the viewer gate; "assets" is a reserved company handle. */
export const uiScriptPath = "/assets/ui.js";

/** Every first-party page with a form or a dialog loads the enhancer; `pageResponse` puts it in. */
export const uiScriptTag = `<script defer src="${uiScriptPath}"></script>`;

/**
 * What script adds to pages that work without it.
 *
 * - **Dialogs** (`[data-dialog]`, a URL drawn over its page): focus starts on its `autofocus`
 *   control, else its first field. Escape and its close link close one that has a `data-close`
 *   page: reached by a link on this site, closing goes back in history to that page, whichever it
 *   was, past any refused submission the dialog was drawn again for, so neither closing nor Back
 *   revisits it, and Back from a refused submission goes there too; loaded any other way, it goes
 *   to its own page. A dialog without `data-close`, such as the Final step, closes only by its
 *   own actions. Without script it is a page and its close link does the same.
 * - **Focus return**: closing a dialog puts focus back on the link that opened it, or on the
 *   button of the menu that link sits in.
 * - **Show** for a secret field reveals its button and toggles the mask.
 * - **Disclosures**: a fragment naming something inside a `<details>` opens it.
 */
export const uiScript = `(() => {
  const RETURN = "patchy:return-focus";
  const LAST = "patchy:last-link";
  const here = () => location.pathname + location.search;
  const read = (key) => {
    try { return JSON.parse(sessionStorage.getItem(key) ?? "null"); } catch { return null; }
  };
  const write = (key, value) => {
    try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, JSON.stringify(value)); } catch {}
  };
  const linksTo = (href) => [...document.querySelectorAll("a[href]")].filter((link) => link.getAttribute("href") === href);

  for (const button of document.querySelectorAll("button[data-show]")) {
    const field = document.getElementById(button.dataset.show ?? "");
    if (!(field instanceof HTMLInputElement)) continue;
    button.hidden = false;
    button.addEventListener("click", () => {
      const shown = field.type === "text";
      field.type = shown ? "password" : "text";
      button.setAttribute("aria-pressed", String(!shown));
      button.textContent = shown ? "Show" : "Hide";
    });
  }

  const openFragment = () => {
    let id = "";
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    if (id === "") return;
    for (let node = document.getElementById(id); node; node = node.parentElement)
      if (node instanceof HTMLDetailsElement) node.open = true;
  };
  openFragment();
  addEventListener("hashchange", openFragment);

  // The link a click followed: its page, where it led, and which link it was, by id or by its
  // place among the links to the same address.
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (link === null) return;
    const href = link.getAttribute("href");
    write(LAST, { page: here(), href, to: new URL(href, location.href).href, id: link.id || null, index: linksTo(href).indexOf(link) });
  }, true);

  // A link in a closed menu can't take focus; the button that opens its menu takes it instead.
  const focusable = (link) => {
    const menu = link.closest("[popover]");
    const owner = menu === null || menu.id === "" ? link : document.querySelector('[popovertarget="' + CSS.escape(menu.id) + '"]') ?? link;
    return owner.getClientRects().length > 0 ? owner : null;
  };
  const returnFocus = () => {
    const entry = read(RETURN);
    if (entry === null || entry.page !== here()) return;
    write(RETURN, null);
    const same = linksTo(entry.href);
    const named = entry.id === null ? null : document.getElementById(entry.id);
    for (const link of [named, same[entry.index], ...same]) {
      const target = link instanceof HTMLElement ? focusable(link) : null;
      if (target !== null) return target.focus();
    }
  };
  addEventListener("pageshow", returnFocus);

  // The dialog chain: how many history entries this dialog has taken since a link on this site
  // opened it, counting each refused submission it was drawn again for, and that link. Kept in
  // the entry's own state, so a reload or a step back and forward finds it again.
  const CHAIN = "patchy:dialog";
  const dialog = document.querySelector("[data-dialog]");
  if (!(dialog instanceof HTMLElement)) return write(CHAIN, null);
  if (!dialog.contains(document.activeElement))
    (dialog.querySelector("[autofocus]") ??
      dialog.querySelector(".dialog-body :is(input:not([type=hidden]), select, textarea, button, a[href]):not(:disabled)") ??
      dialog.querySelector("a[href], button"))?.focus();
  const close = dialog.dataset.close;
  if (close === undefined) return write(CHAIN, null);
  const from = document.referrer === "" ? null : new URL(document.referrer);
  const came = from !== null && from.origin === location.origin ? from.pathname + from.search : null;
  let chain = history.state?.patchyDialog ?? null;
  // Found in the entry's state: a reload or a step back or forward, not a fresh open.
  const restored = chain !== null;
  if (chain === null) {
    const opener = read(LAST);
    const previous = read(CHAIN);
    if (opener !== null && came === opener.page && new URL(opener.to).href.split("#")[0] === location.href.split("#")[0])
      chain = { opener, depth: 1 };
    else if (previous !== null && came === previous.at) chain = { opener: previous.opener, depth: previous.depth + 1 };
    if (chain !== null) history.replaceState({ ...(history.state ?? {}), patchyDialog: chain }, "");
  }
  // Reached from a page on this site, closing goes back past every entry the dialog took, to
  // that page, so neither closing nor Back revisits a submission; loaded any other way, closing
  // goes to the dialog's own page.
  const leave = () => {
    if (chain !== null) {
      write(RETURN, chain.opener);
      write(CHAIN, null);
      history.go(-chain.depth);
    } else location.assign(new URL(close, location.href).href);
  };
  // A step back from a refused submission lands on an earlier entry of the same chain, which the
  // later one has left in storage: that closes the dialog too, on to the page that opened it.
  // Shown again from the back-forward cache, the page settles the same way.
  const settle = (traversed) => {
    const later = read(CHAIN);
    if (traversed && chain !== null && later !== null && later.depth > chain.depth && JSON.stringify(later.opener) === JSON.stringify(chain.opener))
      return leave();
    write(CHAIN, chain === null ? null : { ...chain, at: here() });
  };
  settle(restored);
  addEventListener("pageshow", (event) => {
    if (event.persisted) settle(true);
  });
  // Captured before a menu or the switcher handles it: Escape closes those first, then the dialog.
  addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (document.querySelector(":popover-open, dialog[open]") !== null) return;
    event.preventDefault();
    leave();
  }, true);
  for (const link of dialog.querySelectorAll("a[href]"))
    if (link.getAttribute("href") === close)
      link.addEventListener("click", (event) => {
        event.preventDefault();
        leave();
      });
})();
`;
