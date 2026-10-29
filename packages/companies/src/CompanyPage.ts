import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type { SqlError } from "effect/sql/SqlError";
import { Analytics } from "@patchy/analytics";
import {
  ago,
  avatar,
  dateLabel,
  escapeAttribute,
  escapeHtml,
  menuLink,
  menuPost,
  rowMenu,
  searchField,
  sentenceList
} from "@patchy/core";
import { registry } from "@patchy/limits/registry";
import { withReportedCommit } from "@patchy/sql";
import * as Companies from "./Companies.js";
import * as Invitations from "./Invitations.js";
import * as Users from "./Users.js";
import * as Guests from "./Guests.js";

interface Viewer {
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  readonly company: { readonly id: string; readonly handle: string; readonly name: string };
  readonly role: Users.Role;
}
/** `view` reads People and `view-agent-access` reads Agent access; the rest are admins' forms. */
export type Action =
  | { readonly kind: "view" }
  | { readonly kind: "view-agent-access" }
  | { readonly kind: "invite" }
  | { readonly kind: "agent-access" }
  | {
      readonly kind: "revoke" | "resend" | "role" | "deactivate-guest" | "reactivate-guest";
      readonly id: string;
    };

export interface Page {
  readonly title: string;
  readonly body: string;
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

/** Patches supplies this read; only an active company admin may reach its consumer below. */
export interface CompanyGuest {
  readonly guest: Guests.Guest;
  readonly grants: readonly {
    readonly name: string | null;
    readonly title: string | null;
    readonly manageable: boolean;
    readonly access: "active" | "deactivated" | "revoked" | "ended" | "unavailable";
  }[];
}
export const CompanyGuests = Context.Reference<
  (companyId: string) => Effect.Effect<readonly CompanyGuest[], SqlError>
>("@patchy/companies/CompanyPage/CompanyGuests", {
  defaultValue: () => () => Effect.succeed([])
});

/** The pages' layout; components come from the shell. */
export const styles = `
    .company-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 20px; }
    .company-search { width: min(100%, 300px); }
    /* An open invite takes its own line under the search and tabs, its button kept at the right. */
    .company-invite { margin-left: auto; }
    .company-invite[open] { flex-basis: 100%; text-align: right; }
    .company-invite > summary { list-style: none; }
    .company-invite > summary::-webkit-details-marker { display: none; }
    .company-invite-form { max-width: 560px; margin: 12px 0 0 auto; text-align: left; }
    .company-invite-form > :first-child { margin-top: 0; }
    .company-invite-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
    .company-invite-row > select { width: 10rem; }
    .company-matches { margin-top: 12px; }
    .company-table { overflow-x: auto; }
    /* Cells keep words whole, so on a phone the table scrolls here rather than splitting "Member". */
    .company-table .table { min-width: 760px; overflow-wrap: break-word; }
    .company-table :is(th, td) { vertical-align: middle; }
    .company-table .company-row-actions { text-align: right; white-space: nowrap; }
    .company-person { display: flex; align-items: center; gap: 12px; }
    .company-actions { display: inline-flex; align-items: center; gap: 6px; }
    .agent-access-state { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    @media (max-width: 640px) {
      .company-invite { margin-left: 0; }
      .company-invite[open] { text-align: left; }
      .company-invite-form { margin-left: 0; }
    }
`;

const shows = ["all", "admins", "invited", "deactivated"] as const;
type Show = (typeof shows)[number];
const showLabels: Record<Show, string> = {
  all: "All",
  admins: "Admins",
  invited: "Invited",
  deactivated: "Deactivated"
};

/** What a GET of the page narrows its list to. */
interface Filter {
  readonly show: Show;
  readonly query: string;
}

/** The invite field as submitted, kept after a refusal so a pasted list is not lost. */
interface Draft {
  readonly text: string;
  readonly role: Users.Role;
  /** Why the addresses were refused, shown under the field. */
  readonly problem?: string;
}

/** A refusal or a partial result above a page. The message is HTML: whoever builds it escapes what it interpolates. */
interface Notice {
  readonly message: string;
  readonly status: number;
}

interface View {
  readonly filter?: Filter;
  readonly notice?: Notice;
  /** Opens the invite form, which a draft also opens. */
  readonly inviting?: boolean;
  readonly draft?: Draft;
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
const displayName = (user: Users.User) => user.name.trim() || user.email;

const time = (date: Date, label = dateLabel(date.toISOString())) =>
  `<time datetime="${date.toISOString()}">${escapeHtml(label)}</time>`;

const noticeHtml = (notice: Notice | undefined) =>
  notice ? `<div class="note note-warn" role="alert">${notice.message}</div>` : "";

const filterHref = (show: Show, query: string) => {
  const params = new URLSearchParams();
  if (show !== "all") params.set("show", show);
  if (query) params.set("q", query);
  const search = params.toString();
  return search ? `/company?${search}` : "/company";
};

const guestAccess: Record<CompanyGuest["grants"][number]["access"], string> = {
  active: "Has access",
  deactivated: "Suspended · guest deactivated",
  revoked: "Revoked",
  ended: "Ended",
  unavailable: "Patch unavailable to guests"
};

const renderGuests = Effect.fn("CompanyPage.renderGuests")(function* (
  viewer: Viewer,
  query: string
) {
  // Auth already requires active membership. Match the existing company management guard
  // before acquiring the read; URL parameters never choose a company or a principal.
  if (viewer.role !== "admin")
    return yield* refuse(viewer, "Only an admin can manage this company.", 403);
  const guests = yield* (yield* CompanyGuests)(viewer.company.id);
  const needle = query.toLowerCase();
  const entries = guests.filter(({ guest }) =>
    `${guest.name}\n${guest.email}`.toLowerCase().includes(needle)
  );
  const rows = entries
    .map(({ guest, grants }) => {
      const state = [
        guest.endedAt ? "Ended" : guest.deactivatedAt ? "Deactivated" : "Active",
        ...(guest.endedAt && guest.deactivatedAt ? ["Deactivated"] : [])
      ];
      const patches = grants
        .map(({ name, title, access, manageable }) => {
          const label =
            name === null
              ? "Reclaimed patch"
              : `${manageable ? `<a href="/patches/${encodeURIComponent(name)}/settings#share">${escapeHtml(title || name)}</a>` : escapeHtml(title || name)} <span class="supporting-text">${escapeHtml(name)}</span>`;
          return `<li class="list-row">${label} · ${guestAccess[access]}</li>`;
        })
        .join("");
      const action = guest.deactivatedAt ? "reactivate" : "deactivate";
      const control = `<form method="post" action="/company/guests/${encodeURIComponent(guest.id)}/${action}"><button class="btn${guest.deactivatedAt ? "" : " btn-danger"}" type="submit">${guest.deactivatedAt ? "Reactivate" : "Deactivate"}</button></form>`;
      return `<tr><td><div class="company-person">${avatar(guest.id, guest.name || guest.email, guest.deactivatedAt || guest.endedAt ? "off" : undefined)}<div><strong>${escapeHtml(guest.name || guest.email)}</strong><br><span class="supporting-text">${escapeHtml(guest.email)}</span></div></div></td><td>${state.join(" · ")}</td><td>${grants.some(({ access }) => access === "active") ? "" : '<p class="supporting-text">No current patch access.</p>'}${patches ? `<ul class="list list-compact">${patches}</ul>` : '<p class="supporting-text">No patch grants.</p>'}</td><td class="company-row-actions">${control}</td></tr>`;
    })
    .join("");
  const search = searchField({
    action: "/company",
    id: "company-search",
    query,
    placeholder: "Search guests",
    label: "Search guests",
    keep: { show: "guests" },
    className: "company-search"
  });
  return {
    title: "People",
    body: `<div class="company-tools">${search}<nav class="tabs" aria-label="Show"><a href="/company">All people</a><a href="/company?show=guests" aria-current="page">Guests <span class="count">${guests.length}</span></a></nav></div><p class="supporting-text">Guests have access only to patches shared with them. Open a patch’s Share settings to revoke its grant. Deactivation blocks this guest’s patch access and new shares in this company. Reactivation restores only still-valid grants; revoked or ended grants and ended relationships stay ended. Other companies are unaffected.</p>${rows ? `<div class="company-table"><table class="table"><thead><tr><th scope="col">Guest</th><th scope="col">Relationship</th><th scope="col">Patch access</th><th scope="col">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p>${query ? `No guests match “${escapeHtml(query)}”.` : "No guests yet."}</p>`}`
  } satisfies Page;
});

/**
 * `/company/agent-access`: whether the company's agents can use patches, its latest change, and
 * for an admin the one button that flips it. A member reads the same state and whom to ask.
 */
const renderAgentAccess = Effect.fn("CompanyPage.renderAgentAccess")(function* (
  viewer: Viewer,
  notice?: Notice
): Effect.fn.Return<Page, SqlError, Users.Users | Companies.Companies> {
  // The viewer's own company: it exists for as long as they can open this page.
  const access = yield* (yield* Companies.Companies)
    .agentAccess(viewer.company.id)
    .pipe(Effect.catchTags({ CompanyNotFound: Effect.die }));
  const company = escapeHtml(viewer.company.name);
  const state = access.on
    ? '<span class="pill pill-done">On</span>'
    : '<span class="pill">Off</span>';
  const latest = access.latest
    ? `<span class="supporting-text">Turned ${access.on ? "on" : "off"} by ${escapeHtml(access.latest.by.name)} on ${time(access.latest.at)}</span>`
    : "";
  const consequence = access.on
    ? `Anyone at ${company} can connect their own agent to use patches’ agent tools as themselves.`
    : "Agents can’t use any patch; connections stay and work again when it’s on.";
  let control: string;
  if (viewer.role === "admin") {
    const next = access.on ? "off" : "on";
    // What the button does, before it is pressed: turning off refuses every agent but keeps connections.
    const effect = access.on
      ? `<p class="supporting-text">Turning it off refuses every agent at ${company} until it’s back on. Nobody’s connection ends.</p>`
      : "";
    control = `${effect}<form class="actions" method="post" action="/company/agent-access"><input type="hidden" name="state" value="${next}"><button class="btn${access.on ? "" : " btn-primary"}" type="submit">Turn ${next} agent access</button></form>`;
  } else {
    const admins = (yield* (yield* Users.Users).list(viewer.company.id))
      .filter((user) => user.role === "admin" && user.deactivatedAt === null)
      .map(displayName)
      .sort((a, b) => a.localeCompare(b));
    control = `<p class="supporting-text">Only an admin can change this. At ${company} that’s ${sentenceList(admins)}.</p>${access.on ? '<div class="actions"><a class="btn" href="/machines">Connect your agent</a></div>' : ""}`;
  }
  return {
    title: "Agent access",
    body: `${noticeHtml(notice)}<p class="agent-access-state">${state}${latest}</p><p>${consequence}</p>${control}`,
    status: notice?.status
  };
});

/**
 * `/company`, People: everyone in the company and its open invites, narrowed by a tab and a
 * search. Admins invite from the toolbar and manage each row from its menu.
 */
const render = Effect.fn("CompanyPage.render")(function* (
  viewer: Viewer,
  view: View = {}
): Effect.fn.Return<Page, SqlError, Users.Users | Companies.Companies> {
  const companies = yield* Companies.Companies;
  const users = yield* (yield* Users.Users).list(viewer.company.id);
  const invites = yield* companies.listInvites(viewer.company.id);
  const ownedPatches = yield* OwnedPatches;
  const owned =
    ownedPatches === undefined
      ? undefined
      : yield* ownedPatches({ companyId: viewer.company.id, userId: viewer.user.id });
  const now = yield* Clock.currentTimeMillis;
  const admin = viewer.role === "admin";
  const { show, query } = view.filter ?? { show: "all", query: "" };

  const byName = (a: Users.User, b: Users.User) =>
    a.name.localeCompare(b.name) || a.email.localeCompare(b.email);
  const active = users.filter((user) => user.deactivatedAt === null).sort(byName);
  const deactivated = users.filter((user) => user.deactivatedAt !== null).sort(byName);
  const inviteState = (invite: Companies.Invite) =>
    invite.expiresAt.getTime() <= now
      ? "expired"
      : invite.clerkInvitationId === null
        ? "unsent"
        : "waiting";
  // Invites that need an admin come first: their email never went out, or they ran out.
  const openInvites = [...invites].sort(
    (a, b) => Number(inviteState(a) === "waiting") - Number(inviteState(b) === "waiting")
  );
  type Entry =
    | { readonly kind: "invite"; readonly invite: Companies.Invite }
    | { readonly kind: "user"; readonly user: Users.User };
  const people = (list: readonly Users.User[]) =>
    list.map((user): Entry => ({ kind: "user", user }));
  const lists: Record<Show, readonly Entry[]> = {
    all: [
      ...openInvites.map((invite): Entry => ({ kind: "invite", invite })),
      ...people(active),
      ...people(deactivated)
    ],
    admins: people(active.filter((user) => user.role === "admin")),
    invited: openInvites.map((invite): Entry => ({ kind: "invite", invite })),
    deactivated: people(deactivated)
  };
  const needle = query.toLowerCase();
  const entries = lists[show].filter((entry) =>
    entry.kind === "invite"
      ? entry.invite.email.toLowerCase().includes(needle)
      : `${entry.user.name}\n${entry.user.email}`.toLowerCase().includes(needle)
  );
  // While every row is someone who joined, the column holds only dates and is named for them.
  const joinedOnly = entries.every(
    (entry) => entry.kind === "user" && entry.user.deactivatedAt === null
  );

  const userRow = (user: Users.User) => {
    const path = `/company/users/${encodeURIComponent(user.id)}`;
    const label = displayName(user);
    const you = user.id === viewer.user.id ? '<span class="tag">You</span>' : "";
    const second = user.name.trim()
      ? `<br><span class="supporting-text">${escapeHtml(user.email)}</span>`
      : "";
    const status = user.deactivatedAt
      ? `<span class="pill">Deactivated ${escapeHtml(dateLabel(user.deactivatedAt.toISOString()))}</span>`
      : joinedOnly
        ? time(user.createdAt)
        : `<span class="supporting-text">Joined ${time(user.createdAt)}</span>`;
    const role = user.role === "admin" ? "member" : "admin";
    const lifecycle = user.deactivatedAt
      ? menuLink(`${path}/reactivate`, "Reactivate…")
      : user.id === viewer.user.id
        ? ""
        : menuLink(`${path}/deactivate`, "Deactivate…", true);
    const actions = admin
      ? `<td class="company-row-actions">${rowMenu(user.id, label, [
          menuPost(
            `${path}/role`,
            role === "admin" ? "Make admin" : "Make member",
            `<input type="hidden" name="role" value="${role}">`
          ),
          ...(lifecycle ? ['<hr class="menu-rule">', lifecycle] : [])
        ])}</td>`
      : "";
    return `<tr><td><div class="company-person">${avatar(user.id, label, user.deactivatedAt ? "off" : undefined)}<div><strong>${escapeHtml(label)}</strong>${you}${second}</div></div></td><td>${user.role === "admin" ? "Admin" : "Member"}</td>${owned ? `<td>${owned.get(user.id) ?? 0}</td>` : ""}<td>${status}</td>${actions}</tr>`;
  };
  const inviteRow = (invite: Companies.Invite) => {
    const path = `/company/invites/${encodeURIComponent(invite.id)}`;
    const state = inviteState(invite);
    const sent = `Invited ${time(invite.createdAt, ago(invite.createdAt.toISOString(), now))}${state === "waiting" ? ` · expires ${time(invite.expiresAt)}` : ""}`;
    const status =
      state === "expired"
        ? '<span class="pill">Expired</span>'
        : state === "unsent"
          ? '<span class="pill pill-failed">Email didn’t send</span>'
          : '<span class="pill pill-progress">Invited</span>';
    const stuck = state !== "waiting";
    const actions = admin
      ? `<td class="company-row-actions"><div class="company-actions">${stuck ? `<form method="post" action="${escapeAttribute(`${path}/resend`)}"><button class="btn" type="submit" aria-label="${escapeAttribute(`Resend the invite to ${invite.email}`)}">Resend</button></form>` : ""}${rowMenu(
          invite.id,
          invite.email,
          [
            ...(stuck
              ? []
              : [menuPost(`${path}/resend`, "Resend invite"), '<hr class="menu-rule">']),
            menuPost(`${path}/revoke`, "Revoke invite", "", true)
          ]
        )}</div></td>`
      : "";
    return `<tr><td><div class="company-person">${avatar(invite.id, invite.email, "waiting")}<div><strong>${escapeHtml(invite.email)}</strong><br><span class="supporting-text">${sent}</span></div></div></td><td>${invite.role === "admin" ? "Admin" : "Member"}</td>${owned ? "<td></td>" : ""}<td>${status}</td>${actions}</tr>`;
  };

  const counts: Record<Show, number> = {
    all: invites.length + users.length,
    admins: lists.admins.length,
    invited: invites.length,
    deactivated: deactivated.length
  };
  // Invited and Deactivated appear once there is something in them.
  const tabs =
    shows
      .filter((tab) => tab === "all" || tab === "admins" || counts[tab] > 0 || tab === show)
      .map(
        (tab) =>
          `<a href="${escapeAttribute(filterHref(tab, query))}"${tab === show ? ' aria-current="page"' : ""}>${showLabels[tab]} <span class="count">${counts[tab]}</span></a>`
      )
      .join("") + (admin ? '<a href="/company?show=guests">Guests</a>' : "");
  const search = searchField({
    action: "/company",
    id: "company-search",
    query,
    placeholder: "Search people",
    label: "Search people",
    keep: show === "all" ? {} : { show },
    className: "company-search"
  });
  const matches = query
    ? `<p class="supporting-text company-matches">${plural(entries.length, "match", "matches")} for “${escapeHtml(query)}” · <a href="${escapeAttribute(filterHref(show, ""))}">Clear search</a></p>`
    : "";
  const empty = query
    ? `<p>No one matches “${escapeHtml(query)}”.</p>`
    : show === "invited"
      ? "<p>No open invites.</p>"
      : "<p>No one is deactivated.</p>";
  const table = entries.length
    ? `<div class="company-table"><table class="table"><thead><tr><th scope="col">Person</th><th scope="col">Role</th>${owned ? '<th scope="col">Patches</th>' : ""}<th scope="col">${joinedOnly ? "Joined" : "Status"}</th>${admin ? '<th class="company-row-actions" scope="col" aria-label="Actions"></th>' : ""}</tr></thead><tbody>${entries.map((entry) => (entry.kind === "invite" ? inviteRow(entry.invite) : userRow(entry.user))).join("")}</tbody></table></div>`
    : empty;

  const draft = view.draft;
  const inviteNote = draft?.problem
    ? `<div class="note note-refused field-callout" id="invite-email-note" role="alert">${escapeHtml(draft.problem)}</div>`
    : `<p class="field-hint" id="invite-email-note">Up to ${inviteBatch} at once. Invites expire after ${lifetimeDays} days.</p>`;
  const invite = admin
    ? `<details class="company-invite"${view.inviting || draft ? " open" : ""}><summary class="btn btn-primary">Invite people</summary><form class="side-panel company-invite-form" method="post" action="/company/invites" novalidate><label class="field-label" for="invite-email">Emails</label><textarea class="field field-grow" id="invite-email" name="email" rows="1" required aria-describedby="invite-email-note"${draft?.problem ? ' aria-invalid="true" autofocus' : ""}>${escapeHtml(draft?.text ?? "")}</textarea>${inviteNote}<label class="field-label" for="invite-role">Role</label><div class="company-invite-row"><select class="field" id="invite-role" name="role"><option value="member">Member</option><option value="admin"${draft?.role === "admin" ? " selected" : ""}>Admin</option></select><button class="btn btn-primary" type="submit">Send invites</button></div></form></details>`
    : "";
  const admins = active.filter((user) => user.role === "admin");
  return {
    title: "People",
    body: `<p class="supporting-text">${plural(active.length, "person", "people")} · ${plural(admins.length, "admin", "admins")}</p>${noticeHtml(view.notice)}<div class="company-tools">${search}<nav class="tabs" aria-label="Show">${tabs}</nav>${invite}</div>${matches}${table}`,
    status: view.notice?.status ?? (draft?.problem ? 422 : undefined)
  };
});

/** Re-renders People with a plain-text refusal above it. */
const refuse = (viewer: Viewer, message: string, status: number, draft?: Draft) =>
  render(viewer, { notice: { message: escapeHtml(message), status }, draft });

/** People again after a change, with the receipt naming it. */
const done = (receipt: string): Page => ({
  title: "People",
  body: "",
  redirect: "/company",
  receipt
});

/** Turns agent access on or off; a refusal re-renders Agent access, which the form sat on. */
const setAgentAccess = Effect.fn("CompanyPage.setAgentAccess")(function* (viewer: Viewer) {
  const refused = (message: string, status: number) =>
    renderAgentAccess(viewer, { message: escapeHtml(message), status });
  if (viewer.role !== "admin")
    return yield* refused("Only an admin can turn agent access on or off.", 403);
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
    redirect: "/company/agent-access",
    receipt: `Agent access is ${access.on ? "on" : "off"}`
  } satisfies Page;
});

/** Auth supplies the viewer; Companies owns the forms and their company-scoped actions. */
export const handle = Effect.fn("CompanyPage.handle")(function* (viewer: Viewer, action: Action) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (action.kind === "view") {
    // Only the query matters here; the base never reaches a link.
    const params = new URL(request.url, "http://company.invalid").searchParams;
    if (params.get("show") === "guests")
      return yield* renderGuests(viewer, (params.get("q") ?? "").trim().slice(0, 200));
    const show = shows.find((candidate) => candidate === params.get("show")) ?? "all";
    return yield* render(viewer, {
      filter: { show, query: (params.get("q") ?? "").trim().slice(0, 200) },
      inviting: params.get("invite") === "1"
    });
  }
  if (action.kind === "view-agent-access") return yield* renderAgentAccess(viewer);
  if (action.kind === "agent-access") return yield* setAgentAccess(viewer);
  if (viewer.role !== "admin")
    return yield* refuse(viewer, "Only an admin can manage this company.", 403);
  if (action.kind === "deactivate-guest" || action.kind === "reactivate-guest") {
    const guest = yield* Guests.findById(action.id);
    if (guest === null || guest.companyId !== viewer.company.id)
      return yield* refuse(viewer, "Guest not found in this company.", 404);
    const deactivated = action.kind === "deactivate-guest";
    const analytics = yield* Analytics.Analytics;
    // Only clear the suspension: never reopen a relationship or change its grants.
    const updated = yield* withReportedCommit(
      Guests.setDeactivated({
        companyId: viewer.company.id,
        clerkUserId: guest.clerkUserId,
        deactivated
      }),
      (result) =>
        result === null
          ? Effect.void
          : analytics.track({
              name: deactivated ? "guest.deactivated" : "guest.reactivated",
              principalId: viewer.user.id,
              companyId: viewer.company.id,
              properties: { guestId: result.id }
            })
    );
    if (updated === null) return yield* refuse(viewer, "Guest not found in this company.", 404);
    return {
      ...done(`${deactivated ? "Deactivated" : "Reactivated"} ${updated.name || updated.email}`),
      redirect: "/company?show=guests"
    };
  }
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
      const role = yield* decodeRole(fields).pipe(
        Effect.map(({ role }) => role),
        Effect.catchTags({ SchemaError: () => Effect.succeed(null) })
      );
      if (role === null)
        return yield* refuse(viewer, "Choose Member or Admin.", 422, { text, role: "member" });
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
      if (problem) return yield* render(viewer, { draft: { text, role, problem } });
      // Each address is its own invitation: a refusal or a failed save stops that address only.
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
        return done(sent.length === 1 ? `Invited ${sent[0]}` : `Invited ${sent.length} people`);
      // Anything short of every address sent is explained per address, not receipted.
      const lines = [
        sent.length ? `Invited ${sentenceList(sent)}.` : "",
        unsent.length
          ? `Saved the invite for ${sentenceList(unsent)}, but the email did not go out. Resend it from the list.`
          : "",
        members.length
          ? `${sentenceList(members)} ${members.length === 1 ? "is" : "are"} already in a company.`
          : "",
        invited.length
          ? `${sentenceList(invited)} already ${invited.length === 1 ? "has an invite" : "have invites"}. Resend from the list instead.`
          : "",
        failed.length
          ? `Could not save the invite for ${sentenceList(failed)}. ${failed.length === 1 ? "It is" : "They are"} still in the box; send again.`
          : ""
      ];
      return yield* render(viewer, {
        notice: {
          message: lines.filter(Boolean).join(" "),
          status: failed.length ? 503 : unsent.length ? 502 : 409
        },
        // The form stays open with the chosen role; only addresses that can be sent again stay in it.
        draft: { text: failed.join("\n"), role }
      });
    }
    if (act.kind === "revoke") {
      const result = yield* Invitations.revoke({
        companyId: viewer.company.id,
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
      const result = yield* Invitations.resend({
        companyId: viewer.company.id,
        inviteId: act.id
      }).pipe(
        Effect.tap(({ invite, mailFailed }) =>
          analytics.track({
            name: "invite.resent",
            ...admin,
            properties: { inviteId: invite.id, emailed: !mailFailed }
          })
        ),
        Effect.uninterruptible
      );
      if (result.mailFailed)
        return yield* refuse(
          viewer,
          "Invitation saved, but the email did not go out. Resend it to try again.",
          502
        );
      return done(`Sent a new invite to ${result.invite.email}`);
    }
    const { role } = yield* decodeRole(Object.fromEntries(yield* request.urlParamsBody));
    const change = users.setRole({ companyId: viewer.company.id, userId: act.id, role });
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
      SchemaError: () => refuse(viewer, "Choose Member or Admin.", 422),
      InviteUnavailable: (error) => refuse(viewer, error.message, 404),
      CompanyNotFound: (error) => refuse(viewer, error.message, 404),
      UserNotFound: (error) => refuse(viewer, error.message, 404),
      LastAdmin: (error) => refuse(viewer, error.message, 409)
    })
  );
});
