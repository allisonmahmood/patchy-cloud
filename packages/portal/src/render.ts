import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import type { AgentTool } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import type { Users } from "@patchy/companies";
import {
  ago,
  dateLabel,
  escapeAttribute,
  escapeHtml,
  patchMark,
  renderOffPatch,
  sentenceList
} from "@patchy/core";
import { Patches } from "@patchy/patches";

export const styles = `
  .portal-card { min-width: 0; max-width: 920px; }
  .portal-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; }
  .portal-card-head > div:nth-child(2) { flex: 1; min-width: min(100%, 240px); }
  .portal-card-head .page-heading { margin: 0; }
  .portal-card-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
  .portal-card-tags .tag { margin: 0; }
  .portal-card-act form { margin: 0; }
  .portal-card-tabs { margin: 18px 0 20px; }
  .portal-stop-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .portal-stop-actions > div { display: grid; align-content: start; }
  .portal-address { align-items: center; }
  .portal-subpage { max-width: 760px; margin-inline: auto; }
  .portal-table { overflow-x: auto; }
  .log-filters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) auto; gap: 0 12px; align-items: end; margin: 8px 0 20px; }
  .log-status { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  .log-outcome { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  /* Log cells keep words whole, so on a phone the table scrolls in portal-table rather than splitting "Version". */
  .log-table { min-width: 880px; overflow-wrap: break-word; }
  .log-table time { white-space: nowrap; }
  @media (max-width: 760px) {
    .log-filters { grid-template-columns: minmax(0, 1fr); }
    .log-filters > :last-child { margin-top: 16px; }
  }
  @media (max-width: 480px) {
    .portal-stop-actions { grid-template-columns: minmax(0, 1fr); }
  }
`;

// The index line: text up to the first sentence-ending period or ellipsis, semicolon or spaced
// en dash, bounded to 80 code points. A period inside a token (".NET", "1.2") is not a boundary.
export const firstClause = (description: string): string => {
  const text = description.trim();
  const boundary = text.search(/\.+(?=\s|$)|;| – /u);
  const clause = boundary === -1 ? text : text.slice(0, boundary).trimEnd();
  const points = Array.from(clause);
  return points.length > 80 ? `${points.slice(0, 79).join("").trimEnd()}…` : clause;
};

const cardPath = (patch: Patches.Patch, action = "") =>
  `/patches/${encodeURIComponent(patch.name)}${action ? `/${action}` : ""}`;
const canManage = (card: Patches.ReadPatch, viewer: RequireSession.Viewer["Service"]) =>
  card.owner.id === viewer.user.id || viewer.role === "admin";
export const hidden = (name: string, value: string | number | null) =>
  `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value ?? "")}">`;
export const refusal = (notice: string | undefined) =>
  notice === undefined
    ? ""
    : `<div class="note note-refused" role="alert">${escapeHtml(notice)}</div>`;

export type ConfirmationAction = "retire" | "delete" | "restore" | "reassign";
export type PatchAction = "description" | "scope" | "rollback" | ConfirmationAction;

/** Opens the POST form for one of the patch's actions, carrying the patch id the handler requires. */
const actionForm = (patch: Patches.Patch, action: PatchAction, className?: string): string =>
  `<form${className === undefined ? "" : ` class="${className}"`} method="post" action="${escapeAttribute(cardPath(patch, action))}">${hidden("expectedPatchId", patch.id)}`;

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
  readonly resources: string[];
}

const dependantGroups = (card: Patches.PortalCard) => {
  const groups = new Map<string, DependantGroup>();
  for (const dependant of card.dependants) {
    const resource = dependant.table ?? dependant.store;
    const existing = groups.get(dependant.patchId);
    if (existing === undefined) {
      groups.set(dependant.patchId, {
        name: dependant.name,
        ownerName: dependant.owner.name,
        resources: [resource]
      });
    } else if (!existing.resources.includes(resource)) existing.resources.push(resource);
  }
  return Array.from(groups.values());
};

const dependantsFact = (groups: readonly DependantGroup[]): string => {
  if (groups.length === 0) return "Nothing else reads this patch";
  const shown = groups
    .slice(0, 3)
    .map(
      (group) =>
        `<li class="list-row"><a href="${escapeAttribute(`/patches/${encodeURIComponent(group.name)}`)}">${escapeHtml(group.name)}</a> (${escapeHtml(group.ownerName)}) reads ${group.resources.map((resource) => `<code>${escapeHtml(resource)}</code>`).join(", ")}</li>`
    )
    .join("");
  return `<p>${escapeHtml(groups.length)} ${groups.length === 1 ? "patch" : "patches"}</p><ul class="list list-compact">${shown}</ul>${groups.length > 3 ? `<p class="supporting-text">and ${escapeHtml(groups.length - 3)} more</p>` : ""}`;
};

