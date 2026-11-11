import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as UrlParams from "effect/http/UrlParams";
import type { SqlError } from "effect/sql/SqlError";
import { Analytics } from "@patchy/analytics";
import type { PatchState } from "@patchy/api";
import {
  ago,
  avatar,
  badge,
  button,
  card,
  choiceGroup,
  type Column,
  dateLabel,
  dialog,
  emptyState,
  escapeAttribute,
  escapeHtml,
  field,
  idFor,
  indexPage,
  linkButton,
  menu,
  type MenuItem,
  notice,
  patchMark,
  patchTitle,
  radio,
  refusal,
  row,
  rows,
  searchField,
  segmented,
  sentenceList,
  settingRow,
  settingsPage,
  switchForm,
  table,
  textarea
} from "@patchy/core";
import { registry } from "@patchy/limits/registry";
import { withReportedCommit } from "@patchy/sql";
import * as Companies from "./Companies.js";
import * as Invitations from "./Invitations.js";
import * as Users from "./Users.js";

interface Viewer {
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  readonly company: { readonly id: string; readonly handle: string; readonly name: string };
  readonly role: Users.Role;
}
/**
 * `view` reads People and `view-agent-access` reads Agent access; the rest are admins' own: their
 * forms, and `view-guest-removal`, the confirmation before `remove-guest`.
 */
export type Action =
  | { readonly kind: "view" }
  | { readonly kind: "view-agent-access" }
  | { readonly kind: "invite" }
  | { readonly kind: "agent-access" }
  | {
      readonly kind: "revoke" | "resend" | "role" | "view-guest-removal" | "remove-guest";
      readonly id: string;
    };

/** A page drawn on core's templates, which carry their own header, or where a form went. */
export interface Page {
  readonly title: string;
  /** The template's heading slot: empty, as app templates draw their header in the body. */
  readonly heading?: string;
  readonly body: string;
  /** A dialog over the page, such as Invite people; the page behind it goes inert. */
  readonly overlay?: string;
  readonly status?: number;
  readonly redirect?: string;
  /** With a redirect, one line naming what the form did, read from server state; Auth shows it once. */
  readonly receipt?: string;
}

/**
 * How many live patches each user owns, among those the viewer can open. Patches depends on
 * Companies, so the server supplies this from Patches; left unset, the page has no Patches column.
 */
export const OwnedPatches = Context.Reference<
  | ((viewer: {
      readonly companyId: string;
      readonly userId: string;
    }) => Effect.Effect<ReadonlyMap<string, number>, SqlError>)
  | undefined
>("@patchy/companies/CompanyPage/OwnedPatches", { defaultValue: () => undefined });

/** A patch shared with a guest, who shared it and when. */
export interface GuestPatch {
  readonly name: string;
  readonly title: string | null;
  readonly tier: number;
  /** Its lifecycle state, or `disabled` once the operator took it down, which no one opens. */
  readonly state: typeof PatchState.Type | "disabled";
  /** The sharer's name. */
  readonly sharedBy: string;
  readonly sharedAt: Date;
}

/** Someone at another company with a patch of this company shared with them now. */
export interface Guest {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  /** Their own company's name. */
  readonly companyName: string;
  readonly patches: ReadonlyArray<GuestPatch>;
}

/**
 * The company's guests, from Patches' grants, which Companies cannot depend on: `list` by name,
 * and `removeAll`, which ends every grant one person holds here. Left unset, People has no guests.
 */
export const Guests = Context.Reference<
  | {
      readonly list: (
        companyId: string,
        viewer?: { readonly userId: string; readonly admin: boolean }
      ) => Effect.Effect<ReadonlyArray<Guest>, SqlError>;
      readonly removeAll: (input: {
        readonly companyId: string;
        readonly userId: string;
        readonly actorId?: string;
      }) => Effect.Effect<void, SqlError>;
    }
  | undefined
>("@patchy/companies/CompanyPage/Guests", { defaultValue: () => undefined });

const shows = ["all", "admins", "invited", "guests", "deactivated"] as const;
type Show = (typeof shows)[number];
const showLabels: Record<Show, string> = {
  all: "All",
  admins: "Admins",
  invited: "Invited",
  guests: "Guests",
  deactivated: "Deactivated"
};

/** What a GET of the page narrows its list to. */
interface Filter {
  readonly show: Show;
  readonly query: string;
}

/** A refusal or a partial result, in plain words; the notice escapes it. */
interface Notice {
  readonly message: string;
  readonly status: number;
  /** A refusal or failure is danger, the default; a list sent in part is a warning. */
  readonly tone?: "warning" | "danger";
}

