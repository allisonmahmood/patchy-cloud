import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as UrlParams from "effect/http/UrlParams";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import {
  escapeHtml,
  escapeAttribute,
  avatar,
  rowMenu,
  menuLink,
  searchField,
  indexPage,
  button,
  linkButton,
  field,
  input,
  notice,
  checkbox,
  row,
  rows
} from "@patchy/core";
import * as Teams from "./Teams.js";
import * as Users from "./Users.js";
import { RoleForbidden } from "./Users.js";

export const path = "/settings/company/teams";
const NameForm = Schema.Struct({ name: Schema.String });
const PersonForm = Schema.Struct({ userId: Schema.String });
const decodeName = Schema.decodeUnknownEffect(NameForm);
const decodePerson = Schema.decodeUnknownEffect(PersonForm);
export type Action = "view" | "create" | "rename" | "add" | "remove" | "delete" | "restore";
interface Viewer {
  readonly company: { readonly id: string };
  readonly user: { readonly id: string };
  readonly role: Users.Role;
}
const address = (id: string) => `${path}?team=${encodeURIComponent(id)}`;
interface NameDraft {
  readonly name: string;
  readonly problem: string;
  readonly status: number;
}
const roleLabel = { member: "Member", admin: "Admin", super_admin: "Super admin" } satisfies Record<
  Users.Role,
  string
>;
const link = (href: string, label: string, primary = false) =>
  linkButton(label, href, { kind: primary ? "primary" : "secondary" });
const back = (href: string, label = "Teams") =>
  `<p><a href="${escapeAttribute(href)}">← ${escapeHtml(label)}</a></p>`;
const actions = (submit: string, cancel: string) =>
  `<div class="btn-group">${submit}${link(cancel, "Cancel")}</div>`;
const nameForm = (action: string, label: string, cancel: string, name = "", problem?: string) =>
  `<form class="stack" method="post" action="${escapeAttribute(action)}" novalidate>${field({ id: "team-name", label: "Team name", ...(problem ? { error: problem } : {}), control: (aria) => input(aria, { name: "name", value: name, required: true, maxlength: 200, autofocus: problem !== undefined }) })}${actions(button(label, { kind: "primary" }), cancel)}</form>`;