const descriptionForm = (card: Patches.PortalCard, submitted?: string, error?: string): string =>
  // Native maxlength counts UTF-16 units, not the server's Unicode code-point bound.
  `<section class="section">${actionForm(card.patch, "description")}${hidden("expectedDescriptionUpdatedAt", card.patch.descriptionUpdatedAt)}<label class="field-label" for="description">Description</label><textarea class="field" id="description" name="description" rows="4" aria-describedby="description-hint${error === undefined ? "" : " description-error"}"${error === undefined ? "" : ' aria-invalid="true"'}>${escapeHtml(submitted ?? card.patch.description)}</textarea><p class="field-hint" id="description-hint">The repo pulls this change in the next time it runs <code>patchy dev</code> or publishes. Start with what the tool does. Up to 500 characters.</p>${error === undefined ? "" : `<p class="field-error" id="description-error" role="alert">${escapeHtml(error)}</p>`}<div class="actions"><button class="btn" type="submit">Save description</button></div></form></section>`;

const scopeForm = (card: Patches.PortalCard): string => {
  const radio = (scope: Patches.Patch["scope"], label: string) =>
    `<label class="field-choice"><input class="field-radio" type="radio" name="scope" value="${escapeAttribute(scope)}"${card.patch.scope === scope ? " checked" : ""}>${escapeHtml(label)}</label>`;
  return `<section class="section"><h3 class="section-heading" id="scope-heading">Who can open it</h3>${actionForm(card.patch, "scope")}${hidden("expectedScope", card.patch.scope)}<div role="radiogroup" aria-labelledby="scope-heading" aria-describedby="scope-hint">${radio("company", "People at the company")}${radio("public", "Anyone on the internet")}</div><p class="field-hint" id="scope-hint">This governs opening the page only. Which tables and stores other patches may read is declared in code and changes at publish.</p><div class="actions"><button class="btn" type="submit">Save who can open it</button></div></form></section>`;
};

