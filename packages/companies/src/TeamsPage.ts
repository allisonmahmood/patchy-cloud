import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as UrlParams from "effect/http/UrlParams";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import {
  avatar,
  button,
  checklist,
  detailPage,
  directoryCards,
  dialog,
  emptyState,
  escapeAttribute,
  escapeHtml,
  field,
  flowPage,
  idFor,
  indexPage,
  input,
  linkButton,
  menu,
  notice,
  productMark,
  refusalNotice,
  row,
  rows,
  searchField
} from "@patchy/core";
import type { Page } from "./CompanyPage.js";
import * as Teams from "./Teams.js";
import * as Users from "./Users.js";

export const path = "/settings/company/teams";
const NameForm = Schema.Struct({ name: Schema.String });
const PersonForm = Schema.Struct({ userId: Schema.String });
const decodeName = Schema.decodeUnknownEffect(NameForm);
const decodePerson = Schema.decodeUnknownEffect(PersonForm);
const screens = ["create", "rename", "add", "remove", "delete"] as const;
type Screen = (typeof screens)[number];
export type Action = "view" | Screen;
interface Viewer {
  readonly company: { readonly id: string };
  readonly user: { readonly id: string };
  readonly role: Users.Role;
}
interface View {
  readonly teamId: string;
  readonly screen?: Screen;
  readonly query: string;
  readonly personId: string;
  readonly selected: readonly string[];
}
interface Draft {
  readonly name: string;
  readonly error: string;
  readonly status: number;
}
interface Refusal {
  readonly message: string;
  readonly status: number;
}
const roleLabel = { member: "Member", admin: "Admin" } satisfies Record<Users.Role, string>;
/** The patches and connections using a team that the viewer can see, and how many others do. */
export interface TeamUses {
  readonly patches: readonly string[];
  readonly connections: readonly string[];
  readonly hidden: number;
}

/**
 * What a refused deletion names. Patches and Integrations know what uses a team, which Companies
 * cannot read, so hosting provides it; without it the refusal names nothing.
 */
export const Uses = Context.Reference<
  ((team: Teams.TeamRef) => Effect.Effect<TeamUses, SqlError>) | undefined
>("@patchy/companies/TeamsPage/Uses", { defaultValue: () => undefined });

const listed = (items: readonly string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** "Roadmap, postgres/warehouse and 2 more you can’t see use this team. Change their audiences first." */
const inUse = (uses: TeamUses | undefined) => {
  const named = [...(uses?.patches ?? []), ...(uses?.connections ?? [])];
  const hidden = uses?.hidden ?? 0;
  if (named.length === 0 && hidden === 0)
    return "Patches or connections use this team. Change their audiences first.";
  const more = hidden === 0 ? [] : [`${hidden} more you can’t see`];
  return `${listed([...named, ...more])} ${named.length + hidden === 1 ? "uses" : "use"} this team. Change ${named.length + hidden === 1 ? "its audience" : "their audiences"} first.`;
};

const address = (id: string) => `${path}?team=${encodeURIComponent(id)}`;
const operation = (id: string, action: Screen) =>
  `${path}/${action}?team=${encodeURIComponent(id)}`;
const screenHref = (id: string, screen: Screen) => `${address(id)}&view=${screen}`;
const peopleCount = (count: number) => `${count} ${count === 1 ? "person" : "people"}`;
const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}">`;
const problem = (refused?: Refusal) => (refused ? refusalNotice(refused.message) : "");
const teamMark = () => productMark({ icon: "people" });
const cancel = (href: string, autofocus = false) =>
  linkButton("Cancel", href, { kind: "quiet", autofocus });
const nameField = (name: string, draft?: Draft) =>
  field({
    id: "team-name",
    label: "Team name",
    ...(draft ? { error: draft.error } : {}),
    control: (aria) =>
      input(aria, {
        name: "name",
        value: draft?.name ?? name,
        required: true,
        maxlength: 100,
        autofocus: true
      })
  });
const failurePage = (title: string, message: string, status: number): Page => ({
  title,
  status,
  ...indexPage({
    title,
    content: notice({ tone: "danger", title: message, action: linkButton("Back to Teams", path) })
  })
});

