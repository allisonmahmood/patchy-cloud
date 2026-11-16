export {};

type Variant = "sort" | "filters" | "groups";
type Screen =
  "list" | "home" | "patch" | "create" | "add" | "manage" | "map" | "agents" | "settings";
type SortKey = "title" | "owner" | "updated" | "visits" | "access" | "failures";
interface Patch {
  id: number;
  title: string;
  description: string;
  owner: string;
  kind: "Page" | "Tool";
  created: string;
  updated: string;
  visits: number;
  access: string;
  failures: number | null;
  unopened: boolean;
  area: string;
}
interface Group {
  id: number;
  name: string;
  patches: Set<number>;
}
const patches: Patch[] = await (await fetch("./data.json")).json();
const variants: Record<Variant, string> = {
  sort: "1 · Sort headings",
  filters: "2 · Quick filters",
  groups: "3 · Custom groups"
};
const columns: ReadonlyArray<{ key: SortKey; label: string; descending: boolean }> = [
  { key: "title", label: "Patch", descending: false },
  { key: "owner", label: "Owner", descending: false },
  { key: "updated", label: "Updated", descending: true },
  { key: "visits", label: "Visits", descending: true },
  { key: "access", label: "Access", descending: false },
  { key: "failures", label: "Failures (24 h)", descending: true }
];
const quarterNames = [
  "Budget review",
  "Invoice tracker",
  "Board metrics",
  "Forecast scenarios",
  "Cost allocation",
  "Card reconciliation",
  "Month-end checklist",
  "Payment calendar",
  "Collections queue",
  "Revenue report",
  "Contract renewals",
  "Audit checklist",
  "Spend approvals",
  "Decision log",
  "Quarterly goals",
  "Weekly planning",
  "Launch readiness",
  "Risk register"
];
const state = {
  variant: "sort" as Variant,
  screen: "list" as Screen,
  patchId: 1,
  groupId: 0,
  groups: [
    {
      id: 1,
      name: "Quarter-end",
      patches: new Set(patches.filter((p) => quarterNames.includes(p.title)).map((p) => p.id))
    }
  ] as Group[],
  nextGroup: 2,
  owner: "",
  unopened: false,
  since: "",
  type: "",
  search: "",
  page: 1,
  sort: "title" as SortKey,
  descending: false,
  pins: new Set(
    patches
      .filter((p) => ["Renewal tracker", "Release checklist", "Weekly planning"].includes(p.title))
      .map((p) => p.id)
  ),
  selected: new Set<number>(),
  pickerSearch: "",
  notice: "",
  deletePending: false
};
const root = document.querySelector<HTMLDivElement>("#root")!;
const esc = (value: string | number) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!
  );
const currentGroup = () => state.groups.find((g) => g.id === state.groupId);
const button = (label: string, action: string, extra = "", quiet = false) =>
  `<button class="btn btn-sm${quiet ? " btn-quiet" : ""}" data-action="${action}" ${extra}>${label}</button>`;
