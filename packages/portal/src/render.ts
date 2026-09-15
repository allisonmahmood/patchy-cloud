import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import type { RequireSession } from "@patchy/auth";
import type { Users } from "@patchy/companies";
import { dateLabel, daysLeft, escapeAttribute, escapeHtml, renderOffPatch } from "@patchy/core";
import { Patches } from "@patchy/patches";

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

const epochMillis = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

export const ago = (iso: string, now: number): string => {
  const seconds = Math.max(0, Math.round((now - epochMillis(iso)) / 1000));
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"} ago`;
  if (seconds < 45) return "just now";
  if (seconds < 3600) return unit(Math.max(1, Math.round(seconds / 60)), "minute");
  if (seconds < 86_400) return unit(Math.round(seconds / 3600), "hour");
  return unit(Math.round(seconds / 86_400), "day");
};

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
export const hidden = (name: string, value: string | number | null) =>
  `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value ?? "")}">`;
export const refusal = (notice: string | undefined) =>
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
          ? `deleted · gone in ${daysLeft(epochMillis(patch.purgeAt!), now)} days`
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
  const off =
    patch.state === "live"
      ? null
      : renderOffPatch({
          name: patch.name,
          state: patch.state,
          actorName: patch.state === "retired" ? card.actorNames.retired : card.actorNames.deleted,
          stateAt: patch.state === "retired" ? patch.retiredAt : patch.deletedAt,
          purgeAt: patch.purgeAt,
          now,
          restore: manage
            ? {
                href: cardPath(patch, all, "restore"),
                sourcesOff: card.offSources.length > 0,
                currentVersion: card.currentVersion
              }
            : null
        });
  const stateFact = off?.stateFact ?? "";
  const facts =
    !live && !manage
      ? `<dl class="facts">${stateFact}</dl>`
      : `<dl class="facts">${stateFact}<dt>Owner</dt><dd>${owner}</dd><dt>Current version</dt><dd>${escapeHtml(versionFact)}</dd>${live ? `<dt>Who can open it</dt><dd>${escapeHtml(audience)}</dd>` : ""}<dt>Used by other patches</dt><dd>${dependantsFact(groups, all)}</dd></dl>`;
  const offNote = off?.note ?? "";
  let restoreActions = "";
  if (manage && off !== null) {
    const deleteLink =
      patch.state === "retired"
        ? `<a class="btn btn-danger" href="${escapeAttribute(cardPath(patch, all, "delete"))}">Delete…</a>`
        : "";
    const deleteHint = patch.state === "retired" ? " Delete starts the 30-day clock." : "";
    restoreActions =
      off.recoveryEnded ||
      `<div class="actions">${off.restoreControl}${deleteLink}</div><p class="supporting-text">${off.restoreHint}${deleteHint}</p>`;
  }
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
    ? `${adminLine}<section class="section" aria-labelledby="manage-heading"><h2 class="section-heading" id="manage-heading">Manage</h2>${restoreActions}${patch.state === "deleted" ? "" : descriptionForm(card, all, input.submittedDescription, input.descriptionError)}${live ? scopeForm(card, all) + versionsSection(card, viewer, all, now) + stop : ""}</section>`
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

export type ConfirmationAction = "retire" | "delete" | "restore" | "reassign";

const confirmationDependants = (groups: readonly DependantGroup[]): string =>
  groups.length === 0
    ? '<p class="supporting-text">Nothing else reads this patch.</p>'
    : `<p>These patches will lose access to its tables on their next read, until it is restored.</p><ul class="confirmation-list">${groups
        .map(
          (group) =>
            `<li><code>${escapeHtml(group.name)}</code> (${escapeHtml(group.ownerName)}) reads ${group.tables.map((table) => `<code>${escapeHtml(table)}</code>`).join(", ")}</li>`
        )
        .join("")}</ul>`;

export const confirmationAcknowledgement = (text: string, checked: boolean): string =>
  `<label class="confirmation-acknowledgement"><input class="field-checkbox" type="checkbox" name="ack" value="1" required${checked ? " checked" : ""}><span>${escapeHtml(text)}</span></label>`;