/** One directory or one focused task; writes still go through Teams' current authority checks. */
const render = Effect.fn("TeamsPage.render")(function* (
  viewer: Viewer,
  selectedId: string,
  draft?: NameDraft,
  deletedView = false,
  confirmation = "",
  query = "",
  personId = ""
) {
  const users = yield* Users.Users;
  const teams = yield* Teams.Teams;
  const ref = { companyId: viewer.company.id, actorId: viewer.user.id };
  const editable = viewer.role !== "member";
  const page = (title: string, body: string, status = draft?.status) => ({
    title,
    ...indexPage({ title, content: body }),
    status
  });
  if (confirmation === "create") {
    if (!editable) return yield* new RoleForbidden(ref);
    return page(
      "Create team",
      `<section class="stack">${back(path)}${nameForm(`${path}/create`, "Create team", path, draft?.name, draft?.problem)}</section>`
    );
  }
  if (deletedView && !editable) return yield* new RoleForbidden(ref);
  const all = yield* deletedView ? teams.deleted(ref) : teams.list(ref);
  const selected = all.find((team) => team.id === selectedId);
  if (selectedId && !selected) return yield* new Teams.TeamNotFound({ teamId: selectedId });
  const directoryPath = deletedView ? `${path}?deleted=1` : path;
  const matches = (value: string) => value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  if (!selected) {
    const filtered = all.filter((team) => matches(team.name));
    const search = searchField({
      action: path,
      id: "search",
      query,
      placeholder: "Find a team",
      label: "Find a team",
      keep: deletedView ? { deleted: "1" } : {},
      className: "search"
    });
    return page(
      deletedView ? "Deleted teams" : "Teams",
      `${deletedView ? back(path) : ""}<div class="cluster">${editable && !deletedView ? link(`${path}?view=create`, "Create team", true) : ""}</div>${all.length ? `<div class="cluster">${search}</div><nav aria-label="Teams">${rows(filtered.map((team) => row({ name: team.name, href: deletedView ? `${address(team.id)}&deleted=1&confirm=restore` : address(team.id) })))}</nav>${filtered.length ? "" : '<p role="status">No teams match your search.</p>'}` : `<p class="meta">${deletedView ? "No deleted teams." : "No teams yet."}</p>`}${editable && !deletedView ? `<p><a href="${path}?deleted=1">Deleted teams</a></p>` : ""}`
    );
  }
  const teamPath = address(selected.id);
  const operation = (name: string) => `${path}/${name}?team=${encodeURIComponent(selected.id)}`;
  const view = (name: string) => `${teamPath}&view=${name}`;
  if (confirmation && !editable) return yield* new RoleForbidden(ref);
  // A deleted team has only a restore door, never a live roster or membership controls.
  if (deletedView && confirmation !== "restore")
    return page(
      "Deleted teams",
      `${back(directoryPath, "Deleted teams")}${link(`${teamPath}&deleted=1&confirm=restore`, "Restore team", true)}`
    );
  if (confirmation === "rename") {
    return page(
      "Rename team",
      `<section class="stack">${back(teamPath, selected.name)}${nameForm(operation("rename"), "Save name", teamPath, draft?.name ?? selected.name, draft?.problem)}</section>`
    );
  }
  if (confirmation === "delete" || confirmation === "restore") {
    const restoring = confirmation === "restore";
    const label = restoring ? "Restore team" : "Delete team";
    return page(
      `${restoring ? "Restore" : "Delete"} ${selected.name}?`,
      `<section class="stack">${back(restoring ? directoryPath : teamPath, restoring ? "Deleted teams" : selected.name)}<form class="stack" method="post" action="${escapeAttribute(operation(restoring ? "restore" : "delete"))}"><p class="prose">${restoring ? "The team and its recorded memberships will return." : "Memberships will be kept for restoration. Patches and connections must no longer reference this team."}</p>${actions(button(label, { kind: restoring ? "primary" : "danger-solid" }), restoring ? directoryPath : teamPath)}</form></section>`
    );
  }
  const people = yield* users.list(ref.companyId);
  const ids = new Set(yield* teams.members({ ...ref, teamId: selected.id }));
  const members = people.filter((person) => ids.has(person.id));
  if (confirmation === "remove") {
    const person = members.find((person) => person.id === personId);
    if (!person)
      return yield* new Users.UserNotFound({ companyId: ref.companyId, userId: personId });
    if (!Teams.canRemoveMembership({ id: viewer.user.id, role: viewer.role }, person))
      return yield* new RoleForbidden(ref);
    return page(
      "Remove person",
      `<section class="stack">${back(teamPath, selected.name)}<form class="stack" method="post" action="${escapeAttribute(operation("remove"))}"><input type="hidden" name="userId" value="${escapeAttribute(person.id)}"><p class="prose">Access granted by this team will be removed.</p>${actions(button("Remove person", { kind: "danger-solid" }), teamPath)}</form></section>`
    );
  }
  const search = searchField({
    action: path,
    id: "team-people-search",
    query,
    placeholder:
      confirmation === "add" ? "Search people by name or email" : "Find someone in this team",
    label: "Find people",
    keep: { team: selected.id, ...(confirmation === "add" ? { view: "add" } : {}) },
    className: "search"
  });
  if (confirmation === "add") {
    const filtered = people.filter((person) => matches(`${person.name} ${person.email}`));
    return page(
      "Add people",
      `<section class="stack">${back(teamPath, selected.name)}${search}<form method="post" action="${escapeAttribute(operation("add"))}"><div class="stack">${
        filtered
          .map((person) => {
            const member = ids.has(person.id);
            const inactive = person.deactivatedAt !== null;
            return checkbox({
              name: "userId",
              value: person.id,
              label: `${person.name} · ${person.email}${inactive ? " · Deactivated" : member ? " · Already in team" : ""}`,
              checked: member,
              disabled: member || inactive
            });
          })
          .join("") || '<p role="status">No people match your search.</p>'
      }</div>${actions(button("Add selected people", { kind: "primary" }), teamPath)}</form></section>`
    );
  }
  const filtered = members.filter((person) => matches(`${person.name} ${person.email}`));
  const join =
    editable && !ids.has(viewer.user.id)
      ? `<form method="post" action="${escapeAttribute(operation("add"))}"><input type="hidden" name="userId" value="${escapeAttribute(viewer.user.id)}">${button("Join team")}</form>`
      : "";
  const roster = rows(
    filtered.map((person) =>
      row({
        lead: avatar(person.id, person.name),
        name: person.name + (person.id === viewer.user.id ? " (you)" : ""),
        description: person.deactivatedAt ? "Deactivated" : roleLabel[person.role],
        end: Teams.canRemoveMembership({ id: viewer.user.id, role: viewer.role }, person)
          ? rowMenu(person.id, person.name, [
              menuLink(
                `${view("remove")}&person=${encodeURIComponent(person.id)}`,
                person.id === viewer.user.id ? "Leave team…" : "Remove from team…",
                true
              )
            ])
          : ""
      })
    )
  );
  return {
    title: selected.name,
    ...indexPage({
      title: selected.name,
      meta: [`${members.length} ${members.length === 1 ? "person" : "people"}`],
      actions: `${editable ? link(view("add"), "Add people", true) : ""}${join}${editable ? rowMenu("team", selected.name, [menuLink(view("rename"), "Rename team"), menuLink(`${teamPath}&confirm=delete`, "Delete team…", true)]) : ""}`,
      toolbar: members.length ? search : undefined,
      content: `${back(path)}${members.length ? roster + (filtered.length ? "" : '<p role="status">No people match your search.</p>') : '<p class="meta">No people in this team.</p>'}`
    }),
    status: draft?.status
  };
});

