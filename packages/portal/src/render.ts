// How a patch's page is drawn: one header over its tabs (Overview, Log, Versions, Settings), what
// each tab holds, and the dialogs its acts ask in. `PatchPages.ts` reads the patch and hands it here.
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import { type AgentTool, type GuestReason, guestReasonText } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import type { Users } from "@patchy/companies";
import {
  ago,
  badge,
  button,
  codeRow,
  card as uiCard,
  copyButton,
  copyScriptPath,
  dateLabel,
  detailPage,
  dialog,
  dot,
  escapeAttribute,
  escapeHtml,
  facts,
  field,
  idFor,
  input as textInput,
  linkButton,
  menu,
  menuCopy,
  menuLink,
  menuNewTab,
  menuRule,
  notice,
  patchMark,
  patchTitle,
  person,
  recovery,
  recoveryLine,
  refusalNotice,
  row,
  rowMenu,
  rows,
  section,
  select,
  sentenceList,
  settingRow,
  settingsPanel,
  table,
  tabs,
  type Template,
  textarea
} from "@patchy/core";
import { Patches } from "@patchy/patches";
import {
  accessLabel,
  audienceText,
  canReassign,
  cardPath,
  failedLog,
  firstClause,
  hidden,
  patchAddress,
  shareHref,
  turnedAwayTitle
} from "./shared/presentation.js";

type Viewer = RequireSession.Viewer["Service"];

export type CardTab = "overview" | "log" | "versions" | "settings";
export type ConfirmationAction = "retire" | "delete" | "restore" | "reassign";
export type PatchAction = "description" | "rollback" | ConfirmationAction;

/** Admins, and the owner while they can open it, manage a patch: its log, settings and lifecycle. */
export const canManage = (card: Pick<Patches.ReadPatch, "access">) => card.access.canManage;

const tabLabels: Record<CardTab, string> = {
  overview: "Overview",
  log: "Log",
  versions: "Versions",
  settings: "Settings"
};

/** The `<title>` heading of a patch's tab: the patch on Overview, "Log – New Business" on the rest. */
export const tabTitle = (title: string, tab: CardTab) =>
  tab === "overview" ? title : `${tabLabels[tab]} – ${title}`;

/** A retired or deleted patch's standing, or null while it is live. */
const standing = (card: Patches.PortalCard, now: number) =>
  card.patch.state === "live"
    ? null
    : recovery({
        state: card.patch.state,
        actorName:
          card.patch.state === "retired" ? card.actorNames.retired : card.actorNames.deleted,
        stateAt: card.patch.state === "retired" ? card.patch.retiredAt : card.patch.deletedAt,
        purgeAt: card.patch.purgeAt,
        now
      });

/** Restore, the header's one primary while it can come back: a dialog first when it reads sources that are off. */
const restoreAction = (card: Patches.PortalCard) =>
  card.offSources.length > 0
    ? linkButton("Restore…", cardPath(card.patch, "restore"), { kind: "primary" })
    : `<form method="post" action="${escapeAttribute(cardPath(card.patch, "restore"))}">${hidden("expectedPatchId", card.patch.id)}${hidden("expectedState", card.patch.state)}${button("Restore", { kind: "primary" })}</form>`;

/** The header's ⋯: opening it elsewhere and copying its link while live, then taking it down. */
const headerMenu = (card: Patches.PortalCard, viewer: Viewer, url: string, title: string) => {
  const { patch } = card;
  const live = patch.state === "live";
  const manage = canManage(card);
  const everyday =
    live && card.access.canOpen
      ? [menuNewTab(patchAddress(patch), title), menuCopy(url, "Copy link", title)]
      : [];
  const takeDown = !manage
    ? []
    : live
      ? [
          menuLink(cardPath(patch, "retire"), "Retire…", false, title),
          menuLink(cardPath(patch, "delete"), "Delete…", true, title)
        ]
      : patch.state === "retired"
        ? [menuLink(cardPath(patch, "delete"), "Delete…", true, title)]
        : [];
  const items = [
    ...everyday,
    ...(everyday.length && takeDown.length ? [menuRule] : []),
    ...takeDown
  ];
  return items.length === 0 ? "" : rowMenu(idFor("patch", patch.id), title, items);
};

