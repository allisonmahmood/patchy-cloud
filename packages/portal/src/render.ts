import * as DateTime from "effect/DateTime";
import type { RequireSession } from "@patchy/auth";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import type { Patches } from "@patchy/patches";

export const styles = `
  .portal { display: grid; grid-template-columns: minmax(220px, 280px) minmax(0, 1fr); gap: 36px; align-items: start; }
  .portal-index, .portal-card { min-width: 0; }
  .portal-card { position: sticky; top: 24px; }
  .portal-index-line { display: block; }
  .portal-stop-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .portal-stop-actions > div { display: grid; align-content: start; }
  .portal-address { align-items: center; }
  .portal-subpage { max-width: 760px; margin-inline: auto; }
  .portal-table { overflow-x: auto; }
  @media (max-width: 860px) {
    .portal { grid-template-columns: minmax(0, 1fr); }
    .portal-card { position: static; }
  }
  @media (max-width: 480px) {
    .portal-stop-actions { grid-template-columns: minmax(0, 1fr); }
  }
`;

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const epochMillis = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
const dateLabel = (iso: string): string => {
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(iso));
  return `${parts.day} ${months[parts.month - 1]} ${parts.year}`;
};

export const ago = (iso: string, now: number): string => {
  const seconds = Math.max(0, Math.round((now - epochMillis(iso)) / 1000));
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"} ago`;
  if (seconds < 45) return "just now";
  if (seconds < 3600) return unit(Math.max(1, Math.round(seconds / 60)), "minute");
  if (seconds < 86_400) return unit(Math.round(seconds / 3600), "hour");
  return unit(Math.round(seconds / 86_400), "day");
};

const daysLeft = (purgeAt: string, now: number) =>
  Math.max(0, Math.ceil((epochMillis(purgeAt) - now) / 86_400_000));

const firstClause = (description: string): string => {
  const text = description.trim();
  const boundary = text.search(/\.|;| – /u);
  const clause = boundary === -1 ? text : text.slice(0, boundary).trimEnd();
  const points = Array.from(clause);
  return points.length > 80 ? `${points.slice(0, 79).join("").trimEnd()}…` : clause;
};

const cardPath = (patch: Patches.Patch, all: boolean, action = "") =>
  `/patches/${encodeURIComponent(patch.name)}${action ? `/${action}` : ""}${all ? "?all=1" : ""}`;
const canManage = (card: Patches.ReadPatch, viewer: RequireSession.Viewer["Service"]) =>
  card.owner.id === viewer.user.id || viewer.role === "admin";
const hidden = (name: string, value: string | number | null) =>
  `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value ?? "")}">`;
const refusal = (notice: string | undefined) =>
  notice === undefined
    ? ""
    : `<div class="note note-refused" role="alert">${escapeHtml(notice)}</div>`;

const indexGroup = (
  title: string,
  rows: readonly Patches.ReadPatch[],
  card: Patches.PortalCard | null,
  all: boolean,
  now: number
): string => {
  if (rows.length === 0) return "";
  const items = rows.map((row) => {
    const { patch } = row;
    const state =
      patch.state === "retired"
        ? "retired"
        : patch.state === "deleted"
          ? `deleted · gone in ${daysLeft(patch.purgeAt!, now)} days`
          : "";
    const clause = firstClause(patch.description);
    return `<li class="list-row"><a class="list-link" href="${escapeAttribute(cardPath(patch, all))}"${card?.patch.id === patch.id ? ' aria-current="page"' : ""}><span class="portal-index-line">${escapeHtml(patch.name)}</span><span class="supporting-text portal-index-line">${escapeHtml(clause || "No description")}</span>${state ? `<span class="pill">${escapeHtml(state)}</span>` : ""}${row.owner.deactivated ? '<span class="pill">owner deactivated</span>' : ""}</a></li>`;
  });
  return `<section class="section"><h2 class="section-heading">${escapeHtml(title)}</h2><ul class="list list-compact">${items.join("")}</ul></section>`;
};