/** Plain session forms; Teams owns current authority checks and transactional membership edits. */
export const handle = Effect.fn("TeamsPage.handle")(function* (viewer: Viewer, action: Action) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, "http://page.local");
  const selectedId = url.searchParams.get("team") ?? "";
  const ref = { companyId: viewer.company.id, actorId: viewer.user.id };
  return yield* Effect.gen(function* () {
    if (action !== "view") {
      if (viewer.role === "member") return yield* new RoleForbidden(ref);
      const form = yield* request.urlParamsBody;
      const target = { ...ref, teamId: selectedId };
      if (action === "create" || action === "rename") {
        const { name } = yield* decodeName(Object.fromEntries(form));
        return yield* Effect.gen(function* () {
          const team =
            action === "create"
              ? yield* (yield* Teams.Teams).create({ ...ref, name })
              : yield* (yield* Teams.Teams).rename({ ...target, name });
          return {
            title: "Teams",
            body: "",
            redirect: address(team.id),
            receipt: action === "create" ? "Team created." : "Team name saved."
          };
        }).pipe(
          Effect.catchTags({
            TeamNameTaken: (error) =>
              render(
                viewer,
                selectedId,
                {
                  name,
                  problem: error.message,
                  status: 409
                },
                false,
                action
              ),
            InvalidTeamName: (error) =>
              render(
                viewer,
                selectedId,
                {
                  name,
                  problem: error.message,
                  status: 400
                },
                false,
                action
              )
          })
        );
      }
      if (action === "delete" || action === "restore") {
        yield* (yield* Teams.Teams).setDeleted({ ...target, deleted: action === "delete" });
        return {
          title: "Teams",
          body: "",
          redirect: action === "delete" ? `${path}?deleted=1` : address(selectedId),
          receipt: action === "delete" ? "Team deleted." : "Team restored."
        };
      }
      if (action === "remove") {
        const { userId } = yield* decodePerson(Object.fromEntries(form));
        yield* (yield* Teams.Teams).setMemberships({ ...target, userIds: [userId], added: false });
      } else {
        const ids = UrlParams.getAll(form, "userId");
        yield* (yield* Teams.Teams).setMemberships({ ...target, userIds: ids, added: true });
      }
      return {
        title: "Teams",
        body: "",
        redirect: address(selectedId),
        receipt: "Team membership saved."
      };
    }
    return yield* render(
      viewer,
      selectedId,
      undefined,
      url.searchParams.get("deleted") === "1",
      url.searchParams.get("view") ?? url.searchParams.get("confirm") ?? "",
      (url.searchParams.get("q") ?? "").slice(0, 200),
      url.searchParams.get("person") ?? ""
    );
  }).pipe(
    Effect.catchTags({
      TeamInUse: (error) =>
        Effect.succeed({
          title: "Team is in use",
          body: `${notice({ tone: "danger", title: error.message })}${link(address(selectedId), "Back to team")}`,
          status: 409
        }),
      RoleForbidden: () =>
        Effect.succeed({
          title: "Teams",
          body: notice({
            tone: "danger",
            title: "You no longer have permission to change this team. Nothing changed."
          }),
          status: 403
        }),
      TeamNotFound: () =>
        Effect.succeed({
          title: "Team not found",
          body: `<a href="${path}">Back to Teams</a>`,
          status: 404
        }),
      UserNotFound: () =>
        Effect.succeed({
          title: "Teams",
          body: `${notice({ tone: "danger", title: `That person is no longer active in this company. Nothing changed.` })}<a href="${path}">Back to Teams</a>`,
          status: 409
        }),
      SchemaError: () =>
        Effect.succeed({
          title: "Invalid form",
          body: `<a href="${path}">Back to Teams</a>`,
          status: 400
        })
    })
  );
});