export const renderConfirmation = (input: {
  readonly card: Patches.PortalCard;
  readonly viewer: RequireSession.Viewer["Service"];
  readonly all: boolean;
  readonly now: number;
  readonly action: ConfirmationAction;
  readonly members: readonly Users.User[];
  readonly query: string;
  readonly notice?: string;
  readonly submittedName?: string;
  readonly nameError?: string;
  readonly selectedOwnerId?: string;
  readonly acknowledged?: boolean;
}): string => {
  const { card, viewer, all, action } = input;
  const { patch } = card;
  const postPath = cardPath(patch, all, action);
  const cancelPath = cardPath(patch, all);
  const acknowledged = input.acknowledged === true;
  let verb: string;
  let fields: string;
  let consequence: string;
  let filter = "";
  let disabled = false;

  switch (action) {
    case "retire": {
      verb = "Retire";
      consequence = `Nobody can open <code>${escapeHtml(patch.name)}</code> until it is restored. Its page, versions, tables, files and name are kept indefinitely. The owner or an admin can restore it.`;
      const groups = dependantGroups(card);
      fields = `${hidden("expectedState", "live")}${confirmationDependants(groups)}${groups.length === 0 ? "" : confirmationAcknowledgement("I understand these patches will lose access to its tables.", acknowledged)}`;
      break;
    }
    case "delete": {
      verb = "Delete";
      const reclaimAt = DateTime.formatIso(
        DateTime.makeUnsafe(input.now + Duration.toMillis(Patches.RECOVERY_WINDOW))
      );
      consequence = `${patch.state === "retired" ? "Its readers already lost access when it was retired. This starts the 30-day clock." : `Nobody can open <code>${escapeHtml(patch.name)}</code> until it is restored. Delete keeps it for 30 days.`} The owner or an admin can restore it during that window. On ${escapeHtml(dateLabel(reclaimAt))}, the page, its versions, tables, files and the name will be reclaimed for good.`;
      const groups = patch.state === "live" ? dependantGroups(card) : [];
      const dependants =
        patch.state === "live"
          ? `${confirmationDependants(groups)}${groups.length === 0 ? "" : confirmationAcknowledgement("I understand these patches will lose access to its tables.", acknowledged)}`
          : "";
      const nameError =
        input.nameError === undefined
          ? ""
          : `<p class="field-error" id="confirm-error" role="alert">${escapeHtml(input.nameError)}</p>`;
      fields = `${hidden("expectedState", "not-deleted")}${dependants}<label class="field-label" for="confirm">Type ${escapeHtml(patch.name)} to confirm</label><input class="field" id="confirm" name="confirm" value="${escapeAttribute(input.submittedName ?? "")}" required autocomplete="off" spellcheck="false" aria-describedby="confirm-hint${input.nameError === undefined ? "" : " confirm-error"}"${input.nameError === undefined ? "" : ' aria-invalid="true"'}><p class="field-hint" id="confirm-hint">Enter the patch name exactly.</p>${nameError}`;
      break;
    }
    case "restore": {
      verb = "Restore";
      consequence =
        "This patch will serve, but it will error when it reads these tables until their sources are restored too. A source that is gone cannot be restored.";
      const sources = card.offSources
        .map(
          (source) =>
            `<li><code>${escapeHtml(source.name ?? source.patchId)}</code> / <code>${escapeHtml(source.table)}</code>: ${escapeHtml(source.state)}</li>`
        )
        .join("");
      fields = `${hidden("expectedState", patch.state)}<ul class="confirmation-list">${sources}</ul>${confirmationAcknowledgement("I understand this patch will error when it reads these tables.", acknowledged)}`;
      break;
    }
    case "reassign": {
      verb = "Reassign";
      consequence = `Choose an active member of ${escapeHtml(viewer.company.name)} to own this patch. Its versions keep their original publisher attribution. Choosing ${escapeHtml(card.owner.name)}, the current owner, changes nothing.`;
      const activeMembers = input.members.filter(
        (member) => member.deactivatedAt === null && member.companyId === viewer.company.id
      );
      const selectedOwnerId = activeMembers.some((member) => member.id === input.selectedOwnerId)
        ? input.selectedOwnerId
        : undefined;
      const needle = input.query.trim().toLowerCase();
      const members = activeMembers.filter(
        (member) =>
          member.id === selectedOwnerId ||
          member.name.toLowerCase().includes(needle) ||
          member.email.toLowerCase().includes(needle)
      );
      filter = `<form method="get" action="${escapeAttribute(cardPath(patch, false, action))}">${all ? hidden("all", "1") : ""}<label class="field-label" for="member-query">Find a member</label><input class="field" type="search" id="member-query" name="q" value="${escapeAttribute(input.query)}"><div class="actions"><button class="btn" type="submit">Filter members</button></div></form>`;
      const choices = members
        .map(
          (member, index) =>
            `<li><label class="field-choice"><input class="field-radio" type="radio" name="user" value="${escapeAttribute(member.id)}" required aria-describedby="member-consequence-${index}"${member.id === selectedOwnerId ? " checked" : ""}><span>${escapeHtml(member.name)} (${escapeHtml(member.email)})${member.id === card.owner.id ? ", current owner" : ""}</span></label><p class="field-hint" id="member-consequence-${index}">${escapeHtml(member.name)} can publish, retire or delete it at once; you can reassign it again.</p></li>`
        )
        .join("");
      fields = `${hidden("expectedOwnerUserId", card.owner.id)}${members.length === 0 ? '<p class="supporting-text">No active members match this filter.</p>' : `<div role="radiogroup" aria-label="New owner"><ul class="confirmation-list">${choices}</ul></div>`}`;
      disabled = members.length === 0;
      break;
    }
  }

  return `<article class="portal-subpage"><p><a href="${escapeAttribute(cancelPath)}">Back to ${escapeHtml(patch.name)}</a></p><h1 class="page-heading">${verb} ${escapeHtml(patch.name)}?</h1>${refusal(input.notice)}${filter}<form class="confirmation-form" method="post" action="${escapeAttribute(postPath)}"><p class="confirmation-consequence">${consequence}</p>${fields}<div class="confirmation-actions"><button class="btn ${action === "retire" || action === "delete" ? "btn-danger" : "btn-primary"}" type="submit"${disabled ? " disabled" : ""}>${verb} ${escapeHtml(patch.name)}</button><a class="btn btn-quiet" href="${escapeAttribute(cancelPath)}">Cancel</a></div></form></article>`;
};