const renderIndex = (input: {
  readonly rows: readonly Patches.ReadPatch[];
  readonly card: Patches.PortalCard | null;
  readonly viewer: RequireSession.Viewer["Service"];
  readonly all: boolean;
  readonly now: number;
}): string => {
  const yours: Patches.ReadPatch[] = [];
  const company: Patches.ReadPatch[] = [];
  const off: Patches.ReadPatch[] = [];
  for (const row of input.rows) {
    if (row.patch.state !== "live") off.push(row);
    else if (row.owner.id === input.viewer.user.id) yours.push(row);
    else company.push(row);
  }
  const byName = (a: Patches.ReadPatch, b: Patches.ReadPatch) =>
    a.patch.name.localeCompare(b.patch.name);
  yours.sort(byName);
  company.sort(byName);
  off.sort(byName);
  const liveCount = yours.length + company.length;
  const count = liveCount + (input.all ? off.length : 0);
  const togglePath =
    input.card === null ? (input.all ? "/" : "/?all=1") : cardPath(input.card.patch, !input.all);
  const toggle =
    off.length === 0
      ? ""
      : `<p><a href="${escapeAttribute(togglePath)}">${input.all ? "Hide" : "Show"} retired and deleted</a></p>`;
  return `<aside class="portal-index" aria-label="Patch index"><p class="supporting-text">${escapeHtml(count)} ${count === 1 ? "patch" : "patches"}</p>${toggle}${liveCount === 0 ? '<p class="supporting-text">No live patches.</p>' : ""}${indexGroup("Yours", yours, input.card, input.all, input.now)}${indexGroup("Company", company, input.card, input.all, input.now)}${input.all ? indexGroup("Retired and deleted", off, input.card, input.all, input.now) : ""}</aside>`;
};

const titleLine = (patch: Patches.Patch): string => {
  const normalized = (text: string) =>
    text
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/gu, "");
  return patch.title.trim() !== "" && normalized(patch.title) !== normalized(patch.name)
    ? `<p class="supporting-text">${escapeHtml(patch.title)}</p>`
    : "";
};

const descriptionBlock = (card: Patches.PortalCard): string => {
  const { patch } = card;
  const description =
    patch.description === ""
      ? '<p class="supporting-text">No description</p>'
      : `<p>${escapeHtml(patch.description)}</p>`;
  const actor =
    card.actorNames.description !== null && patch.descriptionUpdatedAt !== null
      ? `<p class="supporting-text">Description edited by ${escapeHtml(card.actorNames.description)} on ${escapeHtml(dateLabel(patch.descriptionUpdatedAt))}</p>`
      : "";
  return description + actor;
};

interface DependantGroup {
  readonly name: string;
  readonly ownerName: string;
  readonly tables: string[];
}

const dependantGroups = (card: Patches.PortalCard) => {
  const groups = new Map<string, DependantGroup>();
  for (const dependant of card.dependants) {
    const existing = groups.get(dependant.patchId);
    if (existing === undefined) {
      groups.set(dependant.patchId, {
        name: dependant.name,
        ownerName: dependant.owner.name,
        tables: [dependant.table]
      });
    } else if (!existing.tables.includes(dependant.table)) existing.tables.push(dependant.table);
  }
  return Array.from(groups.values());
};

const dependantsFact = (groups: readonly DependantGroup[], all: boolean): string => {
  if (groups.length === 0) return "Nothing else reads this patch";
  const shown = groups
    .slice(0, 3)
    .map(
      (group) =>
        `<li class="list-row"><a href="${escapeAttribute(`/patches/${encodeURIComponent(group.name)}${all ? "?all=1" : ""}`)}">${escapeHtml(group.name)}</a> (${escapeHtml(group.ownerName)}) reads ${group.tables.map((table) => `<code>${escapeHtml(table)}</code>`).join(", ")}</li>`
    )
    .join("");
  return `<p>${escapeHtml(groups.length)} ${groups.length === 1 ? "patch" : "patches"}</p><ul class="list list-compact">${shown}</ul>${groups.length > 3 ? `<p class="supporting-text">and ${escapeHtml(groups.length - 3)} more</p>` : ""}`;
};

const descriptionForm = (
  card: Patches.PortalCard,
  all: boolean,
  submitted?: string,
  error?: string
): string =>
  // Native maxlength counts UTF-16 units, not the server's Unicode code-point bound.
  `<section class="section"><form method="post" action="${escapeAttribute(cardPath(card.patch, all, "description"))}">${hidden("expectedDescriptionUpdatedAt", card.patch.descriptionUpdatedAt)}<label class="field-label" for="description">Description</label><textarea class="field" id="description" name="description" rows="4" aria-describedby="description-hint${error === undefined ? "" : " description-error"}"${error === undefined ? "" : ' aria-invalid="true"'}>${escapeHtml(submitted ?? card.patch.description)}</textarea><p class="field-hint" id="description-hint">The repo pulls this change in the next time it runs <code>patchy dev</code> or publishes. Start with what the tool does. Up to 500 characters.</p>${error === undefined ? "" : `<p class="field-error" id="description-error" role="alert">${escapeHtml(error)}</p>`}<div class="actions"><button class="btn" type="submit">Save description</button></div></form></section>`;

