/** External app-shell script; notes are text, never executable markup. */
export const updatesScript = String.raw`(() => {
  const bell = document.getElementById("updates-bell");
  if (!bell) return;
  const popover = document.getElementById("updates-popover");
  const content = document.getElementById("updates-popover-content");
  const dot = document.getElementById("updates-dot");
  const key = "patchy:updates:read-through:" + bell.dataset.viewerId;
  let latest = null;
  let status = "loading";
  let memory = 0;
  let pending = false;
  let open = false;
  let captured = false;
  let openedEntry = null;
  const stored = () => {
    try {
      const value = Number(localStorage.getItem(key));
      return Number.isSafeInteger(value) && value >= 0 ? Math.max(memory, value) : memory;
    } catch { return memory; }
  };
  const markThrough = (through) => {
    if (document.visibilityState !== "visible" || !Number.isSafeInteger(through) || through <= stored()) return;
    memory = through;
    try { localStorage.setItem(key, String(through)); } catch { /* Keep this tab usable. */ }
  };
  const seen = () => {
    const page = document.querySelector("[data-updates-through]");
    if (page) markThrough(Number(page.dataset.updatesThrough));
  };
  function captureOpenedEntry() {
    if (!open || captured || status !== "ready" || document.visibilityState !== "visible") return;
    captured = true;
    openedEntry = latest && latest.sequence > stored() ? latest : null;
    if (openedEntry) markThrough(openedEntry.sequence);
  }
  const element = (tag, className, text) => {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  function render() {
    const unread = status === "ready" && latest && latest.sequence > stored();
    dot.hidden = !unread;
    bell.setAttribute("aria-label", "Updates — " + (status === "loading" ? "loading" : status === "error" ? "unavailable" : unread ? "new deployment" : "all caught up"));
    const displayed = open ? openedEntry : unread ? latest : null;
    const block = element(displayed ? "a" : "div", displayed ? "latest-update" : "updates-caught-up");
    if (displayed) {
      // The query forces a new document when a newer update arrives on /updates.
      block.href = "/updates?release=" + displayed.sequence + "#update-" + displayed.sequence;
      const time = element("time", "", new Date(displayed.publishedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }));
      time.dateTime = displayed.publishedAt;
      block.append(time, element("h3", "", displayed.title), element("p", "", displayed.summary));
    } else {
      block.append(element("h3", "", status === "loading" ? "Checking for updates…" : status === "error" ? "Updates unavailable" : "All caught up"));
      block.append(element("p", "", status === "error" ? "Please try again in a moment." : status === "loading" ? "" : "You’ve seen the latest updates."));
    }
    content.replaceChildren(block);
  }
  function position() {
    const rect = bell.getBoundingClientRect();
    popover.style.top = Math.min(rect.bottom + 10, innerHeight - 160) + "px";
    popover.style.left = Math.max(12, Math.min(rect.right - 350, innerWidth - 362)) + "px";
  }
  async function refresh() {
    if (pending || document.visibilityState !== "visible") return;
    pending = true;
    try {
      const response = await fetch("/updates/latest", { cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Unavailable");
      const data = await response.json();
      if (data.viewerId !== bell.dataset.viewerId) throw new Error("Session changed");
      latest = data.latest;
      status = "ready";
    } catch { status = "error"; openedEntry = null; }
    finally { pending = false; captureOpenedEntry(); render(); }
  }
  function enter() {
    seen();
    render();
    void refresh();
  }
  popover.addEventListener("beforetoggle", (event) => {
    open = event.newState === "open";
    captured = false;
    openedEntry = null;
    if (open) { position(); openedEntry = status === "ready" && latest && latest.sequence > stored() ? latest : null; }
    render();
    if (open) void refresh();
  });
  window.addEventListener("resize", position);
  window.addEventListener("storage", (event) => { if (event.key === key || event.key === null) render(); });
  window.addEventListener("pageshow", enter);
  window.addEventListener("focus", enter);
  document.addEventListener("visibilitychange", enter);
  // A link from the bell opens the named deployment without changing older rows.
  if (/^#update-[0-9]+$/.test(location.hash)) {
    const target = document.getElementById(location.hash.slice(1));
    if (target instanceof HTMLDetailsElement) target.open = true;
  }
  setInterval(() => { void refresh(); }, 5000);
  enter();
})();`;
