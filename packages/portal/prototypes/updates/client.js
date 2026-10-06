// THROWAWAY UI. All data and mutations stay on the loopback simulation server.
const main = document.querySelector(".app-page");
const portal = main.innerHTML;
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]
  );
const date = (value) =>
  new Date(value).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
let state;
let busy = false;

document.querySelector(".app-who form")?.remove();
document.querySelector(".app-who").insertAdjacentHTML(
  "afterbegin",
  `
  <button type="button" class="btn btn-quiet updates-bell" id="updates-bell" popovertarget="updates-popover" aria-label="Updates">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" stroke-linejoin="round"/><path d="M10 21h4" stroke-linecap="round"/></svg>
    <span class="updates-dot" id="updates-dot" hidden></span>
  </button>`
);
document.body.insertAdjacentHTML(
  "afterbegin",
  '<div class="prototype-label">LOCAL PREVIEW <span>Sample patches &amp; deployments</span></div>'
);
document.body.insertAdjacentHTML(
  "beforeend",
  `
  <aside id="updates-popover" popover aria-label="Latest Patchy update"></aside>
  <details class="prototype-lab" id="prototype-lab"><summary><span class="lab-indicator"></span> Simulation <span class="lab-summary" id="lab-summary">Loading…</span></summary>
    <div class="lab-content"><p>Try the bell → update history flow. These buttons simulate a successful GitHub Action.</p>
      <div class="lab-actions"><button class="btn btn-primary" data-action="deploy">Simulate new deployment</button><button class="btn" data-action="retry">Retry latest deployment</button><button class="btn" data-action="return">Return to Patchy</button><button class="btn btn-quiet" data-action="reset">Reset demo</button></div>
      <p class="lab-status" id="lab-status" role="status"></p><dl class="lab-facts" id="lab-facts"></dl>
      <p class="lab-flow">Action prepares notes → deployment confirmed live → one update published</p>
      <details><summary>Simulated Action output</summary><pre id="action-output"></pre></details>
      <p class="lab-footnote">Sample notes are prepared by the local Action simulator. No GitHub workflow is run. State is saved in a disposable local file, so closing this tab keeps your place.</p>
    </div>
  </details>`
);

const bell = document.getElementById("updates-bell");
const popover = document.getElementById("updates-popover");
function positionPopover() {
  const rect = bell.getBoundingClientRect();
  popover.style.top = `${rect.bottom + 10}px`;
  popover.style.left = `${Math.max(12, Math.min(rect.right - 350, innerWidth - 362))}px`;
}
popover.addEventListener("beforetoggle", (event) => {
  if (event.newState === "open") positionPopover();
});
window.addEventListener("resize", positionPopover);

function renderBell() {
  const latest = state.entries.at(-1);
  const unread = latest.sequence > state.readThrough;
  document.getElementById("updates-dot").hidden = !unread;
  bell.setAttribute("aria-label", unread ? "Updates — new deployment" : "Updates — all caught up");
  popover.innerHTML = `<div class="updates-popover-top"><h2 class="section-heading">What’s new</h2>${unread ? '<span class="supporting-text">New update</span>' : ""}</div>
    ${
      unread
        ? `<a class="latest-update" href="/updates"><time datetime="${escape(latest.completedAt)}">${date(latest.completedAt)}</time><h3>${escape(latest.notes.title)}</h3><p>${escape(latest.notes.summary)}</p></a>`
        : '<div class="updates-caught-up"><h3>All caught up</h3><p>You’ve seen the latest updates.</p></div>'
    }
    <div class="updates-popover-footer"><a class="btn btn-primary" href="/updates">View all updates <span aria-hidden="true">→</span></a></div>`;
}

function renderLab() {
  const unread = state.entries.filter((entry) => entry.sequence > state.readThrough).length;
  document.getElementById("lab-summary").textContent =
    `${state.entries.length} updates · ${unread ? "new update" : "all caught up"}`;
  document.getElementById("lab-status").textContent = state.lastResult;
  document.getElementById("lab-facts").innerHTML =
    `<dt>Published updates</dt><dd>${state.entries.length}</dd><dt>Unseen deployments</dt><dd>${unread}</dd><dt>Viewed through</dt><dd>Sample ${state.readThrough}</dd><dt>Latest deployment</dt><dd>Sample ${state.entries.at(-1).sequence}</dd>`;
  document.getElementById("action-output").textContent = JSON.stringify(
    state.lastPayload ?? state.entries.at(-1),
    null,
    2
  );
}