const scopeForm = (card: Patches.PortalCard, all: boolean): string => {
  const radio = (scope: Patches.Patch["scope"], label: string) =>
    `<label class="field-choice"><input class="field-radio" type="radio" name="scope" value="${escapeAttribute(scope)}"${card.patch.scope === scope ? " checked" : ""}>${escapeHtml(label)}</label>`;
  return `<section class="section"><h3 class="section-heading" id="scope-heading">Who can open it</h3><form method="post" action="${escapeAttribute(cardPath(card.patch, all, "scope"))}">${hidden("expectedScope", card.patch.scope)}<div role="radiogroup" aria-labelledby="scope-heading" aria-describedby="scope-hint">${radio("company", "People at the company")}${radio("public", "Anyone on the internet")}</div><p class="field-hint" id="scope-hint">This governs opening the page only. Which tables other patches may read is declared in code and changes at publish.</p><div class="actions"><button class="btn" type="submit">Save who can open it</button></div></form></section>`;
};

const versionsTable = (
  card: Patches.PortalCard,
  versions: Patches.PortalCard["versions"],
  viewer: RequireSession.Viewer["Service"],
  all: boolean,
  now: number
): string => {
  const manage = canManage(card, viewer) && card.patch.state === "live";
  const rows = versions.map((version) => {
    const current = version.id === card.patch.currentVersionId;
    const action = current
      ? '<span class="pill pill-done">current</span>'
      : manage
        ? `<form method="post" action="${escapeAttribute(cardPath(card.patch, all, "rollback"))}">${hidden("expectedCurrentVersionId", card.patch.currentVersionId)}${hidden("versionNumber", version.versionNumber)}<button class="btn" type="submit">Show this version at the address</button></form>`
        : "";
    return `<tr><th scope="row">v${escapeHtml(version.versionNumber)}</th><td><time datetime="${escapeAttribute(version.createdAt)}">${escapeHtml(dateLabel(version.createdAt))}</time><br><span class="supporting-text">${escapeHtml(ago(version.createdAt, now))}</span></td><td>${escapeHtml(version.publisherName)}</td><td>${action}</td></tr>`;
  });
  return `<div class="portal-table"><table class="table" aria-label="Patch versions"><thead><tr><th scope="col">Version</th><th scope="col">Published</th><th scope="col">Published by</th><th scope="col">At the address</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
};

const versionsSection = (
  card: Patches.PortalCard,
  viewer: RequireSession.Viewer["Service"],
  all: boolean,
  now: number
): string => {
  const current = card.versions.find((version) => version.id === card.patch.currentVersionId);
  const shown = current === undefined ? [] : [current];
  for (const version of card.versions) {
    if (version.id !== card.patch.currentVersionId) shown.push(version);
    if (shown.length === 4) break;
  }
  return `<section class="section"><h3 class="section-heading">Versions</h3>${versionsTable(card, shown, viewer, all, now)}<p class="supporting-text">The address changes for everyone now. Tables and the description do not move.</p><p><a href="${escapeAttribute(cardPath(card.patch, all, "versions"))}">All ${escapeHtml(card.versions.length)} versions</a></p></section>`;
};

const restoreActions = (card: Patches.PortalCard, all: boolean, now: number): string => {
  const { patch } = card;
  if (patch.state === "deleted" && (patch.purgeAt === null || epochMillis(patch.purgeAt) <= now)) {
    return '<p class="supporting-text">The recovery window has ended. This patch can no longer be restored.</p>';
  }
  const restore =
    card.offSources.length === 0
      ? `<form method="post" action="${escapeAttribute(cardPath(patch, all, "restore"))}">${hidden("expectedState", patch.state)}<button class="btn btn-primary" type="submit">Restore</button></form>`
      : `<a class="btn btn-primary" href="${escapeAttribute(cardPath(patch, all, "restore"))}">Restore…</a>`;
  const hint =
    card.offSources.length === 0
      ? `Restore brings it back live at v${card.currentVersion} with the same address.`
      : "It reads tables from patches that are off. Review those sources before restoring it.";
  return `<div class="actions">${restore}${patch.state === "retired" ? `<a class="btn btn-danger" href="${escapeAttribute(cardPath(patch, all, "delete"))}">Delete…</a>` : ""}</div><p class="supporting-text">${escapeHtml(hint)}${patch.state === "retired" ? " Delete starts the 30-day clock." : ""}</p>`;
};

const renderCard = (input: {
  readonly card: Patches.PortalCard;
  readonly viewer: RequireSession.Viewer["Service"];
  readonly all: boolean;
  readonly now: number;
  readonly publicBaseUrl: string;
  readonly submittedDescription?: string;
  readonly descriptionError?: string;
}): string => {
  const { card, viewer, all, now } = input;
  const { patch } = card;
  const live = patch.state === "live";
  const manage = canManage(card, viewer);
  const groups = dependantGroups(card);
  const url = `${input.publicBaseUrl.replace(/\/+$/u, "")}/${encodeURIComponent(patch.companyHandle)}/${encodeURIComponent(patch.name)}`;
  const open = live
    ? `<div class="actions portal-address"><a class="btn btn-primary" href="${escapeAttribute(`/${encodeURIComponent(patch.companyHandle)}/${encodeURIComponent(patch.name)}`)}">Open</a><code class="copy-address" aria-label="Patch address, select to copy">${escapeHtml(url)}</code></div>`
    : "";
  const current = card.versions.find((version) => version.id === patch.currentVersionId);
  const versionFact = `v${card.currentVersion}, published ${ago(card.publishedAt, now)}${current === undefined ? "" : ` by ${current.publisherName}`}`;
  const owner = `${escapeHtml(card.owner.name)}${card.owner.deactivated ? " (deactivated)" : ""}${viewer.role === "admin" ? ` <a href="${escapeAttribute(cardPath(patch, all, "reassign"))}">Reassign…</a>` : ""}`;
  const audience =
    patch.scope === "company"
      ? `Anyone at ${viewer.company.name} who signs in. Not the public.`
      : "Anyone on the internet. No sign-in.";
  const stateActor = patch.state === "retired" ? card.actorNames.retired : card.actorNames.deleted;
  const stateAt = patch.state === "retired" ? patch.retiredAt : patch.deletedAt;
  const stateFact = live
    ? ""
    : `<dt>State</dt><dd>${patch.state === "retired" ? "Retired" : "Deleted"}${stateActor === null ? "" : ` by ${escapeHtml(stateActor)}`}${stateAt === null ? "" : `, ${escapeHtml(dateLabel(stateAt))}`}</dd>`;
  const facts =
    !live && !manage
      ? `<dl class="facts">${stateFact}</dl>`
      : `<dl class="facts">${stateFact}<dt>Owner</dt><dd>${owner}</dd><dt>Current version</dt><dd>${escapeHtml(versionFact)}</dd>${live ? `<dt>Who can open it</dt><dd>${escapeHtml(audience)}</dd>` : ""}<dt>Used by other patches</dt><dd>${dependantsFact(groups, all)}</dd></dl>`;
  const offNote = live
    ? ""
    : patch.state === "retired"
      ? `<div class="note"><span class="note-title">Off the shelf, kept as it was</span>Its tables, files and all its versions are kept for as long as you like; nobody can open <code>${escapeHtml(patch.name)}</code> until it is restored.</div>`
      : `<div class="note note-warn"><span class="note-title">Gone for good in ${escapeHtml(daysLeft(patch.purgeAt!, now))} days</span>Until then the owner or an admin can restore it; after that the page, its versions, tables, files and the name are all reclaimed.</div>`;
  const deactivated =
    viewer.role === "admin" && card.owner.deactivated
      ? `<div class="note note-warn">Nobody can publish to this patch. Its owner is deactivated.${live ? " Reassign it or retire it." : ""}</div>`
      : "";
  const adminLine =
    viewer.role === "admin" && viewer.user.id !== card.owner.id
      ? '<p class="supporting-text">You can do everything an owner can from here, except publish.</p>'
      : "";
  const stop =
    live && manage
      ? `<section class="note note-warn"><span class="note-title">Stop serving</span><p>${groups.length === 0 ? "Nothing else reads this patch." : `${escapeHtml(groups.length)} ${groups.length === 1 ? "patch reads" : "patches read"} this patch's tables and will break until it is restored. You will be asked to confirm.`}</p><div class="actions portal-stop-actions"><div><a class="btn btn-danger" href="${escapeAttribute(cardPath(patch, all, "retire"))}">Retire…</a><p class="supporting-text">Keeps everything indefinitely. Nobody can open it until it is restored.</p></div><div><a class="btn btn-danger" href="${escapeAttribute(cardPath(patch, all, "delete"))}">Delete…</a><p class="supporting-text">Keeps it 30 days, then it is gone for good.</p></div></div></section>`
      : "";
  const management = manage
    ? `${adminLine}<section class="section" aria-labelledby="manage-heading"><h2 class="section-heading" id="manage-heading">Manage</h2>${live ? "" : restoreActions(card, all, now)}${patch.state === "deleted" ? "" : descriptionForm(card, all, input.submittedDescription, input.descriptionError)}${live ? scopeForm(card, all) + versionsSection(card, viewer, all, now) + stop : ""}</section>`
    : "";
  return `<article class="portal-card"><p class="supporting-text">${escapeHtml(patch.companyHandle)} / ${escapeHtml(patch.name)}</p><h1 class="page-heading">${escapeHtml(patch.name)}</h1>${titleLine(patch)}${descriptionBlock(card)}${open}${facts}${offNote}${deactivated}${management}</article>`;
};

export const renderPortal = (input: {
  readonly rows: readonly Patches.ReadPatch[];
  readonly card: Patches.PortalCard | null;
  readonly viewer: RequireSession.Viewer["Service"];
  readonly all: boolean;
  readonly now: number;
  readonly publicBaseUrl: string;
  readonly notice?: string;
  readonly submittedDescription?: string;
  readonly descriptionError?: string;
}): string => {
  if (input.rows.length === 0 && input.card === null) {
    return `${refusal(input.notice)}<article><h1 class="page-heading">No patches yet</h1><p>The first one published lists here for everyone at ${escapeHtml(input.viewer.company.name)}.</p><div class="note"><span class="note-title">Publish the first one</span>Ask your agent to publish a page with Patchy, or run <code>patchy publish page.html</code> from a terminal that has done <code>patchy login</code>.</div></article>`;
  }
  const card =
    input.card === null
      ? `<article class="portal-card"><h1 class="page-heading">No live patches</h1><p>${input.all ? "Choose a patch from Retired and deleted to see its card." : "Show retired and deleted to see the company's patches."}</p></article>`
      : renderCard({ ...input, card: input.card });
  return `${refusal(input.notice)}<div class="portal">${renderIndex(input)}${card}</div>`;
};

export const renderVersions = (input: {
  readonly card: Patches.PortalCard;
  readonly viewer: RequireSession.Viewer["Service"];
  readonly all: boolean;
  readonly now: number;
}): string =>
  `<article class="portal-subpage"><p><a href="${escapeAttribute(cardPath(input.card.patch, input.all))}">Back to ${escapeHtml(input.card.patch.name)}</a></p><h1 class="page-heading">Versions of ${escapeHtml(input.card.patch.name)}</h1>${versionsTable(input.card, input.card.versions, input.viewer, input.all, input.now)}${canManage(input.card, input.viewer) && input.card.patch.state === "live" ? '<p class="supporting-text">The address changes for everyone now. Tables and the description do not move.</p>' : ""}</article>`;

export const renderRestoreConflict = (input: {
  readonly card: Patches.PortalCard;
  readonly viewer: RequireSession.Viewer["Service"];
  readonly all: boolean;
}): string => {
  const { card, viewer, all } = input;
  const sources = card.offSources
    .map(
      (source) =>
        `<li><code>${escapeHtml(source.name ?? source.patchId)}</code> / <code>${escapeHtml(source.table)}</code>: ${escapeHtml(source.state)}</li>`
    )
    .join("");
  return `<article class="portal-subpage"><p><a href="${escapeAttribute(cardPath(card.patch, all))}">Back to ${escapeHtml(card.patch.name)}</a></p><h1 class="page-heading">Restore ${escapeHtml(card.patch.name)}?</h1><div class="note note-refused" role="alert">Some sources are off. Nothing was done.</div><p class="confirmation-consequence">This patch will serve, but it will error when it reads these tables until their sources are restored too.</p><ul class="confirmation-list">${sources}</ul><div class="confirmation-actions">${canManage(card, viewer) ? `<a class="btn btn-primary" href="${escapeAttribute(cardPath(card.patch, all, "restore"))}">Review restore…</a>` : ""}<a class="btn btn-quiet" href="${escapeAttribute(cardPath(card.patch, all))}">Cancel</a></div></article>`;
};