/** Every read is scoped by Teams first. UI state never grants membership or management authority. */
const render = Effect.fn("TeamsPage.render")(function* (
  viewer: Viewer,
  view: View,
  draft?: Draft,
  refused?: Refusal
): Effect.fn.Return<
  Page,
  Users.RoleForbidden | Users.UserNotFound | Teams.TeamNotFound | SqlError,
  Teams.Teams | Users.Users
> {
  const teams = yield* Teams.Teams;
  const users = yield* Users.Users;
  const ref = { companyId: viewer.company.id, actorId: viewer.user.id };
  const editable = viewer.role === "admin";
  if (!editable && view.screen) return yield* new Users.RoleForbidden(ref);
  const all = yield* teams.list(ref);
  const selected = all.find((team) => team.id === view.teamId);
  if (view.teamId && !selected) return yield* new Teams.TeamNotFound({ teamId: view.teamId });
  const query = view.query.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(query);
  const directoryHref = path;
  const status = draft?.status ?? refused?.status;
  if (!selected) {
    // One batched read supplies recorded counts, including inactive members, without one query per team.
    const people = all.length ? yield* users.list(ref.companyId) : [];
    const memberships = people.length
      ? yield* teams.people(
          ref.companyId,
          people.map((person) => person.id)
        )
      : [];
    const teamsByPerson = new Map(memberships.map((person) => [person.id, person.teamIds]));
    const previews = new Map<string, string[]>();
    const counts = new Map<string, number>();
    for (const user of [...people].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    ))
      for (const teamId of teamsByPerson.get(user.id) ?? []) {
        counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
        if (user.deactivatedAt === null) {
          const preview = previews.get(teamId) ?? [];
          if (preview.length < 3) preview.push(avatar(user.id, user.name));
          previews.set(teamId, preview);
        }
      }
    const filtered = all.filter((team) => matches(team.name));
    const create = editable
      ? linkButton("Create team", `${path}?view=create`, { kind: "primary", icon: "plus" })
      : "";
    const content =
      all.length === 0
        ? emptyState({
            title: "No teams yet",
            ...(create ? { action: create } : {})
          })
        : filtered.length === 0
          ? emptyState({
              title: "No teams match your search",
              action: linkButton("Clear search", directoryHref)
            })
          : directoryCards(
              filtered.map((team) => ({
                name: team.name,
                href: address(team.id),
                mark: teamMark(),
                meta: peopleCount(counts.get(team.id) ?? 0),
                preview: (previews.get(team.id) ?? []).join(""),
                action: "Open team"
              }))
            );
    const title = "Teams";
    const page: Page = {
      title,
      status,
      ...indexPage({
        title,
        meta: [`${all.length} ${all.length === 1 ? "team" : "teams"}`],
        ...(all.length && create ? { actions: create } : {}),
        content: `<div class="stack">${all.length ? searchField({ action: path, id: "teams-search", query: view.query, placeholder: "Find a team", label: "Find a team" }) : ""}${problem(refused)}${content}</div>`
      })
    };
    if (view.screen === "create")
      return {
        ...page,
        overlay: dialog({
          id: "create-team",
          title: "Create team",
          closeHref: path,
          form: { action: `${path}/create` },
          body: problem(refused) + nameField("", draft),
          foot: cancel(path) + button("Create team", { kind: "primary" })
        })
      };
    return page;
  }
  const teamHref = address(selected.id);
  const people = [...(yield* users.list(ref.companyId))].sort(
    (a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email)
  );
  const ids = new Set(yield* teams.members({ ...ref, teamId: selected.id }));
  const members = people.filter((person) => ids.has(person.id));
  const active = people.filter((person) => person.deactivatedAt === null && !ids.has(person.id));
  if (view.screen === "add") {
    const eligible = new Set(active.map((person) => person.id));
    const picked = new Set(view.selected.filter((id) => eligible.has(id)));
    const found = active.filter((person) => matches(`${person.name} ${person.email}`));
    const visible = new Set(found.map((person) => person.id));
    const fieldset = found.length
      ? checklist({
          id: "team-candidates",
          legend: "People",
          name: "userId",
          items: found.map((person) => ({
            value: person.id,
            label: person.name,
            description: person.email,
            checked: picked.has(person.id)
          }))
        })
      : emptyState({
          title: query ? "No eligible people match" : "Everyone active is already in this team"
        });
    // GET search carries checked choices; the final button alone switches to the existing POST operation.
    // Hidden choices are only those outside this result, so unchecking a visible choice really removes it.
    const search = `<div class="pair"><span class="grow">${field({ id: "people-search", label: "Search people", control: (aria) => input(aria, { name: "q", type: "search", value: view.query, placeholder: "Name or email", maxlength: 200 }) })}</span>${button("Search")}</div>`;
    const retained = [...picked]
      .filter((id) => !visible.has(id))
      .map((id) => hidden("userId", id))
      .join("");
    const selectedNames = active
      .filter((person) => picked.has(person.id))
      .map((person) => person.name);
    const form = `<form method="get" action="${path}">${hidden("team", selected.id)}${hidden("view", "add")}${retained}<div class="stack">${problem(refused)}${search}${picked.size ? notice({ tone: "info", title: `${peopleCount(picked.size)} selected`, body: `<p>${escapeHtml(selectedNames.join(", "))}</p>` }) : ""}${fieldset}<div class="btn-group">${button("Add selected people", { kind: "primary", formAction: operation(selected.id, "add"), formMethod: "post" })}${cancel(teamHref)}</div></div></form>`;
    return {
      title: `Add people to ${selected.name}`,
      status,
      ...flowPage({
        title: `Add people to ${selected.name}`,
        parent: { label: selected.name, href: teamHref },
        sections: [],
        outcome: form,
        submit: ""
      })
    };
  }
  const joined = ids.has(viewer.user.id);
  const join =
    editable && !joined
      ? `<form method="post" action="${escapeAttribute(operation(selected.id, "add"))}">${hidden("userId", viewer.user.id)}${button("Join team")}</form>`
      : "";
  const roster = members.filter((person) => matches(`${person.name} ${person.email}`));
  const inactiveCount = members.filter((person) => person.deactivatedAt !== null).length;
  const actions = editable
    ? linkButton("Add people", screenHref(selected.id, "add"), { kind: "primary", icon: "plus" }) +
      join +
      menu({
        id: idFor("team", selected.id),
        label: selected.name,
        items: [
          { kind: "link", label: "Rename team", href: screenHref(selected.id, "rename") },
          {
            kind: "link",
            label: "Delete team…",
            href: screenHref(selected.id, "delete"),
            danger: true
          }
        ]
      })
    : "";
  const rosterHtml =
    members.length === 0
      ? emptyState({ title: "No people in this team" })
      : roster.length === 0
        ? emptyState({
            title: "No people match your search",
            action: linkButton("Clear search", teamHref)
          })
        : rows(
            roster.map((person) =>
              row({
                lead: avatar(person.id, person.name, person.deactivatedAt ? "off" : undefined),
                name: person.name + (person.id === viewer.user.id ? " (you)" : ""),
                description: `${person.email} · ${person.deactivatedAt ? "Deactivated" : roleLabel[person.role]}`,
                end: `${editable ? linkButton(person.id === viewer.user.id ? "Leave…" : "Remove…", `${screenHref(selected.id, "remove")}&person=${encodeURIComponent(person.id)}`, { kind: "quiet", danger: true, size: "sm", ariaLabel: `${person.id === viewer.user.id ? "Leave" : `Remove ${person.name} from`} ${selected.name}` }) : ""}`
              })
            ),
            true
          );
  const main = `${view.screen ? "" : problem(refused)}${members.length ? `<div class="toolbar">${searchField({ action: path, id: "roster-search", query: view.query, label: "Find people", placeholder: "Find a person", keep: { team: selected.id }, className: "grow" })}</div>` : ""}${rosterHtml}`;
  const page: Page = {
    title: selected.name,
    status,
    ...detailPage({
      title: selected.name,
      parent: { label: "Teams", href: path },
      mark: teamMark(),
      meta: [
        peopleCount(members.length),
        ...(inactiveCount ? [`${inactiveCount} deactivated`] : [])
      ],
      actions,
      main
    })
  };
  if (view.screen === "rename")
    return {
      ...page,
      overlay: dialog({
        id: "rename-team",
        title: "Rename team",
        closeHref: teamHref,
        form: { action: operation(selected.id, "rename") },
        body: problem(refused) + nameField(selected.name, draft),
        foot: cancel(teamHref) + button("Save name", { kind: "primary" })
      })
    };
  if (view.screen === "delete")
    return {
      ...page,
      overlay: dialog({
        id: "delete-team",
        title: `Delete ${selected.name}?`,
        closeHref: teamHref,
        form: { action: operation(selected.id, "delete") },
        body: `${problem(refused)}<p class="prose">Its memberships go with it.</p>`,
        foot: cancel(teamHref, !refused) + button("Delete team", { kind: "danger-solid" })
      })
    };
  if (view.screen === "remove") {
    const person = members.find((person) => person.id === view.personId);
    if (!person)
      return yield* new Users.UserNotFound({ companyId: ref.companyId, userId: view.personId });
    const self = person.id === viewer.user.id;
    return {
      ...page,
      overlay: dialog({
        id: "remove-person",
        title: self ? `Leave ${selected.name}?` : `Remove ${person.name} from ${selected.name}?`,
        closeHref: teamHref,
        form: { action: operation(selected.id, "remove"), fields: hidden("userId", person.id) },
        body: `${problem(refused)}${rows([row({ lead: avatar(person.id, person.name), name: person.name, description: person.email })], true)}<p class="prose">${self ? "You’ll" : `${escapeHtml(person.name)} will`} lose access granted by this team.</p>`,
        foot:
          cancel(teamHref, !refused) +
          button(self ? "Leave team" : "Remove person", { kind: "danger-solid" })
      })
    };
  }
  return page;
});