/** The invite form as submitted, kept after a refusal so a pasted list is not lost. */
interface Draft {
  readonly text: string;
  readonly role: Users.Role;
  /** Why the addresses were refused, under the field. */
  readonly problem?: string;
  /** What became of a list sent in part, or a refusal of the whole form, above its buttons. */
  readonly outcome?: Notice;
}

interface View {
  readonly filter?: Filter;
  /** A refusal about the page, above its list. */
  readonly notice?: Notice;
  /** Opens Invite people over the page; a draft opens it too. */
  readonly inviting?: boolean;
  readonly draft?: Draft;
  /** The guest an admin is about to remove, confirmed in a dialog over Guests. */
  readonly removing?: Guest;
}

const inviteBatch = registry["invites.batch"].default;
const lifetimeDays = Companies.INVITATION_LIFETIME_MS / 86_400_000;
const isEmail = Schema.is(
  Schema.String.check(Schema.isMaxLength(254), Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))
);
const decodeRole = Schema.decodeUnknownEffect(Schema.Struct({ role: Users.Role }));
const decodeAgentAccess = Schema.decodeUnknownEffect(
  Schema.Struct({ state: Schema.Literals(["on", "off"]) })
);

/** A pasted list: commas, semicolons and whitespace separate addresses; repeats count once. */
const addresses = (text: string) => {
  const seen = new Set<string>();
  return text.split(/[\s,;]+/).filter((entry) => {
    const key = entry.toLowerCase();
    if (entry === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** What became of one address in an invite: emailed, saved without its email, skipped, or not saved. */
interface Delivery {
  readonly email: string;
  readonly outcome: "sent" | "unsent" | "member" | "invited" | "failed";
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** "a, b and c" in plain words, for a notice, which escapes its own text. */
const listed = (items: readonly string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const displayName = (user: Users.User) => user.name.trim() || user.email;
const roleLabel = (role: Users.Role) =>
  role === "super_admin" ? "Super admin" : role === "admin" ? "Admin" : "Member";

const time = (date: Date, label = dateLabel(date.toISOString())) =>
  `<time datetime="${date.toISOString()}">${escapeHtml(label)}</time>`;

/** A refusal no field owns, where the page's focus starts, or inside a dialog, the dialog's. */
const noticeHtml = (value: Notice | undefined) =>
  value === undefined
    ? ""
    : refusal(notice({ tone: value.tone ?? "danger", title: value.message }));

/** The active admins' names, A–Z, for whoever needs to ask one. */
const adminNames = (users: readonly Users.User[]) =>
  users
    .filter((user) => user.role !== "member" && user.deactivatedAt === null)
    .map(displayName)
    .sort((a, b) => a.localeCompare(b));

const offLabels = { retired: "Retired", deleted: "Deleted", disabled: "Unavailable" } as const;
/** The word for a guest's patch once it's off. */
const offBadge = ({ state }: GuestPatch) => (state === "live" ? "" : badge(offLabels[state]));

/**
 * A patch's title, opening the patch, or its card once it's off, as everywhere patches are listed.
 * A disabled patch opens for no one, so its title is no link.
 */
const patchLink = (viewer: Viewer, patch: GuestPatch) => {
  if (patch.title === null) return "Restricted patch";
  const title = escapeHtml(patchTitle({ ...patch, title: patch.title }, viewer.company.name));
  const name = encodeURIComponent(patch.name);
  if (patch.state === "disabled") return title;
  const href =
    patch.state === "live"
      ? `/${encodeURIComponent(viewer.company.handle)}/${name}`
      : `/patches/${name}`;
  return `<a href="${escapeAttribute(href)}">${title}</a>`;
};

/** People narrowed to `show` and `query`; `invite` opens Invite people over it. */
const peopleHref = (show: Show, query: string, invite = false) => {
  const params = new URLSearchParams();
  if (show !== "all") params.set("show", show);
  if (query) params.set("q", query);
  if (invite) params.set("invite", "1");
  const search = params.toString();
  return search ? `/settings/people?${search}` : "/settings/people";
};

/** A filter as a GET or the invite form gives it: an unknown `show` is All, `q` trimmed and cut. */
const filterOf = (show: string | null | undefined, query: string | null | undefined): Filter => ({
  show: shows.find((candidate) => candidate === show) ?? "all",
  query: (query ?? "").trim().slice(0, 200)
});

/**
 * `/settings/agent-access`: whether the company's agents can use patches, as one setting row, and
 * who changed it last. An admin's row holds the switch; a member's holds the value, and the
 * header names who can change it.
 */
const renderAgentAccess = Effect.fn("CompanyPage.renderAgentAccess")(function* (
  viewer: Viewer,
  refused?: Notice
): Effect.fn.Return<Page, SqlError, Users.Users | Companies.Companies> {
  // The viewer's own company: it exists for as long as they can open this page.
  const access = yield* (yield* Companies.Companies)
    .agentAccess(viewer.company.id)
    .pipe(Effect.catchTags({ CompanyNotFound: Effect.die }));
  const admin = viewer.role === "super_admin";
  const admins = admin
    ? []
    : adminNames(
        (yield* (yield* Users.Users).list(viewer.company.id)).filter(
          (user) => user.role === "super_admin"
        )
      );
  const title = "Agents use patches";
  const latest = access.latest
    ? `<span class="meta">Turned ${access.on ? "on" : "off"} by ${escapeHtml(access.latest.by.name)} on ${time(access.latest.at)}</span>`
    : "";
  // What a member can do while it's on: connect their own app.
  const connect =
    !admin && access.on ? linkButton("Connect your app", "/agents/connect", { size: "sm" }) : "";
  const page = settingsPage({
    title: "Agent access",
    ...(admin
      ? {}
      : { meta: [`Only super admins can change this. Super admins: ${sentenceList(admins)}.`] }),
    cards: [
      noticeHtml(refused),
      card({
        rows: [
          settingRow({
            title,
            description:
              "People’s own agents (Claude, ChatGPT, Codex…) can use the agent tools in patches they can open, as themselves. Turning it off refuses every agent until it’s back on; nobody’s connection ends.",
            control: admin
              ? switchForm({
                  action: "/settings/agent-access",
                  label: title,
                  checked: access.on,
                  fields: `<input type="hidden" name="state" value="${access.on ? "off" : "on"}">`
                })
              : `<strong>${access.on ? "On" : "Off"}</strong>`
          })
        ],
        ...(latest || connect ? { foot: `${latest}${connect}` } : {})
      })
    ]
  });
  return { title: "Agent access", ...page, ...(refused ? { status: refused.status } : {}) };
});

/**
 * Invite people, over People narrowed by `filter`, which the form carries so a refusal draws the
 * same list behind it: the emails, the role, and Send invites. A refusal draws it again with what
 * was typed, its problem under the field, which takes the focus, or its outcome above the
 * buttons, which does.
 */
const inviteDialog = (draft: Draft | undefined, filter: Filter) =>
  dialog({
    id: "invite",
    title: "Invite people",
    size: "lg",
    closeHref: peopleHref(filter.show, filter.query),
    form: {
      action: "/settings/people/invites",
      fields: `<input type="hidden" name="show" value="${filter.show}"><input type="hidden" name="q" value="${escapeAttribute(filter.query)}">`
    },
    body: `${field({
      id: "invite-email",
      label: "Emails",
      hint: `Separate them with commas or new lines. Up to ${inviteBatch} at once.`,
      ...(draft?.problem === undefined ? {} : { error: draft.problem }),
      control: (aria) =>
        textarea(aria, {
          name: "email",
          rows: 3,
          autocomplete: "off",
          autofocus: draft?.outcome === undefined,
          ...(draft === undefined ? {} : { value: draft.text })
        })
    })}${choiceGroup({
      id: "invite-role",
      legend: "Role",
      hint: "Admins also invite people and change settings.",
      choices: (aria) =>
        Users.Role.literals
          .map((role) =>
            radio({
              name: "role",
              value: role,
              label: roleLabel(role),
              checked: (draft?.role ?? "member") === role,
              aria
            })
          )
          .join("")
    })}${noticeHtml(draft?.outcome)}`,
    foot: `<span class="meta dialog-foot-start">Invites expire after ${lifetimeDays} days</span>${linkButton("Cancel", peopleHref(filter.show, filter.query), { kind: "quiet" })}${button("Send invites", { kind: "primary" })}`
  });

/** Removing a guest from every patch here, confirmed over Guests, naming each patch they lose. */
const guestRemoval = (viewer: Viewer, guest: Guest) => {
  const close = peopleHref("guests", "");
  return dialog({
    id: "remove-guest",
    title: `Remove ${guest.name} from all ${viewer.company.name} patches?`,
    closeHref: close,
    form: { action: `/settings/people/guests/${encodeURIComponent(guest.userId)}/remove` },
    body: `<p class="prose">${escapeHtml(guest.name)}’s guest access to these ends. Public ones stay open to anyone with the link. Their ${escapeHtml(guest.companyName)} account stays as it is.</p>${rows(
      guest.patches.map((patch) =>
        row({
          lead: patchMark(patch.name, patch.tier),
          name:
            patch.title === null
              ? "Restricted patch"
              : patchTitle({ ...patch, title: patch.title }, viewer.company.name),
          end: offBadge(patch)
        })
      ),
      true
    )}`,
    foot: `${linkButton("Cancel", close, { kind: "quiet", autofocus: true })}${button(`Remove from ${plural(guest.patches.length, "patch", "patches")}`, { kind: "danger-solid" })}`
  });
};

/**
 * `/settings/people`, People: everyone in the company, its open invitations and its guests,
 * narrowed by a segmented filter and a search. Admins invite from the header and manage each row
 * from its menu; members read the same list.
 */
const render = Effect.fn("CompanyPage.render")(function* (
  viewer: Viewer,
  view: View = {}
): Effect.fn.Return<Page, SqlError, Users.Users | Companies.Companies> {
  const companies = yield* Companies.Companies;
  const users = yield* (yield* Users.Users).list(viewer.company.id);
  const invites = yield* companies.listInvites(viewer.company.id);
  const companyGuests = yield* Guests;
  const guests =
    companyGuests === undefined
      ? []
      : yield* companyGuests.list(viewer.company.id, {
          userId: viewer.user.id,
          admin: viewer.role !== "member"
        });
  const ownedPatches = yield* OwnedPatches;
  const owned =
    ownedPatches === undefined
      ? undefined
      : yield* ownedPatches({ companyId: viewer.company.id, userId: viewer.user.id });
  const now = yield* Clock.currentTimeMillis;
  const admin = viewer.role !== "member";
  const superAdmin = viewer.role === "super_admin";
  const { show, query } = view.filter ?? { show: "all", query: "" };

  const byName = (a: Users.User, b: Users.User) =>
    a.name.localeCompare(b.name) || a.email.localeCompare(b.email);
  const active = users.filter((user) => user.deactivatedAt === null).sort(byName);
  const deactivated = users.filter((user) => user.deactivatedAt !== null).sort(byName);
  const admins = active.filter((user) => user.role !== "member");
  const names = new Map(users.map((user) => [user.id, displayName(user)]));
  const inviteState = (invite: Companies.Invite) =>
    invite.expiresAt.getTime() <= now
      ? "expired"
      : invite.clerkInvitationId === null
        ? "unsent"
        : "waiting";
  // Invitations that need an admin come first: their email never went out, or they ran out.
  const openInvites = [...invites].sort(
    (a, b) => Number(inviteState(a) === "waiting") - Number(inviteState(b) === "waiting")
  );
  type Entry =
    | { readonly kind: "invite"; readonly invite: Companies.Invite }
    | { readonly kind: "user"; readonly user: Users.User }
    | { readonly kind: "guest"; readonly guest: Guest };
  const people = (list: readonly Users.User[]) =>
    list.map((user): Entry => ({ kind: "user", user }));
  const invited = openInvites.map((invite): Entry => ({ kind: "invite", invite }));
  const lists: Record<Show, readonly Entry[]> = {
    all: [
      ...people(active),
      ...invited,
      ...people(deactivated),
      ...guests.map((guest): Entry => ({ kind: "guest", guest }))
    ],
    admins: people(admins),
    invited,
    guests: guests.map((guest): Entry => ({ kind: "guest", guest })),
    deactivated: people(deactivated)
  };
  const needle = query.toLowerCase();
  const searched = (entry: Entry) => {
    switch (entry.kind) {
      case "invite":
        return entry.invite.email;
      case "user":
        return `${entry.user.name}\n${entry.user.email}`;
      case "guest":
        return `${entry.guest.name}\n${entry.guest.email}\n${entry.guest.companyName}`;
    }
  };
  const found = (tab: Show) =>
    lists[tab].filter((entry) => searched(entry).toLowerCase().includes(needle));
  const entries = found(show);

  /**
   * A person's circle, their name and one line under it, which hold all a phone shows of the row:
   * there `role`, whose column is gone, follows on its own line. `after` follows the name, such
   * as an invite's state; it and `line` are trusted HTML.
   */
  const personCell = (spec: {
    readonly mark: string;
    readonly name: string;
    readonly line: string;
    readonly after?: string;
    readonly role?: Users.Role;
  }) =>
    `<div class="cell-name">${spec.mark}<div class="row-main"><span class="row-name">${escapeHtml(spec.name)}${spec.after === undefined ? "" : ` ${spec.after}`}</span>${spec.line === "" ? "" : `<span class="row-desc">${spec.line}</span>`}${spec.role === undefined ? "" : `<span class="row-desc show-sm">${roleLabel(spec.role)}</span>`}</div></div>`;
  const none = '<span class="muted">—</span>';

  const userRow = (user: Users.User) => {
    const path = `/settings/people/users/${encodeURIComponent(user.id)}`;
    const label = displayName(user);
    const self = user.id === viewer.user.id;
    const off = user.deactivatedAt !== null;
    const theirs: MenuItem = self
      ? { kind: "link", label: "See your patches", href: "/patches?show=yours" }
      : {
          kind: "link",
          label: "See their patches",
          href: `/patches?owner=${encodeURIComponent(user.id)}`
        };
    const canManage = superAdmin || user.role === "member";
    const role: MenuItem[] = superAdmin
      ? Users.Role.literals
          .filter((role) => role !== user.role)
          .map((role) => ({
            kind: "post",
            label: `Make ${roleLabel(role).toLowerCase()}`,
            action: `${path}/role`,
            fields: `<input type="hidden" name="role" value="${role}">`
          }))
      : [];
    const items: MenuItem[] =
      off && canManage
        ? [
            theirs,
            { kind: "rule" },
            { kind: "link", label: "Reactivate…", href: `${path}/reactivate` }
          ]
        : [
            ...role,
            theirs,
            ...(self || !canManage
              ? []
              : ([
                  { kind: "rule" },
                  { kind: "link", label: "Deactivate…", href: `${path}/deactivate`, danger: true }
                ] satisfies MenuItem[]))
          ];
    return [
      personCell({
        mark: avatar(user.id, label, off ? "off" : undefined),
        name: label,
        line: [
          ...(user.name.trim() ? [escapeHtml(user.email)] : []),
          ...(user.deactivatedAt === null ? [] : [`Deactivated ${time(user.deactivatedAt)}`])
        ].join(" · "),
        role: user.role,
        ...(self ? { after: '<span class="you">(you)</span>' } : {})
      }),
      roleLabel(user.role),
      ...(owned ? [String(owned.get(user.id) ?? 0)] : []),
      `<span class="muted">${time(user.createdAt)}</span>`,
      ...(admin ? [menu({ id: idFor("person", user.id), label, items })] : [])
    ];
  };

  const inviteRow = (invite: Companies.Invite) => {
    const path = `/settings/people/invites/${encodeURIComponent(invite.id)}`;
    const state = inviteState(invite);
    const by = names.get(invite.invitedBy);
    const line = `Invited${by === undefined ? "" : ` by ${escapeHtml(by)}`} ${time(invite.createdAt, ago(invite.createdAt.toISOString(), now))}${state === "waiting" ? ` · expires ${time(invite.expiresAt)}` : ""}`;
    const status =
      state === "expired"
        ? badge("Expired", "warning")
        : state === "unsent"
          ? badge("Email didn’t send", "danger")
          : badge("Invited");
    // Resend hands back the expiry it showed, so a second press of the same form sends nothing.
    const shown = `<input type="hidden" name="expires" value="${invite.expiresAt.getTime()}">`;
    return [
      personCell({
        mark: avatar(invite.id, invite.email, "waiting"),
        name: invite.email,
        line,
        after: status,
        role: invite.role
      }),
      roleLabel(invite.role),
      ...(owned ? [none] : []),
      none,
      ...(admin
        ? [
            menu({
              id: idFor("invite", invite.id),
              label: invite.email,
              items: [
                { kind: "post", label: "Resend", action: `${path}/resend`, fields: shown },
                { kind: "rule" },
                { kind: "post", label: "Revoke", action: `${path}/revoke`, danger: true }
              ]
            })
          ]
        : [])
    ];
  };

  const guestRow = (guest: Guest) => [
    personCell({
      mark: avatar(guest.userId, guest.name),
      name: guest.name,
      line: `${escapeHtml(guest.email)} · ${escapeHtml(guest.companyName)}`
    }),
    guest.patches
      .map(
        (patch) =>
          `<div class="cell-name">${patchMark(patch.name, patch.tier)}<div class="row-main"><span>${patchLink(viewer, patch)} ${offBadge(patch)}</span><span class="row-desc">Shared by ${escapeHtml(patch.sharedBy)} · ${time(patch.sharedAt)}</span></div></div>`
      )
      .join(""),
    ...(admin
      ? [
          menu({
            id: idFor("guest", guest.userId),
            label: guest.name,
            items: [
              {
                kind: "link",
                label: "Remove from all patches…",
                href: `/settings/people/guests/${encodeURIComponent(guest.userId)}/remove`,
                danger: true
              }
            ]
          })
        ]
      : [])
  ];

  const actions: Column[] = admin ? [{ label: "Actions", hidden: true, align: "end" }] : [];
  const content =
    show === "guests"
      ? table({
          label: "Guests",
          columns: [{ label: "Guest" }, { label: "Can open" }, ...actions],
          rows: entries.flatMap((entry) => (entry.kind === "guest" ? [guestRow(entry.guest)] : []))
        })
      : table({
          label: "People",
          columns: [
            { label: "Person" },
            { label: "Role", hideOnPhone: true },
            ...(owned ? [{ label: "Patches", align: "end", hideOnPhone: true } as const] : []),
            { label: "Joined", hideOnPhone: true },
            ...actions
          ],
          rows: entries.flatMap((entry) =>
            entry.kind === "user"
              ? [userRow(entry.user)]
              : entry.kind === "invite"
                ? [inviteRow(entry.invite)]
                : []
          )
        });
  const empty = emptyState(
    query
      ? {
          title: `No one matches “${query}”`,
          action: linkButton("Clear filter", peopleHref(show, ""), { size: "sm" })
        }
      : show === "invited"
        ? {
            title: "No open invitations",
            ...(admin
              ? {
                  action: linkButton("Invite people…", peopleHref(show, "", true), { size: "sm" })
                }
              : {})
          }
        : show === "guests"
          ? { title: "No guests" }
          : { title: "No one is deactivated" }
  );

  // Deactivated appears once someone is.
  const filter = segmented({
    label: "Show",
    current: showLabels[show],
    items: shows
      .filter((tab) => tab !== "deactivated" || deactivated.length > 0 || tab === show)
      .map((tab) => ({
        label: showLabels[tab],
        href: peopleHref(tab, query),
        count: found(tab).length
      }))
  });
  const search = searchField({
    action: "/settings/people",
    id: "people-filter",
    query,
    placeholder: "Filter people",
    label: "Filter people",
    keep: show === "all" ? {} : { show },
    className: "grow"
  });

  const draft = view.draft;
  const overlay =
    view.removing !== undefined
      ? guestRemoval(viewer, view.removing)
      : admin && (view.inviting === true || draft !== undefined)
        ? inviteDialog(draft, { show, query })
        : undefined;
  const status =
    view.notice?.status ?? draft?.outcome?.status ?? (draft?.problem ? 422 : undefined);
  return {
    title: "People",
    ...indexPage({
      title: "People",
      meta: [
        plural(active.length, "person", "people"),
        plural(admins.length, "admin", "admins"),
        ...(admin
          ? []
          : [`Only admins can invite or change roles. Admins: ${sentenceList(adminNames(users))}.`])
      ],
      ...(admin
        ? {
            actions: linkButton("Invite people…", peopleHref(show, query, true), {
              kind: "primary",
              icon: "plus"
            })
          }
        : {}),
      toolbar: `${filter}${search}`,
      content: `${noticeHtml(view.notice)}${entries.length ? content : `<div class="box">${empty}</div>`}`
    }),
    ...(overlay === undefined ? {} : { overlay }),
    ...(status === undefined ? {} : { status })
  };
});

/** Re-renders People with a refusal above its list. */
const refuse = (viewer: Viewer, message: string, status: number) =>
  render(viewer, { notice: { message, status } });

/** People again after a change, with the receipt naming it. */
const done = (receipt: string, redirect = "/settings/people"): Page => ({
  title: "People",
  body: "",
  redirect,
  receipt
});

/** Turns agent access on or off; a refusal re-renders Agent access, which the form sat on. */
const setAgentAccess = Effect.fn("CompanyPage.setAgentAccess")(function* (viewer: Viewer) {
  const refused = (message: string, status: number) =>
    renderAgentAccess(viewer, { message, status });
  if (viewer.role !== "super_admin")
    return yield* refused("Only a super admin can turn agent access on or off.", 403);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = yield* decodeAgentAccess(Object.fromEntries(yield* request.urlParamsBody)).pipe(
    Effect.catchTags({ SchemaError: () => Effect.succeed(null) })
  );
  if (form === null) return yield* refused("Choose on or off.", 422);
  const analytics = yield* Analytics.Analytics;
  const change = (yield* Companies.Companies).setAgentAccess({
    companyId: viewer.company.id,
    on: form.state === "on",
    by: viewer.user.id
  });
  // A stale form asking for the state it already has changes and reports nothing. The
  // viewer's own company exists for as long as they can submit this form.
  const { access } = yield* withReportedCommit(change, ({ changed, access }) =>
    changed
      ? analytics.track({
          name: "agent_access.changed",
          principalId: viewer.user.id,
          companyId: viewer.company.id,
          properties: { on: access.on }
        })
      : Effect.void
  ).pipe(Effect.catchTags({ CompanyNotFound: Effect.die }));
  return {
    title: "Agent access",
    body: "",
    redirect: "/settings/agent-access",
    receipt: `Agent access is ${access.on ? "on" : "off"}`
  } satisfies Page;
});

/** Auth supplies the viewer; Companies owns the forms and their company-scoped actions. */
export const handle = Effect.fn("CompanyPage.handle")(function* (viewer: Viewer, action: Action) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (action.kind === "view") {
    // Only the query matters here; the base never reaches a link.
    const params = new URL(request.url, "http://company.invalid").searchParams;
    return yield* render(viewer, {
      filter: filterOf(params.get("show"), params.get("q")),
      inviting: params.get("invite") === "1"
    });
  }
  if (action.kind === "view-agent-access") return yield* renderAgentAccess(viewer);
  if (action.kind === "agent-access") return yield* setAgentAccess(viewer);
  if (viewer.role === "member")
    return yield* refuse(viewer, "Only an admin can manage this company.", 403);
  // Narrowed here, so the effect below keeps the forms that remain.
  const act = action;
  return yield* Effect.gen(function* () {
    const users = yield* Users.Users;
    const analytics = yield* Analytics.Analytics;
    // A refused action fails before its event. Invitations deliver uninterruptibly,
    // so each reports in the same region; role changes report with their commit.
    const admin = { principalId: viewer.user.id, companyId: viewer.company.id };
    if (act.kind === "invite") {
      const fields = Object.fromEntries(new URLSearchParams(yield* request.text));
      const text = fields.email ?? "";
      // The list the dialog was opened over, drawn behind it again and landed on after.
      const filter = filterOf(fields.show, fields.q);
      const role = yield* decodeRole(fields).pipe(
        Effect.map(({ role }) => role),
        Effect.catchTags({ SchemaError: () => Effect.succeed(null) })
      );
      if (role === null)
        return yield* render(viewer, {
          filter,
          draft: {
            text,
            role: "member",
            outcome: { message: "Choose Member or Admin.", status: 422 }
          }
        });
      const list = addresses(text);
      const invalid = list.filter((entry) => !isEmail(entry));
      const problem =
        list.length === 0
          ? "Enter at least one email address."
          : invalid.length > 0
            ? `${invalid.join(", ")} ${invalid.length === 1 ? "is not an email address" : "are not email addresses"}. Fix ${invalid.length === 1 ? "it" : "them"} and send again.`
            : list.length > inviteBatch
              ? `That is ${list.length} addresses. Send up to ${inviteBatch} at a time.`
              : undefined;
      if (problem) return yield* render(viewer, { filter, draft: { text, role, problem } });
      // Each address is its own invitation: a refusal or a failed save stops that address only.
      // A repeat of the same list sends nothing twice: a live invitation refuses its address.
      const outcomes = yield* Effect.forEach(list, (email) =>
        Invitations.create({
          email,
          role,
          companyId: viewer.company.id,
          invitedBy: viewer.user.id
        }).pipe(
          Effect.tap(({ invite, mailFailed }) =>
            analytics.track({
              name: "invite.sent",
              ...admin,
              properties: { inviteId: invite.id, role: invite.role, emailed: !mailFailed }
            })
          ),
          Effect.uninterruptible,
          Effect.map(({ invite, mailFailed }): Delivery => ({
            email: invite.email,
            outcome: mailFailed ? "unsent" : "sent"
          })),
          Effect.catchTags({
            AlreadyInCompany: () => Effect.succeed<Delivery>({ email, outcome: "member" }),
            AlreadyInvited: () => Effect.succeed<Delivery>({ email, outcome: "invited" }),
            SqlError: () => Effect.succeed<Delivery>({ email, outcome: "failed" })
          })
        )
      );
      const emails = (kind: Delivery["outcome"]) =>
        outcomes.filter((entry) => entry.outcome === kind).map((entry) => entry.email);
      const sent = emails("sent");
      const unsent = emails("unsent");
      const members = emails("member");
      const invited = emails("invited");
      const failed = emails("failed");
      if (sent.length === outcomes.length)
        return done(
          sent.length === 1 ? `Invited ${sent[0]}` : `Invited ${sent.length} people`,
          peopleHref(filter.show, filter.query)
        );
      // Anything short of every address sent is explained per address, not receipted.
      const lines = [
        sent.length ? `Invited ${listed(sent)}.` : "",
        unsent.length
          ? `Saved the invite for ${listed(unsent)}, but the email did not go out. Resend it from the list.`
          : "",
        members.length
          ? `${listed(members)} ${members.length === 1 ? "is" : "are"} already in a company.`
          : "",
        invited.length
          ? `${listed(invited)} already ${invited.length === 1 ? "has an invite" : "have invites"}. Resend from the list instead.`
          : "",
        failed.length
          ? `Could not save the invite for ${listed(failed)}. ${failed.length === 1 ? "It is" : "They are"} still in the box; send again.`
          : ""
      ];
      // The dialog stays open with the chosen role; only addresses that can be sent again stay in it.
      return yield* render(viewer, {
        filter,
        draft: {
          text: failed.join("\n"),
          role,
          outcome: {
            message: lines.filter(Boolean).join(" "),
            status: failed.length ? 503 : unsent.length ? 502 : 409,
            // Some sent and the rest only skipped is a warning; anything lost or none sent, danger.
            tone: sent.length > 0 && !failed.length && !unsent.length ? "warning" : "danger"
          }
        }
      });
    }
    if (act.kind === "revoke") {
      const result = yield* Invitations.revoke({
        companyId: viewer.company.id,
        actorId: viewer.user.id,
        inviteId: act.id
      }).pipe(
        Effect.tap(({ invite }) =>
          analytics.track({ name: "invite.revoked", ...admin, properties: { inviteId: invite.id } })
        ),
        Effect.uninterruptible
      );
      // Here mail failure means Clerk kept the emailed link; Patchy revoked the invitation.
      if (result.mailFailed)
        return yield* refuse(
          viewer,
          "Invitation revoked in Patchy, but Clerk could not revoke the emailed link. It can no longer be used to join this company.",
          502
        );
      return done(`Revoked the invite to ${result.invite.email}`);
    }
    if (act.kind === "resend") {
      const shown = Number.parseInt(
        Option.getOrElse(UrlParams.getFirst(yield* request.urlParamsBody, "expires"), () => ""),
        10
      );
      const result = yield* Invitations.resend({
        companyId: viewer.company.id,
        actorId: viewer.user.id,
        inviteId: act.id,
        ...(Number.isSafeInteger(shown) ? { shownExpiry: shown } : {})
      }).pipe(
        Effect.tap(({ invite, mailFailed, repeated }) =>
          repeated
            ? Effect.void
            : analytics.track({
                name: "invite.resent",
                ...admin,
                properties: { inviteId: invite.id, emailed: !mailFailed }
              })
        ),
        Effect.uninterruptible
      );
      if (result.repeated) return done(`A new invite already went to ${result.invite.email}`);
      if (result.mailFailed)
        return yield* refuse(
          viewer,
          "Invitation saved, but the email did not go out. Resend it to try again.",
          502
        );
      return done(`Sent a new invite to ${result.invite.email}`);
    }
    if (act.kind === "view-guest-removal" || act.kind === "remove-guest") {
      const guests = yield* Guests;
      const guest =
        guests === undefined
          ? undefined
          : (yield* guests.list(viewer.company.id)).find(({ userId }) => userId === act.id);
      if (guests === undefined || guest === undefined)
        return yield* render(viewer, {
          filter: { show: "guests", query: "" },
          notice: { message: "No patch here is shared with them now.", status: 404 }
        });
      if (act.kind === "view-guest-removal")
        return yield* render(viewer, { filter: { show: "guests", query: "" }, removing: guest });
      // Ends whatever they hold now, so a patch shared since the confirmation goes too.
      yield* guests.removeAll({ companyId: viewer.company.id, userId: guest.userId });
      return done(`Removed ${guest.name} from all patches`, peopleHref("guests", ""));
    }
    const { role } = yield* decodeRole(Object.fromEntries(yield* request.urlParamsBody));
    const change = users.setRole({
      companyId: viewer.company.id,
      actorId: viewer.user.id,
      userId: act.id,
      role
    });
    const { user } = yield* withReportedCommit(change, ({ changed }) =>
      changed
        ? analytics.track({
            name: "user.role_changed",
            ...admin,
            properties: { userId: act.id, role }
          })
        : Effect.void
    );
    return done(`${displayName(user)} is now ${user.role === "admin" ? "an admin" : "a member"}`);
  }).pipe(
    Effect.catchTags({
      SchemaError: () => refuse(viewer, "Choose Member, Admin or Super admin.", 422),
      RoleForbidden: (error) => refuse(viewer, error.message, 403),
      InviteUnavailable: (error) => refuse(viewer, error.message, 404),
      CompanyNotFound: (error) => refuse(viewer, error.message, 404),
      UserNotFound: (error) => refuse(viewer, error.message, 404),
      LastSuperAdmin: (error) => refuse(viewer, error.message, 409)
    })
  );
});