async function post(path, payload = {}) {
  const response = await fetch(`/simulation/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("The local simulator could not complete this action.");
  return response.json();
}

function renderUpdates(snapshot) {
  document.title = "What’s new in Patchy · local preview";
  main.innerHTML = `<article class="updates-page"><a href="/" class="updates-back">← Back to patches</a>
    <header class="updates-heading"><div class="updates-eyebrow">THE LATEST FROM PATCHY</div><h1 class="page-heading" tabindex="-1">What’s new in Patchy</h1><p>The latest improvements, all in one place.</p></header>
    <div class="updates-list" aria-label="Deployment updates">${[...snapshot.entries]
      .reverse()
      .map(
        (entry, index) => `
      <details class="update-entry" data-sequence="${entry.sequence}"><summary>
        <span class="update-date"><time datetime="${escape(entry.completedAt)}">${date(entry.completedAt)}</time>${index === 0 ? '<span class="pill">Latest</span>' : ""}${entry.sequence > snapshot.readThrough ? '<span class="update-new">New</span>' : ""}</span>
        <span class="update-title">${escape(entry.notes.title)}</span><span class="update-summary">${escape(entry.notes.summary)}</span>
        <svg class="update-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </summary><div class="update-content">${entry.notes.changes
        .map(
          (change) => `
        <section class="update-change"><span class="pill ${change.kind === "New" ? "pill-done" : ""}">${escape(change.kind)}</span><div><h2>${escape(change.title)}</h2><p>${escape(change.detail)}</p></div></section>`
        )
        .join("")}
        <p class="supporting-text update-published">Available since ${date(entry.completedAt)}.</p></div></details>`
      )
      .join("")}</div>
    <p class="supporting-text updates-end">You’ve reached the beginning.</p></article>`;
}

async function navigate(path, push = true) {
  if (popover.matches(":popover-open")) popover.hidePopover();
  if (push && location.pathname !== path) history.pushState({}, "", path);
  const patchesLink = document.querySelector('.app-nav a[href="/"]');
  if (path === "/") patchesLink.setAttribute("aria-current", "page");
  else patchesLink.removeAttribute("aria-current");
  if (path === "/updates") {
    const snapshot = structuredClone(state);
    renderUpdates(snapshot);
    state = await post("seen", {
      through: snapshot.entries.at(-1).sequence,
      generation: snapshot.generation
    });
  } else {
    main.innerHTML = portal;
    document.title = "Patchy · local updates prototype";
  }
  renderBell();
  renderLab();
  window.scrollTo(0, 0);
  if (push) main.querySelector("h1")?.focus({ preventScroll: true });
}

// Other global sections are context only; the chosen prototype covers Patches and Updates.
for (const link of document.querySelectorAll('.app-nav a:not([href="/"])')) {
  link.setAttribute("aria-disabled", "true");
  link.title = "Outside this local prototype";
}
document.addEventListener("click", async (event) => {
  const link = event.target.closest("a");
  if (link?.getAttribute("aria-disabled") === "true") {
    event.preventDefault();
    return;
  }
  if (
    link &&
    ["/", "/updates"].includes(link.getAttribute("href")) &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey
  ) {
    event.preventDefault();
    await navigate(link.getAttribute("href"));
  }
  const patch = event.target.closest(".prototype-patch");
  if (patch) {
    document
      .querySelectorAll(".prototype-patch")
      .forEach((item) => item.removeAttribute("aria-current"));
    patch.setAttribute("aria-current", "page");
    const name = patch.dataset.patch;
    const descriptions = {
      "team-handbook":
        "Everything the team needs to get started. Find useful links, working agreements, and the answers to everyday questions.",
      "weekly-report": "A quick look at this week’s progress, ready to share with your team.",
      "request-tracker":
        "Keep internal requests moving. See what’s waiting, who’s helping, and what’s done."
    };
    document.getElementById("prototype-patch-card").innerHTML =
      `<h2 class="section-heading">${escape(name)}</h2><p>${escape(descriptions[name])}</p><dl class="facts"><dt>Owner</dt><dd>${name === "request-tracker" ? "Alex" : "Srikar"}</dd><dt>Who can open</dt><dd>Everyone at Patchy Dev</dd><dt>Current version</dt><dd>v3</dd></dl><section class="section"><span class="pill pill-done">Live</span></section>`;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action || busy) return;
  busy = true;
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.disabled = true;
  });
  try {
    if (action !== "return") state = await post(action);
    else state = await (await fetch("/simulation/state")).json();
    await navigate("/");
  } catch (error) {
    document.getElementById("lab-status").textContent = error.message;
  } finally {
    busy = false;
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.disabled = false;
    });
  }
});
window.addEventListener("popstate", () => navigate(location.pathname, false));
window.addEventListener("focus", async () => {
  if (!state || busy) return;
  state = await (await fetch("/simulation/state")).json();
  renderBell();
  renderLab();
});
async function start() {
  state = await (await fetch("/simulation/state")).json();
  await navigate(location.pathname === "/updates" ? "/updates" : "/", false);
}
start().catch((error) => {
  document.getElementById("lab-status").textContent = error.message;
});