/** Plain session forms preserve existing Teams operations and atomic authority checks. */
export const handle = Effect.fn("TeamsPage.handle")(function* (viewer: Viewer, action: Action) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, "http://page.local");
  const asked = url.searchParams.get("view");
  const view: View = {
    teamId: url.searchParams.get("team") ?? "",
    screen: screens.find((screen) => screen === asked),
    query: (url.searchParams.get("q") ?? "").slice(0, 200),
    personId: url.searchParams.get("person") ?? "",
    selected: url.searchParams.getAll("userId")
  };
  const ref = { companyId: viewer.company.id, actorId: viewer.user.id };
  return yield* Effect.gen(function* () {
    if (action === "view") return yield* render(viewer, view);
    if (viewer.role !== "admin") return yield* new Users.RoleForbidden(ref);
    const teams = yield* Teams.Teams;
    const form = yield* request.urlParamsBody;
    const target = { ...ref, teamId: view.teamId };
    if (action === "create" || action === "rename") {
      const { name } = yield* decodeName(Object.fromEntries(form));
      return yield* Effect.gen(function* () {
        const team =
          action === "create"
            ? yield* teams.create({ ...ref, name })
            : yield* teams.rename({ ...target, name });
        return {
          title: "Teams",
          body: "",
          redirect: address(team.id),
          receipt: action === "create" ? "Team created." : "Team name saved."
        } satisfies Page;
      }).pipe(
        Effect.catchTags({
          TeamNameTaken: (error) =>
            render(
              viewer,
              { ...view, teamId: action === "create" ? "" : view.teamId, screen: action },
              { name, error: error.message, status: 409 }
            ),
          InvalidTeamName: (error) =>
            render(
              viewer,
              { ...view, teamId: action === "create" ? "" : view.teamId, screen: action },
              { name, error: error.message, status: 400 }
            )
        })
      );
    }
    if (action === "delete") {
      return yield* teams.remove(target).pipe(
        Effect.map(
          () =>
            ({ title: "Teams", body: "", redirect: path, receipt: "Team deleted." }) satisfies Page
        ),
        Effect.catchTags({
          TeamInUse: () =>
            Effect.gen(function* () {
              const uses = yield* Uses;
              return yield* render(viewer, { ...view, screen: "delete" }, undefined, {
                message: inUse(uses === undefined ? undefined : yield* uses(target)),
                status: 409
              });
            })
        })
      );
    }
    if (action === "remove") {
      const { userId } = yield* decodePerson(Object.fromEntries(form));
      yield* teams.setMemberships({ ...target, userIds: [userId], added: false });
    } else {
      const userIds = UrlParams.getAll(form, "userId");
      if (!userIds.length)
        return yield* render(viewer, { ...view, screen: "add" }, undefined, {
          message: "Choose at least one person to add.",
          status: 400
        });
      return yield* teams.setMemberships({ ...target, userIds, added: true }).pipe(
        Effect.map(
          () =>
            ({
              title: "Teams",
              body: "",
              redirect: address(view.teamId),
              receipt: "People added."
            }) satisfies Page
        ),
        Effect.catchTags({
          UserNotFound: () =>
            render(viewer, { ...view, screen: "add", selected: userIds }, undefined, {
              message: "Someone selected is no longer active. No memberships changed.",
              status: 409
            })
        })
      );
    }
    return {
      title: "Teams",
      body: "",
      redirect: address(view.teamId),
      receipt: "Team membership saved."
    } satisfies Page;
  }).pipe(
    Effect.catchTags({
      RoleForbidden: () =>
        Effect.succeed(
          failurePage(
            "Teams",
            "You no longer have permission to change this team. Nothing changed.",
            403
          )
        ),
      TeamNotFound: () =>
        Effect.succeed(failurePage("Team not found", "This team is unavailable.", 404)),
      UserNotFound: () =>
        Effect.succeed(
          failurePage(
            "Person unavailable",
            "That person is no longer in this team. Nothing changed.",
            409
          )
        ),
      SchemaError: () =>
        Effect.succeed(
          failurePage(
            "Invalid form",
            "Check the submitted fields and try again. Nothing changed.",
            400
          )
        )
    })
  );
});