function href(screen: Screen, params: Record<string, string | number> = {}) {
  return (
    "#" +
    new URLSearchParams({
      variant: state.variant,
      screen,
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
    })
  );
}
const link = (
  label: string,
  screen: Screen,
  params: Record<string, string | number> = {},
  className = ""
) => `<a class="${className}" href="${href(screen, params)}">${label}</a>`;
function mark(patch: Patch) {
  return patch.kind === "Page"
    ? '<span class="page-mark"></span>'
    : `<span class="mono mono-green">${esc(
        patch.title
          .replace(/^\d+\.\s*/, "")
          .split(" ")
          .map((w) => w[0])
          .slice(0, 2)
          .join("")
      )}</span>`;
}
function matching() {
  const group = currentGroup();
  return patches.filter(
    (p) =>
      (!group || group.patches.has(p.id)) &&
      (!state.owner || p.owner === state.owner) &&
      (!state.unopened || p.unopened) &&
      (!state.type || (state.type === "Yours" ? p.owner === "Nina Park" : p.kind === state.type)) &&
      (!state.since || p.updated >= state.since) &&
      `${p.title} ${p.description} ${p.owner}`.toLowerCase().includes(state.search.toLowerCase())
  );
}
function sorted(items: Patch[]) {
  return [...items].sort((a, b) => {
    const x = a[state.sort],
      y = b[state.sort];
    if (x === null || y === null)
      return x === y ? a.title.localeCompare(b.title) : x === null ? 1 : -1;
    const result =
      typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return result
      ? result * (state.descending ? -1 : 1)
      : a.title.localeCompare(b.title) || a.id - b.id;
  });
}
function table(items: Patch[], removable = false) {
  return `<div class="table-wrap"><table class="table"><thead><tr>${columns.map(({ key, label }) => `<th class="${key === "title" ? "" : "hide-sm nowrap"}"${state.sort === key ? ` aria-sort="${state.descending ? "descending" : "ascending"}"` : ""}><button class="sort${state.sort === key ? " active" : ""}" data-action="sort" data-key="${key}">${label} ${state.sort === key ? (state.descending ? "↓" : "↑") : "↕"}</button></th>`).join("")}<th><span class="sr-only">Actions</span></th></tr></thead><tbody>${items.map((p) => `<tr data-patch="${p.id}"><td class="cell-grow"><div class="cell-name">${mark(p)}<div class="row-main">${link(esc(p.title) + (p.unopened ? '<span class="unopened" aria-label="Not opened"></span>' : ""), "patch", { id: p.id, group: state.groupId }, "table-title")}<span class="row-desc">${esc(p.description)}</span></div></div></td><td class="hide-sm nowrap"><div class="cell-name"><span class="avatar">${p.owner[0]}</span>${esc(p.owner.split(" ")[0]!)}</div></td><td class="hide-sm nowrap muted">${p.updated}</td><td class="hide-sm nowrap r">${p.visits}</td><td class="hide-sm nowrap">${esc(p.access)}</td><td class="hide-sm nowrap">${p.failures ?? "—"}</td><td class="nowrap">${removable ? button("Remove", "remove", `data-id="${p.id}"`, true) : button(state.pins.has(p.id) ? "Unpin" : "Pin", "pin", `data-id="${p.id}"`, true)}</td></tr>`).join("")}</tbody></table></div>`;
}
function filters() {
  return `<div class="filters"><label><span class="sr-only">Owner</span><select class="field-control" data-filter="owner" aria-label="Owner"><option value="">All owners</option>${[
    ...new Set(patches.map((p) => p.owner))
  ]
    .sort()
    .map((n) => `<option${state.owner === n ? " selected" : ""}>${esc(n)}</option>`)
    .join(
      ""
    )}</select></label><label class="inline-check"><input type="checkbox" data-filter="unopened"${state.unopened ? " checked" : ""}>Not opened</label><label><span class="sr-only">Updated</span><select class="field-control" data-filter="since" aria-label="Updated"><option value="">Updated · Any time</option><option value="2026-11-09"${state.since ? " selected" : ""}>Updated · Last 7 days</option></select></label>${button("Clear filters", "clear", "", true)}</div>${state.owner || state.unopened || state.since ? `<div class="toolbar">${state.owner ? `<span class="chip chip-on">Owner · ${esc(state.owner)}</span>` : ""}${state.unopened ? '<span class="chip chip-on">Not opened</span>' : ""}${state.since ? '<span class="chip chip-on">Updated · Last 7 days</span>' : ""}</div>` : ""}`;
}
function list() {
  const found = sorted(matching());
  const pages = Math.max(1, Math.ceil(found.length / 50));
  state.page = Math.min(state.page, pages);
  const shown = found.slice((state.page - 1) * 50, state.page * 50);
  const group = currentGroup();
  const toolbar =
    state.variant === "groups"
      ? `<div class="toolbar"><div class="seg group-tabs">${link("All patches · 120", "list", {}, state.groupId ? "" : "selected")}${state.groups.map((g) => link(`${esc(g.name)} · ${g.patches.size}`, "list", { group: g.id })).join("")}</div><span class="grow">${link("＋ New group", "create", {}, "btn btn-sm")}</span></div>${group ? `<div class="group-name-row"><h2>${esc(group.name)}</h2><div class="cluster">${link("Add patches", "add", { group: group.id }, "btn btn-sm")}${link("Group options", "manage", { group: group.id }, "btn btn-sm")}</div></div>` : ""}`
      : `<div class="toolbar"><div class="seg">${["", "Tool", "Page", "Yours"].map((type, i) => `<a href="#" data-action="type" data-type="${type}"${state.type === type ? ' aria-current="page"' : ""}>${["All", "Tools", "Pages", "Yours"][i]}</a>`).join("")}</div></div>`;
  return `${toolbar}${state.variant === "filters" ? filters() : ""}<div class="mobile-sort"><label>Sort by <select data-filter="sort" class="field-control">${columns.map((c) => `<option value="${c.key}"${state.sort === c.key ? " selected" : ""}>${c.label}</option>`).join("")}</select></label>${button(state.descending ? "Descending ↓" : "Ascending ↑", "reverse")}</div>${shown.length ? table(shown, Boolean(group)) : `<div class="box empty"><h2>${group && !group.patches.size ? "No patches in this group" : "No matching patches"}</h2>${group ? link("Add patches", "add", { group: group.id }, "btn btn-sm") : button("Clear filters", "clear")}</div>`}<nav class="pagination"><span>${found.length ? (state.page - 1) * 50 + 1 : 0}–${Math.min(state.page * 50, found.length)} of ${found.length}</span><span class="cluster">${state.page > 1 ? button("Previous", "page", 'data-step="-1"') : ""}${state.page < pages ? button("Next", "page", 'data-step="1"') : ""}</span></nav>`;
}
function groupForm() {
  const group = currentGroup();
  if (state.screen === "create" || state.screen === "manage")
    return `<form class="form-stack" id="group-form"><label>Name<input class="field-control" name="name" required maxlength="60" value="${state.screen === "manage" ? esc(group?.name ?? "") : ""}" autofocus></label><div class="cluster"><button class="btn btn-sm" type="submit">${state.screen === "create" ? "Create group" : "Save name"}</button>${link("Cancel", "list", { group: state.groupId }, "btn btn-quiet btn-sm")}</div></form>${state.screen === "manage" ? `<div class="section box box-pad"><h2>Delete group</h2><p>Its patches stay in All patches.</p>${state.deletePending ? `<p>Delete ${esc(group?.name ?? "")}?</p>${button("Delete group now", "delete")}${button("Cancel", "cancel-delete", "", true)}` : button("Delete group", "confirm-delete")}</div>` : ""}`;
  return `<form id="add-form" class="form-stack"><label>Search patches<input class="field-control" id="picker-search" type="search" value="${esc(state.pickerSearch)}" autocomplete="off"></label><div class="box checklist-picker">${patches
    .filter((p) => `${p.title} ${p.owner}`.toLowerCase().includes(state.pickerSearch.toLowerCase()))
    .map(
      (p) =>
        `<div class="picker-row"><input type="checkbox" id="select-${p.id}" data-select="${p.id}"${state.selected.has(p.id) ? " checked" : ""}><label for="select-${p.id}">${esc(p.title)}<small>${esc(p.owner)} · ${p.kind}</small></label></div>`
    )
    .join(
      ""
    )}</div><div class="cluster"><button class="btn btn-sm" type="submit">Save selection <span id="selection-count">(${state.selected.size})</span></button>${link("Cancel", "list", { group: state.groupId }, "btn btn-quiet btn-sm")}</div></form>`;
}
function detail() {
  const p = patches.find((p) => p.id === state.patchId)!;
  return `<div class="patch-detail">${link("← All patches", "list", { group: state.groupId }, "ph-parent")}<p class="meta">${esc(p.owner)} · ${p.kind} · ${esc(p.access)} · Updated ${p.updated}</p><p>${esc(p.description)}</p><div class="cluster">${button(state.pins.has(p.id) ? "Unpin patch" : "Pin patch", "pin", `data-id="${p.id}"`)}${state.variant === "groups" ? link("Your groups", "list", {}, "btn btn-sm") : ""}</div><section class="section"><h2>Example ${p.kind === "Page" ? "document" : "records"}</h2><div class="box box-pad"><p>Northstar · ${esc(p.area)}</p><p>${p.kind === "Page" ? "Notes for the next team review. This is fictional content so you can judge the path into and out of a patch." : "Three sample items for the next review. This screen stands in for an opened patch."}</p><ul><li>Review the current plan · Maya Chen</li><li>Confirm next steps · Priya Shah</li><li>Share the outcome · Nina Park</li></ul></div></section></div>`;
}
function map() {
  return `<p>Click a screen to visit it. Back returns through browser history.</p>${[
    [
      "All variations",
      [
        link("Home", "home", {}, "flow-node"),
        "→",
        link("All patches", "list", {}, "flow-node"),
        "→",
        link("Patch detail", "patch", { id: 1 }, "flow-node"),
        "↔",
        link("Pinned patch", "patch", { id: 12 }, "flow-node")
      ]
    ],
    [
      "Sort headings",
      [
        '<a class="flow-node" href="#variant=sort&screen=list">All patches</a>',
        "→ click heading →",
        '<span class="flow-node">Same list, reordered</span>'
      ]
    ],
    [
      "Quick filters",
      [
        '<a class="flow-node" href="#variant=filters&screen=list">All patches</a>',
        "→ choose owner/date/opened →",
        '<span class="flow-node">Same list, fewer rows</span>'
      ]
    ],
    [
      "Custom groups",
      [
        link("New group", "create", {}, "flow-node"),
        "→",
        '<span class="flow-node">Empty group</span>',
        "→",
        link("Choose patches", "add", { group: state.groups[0]?.id ?? 0 }, "flow-node"),
        "→",
        link("Group list", "list", { group: state.groups[0]?.id ?? 0 }, "flow-node")
      ]
    ]
  ]
    .map(
      ([name, nodes]) =>
        `<section class="map-lane"><h2>${name}</h2><div class="flow-map">${(nodes as string[]).join("")}</div></section>`
    )
    .join(
      ""
    )}<p class="prototype-note">Groups are personal in this mock. Shared groups remain an open product choice. Picker and group-list links use the first group currently in memory.</p>`;
}
function render() {
  const patch = patches.find((p) => p.id === state.patchId);
  const title =
    state.screen === "patch"
      ? (patch?.title ?? "Patch")
      : {
          list: "All patches",
          home: "Home",
          create: "New group",
          add: "Add patches",
          manage: "Group options",
          map: "Screen map",
          agents: "Your agents",
          settings: "Settings"
        }[state.screen];
  let content = "";
  if (state.screen === "list") content = list();
  else if (["create", "add", "manage"].includes(state.screen)) content = groupForm();
  else if (state.screen === "patch") content = detail();
  else if (state.screen === "map") content = map();
  else if (state.screen === "home")
    content = `<h2>Your usual</h2>${table(patches.filter((p) => state.pins.has(p.id)))}<section class="section"><div class="section-head"><h2>From colleagues</h2>${link("See all patches", "list")}</div>${table(patches.filter((p) => p.owner !== "Nina Park").slice(0, 12))}</section>`;
  else
    content = `<div class="placeholder-grid"><section class="box"><h2>${state.screen === "agents" ? "Connected apps" : "Company"}</h2><p>${state.screen === "agents" ? "No real accounts are connected. This is the navigation destination only." : "Northstar · Nina Park · Fictional company"}</p></section><section class="box"><h2>${state.screen === "agents" ? "Computers" : "People"}</h2><p>${state.screen === "agents" ? "No computer setup runs in this prototype." : "12 fictional colleagues. Access settings are not simulated."}</p></section></div>`;
  const navigation = `${link("⌂ Home", "home", {}, "app-place")}${link("▦ All patches", "list", {}, "app-place")}${link("♧ Your agents", "agents", {}, "app-place")}${link("⚙ Settings", "settings", {}, "app-place")}`;
  root.innerHTML = `<div class="study-bar"><span>Design exploration · #1459</span><div class="seg">${Object.entries(
    variants
  )
    .map(
      ([key, label]) =>
        `<a href="#variant=${key}&screen=list"${state.variant === key ? ' aria-current="page"' : ""}>${label}</a>`
    )
    .join(
      ""
    )}</div>${link("Screen map", "map")}${button("Reset mock", "reset", "", true)}<span>In memory · No production connection</span></div><div class="phone-bar"><span class="brand"><span class="glyph"></span>Northstar</span><nav>${link("Home", "home")}${link("All patches", "list")}${link("Map", "map")}</nav></div><div class="app"><aside class="app-side"><div class="app-side-inner"><a class="brand" href="${href("home")}"><span class="glyph"></span>Northstar</a><form id="search-form"><input class="mock-search" name="query" placeholder="Search patches" aria-label="Search patches" value="${esc(state.search)}"></form><div class="app-menu"><p class="meta">Prototype · No publishing</p><nav class="app-nav">${navigation}</nav>${state.variant === "groups" ? `<div class="group-places"><span class="meta">Your groups</span>${state.groups.map((g) => link(esc(g.name), "list", { group: g.id }, "app-place")).join("")}${link("＋ New group", "create", {}, "app-place")}</div>` : ""}<div class="app-pins"><span class="meta">Pinned</span>${patches
    .filter((p) => state.pins.has(p.id))
    .map((p) => link(esc(p.title), "patch", { id: p.id }, "app-place"))
    .join(
      ""
    )}</div><div class="app-foot"><span class="app-place">Nina Park</span></div></div></div></aside><main class="app-page"><div class="page"><header class="ph"><h1 class="title">${esc(title)}</h1></header>${state.notice ? `<p class="status-note" role="status">${esc(state.notice)}</p>` : ""}${state.search ? `<p class="meta">Matching “${esc(state.search)}” ${button("Clear", "clear", "", true)}</p>` : ""}${content}<p class="prototype-note">120 synthetic patches. Reload or Reset mock discards changes. Date filters use 15 Nov 2026.</p></div></main></div>`;
  root.querySelectorAll<HTMLAnchorElement>(".group-tabs a").forEach((a) => {
    if (Number(new URLSearchParams(a.hash.slice(1)).get("group") ?? 0) === state.groupId)
      a.setAttribute("aria-current", "page");
  });
  root.querySelectorAll<HTMLAnchorElement>(".app-nav a").forEach((a) => {
    if (new URLSearchParams(a.hash.slice(1)).get("screen") === state.screen)
      a.setAttribute("aria-current", "page");
  });
}
function route() {
  const params = new URLSearchParams(location.hash.slice(1));
  const nextVariant =
    ["create", "add", "manage"].includes(params.get("screen") ?? "") ||
    Number(params.get("group")) > 0
      ? "groups"
      : params.get("variant");
  if (nextVariant && nextVariant in variants && nextVariant !== state.variant) {
    state.variant = nextVariant as Variant;
    state.owner = "";
    state.unopened = false;
    state.since = "";
    state.type = "";
    state.search = "";
    state.sort = "title";
    state.descending = false;
  }
  const screen = params.get("screen");
  state.screen = (
    ["list", "home", "patch", "create", "add", "manage", "map", "agents", "settings"].includes(
      screen ?? ""
    )
      ? screen
      : "list"
  ) as Screen;
  state.groupId = Number(params.get("group") ?? 0);
  state.page = 1;
  state.notice = "";
  state.deletePending = false;
  if (state.screen === "patch") {
    state.patchId = Number(params.get("id"));
    const patch = patches.find((p) => p.id === state.patchId);
    if (!patch) state.screen = "list";
    else {
      patch.unopened = false;
      patch.visits++;
    }
  }
  if (["add", "manage"].includes(state.screen) && !currentGroup()) state.screen = "list";
  if (state.screen === "add") {
    state.selected = new Set(currentGroup()!.patches);
    state.pickerSearch = "";
  }
  render();
  window.scrollTo(0, 0);
}
root.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  event.preventDefault();
  const action = target.dataset.action;
  if (action === "sort") {
    const column = columns.find((c) => c.key === target.dataset.key)!;
    state.descending = state.sort === column.key ? !state.descending : column.descending;
    state.sort = column.key;
    state.page = 1;
  } else if (action === "reverse") state.descending = !state.descending;
  else if (action === "page") {
    state.page += Number(target.dataset.step);
    window.scrollTo(0, 0);
  } else if (action === "type") {
    state.type = target.dataset.type ?? "";
    state.page = 1;
  } else if (action === "clear") {
    state.owner = "";
    state.since = "";
    state.unopened = false;
    state.search = "";
    state.type = "";
    state.page = 1;
  } else if (action === "pin") {
    const id = Number(target.dataset.id);
    state.pins.has(id) ? state.pins.delete(id) : state.pins.add(id);
  } else if (action === "remove") {
    currentGroup()!.patches.delete(Number(target.dataset.id));
    state.notice = "Removed from this group. The patch stays in All patches.";
  } else if (action === "confirm-delete") state.deletePending = true;
  else if (action === "cancel-delete") state.deletePending = false;
  else if (action === "delete") {
    state.groups = state.groups.filter((g) => g.id !== state.groupId);
    location.hash = href("list");
    return;
  } else if (action === "reset") {
    location.reload();
    return;
  }
  render();
});
root.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.dataset.select) {
    const id = Number(target.dataset.select);
    target.checked ? state.selected.add(id) : state.selected.delete(id);
    document.querySelector("#selection-count")!.textContent = `(${state.selected.size})`;
    return;
  }
  const field = target.dataset.filter;
  if (!field) return;
  if (field === "owner") state.owner = target.value;
  else if (field === "unopened") state.unopened = target.checked;
  else if (field === "since") state.since = target.value;
  else if (field === "sort") {
    state.sort = target.value as SortKey;
    state.descending = columns.find((c) => c.key === state.sort)!.descending;
  }
  state.page = 1;
  render();
});
root.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.name === "name") target.setCustomValidity("");
  if (target.id !== "picker-search") return;
  const position = target.selectionStart;
  state.pickerSearch = target.value;
  render();
  const next = document.querySelector<HTMLInputElement>("#picker-search")!;
  next.focus();
  next.setSelectionRange(position, position);
});
root.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const data = new FormData(form);
  if (form.id === "search-form") {
    state.search = String(data.get("query") ?? "");
    state.page = 1;
    location.hash = href("list", { group: state.groupId });
    render();
  } else if (form.id === "group-form") {
    const name = String(data.get("name")).trim();
    if (!name) {
      form.querySelector("input")!.setCustomValidity("Enter a group name.");
      form.reportValidity();
      return;
    }
    if (state.screen === "create") {
      const group = { id: state.nextGroup++, name, patches: new Set<number>() };
      state.groups.push(group);
      location.hash = href("list", { group: group.id });
    } else {
      currentGroup()!.name = name;
      location.hash = href("list", { group: state.groupId });
    }
  } else if (form.id === "add-form") {
    currentGroup()!.patches = new Set(state.selected);
    location.hash = href("list", { group: state.groupId });
  }
});
window.addEventListener("hashchange", route);
route();