/** What a patch's page is drawn from, whichever tab is open. */
export interface PatchFrame {
  readonly card: Patches.PortalCard;
  readonly viewer: Viewer;
  readonly now: number;
  readonly publicBaseUrl: string;
  readonly tab: CardTab;
  /** The page's own path, which Share opens over. */
  readonly here: string;
  /** A refusal, said under the tabs. */
  readonly notice?: string;
  /** No forms or menus at all, as when refusing a form that was rendered for another patch. */
  readonly readOnly?: boolean;
  /** Failed calls in the last 24 hours, said on Overview's status line when there are any. */
  readonly failures?: number;
  readonly main: string;
  /** Beside the main column on Overview, such as `renderAgentAside`'s. */
  readonly aside?: string;
}

/**
 * A patch's page on one of its tabs: the header every tab shares (its mark, title, kind and
 * address, a status line only when there is something to say, and Share, Open and ⋯), the tabs
 * the viewer may use, a refusal, then the tab. Members see Overview and Versions; the owner and
 * admins see Log and Settings too.
 */
export const renderPatchPage = (frame: PatchFrame): Template => {
  const { card, viewer, now } = frame;
  const { patch } = card;
  const live = patch.state === "live";
  const manage = canManage(card);
  const open = card.access.canOpen;
  const title = patchTitle(patch, viewer.company.name);
  const url = `${frame.publicBaseUrl.replace(/\/+$/u, "")}${patchAddress(patch)}`;
  const shown = url.replace(/^https?:\/\//u, "");
  const off = standing(card, now);

  const status = [
    off === null
      ? ""
      : `${badge(off.state === "retired" ? "Retired" : "Deleted", off.state === "deleted" ? "danger" : undefined)}<span>${recoveryLine(off)}</span>`,
    live && frame.tab === "overview" && (frame.failures ?? 0) > 0
      ? `${dot(`${frame.failures} failed ${frame.failures === 1 ? "call" : "calls"} in the last 24 hours`, "danger")}<a href="${escapeAttribute(failedLog(patch))}">View log</a>`
      : "",
    !open
      ? dot(
          card.owner.id === viewer.user.id
            ? "You own this patch but can’t open it. Ask an admin to add you to one of its teams or reassign it."
            : "You can’t open this patch. Join one of its teams to see what’s in it.",
          "warning"
        )
      : "",
    canReassign(viewer) && (card.owner.deactivated || !card.access.ownerCanOpen)
      ? `${dot(card.owner.deactivated ? "Nobody can publish to this patch. Its owner is deactivated." : "Its owner can’t open it, so nobody can publish to it.", "warning")}${live && !frame.readOnly ? `<a href="${escapeAttribute(cardPath(patch, "reassign"))}">Reassign…</a>` : ""}`
      : ""
  ].filter((part) => part !== "");

  const actions = frame.readOnly
    ? ""
    : `${live && manage ? linkButton("Share", shareHref(frame.here, patch.name), { icon: "share", ariaLabel: `Share ${title}` }) : ""}${live && open ? linkButton("Open", patchAddress(patch), { kind: "primary", icon: "external" }) : !live && manage && off?.restorable ? restoreAction(card) : ""}${headerMenu(card, viewer, url, title)}`;

  const tabStrip = tabs({
    label: title,
    current: tabLabels[frame.tab],
    // The log and versions are content: someone who can't open it manages it from Settings.
    items: [
      { label: "Overview", href: cardPath(patch) },
      ...(manage && open ? [{ label: "Log", href: cardPath(patch, "log") }] : []),
      ...(open
        ? [{ label: "Versions", href: cardPath(patch, "versions"), count: card.versions.length }]
        : []),
      ...(manage ? [{ label: "Settings", href: cardPath(patch, "settings") }] : [])
    ]
  });

  const page = detailPage({
    parent: { label: "All patches", href: "/patches" },
    mark: patchMark(patch.name, card.tier, true),
    title,
    meta: [
      card.tier === 1 ? "Page" : "Tool",
      `<span class="code copy-address">${escapeHtml(shown)}</span>${live && open ? copyButton(url, { kind: "quiet", size: "sm", ariaLabel: `Copy the link to ${title}` }) : ""}`
    ],
    ...(status.length === 0 ? {} : { status: status.join("") }),
    ...(actions === "" ? {} : { actions }),
    tabs: `${tabStrip}${frame.notice === undefined ? "" : refusalNotice(frame.notice)}`,
    main: frame.main,
    ...(frame.aside === undefined || frame.aside === "" ? {} : { aside: frame.aside })
  });
  return live
    ? { ...page, body: `${page.body}<script defer src="${copyScriptPath}"></script>` }
    : page;
};

/** Who can open it: everyone at the company, its teams or anyone, once it's back if it's off. */
const audience = (card: Patches.PortalCard, viewer: Viewer) => {
  if (card.patch.state === "live") return audienceText(card.audience, viewer.company.name);
  const who =
    card.audience.kind === "public"
      ? "Anyone on the internet"
      : audienceText(card.audience, viewer.company.name);
  return `${who}, once it’s restored`;
};

/** The other patches reading this one's tables or stores, once each, as links. */
const usedBy = (card: Patches.PortalCard) => {
  const names = [...new Set(card.dependants.map((dependant) => dependant.name))];
  const linked = names
    .slice(0, 3)
    .map(
      (name) =>
        `<a href="${escapeAttribute(`/patches/${encodeURIComponent(name)}`)}">${escapeHtml(name)}</a>`
    );
  const more = names.length > 3 ? [`${names.length - 3} more`] : [];
  const parts = [...linked, ...more];
  return parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
};

const ownerName = (card: Pick<Patches.ReadPatch, "owner">, viewer: Viewer) =>
  `${person(card.owner.id, card.owner.name)}${card.owner.id === viewer.user.id ? ' <span class="you">(you)</span>' : ""}${card.owner.deactivated ? " (deactivated)" : ""}`;

/**
 * Overview: why its guests can't open it, the description, its facts and, for the owner and
 * admins, the recent log. A member sees an off patch's description and status alone.
 */
export const renderOverview = (input: {
  readonly card: Patches.PortalCard;
  readonly viewer: Viewer;
  readonly now: number;
  readonly here: string;
  /** Recent activity, rendered only for the owner and admins. */
  readonly activity: string;
  /** Why the patch's guests can't open it, for the owner and admins; absent while they can. */
  readonly turnedAway?: GuestReason;
  readonly readOnly?: boolean;
}): string => {
  const { card, viewer, now } = input;
  const { patch } = card;
  const live = patch.state === "live";
  const manage = canManage(card);
  const turnedAway =
    input.turnedAway === undefined
      ? ""
      : notice({
          tone: "warning",
          title: turnedAwayTitle,
          body: `<p>${escapeHtml(guestReasonText(input.turnedAway))}</p>`
        });
  const description =
    patch.description !== ""
      ? `<div class="prose"><p>${escapeHtml(patch.description)}</p></div>`
      : manage && patch.state !== "deleted"
        ? `<p class="meta">No description yet. <a href="${escapeAttribute(cardPath(patch, "settings"))}">Add one</a></p>`
        : "";
  if (!live && !manage) return description;
  const publisher = card.versions.find((version) => version.id === patch.currentVersionId);
  const change =
    live && manage && !input.readOnly
      ? ` · <a href="${escapeAttribute(shareHref(input.here, patch.name))}">Change</a>`
      : "";
  // Its version and opens say what it serves; someone who can't open it sees who can, and who reads it.
  const pairs: Array<readonly [string, string]> = [
    ["Owner", ownerName(card, viewer)],
    ...(live ? [["Access", `${escapeHtml(audience(card, viewer))}${change}`] as const] : []),
    ...(card.access.canOpen
      ? [
          [
            "Version",
            escapeHtml(
              `v${card.currentVersion} · published ${ago(card.publishedAt, now)}${publisher === undefined ? "" : ` by ${publisher.publisherName}`}`
            )
          ] as const,
          ["Opens", escapeHtml(card.visits)] as const
        ]
      : []),
    ...(card.dependants.length === 0 ? [] : [["Used by", usedBy(card)] as const])
  ];
  return `${turnedAway}${card.access.canOpen ? description : ""}${facts(pairs)}${input.activity}`;
};

/**
 * Access to the patch its owner didn't grant, for the owner and admins: audience changes made by
 * anyone else, and admins added to its teams.
 */
export const renderOwnerHistory = (input: {
  readonly entries: readonly Patches.OwnerHistoryEntry[];
  /** Everyone the entries name, by id. */
  readonly names: ReadonlyMap<string, string>;
}): string => {
  if (input.entries.length === 0) return "";
  const name = (id: string) => input.names.get(id) ?? "Someone";
  return section({
    title: "Access changes",
    body: rows(
      input.entries.map((entry) =>
        row({
          name:
            entry.kind === "audience"
              ? `${name(entry.actorId)} changed who can open it from ${accessLabel(entry.before)} to ${accessLabel(entry.after)}`
              : entry.actorId === entry.userId
                ? `${name(entry.userId)}, an admin, joined ${entry.teamName}`
                : `${name(entry.actorId)} added ${name(entry.userId)}, an admin, to ${entry.teamName}`,
          description: dateLabel(entry.at)
        })
      ),
      true
    )
  });
};

type Admin = Pick<Users.User, "id" | "name">;

/** The admins in a sentence, the viewer, when one of them, as "you" and first. */
const adminNames = (admins: readonly Admin[], viewerId: string): string => {
  const others = admins.filter((admin) => admin.id !== viewerId).map(({ name }) => name);
  return sentenceList(others.length < admins.length ? ["you", ...others] : others);
};

/** Names in a sentence, as plain text: "Claude", "Claude and Codex". */
const plainList = (names: readonly string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * Beside a live tool's Overview: the agent tools of the version it serves, each with Reads or
 * Changes, in `open_patch`'s order, then the viewer's own connected apps, or the way to connect
 * one. With agent access off, it names the admins in place of that, and gives an admin the way to
 * turn it on.
 */
export const renderAgentAside = (input: {
  readonly tools: readonly Pick<AgentTool, "name" | "kind" | "description">[];
  readonly viewer: Viewer;
  /** The company's active admins while agent access is off, or null while it is on. */
  readonly admins: readonly Admin[] | null;
  /** The apps the viewer has connected, by name; none until they connect one. */
  readonly apps: readonly string[];
}): string => {
  const { viewer, admins } = input;
  const company = escapeHtml(viewer.company.name);
  const apps = [...new Set(input.apps)];
  const foot =
    admins !== null
      ? `<span class="meta">Agent access is off at ${company}, so no agent can use these yet. Only admins can turn it on: ${adminNames(admins, viewer.user.id)}.</span>${viewer.role === "admin" ? linkButton("Turn it on", "/settings/agent-access", { size: "sm" }) : ""}`
      : apps.length === 0
        ? linkButton("Use with your agent", "/agents/connect", { size: "sm" })
        : `<span class="meta">${dot(`${plainList(apps)} ${apps.length === 1 ? "is" : "are"} connected`, "success")} · <a href="/agents">Your agents</a></span>`;
  return uiCard({
    title: "Your agent can, as you",
    rows: input.tools.map((tool) =>
      codeRow({
        name: tool.name,
        // The first clause says what it does; the agent reads the rest through Patchy MCP.
        description: firstClause(tool.description),
        end: `<span class="meta">${tool.kind === "read" ? "Reads" : "Changes"}</span>`
      })
    ),
    foot
  });
};

/** Settings, for the owner and admins: the description, who owns it and who can open it, then taking it down. */
export const renderSettings = (input: {
  readonly card: Patches.PortalCard;
  readonly viewer: Viewer;
  readonly here: string;
  readonly submittedDescription?: string;
  readonly descriptionError?: string;
}): string => {
  const { card: patchCard, viewer } = input;
  const { patch } = patchCard;
  const edited =
    patchCard.actorNames.description !== null && patch.descriptionUpdatedAt !== null
      ? `Edited by ${patchCard.actorNames.description} on ${dateLabel(patch.descriptionUpdatedAt)} · `
      : "";
  // A deleted patch's description can't be edited; a draft refused for that is still shown to copy.
  const description = !patchCard.access.canOpen
    ? ""
    : patch.state !== "deleted"
      ? uiCard({
          form: {
            action: cardPath(patch, "description"),
            fields: `${hidden("expectedPatchId", patch.id)}${hidden("expectedDescriptionUpdatedAt", patch.descriptionUpdatedAt)}`
          },
          body: field({
            id: "description",
            label: "Description",
            ...(input.descriptionError === undefined ? {} : { error: input.descriptionError }),
            // Native maxlength counts UTF-16 units, not the server's Unicode code-point bound.
            control: (aria) =>
              textarea(aria, {
                name: "description",
                rows: 4,
                value: input.submittedDescription ?? patch.description
              })
          }),
          foot: `<span class="meta">${escapeHtml(`${edited}Up to 500 characters`)}</span>${button("Save", { kind: "primary", size: "sm" })}`
        })
      : input.submittedDescription
        ? uiCard({
            title: "Your description, not saved",
            body: `<pre class="code-panel">${escapeHtml(input.submittedDescription)}</pre>`
          })
        : "";
  const people = uiCard({
    rows: [
      settingRow({
        title: "Owner",
        description: "Only they can publish it. Admins can change it and take it down too.",
        control: `<span>${ownerName(patchCard, viewer)}</span>${canReassign(viewer) ? linkButton("Reassign…", cardPath(patch, "reassign"), { size: "sm" }) : ""}`
      }),
      // An off patch's audience can still change, so it stops naming a team before it's deleted.
      settingRow({
        title: "Who can open it",
        description: audience(patchCard, viewer),
        control: linkButton("Change…", shareHref(input.here, patch.name), { size: "sm" })
      })
    ]
  });
  const danger =
    patch.state === "live"
      ? uiCard({
          title: "Take it down",
          danger: true,
          rows: [
            settingRow({
              title: "Retire",
              description: "Off its address until you restore it. Everything is kept.",
              control: linkButton("Retire…", cardPath(patch, "retire"), { size: "sm" })
            }),
            settingRow({
              title: "Delete",
              description: "Off now and gone for good 30 days later, unless restored.",
              control: linkButton("Delete…", cardPath(patch, "delete"), {
                size: "sm",
                kind: "danger"
              })
            })
          ]
        })
      : patch.state === "retired"
        ? uiCard({
            title: "Take it down",
            danger: true,
            rows: [
              settingRow({
                title: "Delete",
                description: "Gone for good 30 days later, unless restored.",
                control: linkButton("Delete…", cardPath(patch, "delete"), {
                  size: "sm",
                  kind: "danger"
                })
              })
            ]
          })
        : undefined;
  return settingsPanel({
    cards: [description, people].filter((part) => part !== ""),
    ...(danger === undefined ? {} : { danger })
  });
};

/** Where Serve this version… asks about one version. */
export const servePath = (patch: Pick<Patches.Patch, "name">, versionNumber: number) =>
  `${cardPath(patch, "rollback")}?version=${versionNumber}`;

/** Versions: every retained version, the one at the address marked Serving, with Serve this version… for the owner and admins. */
export const renderVersions = (input: {
  readonly card: Patches.PortalCard;
  readonly viewer: Viewer;
  readonly now: number;
}): string => {
  const { card: patchCard, now } = input;
  const { patch } = patchCard;
  const serve = canManage(patchCard) && patchCard.access.canOpen && patch.state === "live";
  return table({
    label: "Versions",
    columns: [
      { label: "Version" },
      { label: "Published" },
      { label: "By", hideOnPhone: true },
      { label: "Status" },
      ...(serve ? [{ label: "Actions", hidden: true, align: "end" as const }] : [])
    ],
    rows: patchCard.versions.map((version) => {
      const current = version.id === patch.currentVersionId;
      const name = `v${version.versionNumber}`;
      return [
        `<span class="strong">${escapeHtml(name)}</span>`,
        `<time datetime="${escapeAttribute(version.createdAt)}">${escapeHtml(ago(version.createdAt, now))}</time> <span class="meta hide-sm">· ${escapeHtml(dateLabel(version.createdAt))}</span>`,
        person(version.publisherName, version.publisherName),
        current ? badge("Serving", "yellow") : "",
        ...(serve
          ? [
              current
                ? ""
                : menu({
                    id: idFor("version", version.id),
                    label: name,
                    items: [
                      {
                        kind: "link",
                        label: "Serve this version…",
                        href: servePath(patch, version.versionNumber)
                      }
                    ]
                  })
            ]
          : [])
      ];
    })
  });
};

interface DependantGroup {
  readonly name: string;
  readonly ownerName: string;
  readonly resources: string[];
}

const dependantGroups = (patchCard: Patches.PortalCard) => {
  const groups = new Map<string, DependantGroup>();
  for (const dependant of patchCard.dependants) {
    const resource = dependant.table ?? dependant.store;
    const existing = groups.get(dependant.patchId);
    if (existing === undefined)
      groups.set(dependant.patchId, {
        name: dependant.name,
        ownerName: dependant.owner.name,
        resources: [resource]
      });
    else if (!existing.resources.includes(resource)) existing.resources.push(resource);
  }
  return Array.from(groups.values());
};

/** The patches that read its tables or stores, and what each reads, as rows in a box. */
const dependantRows = (groups: readonly DependantGroup[]) =>
  rows(
    groups.map((group) =>
      row({
        name: group.name,
        description: `${group.ownerName}’s · reads ${group.resources.join(", ")}`
      })
    ),
    true
  );

/** The patches that stop working with it, and how many more the viewer can't open. */
const dependantsLine = (groups: readonly DependantGroup[], hidden: number) => {
  const count = groups.length + hidden;
  if (count === 0) return "";
  const more =
    hidden === 0
      ? ""
      : `<p class="meta">${groups.length === 0 ? "" : "And "}${hidden} ${hidden === 1 ? "patch" : "patches"} you can’t open.</p>`;
  return `<p class="prose">${count === 1 ? "This patch reads its tables and stops" : "These patches read its tables and stop"} working until it’s restored.</p>${groups.length === 0 ? "" : dependantRows(groups)}${more}`;
};

/** A dialog's refusal that isn't about one field, just above its buttons, taking focus. */
const refusal = (text: string | undefined) => (text === undefined ? "" : refusalNotice(text));

/** What a confirmation's form left to say when it was refused. */
export interface ConfirmationState {
  readonly notice?: string;
  readonly submittedName?: string;
  readonly nameError?: string;
  readonly selectedOwnerId?: string;
  /** Why the chosen owner was refused, under the owner field. */
  readonly ownerError?: string;
}

/**
 * The dialog an act asks in, over the tab it was opened from: Retire (are you sure, naming any
 * patch that reads its tables), Delete (the typed name), Restore (the sources still off),
 * Reassign (the new owner) and Serve this version. Each is one form carrying the ids its act
 * checks; pressing its button is the acknowledgement for the readers and sources it names.
 */
export const renderConfirmation = (
  input: {
    readonly card: Patches.PortalCard;
    readonly viewer: Viewer;
    readonly now: number;
    /** The tab behind it, where Cancel and Close go. */
    readonly close: string;
  } & ConfirmationState &
    (
      | { readonly action: "retire" | "delete" | "restore" }
      | { readonly action: "reassign"; readonly members: readonly Users.User[] }
      | { readonly action: "rollback"; readonly versionNumber: number }
    )
): string => {
  const { card: patchCard, viewer, close } = input;
  const { patch } = patchCard;
  const title = patchTitle(patch, viewer.company.name);
  // Focus starts on a refusal when there is one; else on Cancel where pressing on would break
  // something or change what people get, on the typed name for Delete, on the owner for Reassign.
  const refused = input.notice !== undefined;
  const cancel = (label = "Cancel") =>
    linkButton(label, close, {
      kind: "quiet",
      autofocus: !refused && input.action !== "delete" && input.action !== "reassign"
    });
  const form = (fields: string) => ({
    action: cardPath(patch, input.action),
    fields: `${hidden("expectedPatchId", patch.id)}${hidden("expectedOwnerUserId", patch.ownerUserId)}${fields}`
  });
  switch (input.action) {
    case "retire": {
      const groups = dependantGroups(patchCard);
      const hiddenCount = patchCard.hiddenDependants.length;
      const breaks = groups.length + hiddenCount > 0;
      return dialog({
        id: "patch-retire",
        title: `Retire ${title}?`,
        closeHref: close,
        form: form(`${hidden("expectedState", "live")}${breaks ? hidden("ack", "1") : ""}`),
        body: `<p class="prose">Nobody can open it until you or an admin restores it. Its versions, tables and files are kept.</p>${dependantsLine(groups, hiddenCount)}${refusal(input.notice)}`,
        foot: `${cancel()}${button(`Retire ${title}`, { kind: "danger-solid" })}`
      });
    }
    case "delete": {
      const groups = patch.state === "live" ? dependantGroups(patchCard) : [];
      const hiddenCount = patch.state === "live" ? patchCard.hiddenDependants.length : 0;
      const reclaimAt = dateLabel(
        DateTime.formatIso(
          DateTime.makeUnsafe(input.now + Duration.toMillis(Patches.RECOVERY_WINDOW))
        )
      );
      const lead =
        patch.state === "retired"
          ? `Its readers lost access when it was retired. It is gone for good on ${reclaimAt}, with its versions, tables and files. Until then you or an admin can restore it.`
          : `It goes off its address now and is gone for good on ${reclaimAt}, with its versions, tables and files. Until then you or an admin can restore it.`;
      return dialog({
        id: "patch-delete",
        title: `Delete ${title}`,
        closeHref: close,
        form: form(
          `${hidden("expectedState", "not-deleted")}${groups.length + hiddenCount > 0 ? hidden("ack", "1") : ""}`
        ),
        body: `<p class="prose">${escapeHtml(lead)}</p>${dependantsLine(groups, hiddenCount)}${field(
          {
            id: "confirm",
            label: `Type ${patch.name} to confirm`,
            ...(input.nameError === undefined ? {} : { error: input.nameError }),
            control: (aria) =>
              textInput(aria, {
                name: "confirm",
                value: input.submittedName ?? "",
                required: true,
                autocomplete: "off",
                mono: true,
                autofocus: !refused
              })
          }
        )}${refusal(input.notice)}`,
        foot: `${cancel()}${button(`Delete ${title}`, { kind: "danger-solid" })}`
      });
    }
    case "restore":
      return dialog({
        id: "patch-restore",
        title: `Restore ${title}?`,
        closeHref: close,
        form: form(`${hidden("expectedState", patch.state)}${hidden("ack", "1")}`),
        body: `<p class="prose">It comes back at its address, but it errors when it reads these until their sources are restored too. A source that is gone can’t come back.</p>${rows(
          patchCard.offSources.map((source) =>
            row({
              name: source.name ?? source.patchId,
              description: `${source.table ?? source.store} · ${source.state}`
            })
          ),
          true
        )}${refusal(input.notice)}`,
        foot: `${cancel()}${button(`Restore ${title}`, { kind: "primary" })}`
      });
    case "reassign": {
      const active = input.members
        .filter((member) => member.deactivatedAt === null && member.companyId === viewer.company.id)
        .sort((a, b) => a.name.localeCompare(b.name));
      const selected = active.some((member) => member.id === input.selectedOwnerId)
        ? input.selectedOwnerId
        : undefined;
      return dialog({
        id: "patch-reassign",
        title: `Reassign ${title}`,
        closeHref: close,
        form: form(""),
        body: `<p class="prose">The new owner can publish to it, change it and take it down. Its versions keep who published them.</p>${field(
          {
            id: "reassign-owner",
            label: "New owner",
            ...(input.ownerError === undefined ? {} : { error: input.ownerError }),
            control: (aria) =>
              select(aria, {
                name: "user",
                ...(selected === undefined ? {} : { value: selected }),
                choices: [
                  { value: "", label: "Choose someone" },
                  ...active.map((member) => ({
                    value: member.id,
                    label: `${member.name} (${member.email})${member.id === patchCard.owner.id ? ", owns it now" : ""}`
                  }))
                ]
              })
          }
        )}${refusal(input.notice)}`,
        foot: `${cancel()}${button(`Reassign ${title}`, { kind: "primary" })}`
      });
    }
    case "rollback": {
      const current = `v${patchCard.currentVersion}`;
      const chosen = `v${input.versionNumber}`;
      return dialog({
        id: "patch-serve",
        title: `Serve ${chosen} instead of ${current}?`,
        closeHref: close,
        form: form(
          `${hidden("expectedCurrentVersionId", patch.currentVersionId)}${hidden("versionNumber", input.versionNumber)}`
        ),
        body: `<p class="prose">${escapeHtml(`Everyone who opens ${title} gets ${chosen} now. Its tables, files, sharing and description stay as they are. Your next publish replaces it.`)}</p>${refusal(input.notice)}`,
        foot: `${cancel(`Keep ${current}`)}${button(`Serve ${chosen}`, { kind: "primary" })}`
      });
    }
  }
};
