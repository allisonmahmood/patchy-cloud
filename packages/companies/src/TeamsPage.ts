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
  row,
  rows,
  searchField,
  segmented
} from "@patchy/core";
import type { Page } from "./CompanyPage.js";
import * as Teams from "./Teams.js";
import * as Users from "./Users.js";

export const path = "/settings/company/teams";
const NameForm = Schema.Struct({ name: Schema.String });
const PersonForm = Schema.Struct({ userId: Schema.String });
const decodeName = Schema.decodeUnknownEffect(NameForm);
const decodePerson = Schema.decodeUnknownEffect(PersonForm);
const screens = ["create", "rename", "add", "remove", "delete", "restore"] as const;
type Screen = (typeof screens)[number];
export type Action = "view" | Screen;
interface Viewer {
  readonly company: { readonly id: string };
  readonly user: { readonly id: string };
  readonly role: Users.Role;
}
interface View {
  readonly teamId: string;
  readonly deleted: boolean;
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
const roleLabel = { member: "Member", admin: "Admin", super_admin: "Super admin" } satisfies Record<
  Users.Role,
  string
>;
const address = (id: string) => `${path}?team=${encodeURIComponent(id)}`;
const operation = (id: string, action: Screen) =>
  `${path}/${action}?team=${encodeURIComponent(id)}`;
const screenHref = (id: string, screen: Screen) => `${address(id)}&view=${screen}`;
const peopleCount = (count: number) => `${count} ${count === 1 ? "person" : "people"}`;
const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}">`;
const problem = (refused?: Refusal) =>
  refused ? notice({ tone: "danger", title: refused.message }) : "";
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
  const editable = viewer.role !== "member";
  if (!editable && (view.deleted || view.screen)) return yield* new Users.RoleForbidden(ref);
  const all = yield* view.deleted ? teams.deleted(ref) : teams.list(ref);
  const selected = all.find((team) => team.id === view.teamId);
  if (view.teamId && !selected) return yield* new Teams.TeamNotFound({ teamId: view.teamId });
  const query = view.query.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(query);
  const directoryHref = view.deleted ? `${path}?deleted=1` : path;
  const status = draft?.status ?? refused?.status;
  if (!selected) {
    // One batched read supplies recorded counts, including inactive members, without one query per team.
    const people = all.length && !view.deleted ? yield* users.list(ref.companyId) : [];
    const memberships = people.length
      ? yield* teams.people(
          ref.companyId,
          people.map((person) => person.id)
        )
      : [];
    const counts = new Map<string, number>();
    for (const person of memberships)
      for (const teamId of person.teamIds) counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
    const filtered = all.filter((team) => matches(team.name));
    const create =
      editable && !view.deleted
        ? linkButton("Create team", `${path}?view=create`, { kind: "primary", icon: "plus" })
        : "";
    const content =
      all.length === 0
        ? emptyState({
            title: view.deleted
              ? "No deleted teams"
              : editable
                ? "No teams yet"
                : "You’re not in a team",
            ...(create ? { action: create } : {})
          })
        : filtered.length === 0
          ? emptyState({
              title: "No teams match your search",
              action: linkButton("Clear search", directoryHref)
            })
          : rows(
              filtered.map((team) => {
                const href = view.deleted
                  ? `${address(team.id)}&deleted=1&view=restore`
                  : address(team.id);
                return row({
                  lead: teamMark(),
                  name: team.name,
                  description: view.deleted
                    ? "Memberships kept for restoration"
                    : peopleCount(counts.get(team.id) ?? 0),
                  href,
                  end: linkButton(view.deleted ? "Restore…" : editable ? "Manage" : "View", href, {
                    size: "sm",
                    ariaLabel: `${view.deleted ? "Restore" : editable ? "Manage" : "View"} ${team.name}`
                  })
                });
              }),
              true
            );
    const title = "Teams";
    const page: Page = {
      title,
      status,
      ...indexPage({
        title,
        meta: [
          view.deleted
            ? `${all.length} deleted ${all.length === 1 ? "team" : "teams"}`
            : `${all.length} ${all.length === 1 ? "team" : "teams"}`
        ],
        ...(all.length && create ? { actions: create } : {}),
        toolbar: `${
          editable
            ? segmented({
                label: "Team status",
                current: view.deleted ? "Deleted" : "Active",
                items: [
                  { label: "Active", href: path },
                  { label: "Deleted", href: `${path}?deleted=1` }
                ]
              })
            : ""
        }${all.length ? searchField({ action: path, id: "teams-search", query: view.query, placeholder: "Find a team", label: "Find a team", keep: view.deleted ? { deleted: "1" } : {}, className: "grow" }) : ""}`,
        content: problem(refused) + content
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
  if (view.deleted) {
    const behind = yield* render(
      viewer,
      { ...view, teamId: "", screen: undefined },
      undefined,
      undefined
    );
    return {
      ...behind,
      status,
      overlay: dialog({
        id: "restore-team",
        title: `Restore ${selected.name}?`,
        closeHref: directoryHref,
        form: { action: operation(selected.id, "restore") },
        body: `${problem(refused)}<p class="prose">The team and its recorded memberships will return.</p>`,
        foot: cancel(directoryHref, true) + button("Restore team", { kind: "primary" })
      })
    };
  }
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
    const selectedNames = [...picked].map((id) => people.find((person) => person.id === id)!.name);
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
      ? emptyState({
          title: "No people in this team",
          ...(editable
            ? {
                action: linkButton("Add people", screenHref(selected.id, "add"), {
                  kind: "primary"
                })
              }
            : {})
        })
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
                end: `${Teams.canRemoveMembership({ id: viewer.user.id, role: viewer.role }, person) ? linkButton(person.id === viewer.user.id ? "Leave…" : "Remove…", `${screenHref(selected.id, "remove")}&person=${encodeURIComponent(person.id)}`, { kind: "quiet", size: "sm", ariaLabel: `${person.id === viewer.user.id ? "Leave" : `Remove ${person.name} from`} ${selected.name}` }) : ""}`
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
        body: `${problem(refused)}<p class="prose">Memberships are kept for restoration. A team used by a patch or connection can’t be deleted.</p>`,
        foot: cancel(teamHref, true) + button("Delete team", { kind: "danger-solid" })
      })
    };
  if (view.screen === "remove") {
    const person = members.find((person) => person.id === view.personId);
    if (!person)
      return yield* new Users.UserNotFound({ companyId: ref.companyId, userId: view.personId });
    if (!Teams.canRemoveMembership({ id: viewer.user.id, role: viewer.role }, person))
      return yield* new Users.RoleForbidden(ref);
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
          cancel(teamHref, true) +
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
  const asked = url.searchParams.get("view") ?? url.searchParams.get("confirm");
  const view: View = {
    teamId: url.searchParams.get("team") ?? "",
    deleted: url.searchParams.get("deleted") === "1",
    screen: screens.find((screen) => screen === asked),
    query: (url.searchParams.get("q") ?? "").slice(0, 200),
    personId: url.searchParams.get("person") ?? "",
    selected: url.searchParams.getAll("userId")
  };
  const ref = { companyId: viewer.company.id, actorId: viewer.user.id };
  return yield* Effect.gen(function* () {
    if (action === "view") return yield* render(viewer, view);
    if (viewer.role === "member") return yield* new Users.RoleForbidden(ref);
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
    if (action === "delete" || action === "restore") {
      return yield* teams.setDeleted({ ...target, deleted: action === "delete" }).pipe(
        Effect.map(
          () =>
            ({
              title: "Teams",
              body: "",
              redirect: action === "delete" ? `${path}?deleted=1` : address(view.teamId),
              receipt: action === "delete" ? "Team deleted." : "Team restored."
            }) satisfies Page
        ),
        Effect.catchTags({
          TeamInUse: (error) =>
            render(viewer, { ...view, screen: "delete" }, undefined, {
              message: error.message,
              status: 409
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