const versionsTable = (
  card: Patches.PortalCard,
  versions: Patches.PortalCard["versions"],
  viewer: RequireSession.Viewer["Service"],
  now: number
): string => {
  const manage = canManage(card, viewer) && card.patch.state === "live";
  const rows = versions.map((version) => {
    const current = version.id === card.patch.currentVersionId;
    const action = current
      ? '<span class="pill pill-done">current</span>'
      : manage
        ? `${actionForm(card.patch, "rollback")}${hidden("expectedCurrentVersionId", card.patch.currentVersionId)}${hidden("versionNumber", version.versionNumber)}<button class="btn" type="submit">Show this version at the address</button></form>`
        : "";
    return `<tr><th scope="row">v${escapeHtml(version.versionNumber)}</th><td><time datetime="${escapeAttribute(version.createdAt)}">${escapeHtml(dateLabel(version.createdAt))}</time><br><span class="supporting-text">${escapeHtml(ago(version.createdAt, now))}</span></td><td>${escapeHtml(version.publisherName)}</td><td>${action}</td></tr>`;
  });
  return `<div class="portal-table"><table class="table" aria-label="Patch versions"><thead><tr><th scope="col">Version</th><th scope="col">Published</th><th scope="col">Published by</th><th scope="col">At the address</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
};

export type CardTab = "overview" | "log" | "versions" | "settings";

type Viewer = RequireSession.Viewer["Service"];

/** The off-patch note and restore control for a retired or deleted card, or null while live. */
const offState = (card: Patches.PortalCard, viewer: Viewer, now: number) => {
  const { patch } = card;
  return patch.state === "live"
    ? null
    : renderOffPatch({
        name: patch.name,
        state: patch.state,
        actorName: patch.state === "retired" ? card.actorNames.retired : card.actorNames.deleted,
        stateAt: patch.state === "retired" ? patch.retiredAt : patch.deletedAt,
        purgeAt: patch.purgeAt,
        now,
        restore: canManage(card, viewer)
          ? {
              href: cardPath(patch, "restore"),
              patchId: patch.id,
              sourcesOff: card.offSources.length > 0,
              currentVersion: card.currentVersion
            }
          : null
      });
};

/**
 * One patch's card at `/patches/<name>`: its mark, name, tags and the act that matters most (Open,
 * or Restore for a manager while recovery is open), then its tabs over `body`, with any `panel`
 * beside it. Log and Settings are the owner's and admins'.
 */
export const renderCardFrame = (input: {
  readonly card: Patches.PortalCard;
  readonly viewer: Viewer;
  readonly now: number;
  readonly publicBaseUrl: string;
  readonly tab: CardTab;
  readonly notice?: string;
  /** Leave out the header's Restore form, as when refusing a form rendered for another patch. */
  readonly readOnly?: boolean;
  readonly body: string;
  /** A `side-panel` to the card's right, such as `renderAgentPanel`'s. */
  readonly panel?: string;
}): string => {
  const { card, viewer, now } = input;
  const { patch } = card;
  const live = patch.state === "live";
  const address = `/${encodeURIComponent(patch.companyHandle)}/${encodeURIComponent(patch.name)}`;
  const url = `${input.publicBaseUrl.replace(/\/+$/u, "")}${address}`;
  const restore = input.readOnly ? "" : (offState(card, viewer, now)?.restoreControl ?? "");
  const act = live
    ? `<a class="btn btn-primary" href="${escapeAttribute(address)}">Open</a>`
    : restore;
  const tags = [
    card.tier === 0 ? "Page" : "Tool",
    patch.scope === "public" ? "Public" : "Company only",
    `v${card.currentVersion}`,
    ...(live ? [] : [patch.state === "retired" ? "Retired" : "Deleted"])
  ]
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");
  const tabs = (
    [
      ["overview", "Overview", true],
      ["log", "Log", canManage(card, viewer)],
      ["versions", `Versions <span class="count">${escapeHtml(card.versions.length)}</span>`, true],
      ["settings", "Settings", canManage(card, viewer)]
    ] as const
  )
    .filter(([, , shown]) => shown)
    .map(
      ([tab, label]) =>
        `<a href="${escapeAttribute(cardPath(patch, tab === "overview" ? "" : tab))}"${tab === input.tab ? ' aria-current="page"' : ""}>${label}</a>`
    )
    .join("");
  const article = `<article class="portal-card"><p class="supporting-text"><a href="/">Home</a> / <a href="/patches">All patches</a> / ${escapeHtml(patch.name)}</p><div class="portal-card-head">${patchMark(patch.name, card.tier, true)}<div><h1 class="page-heading">${escapeHtml(patch.name)}</h1>${titleLine(patch)}<p class="portal-card-tags">${tags}</p></div>${act ? `<div class="portal-card-act">${act}</div>` : ""}</div>${live ? `<p><code class="copy-address" aria-label="Patch address, select to copy">${escapeHtml(url)}</code></p>` : ""}<nav class="tabs portal-card-tabs" aria-label="${escapeAttribute(patch.name)}">${tabs}</nav>${refusal(input.notice)}${input.body}</article>`;
  return input.panel ? `<div class="card-split">${article}${input.panel}</div>` : article;
};

type Admin = Pick<Users.User, "id" | "name">;

/** The admins in a sentence, the viewer, when one of them, as "you" and first. */
const adminNames = (admins: readonly Admin[], viewerId: string): string => {
  const others = admins.filter((admin) => admin.id !== viewerId).map(({ name }) => name);
  return sentenceList(others.length < admins.length ? ["you", ...others] : others);
};

/**
 * What agents can do, beside the Overview of a live patch with agent tools: each tool in
 * `open_patch`'s order with Reads or Changes, its description opening in place, then the link
 * to connect an agent on Your machines. With agent access off, a note names the admins in place
 * of that link, and gives an admin the way to turn it on.
 */
export const renderAgentPanel = (input: {
  readonly tools: readonly Pick<AgentTool, "name" | "kind" | "description">[];
  readonly viewer: Viewer;
  /** The company's active admins while agent access is off, or null while it is on. */
  readonly admins: readonly Admin[] | null;
}): string => {
  const { viewer, admins } = input;
  const company = escapeHtml(viewer.company.name);
  const tools = input.tools
    .map(
      (tool) =>
        `<li class="list-row"><details><summary><code>${escapeHtml(tool.name)}</code><span class="tag">${tool.kind === "read" ? "Reads" : "Changes"}</span></summary><p class="supporting-text">${escapeHtml(tool.description)}</p></details></li>`
    )
    .join("");
  const off =
    admins === null
      ? ""
      : `<div class="note note-warn"><strong class="note-title">Agent access is off at ${company}</strong><p>No agent can use these yet. Only admins can turn it on. At ${company} that’s ${adminNames(admins, viewer.user.id)}.</p>${viewer.role === "admin" ? '<div class="actions"><a class="btn" href="/company/agent-access">Turn it on at Company</a></div>' : ""}</div>`;
  const connect =
    admins === null
      ? '<p class="supporting-text"><a href="/machines#connect-an-agent">Connect your agent</a></p>'
      : "";
  return `<aside class="side-panel" aria-labelledby="agent-tools-heading"><h2 class="section-heading" id="agent-tools-heading">What agents can do</h2><p class="supporting-text">As the person who connected them.</p>${off}<ul class="list list-compact">${tools}</ul>${connect}</aside>`;
};

/** The card's Overview: the description, its facts, an off patch's note and the recent log. */
export const renderOverview = (input: {
  readonly card: Patches.PortalCard;
  readonly viewer: Viewer;
  readonly now: number;
  /** Recent activity, rendered only for the owner and admins. */
  readonly activity: string;
}): string => {
  const { card, viewer, now } = input;
  const { patch } = card;
  const live = patch.state === "live";
  const manage = canManage(card, viewer);
  const off = offState(card, viewer, now);
  const current = card.versions.find((version) => version.id === patch.currentVersionId);
  const versionFact = `v${card.currentVersion}, published ${ago(card.publishedAt, now)}${current === undefined ? "" : ` by ${current.publisherName}`}`;
  const audience =
    patch.scope === "company"
      ? `Anyone at ${viewer.company.name} who signs in. Not the public.`
      : "Anyone on the internet. No sign-in.";
  const stateFact = off?.stateFact ?? "";
  const facts =
    !live && !manage
      ? `<dl class="facts">${stateFact}</dl>`
      : `<dl class="facts">${stateFact}<dt>Owner</dt><dd>${escapeHtml(card.owner.name)}${card.owner.deactivated ? " (deactivated)" : ""}</dd><dt>Current version</dt><dd>${escapeHtml(versionFact)}</dd>${live ? `<dt>Who can open it</dt><dd>${escapeHtml(audience)}</dd>` : ""}<dt>Used by other patches</dt><dd>${dependantsFact(dependantGroups(card))}</dd><dt>Visits</dt><dd>${escapeHtml(card.visits)}</dd></dl>`;
  const restoreHint =
    off === null || !manage
      ? ""
      : off.recoveryEnded ||
        (off.restoreHint ? `<p class="supporting-text">${off.restoreHint}</p>` : "");
  const deactivated =
    viewer.role === "admin" && card.owner.deactivated
      ? `<div class="note note-warn">Nobody can publish to this patch. Its owner is deactivated.${live ? " Reassign it or retire it." : ""}</div>`
      : "";
  return `${descriptionBlock(card)}${facts}${off?.note ?? ""}${restoreHint}${deactivated}${input.activity}`;
};

/** The card's Settings, for the owner and admins: owner, description, who can open it, stopping or deleting. */
export const renderSettings = (input: {
  readonly card: Patches.PortalCard;
  readonly viewer: Viewer;
  readonly submittedDescription?: string;
  readonly descriptionError?: string;
}): string => {
  const { card, viewer } = input;
  const { patch } = card;
  const live = patch.state === "live";
  const groups = dependantGroups(card);
  const adminLine =
    viewer.role === "admin" && viewer.user.id !== card.owner.id
      ? '<p class="supporting-text">You can do everything an owner can from here, except publish.</p>'
      : "";
  const deactivated =
    viewer.role === "admin" && card.owner.deactivated
      ? `<div class="note note-warn">Nobody can publish to this patch. Its owner is deactivated.${live ? " Reassign it or retire it." : ""}</div>`
      : "";
  const owner = `<section class="section"><h2 class="section-heading">Owner</h2><p>${escapeHtml(card.owner.name)}${card.owner.deactivated ? " (deactivated)" : ""}</p>${viewer.role === "admin" ? `<div class="actions"><a class="btn" href="${escapeAttribute(cardPath(patch, "reassign"))}">Reassign…</a></div>` : ""}</section>`;
  const stop = live
    ? `<section class="note note-warn"><span class="note-title">Stop serving</span><p>${groups.length === 0 ? "Nothing else reads this patch." : `${escapeHtml(groups.length)} ${groups.length === 1 ? "patch reads" : "patches read"} this patch's tables or stores and will break until it is restored. You will be asked to confirm.`}</p><div class="actions portal-stop-actions"><div><a class="btn btn-danger" href="${escapeAttribute(cardPath(patch, "retire"))}">Retire…</a><p class="supporting-text">Keeps everything indefinitely. Nobody can open it until it is restored.</p></div><div><a class="btn btn-danger" href="${escapeAttribute(cardPath(patch, "delete"))}">Delete…</a><p class="supporting-text">Keeps it 30 days, then it is gone for good.</p></div></div></section>`
    : patch.state === "retired"
      ? `<section class="note note-warn"><span class="note-title">Delete</span><p>It is retired. Delete starts the 30-day clock, then it is gone for good.</p><div class="actions"><a class="btn btn-danger" href="${escapeAttribute(cardPath(patch, "delete"))}">Delete…</a></div></section>`
      : "";
  // A deleted patch's description can't be edited; a draft refused for that is still shown to copy.
  const description =
    patch.state !== "deleted"
      ? descriptionForm(card, input.submittedDescription, input.descriptionError)
      : input.submittedDescription
        ? `<section class="section"><h2 class="section-heading">Your description, not saved</h2><pre class="code-panel">${escapeHtml(input.submittedDescription)}</pre></section>`
        : "";
  return `${adminLine}${deactivated}${owner}${description}${live ? scopeForm(card) : ""}${stop}`;
};

/** The card's Versions: every retained version, with rollback for a live patch's owner and admins. */
export const renderVersions = (input: {
  readonly card: Patches.PortalCard;
  readonly viewer: Viewer;
  readonly now: number;
}): string =>
  `${versionsTable(input.card, input.card.versions, input.viewer, input.now)}${canManage(input.card, input.viewer) && input.card.patch.state === "live" ? '<p class="supporting-text">Showing a version changes the address for everyone now. Tables, files, sharing and the description do not move.</p>' : ""}`;

const confirmationDependants = (groups: readonly DependantGroup[]): string =>
  groups.length === 0
    ? '<p class="supporting-text">Nothing else reads this patch.</p>'
    : `<p>These patches will lose access to its shared tables and stores on their next read, until it is restored.</p><ul class="confirmation-list">${groups
        .map(
          (group) =>
            `<li><code>${escapeHtml(group.name)}</code> (${escapeHtml(group.ownerName)}) reads ${group.resources.map((resource) => `<code>${escapeHtml(resource)}</code>`).join(", ")}</li>`
        )
        .join("")}</ul>`;

export const confirmationAcknowledgement = (text: string, checked: boolean): string =>
  `<label class="confirmation-acknowledgement"><input class="field-checkbox" type="checkbox" name="ack" value="1" required${checked ? " checked" : ""}><span>${escapeHtml(text)}</span></label>`;

export const renderConfirmation = (input: {
  readonly card: Patches.PortalCard;
  readonly viewer: RequireSession.Viewer["Service"];
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
  const { card, viewer, action } = input;
  const { patch } = card;
  const cancelPath = cardPath(patch);
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
      fields = `${hidden("expectedState", "live")}${confirmationDependants(groups)}${groups.length === 0 ? "" : confirmationAcknowledgement("I understand these patches will lose access to its shared tables and stores.", acknowledged)}`;
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
          ? `${confirmationDependants(groups)}${groups.length === 0 ? "" : confirmationAcknowledgement("I understand these patches will lose access to its shared tables and stores.", acknowledged)}`
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
        "This patch will serve, but it will error when it reads these tables or stores until their sources are restored too. A source that is gone cannot be restored.";
      const sources = card.offSources
        .map(
          (source) =>
            `<li><code>${escapeHtml(source.name ?? source.patchId)}</code> / <code>${escapeHtml(source.table ?? source.store)}</code>: ${escapeHtml(source.state)}</li>`
        )
        .join("");
      fields = `${hidden("expectedState", patch.state)}<ul class="confirmation-list">${sources}</ul>${confirmationAcknowledgement("I understand this patch will error when it reads these tables or stores.", acknowledged)}`;
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
      filter = `<form method="get" action="${escapeAttribute(cardPath(patch, action))}"><label class="field-label" for="member-query">Find a member</label><input class="field" type="search" id="member-query" name="q" value="${escapeAttribute(input.query)}"><div class="actions"><button class="btn" type="submit">Filter members</button></div></form>`;
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

  return `<article class="portal-subpage"><p><a href="${escapeAttribute(cancelPath)}">Back to ${escapeHtml(patch.name)}</a></p><h1 class="page-heading">${verb} ${escapeHtml(patch.name)}?</h1>${refusal(input.notice)}${filter}${actionForm(patch, action, "confirmation-form")}<p class="confirmation-consequence">${consequence}</p>${fields}<div class="confirmation-actions"><button class="btn ${action === "retire" || action === "delete" ? "btn-danger" : "btn-primary"}" type="submit"${disabled ? " disabled" : ""}>${verb} ${escapeHtml(patch.name)}</button><a class="btn btn-quiet" href="${escapeAttribute(cancelPath)}">Cancel</a></div></form></article>`;
};
