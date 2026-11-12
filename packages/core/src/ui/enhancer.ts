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
 * - **A hint's live part** (`HintEcho`) follows what its field holds as it is typed, or its
 *   fallback while the field is empty.
 * - **Pending**: a pressed submit with a pending label (`button`'s `pendingLabel`) says it in its
 *   face, static and at the same width, with `aria-disabled`, and its form turns away another submit
 *   until the page answers. A submit a page's own script handles, by preventing it, is left
 *   alone, and a page restored from the back-forward cache is as it was before the press. The
 *   server's own guards are still what stop a repeat.
 * - **Disclosures**: a fragment naming something inside a `<details>` opens it.
 * - **Change bars** (`changeBar`) count their form's boxes that differ from their saved state as
 *   they change, in `changeSummary`'s words, and hide while nothing changed.
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

  for (const echo of document.querySelectorAll("[data-echo]")) {
    const control = document.getElementById(echo.dataset.echo ?? "");
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) continue;
    const show = () => { echo.textContent = control.value.trim() || (echo.dataset.fallback ?? ""); };
    control.addEventListener("input", show);
    show();
  }

  // Pending forms and how their pressed button looked, so a page restored from the back-forward
  // cache gets it back. Captured first, a form already pending turns away the submit; after every
  // other listener, a submit nobody prevented marks its pressed button pending.
  const pending = new Map();
  document.addEventListener("submit", (event) => {
    if (pending.has(event.target)) event.preventDefault();
  }, true);
  document.addEventListener("submit", (event) => {
    const form = event.target;
    const pressed = event.submitter;
    if (event.defaultPrevented || !(form instanceof HTMLFormElement) || !(pressed instanceof HTMLButtonElement)) return;
    const label = pressed.dataset.pending;
    if (label === undefined) return;
    // The face holds the label; the button already holds room for the pending one, and keeps its
    // width when the pending label is the shorter.
    const face = pressed.querySelector(":scope > span") ?? pressed;
    pending.set(form, { pressed, face, html: face.innerHTML, width: pressed.style.minWidth });
    pressed.style.minWidth = pressed.getBoundingClientRect().width + "px";
    face.textContent = label;
    pressed.setAttribute("aria-disabled", "true");
  });
  addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    for (const { pressed, face, html, width } of pending.values()) {
      face.innerHTML = html;
      pressed.style.minWidth = width;
      pressed.removeAttribute("aria-disabled");
    }
    pending.clear();
  });

  for (const bar of document.querySelectorAll("[data-change-bar]")) {
    const form = bar.closest("form");
    const summary = bar.querySelector(".change-bar-summary");
    if (form === null || summary === null) continue;
    const count = () => {
      let added = Number(bar.dataset.added ?? 0);
      let removed = Number(bar.dataset.removed ?? 0);
      for (const box of form.querySelectorAll("input[type=checkbox][data-saved]")) {
        if (box.dataset.saved === "0" && box.checked) added++;
        if (box.dataset.saved === "1" && !box.checked) removed++;
      }
      summary.textContent = [added > 0 ? "Add " + added : "", removed > 0 ? (added > 0 ? "r" : "R") + "emove " + removed : ""].filter(Boolean).join(", ");
      bar.hidden = added + removed === 0;
    };
    form.addEventListener("change", count);
    // A page come back to may have its boxes restored after this first count.
    addEventListener("pageshow", count);
    count();
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
  // A link in view takes it itself, as the sidebar's do while it shows its popover in place.
  const focusable = (link) => {
    if (link.getClientRects().length > 0) return link;
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
