/** External app-shell script; notes are text, never executable markup. */
export const updatesScript = String.raw`(() => {
  const bell = document.getElementById("updates-bell");
  if (!bell) return;
  const popover = document.getElementById("updates-popover");
  const content = document.getElementById("updates-popover-content");
  const dot = document.getElementById("updates-dot");
  const count = document.getElementById("updates-unread-count");
  const prefix = "patchy:updates:read:" + bell.dataset.viewerId + ":";
  const legacyKey = "patchy:updates:read-through:" + bell.dataset.viewerId;
  let legacyThrough = 0;
  try {
    const value = Number(localStorage.getItem(legacyKey));
    if (Number.isSafeInteger(value) && value >= 0) legacyThrough = value;
  } catch { /* Storage is optional. */ }
  const memory = new Map();
  const acknowledged = new WeakSet();
  const rows = [...document.querySelectorAll(".update-entry[data-update-sequence]")];
  let entries = [];
  let status = "loading";
  let pending = null;
  let signature = "";
  function isRead(sequence) {
    if (memory.has(sequence)) return memory.get(sequence);
    try {
      const value = localStorage.getItem(prefix + sequence);
      if (value === "1" || value === "0") return value === "1";
    } catch { /* Use the in-page fallback and legacy baseline. */ }
    return sequence <= legacyThrough;
  }
  function mark(sequence, read) {
    if (document.visibilityState !== "visible" || status !== "ready" || !entries.some(entry => entry.sequence === sequence)) return false;
    // One key per update avoids unrelated reads in two tabs overwriting each other.
    memory.set(sequence, read);
    try { localStorage.setItem(prefix + sequence, read ? "1" : "0"); } catch { /* Keep this page usable. */ }
    return true;
  }
  function readOpenRows() {
    if (document.visibilityState !== "visible") return;
    for (const row of rows) {
      if (row.open && !acknowledged.has(row) && mark(Number(row.dataset.updateSequence), true)) acknowledged.add(row);
    }
  }
  const element = (tag, className, text) => {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  function render() {
    const unread = status === "ready" ? entries.filter(entry => !isRead(entry.sequence)) : [];
    dot.hidden = unread.length === 0;
    bell.setAttribute("aria-label", "Updates — " + (status === "loading" ? "loading" : status === "error" ? "unavailable" : unread.length ? unread.length + " unread update" + (unread.length === 1 ? "" : "s") : "all caught up"));
    count.textContent = status === "ready" ? unread.length + " unread" : "";
    for (const button of document.querySelectorAll(".updates-mark-all")) button.disabled = status !== "ready" || unread.length === 0;
    for (const row of rows) {
      const read = isRead(Number(row.dataset.updateSequence));
      row.dataset.read = String(read);
      const badge = row.querySelector(".update-read-state");
      badge.textContent = read ? "Read" : "Unread";
      badge.className = "pill update-read-state" + (read ? "" : " pill-progress");
      badge.hidden = false;
      const toggle = row.querySelector(".update-read-toggle");
      toggle.textContent = read ? "Mark unread" : "Mark read";
      toggle.hidden = false;
      toggle.disabled = status !== "ready";
    }
    // Avoid replacing focused links and resetting scroll on every poll.
    const next = JSON.stringify([status, unread]);
    if (next === signature) return;
    signature = next;
    const scroll = content.scrollTop;
    const focused = document.activeElement?.dataset.updateLink;
    if (unread.length) {
      const links = unread.map(entry => {
        const link = element("a", "latest-update");
        link.dataset.updateLink = String(entry.sequence);
        link.href = "/updates?release=" + entry.sequence + "#update-" + entry.sequence;
        const time = element("time", "", new Date(entry.publishedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }));
        time.dateTime = entry.publishedAt;
        link.append(time, element("h3", "", entry.title), element("p", "", entry.summary));
        return link;
      });
      content.replaceChildren(...links);
    } else {
      const block = element("div", "updates-caught-up");
      block.append(element("h3", "", status === "loading" ? "Checking for updates…" : status === "error" ? "Updates unavailable" : "All caught up"));
      block.append(element("p", "", status === "error" ? "Please try again in a moment." : status === "loading" ? "" : "You’ve read all the updates."));
      content.replaceChildren(block);
    }
    if (focused) content.querySelector('[data-update-link="' + focused + '"]')?.focus({ preventScroll: true });
    content.scrollTop = scroll;
  }
  function position() {
    const rect = bell.getBoundingClientRect();
    const top = Math.max(12, Math.min(rect.bottom + 10, innerHeight - 160));
    popover.style.top = top + "px";
    popover.style.left = Math.max(12, Math.min(rect.right - 350, innerWidth - 362)) + "px";
    popover.style.maxHeight = Math.max(0, innerHeight - top - 12) + "px";
  }
  async function refresh() {
    if (document.visibilityState !== "visible") return;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetch("/updates/feed", { cache: "no-store", headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error("Unavailable");
        const data = await response.json();
        if (data.viewerId !== bell.dataset.viewerId) throw new Error("Session changed");
        entries = data.entries;
        status = "ready";
        readOpenRows();
      } catch { status = "error"; }
      finally { render(); }
    })();
    try { await pending; } finally { pending = null; }
  }
  for (const row of rows) {
    row.addEventListener("toggle", () => {
      if (!row.open) acknowledged.delete(row);
      else void refresh();
      render();
    });
    row.querySelector(".update-read-toggle").addEventListener("click", async () => {
      await refresh();
      const sequence = Number(row.dataset.updateSequence);
      if (mark(sequence, !isRead(sequence))) acknowledged.add(row);
      render();
    });
  }
  for (const button of document.querySelectorAll(".updates-mark-all")) {
    button.addEventListener("click", async () => {
      // Capture exactly the updates offered when clicked; later arrivals stay unread.
      const snapshot = entries.filter(entry => !isRead(entry.sequence)).map(entry => entry.sequence);
      await refresh();
      for (const sequence of snapshot) mark(sequence, true);
      render();
    });
  }
  function enter() { render(); void refresh(); }
  popover.addEventListener("beforetoggle", event => {
    if (event.newState === "open") { position(); void refresh(); }
  });
  window.addEventListener("resize", position);
  window.addEventListener("storage", event => {
    if (event.key === null) memory.clear();
    else if (event.key.startsWith(prefix)) memory.delete(Number(event.key.slice(prefix.length)));
    else return;
    render();
  });
  window.addEventListener("pageshow", enter);
  window.addEventListener("focus", enter);
  document.addEventListener("visibilitychange", enter);
  if (/^#update-[0-9]+$/.test(location.hash)) {
    const target = document.getElementById(location.hash.slice(1));
    if (target instanceof HTMLDetailsElement) target.open = true;
  }
  setInterval(() => { void refresh(); }, 5000);
  enter();
})();`;
