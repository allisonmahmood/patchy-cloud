import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as UrlParams from "effect/http/UrlParams";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { escapeHtml, escapeAttribute, avatar, rowMenu, menuLink, searchField } from "@patchy/core";
import * as Teams from "./Teams.js";
import * as Users from "./Users.js";
import { RoleForbidden } from "./Users.js";

export const path = "/settings/company/teams";
/** Teams owns geometry; the app shell owns the visual components. */
export const styles = `
  .teams-toolbar, .teams-person, .teams-person-name { display: flex; align-items: center; gap: 12px; }
  .teams-toolbar { flex-wrap: wrap; justify-content: space-between; margin-block: 20px; }
  .teams-toolbar .page-heading { margin: 0; }
  .teams-search { flex: 1; max-width: 420px; }
  .teams-person { justify-content: space-between; }
  .teams-person-name { min-width: 0; }
  .teams-person-name > div { min-width: 0; }
  .teams-subpage { max-width: 760px; }
  .teams-form .field { margin-block: 8px 20px; }
  .teams-picker { max-height: 440px; overflow-y: auto; margin-block: 20px; }
  .teams-picker .field-choice { align-items: center; }
  .teams-picker-name { flex: 1; min-width: 0; }
  .teams-directory .list-link { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .teams-empty { margin-block: 40px; }
  @media (max-width: 640px) { .teams-search { flex-basis: 100%; max-width: none; } }
`;
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
  `<a class="btn${primary ? " btn-primary" : ""}" href="${escapeAttribute(href)}">${escapeHtml(label)}</a>`;
const back = (href: string, label = "Teams") =>
  `<p><a href="${escapeAttribute(href)}">← ${escapeHtml(label)}</a></p>`;
const actions = (submit: string, cancel: string) =>
  `<div class="confirmation-actions">${submit}${link(cancel, "Cancel")}</div>`;
const nameForm = (action: string, label: string, cancel: string, name = "", problem?: string) =>
  `<form class="teams-form confirmation-form" method="post" action="${escapeAttribute(action)}" novalidate><label class="field-label" for="team-name">Team name</label><input class="field" id="team-name" name="name" value="${escapeAttribute(name)}" required maxlength="200"${problem ? ' aria-invalid="true" aria-describedby="team-name-error" autofocus' : ""}>${problem ? `<p class="note note-refused" id="team-name-error" role="alert">${escapeHtml(problem)}</p>` : ""}${actions(`<button class="btn btn-primary" type="submit">${label}</button>`, cancel)}</form>`;

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
    heading: "",
    body,
    status
  });
  const title = (text: string) => `<h1 class="page-heading">${escapeHtml(text)}</h1>`;
  if (confirmation === "create") {
    if (!editable) return yield* new RoleForbidden(ref);
    return page(
      "Create team",
      `<section class="teams-subpage">${back(path)}${title("Create team")}${nameForm(`${path}/create`, "Create team", path, draft?.name, draft?.problem)}</section>`
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
      id: "teams-search",
      query,
      placeholder: "Find a team",
      label: "Find a team",
      keep: deletedView ? { deleted: "1" } : {},
      className: "teams-search"
    });
    return page(
      deletedView ? "Deleted teams" : "Teams",
      `${deletedView ? back(path) : ""}<div class="teams-toolbar">${title(deletedView ? "Deleted teams" : "Teams")}${editable && !deletedView ? link(`${path}?view=create`, "Create team", true) : ""}</div>${all.length ? `<div class="teams-toolbar">${search}</div><nav class="list teams-directory" aria-label="Teams">${filtered.map((team) => `<a class="list-row list-link" href="${escapeAttribute(deletedView ? `${address(team.id)}&deleted=1&confirm=restore` : address(team.id))}"><strong>${escapeHtml(team.name)}</strong><span aria-hidden="true">→</span></a>`).join("")}</nav>${filtered.length ? "" : '<p role="status">No teams match your search.</p>'}` : `<p class="teams-empty">${deletedView ? "No deleted teams." : "No teams yet."}</p>`}${editable && !deletedView ? `<p><a href="${path}?deleted=1">Deleted teams</a></p>` : ""}`
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
      `${back(directoryPath, "Deleted teams")}${title(selected.name)}${link(`${teamPath}&deleted=1&confirm=restore`, "Restore team", true)}`
    );
  if (confirmation === "rename") {
    return page(
      "Rename team",
      `<section class="teams-subpage">${back(teamPath, selected.name)}${title("Rename team")}${nameForm(operation("rename"), "Save name", teamPath, draft?.name ?? selected.name, draft?.problem)}</section>`
    );
  }
  if (confirmation === "delete" || confirmation === "restore") {
    const restoring = confirmation === "restore";
    const label = restoring ? "Restore team" : "Delete team";
    return page(
      `${restoring ? "Restore" : "Delete"} ${selected.name}?`,
      `<section class="teams-subpage">${back(restoring ? directoryPath : teamPath, restoring ? "Deleted teams" : selected.name)}${title(`${restoring ? "Restore" : "Delete"} ${selected.name}?`)}<form class="confirmation-form" method="post" action="${escapeAttribute(operation(restoring ? "restore" : "delete"))}"><p class="confirmation-consequence">${restoring ? "The team and its recorded memberships will return." : "Memberships will be kept for restoration. Patches and connections must no longer reference this team."}</p>${actions(`<button class="btn ${restoring ? "btn-primary" : "btn-danger"}" type="submit">${label}</button>`, restoring ? directoryPath : teamPath)}</form></section>`
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
      `<section class="teams-subpage">${back(teamPath, selected.name)}${title(`${person.id === viewer.user.id ? "Leave" : `Remove ${person.name} from`} ${selected.name}?`)}<form class="confirmation-form" method="post" action="${escapeAttribute(operation("remove"))}"><input type="hidden" name="userId" value="${escapeAttribute(person.id)}"><p class="confirmation-consequence">Access granted by this team will be removed.</p>${actions('<button class="btn btn-danger" type="submit">Remove person</button>', teamPath)}</form></section>`
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
    className: "teams-search"
  });
  if (confirmation === "add") {
    const filtered = people.filter((person) => matches(`${person.name} ${person.email}`));
    return page(
      "Add people",
      `<section class="teams-subpage">${back(teamPath, selected.name)}${title(`Add people to ${selected.name}`)}${search}<form method="post" action="${escapeAttribute(operation("add"))}"><div class="teams-picker">${
        filtered
          .map((person) => {
            const member = ids.has(person.id);
            const inactive = person.deactivatedAt !== null;
            return `<label class="field-choice"><input class="field-checkbox" type="checkbox" name="userId" value="${escapeAttribute(person.id)}"${member ? " checked" : ""}${member || inactive ? " disabled" : ""}>${avatar(person.id, person.name)}<span class="teams-picker-name"><strong>${escapeHtml(person.name)}</strong><br><span class="supporting-text">${escapeHtml(person.email)}</span></span>${member || inactive ? `<span class="tag">${inactive ? "Deactivated" : "Already in team"}</span>` : ""}</label>`;
          })
          .join("") || '<p role="status">No people match your search.</p>'
      }</div>${actions('<button class="btn btn-primary" type="submit">Add selected people</button>', teamPath)}</form></section>`
    );
  }
  const filtered = members.filter((person) => matches(`${person.name} ${person.email}`));
  const join =
    editable && !ids.has(viewer.user.id)
      ? `<form method="post" action="${escapeAttribute(operation("add"))}"><input type="hidden" name="userId" value="${escapeAttribute(viewer.user.id)}"><button class="btn" type="submit">Join team</button></form>`
      : "";
  return page(
    selected.name,
    `${back(path)}<div class="teams-toolbar">${title(selected.name)}<div class="actions">${editable ? link(view("add"), "Add people", true) : ""}${join}${editable ? rowMenu("team", selected.name, [menuLink(view("rename"), "Rename team"), menuLink(`${teamPath}&confirm=delete`, "Delete team…", true)]) : ""}</div></div><p class="supporting-text">${members.length} ${members.length === 1 ? "person" : "people"}</p>${members.length ? `<div class="teams-toolbar">${search}</div><div class="list">${filtered.map((person) => `<div class="list-row teams-person"><div class="teams-person-name">${avatar(person.id, person.name)}<div><strong>${escapeHtml(person.name)}</strong>${person.id === viewer.user.id ? ' <span class="tag">You</span>' : ""}<br><span class="supporting-text">${person.deactivatedAt ? "Deactivated" : roleLabel[person.role]}</span></div></div>${Teams.canRemoveMembership({ id: viewer.user.id, role: viewer.role }, person) ? rowMenu(person.id, person.name, [menuLink(`${view("remove")}&person=${encodeURIComponent(person.id)}`, person.id === viewer.user.id ? "Leave team…" : "Remove from team…", true)]) : ""}</div>`).join("")}</div>${filtered.length ? "" : '<p role="status">No people match your search.</p>'}` : '<p class="teams-empty">No people in this team.</p>'}`
  );
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
          body: `<p class="note note-refused" role="alert">${escapeHtml(error.message)}</p><a class="btn" href="${escapeAttribute(address(selectedId))}">Back to team</a>`,
          status: 409
        }),
      RoleForbidden: () =>
        Effect.succeed({
          title: "Teams",
          body: '<p class="note note-refused" role="alert">You no longer have permission to change this team. Nothing changed.</p>',
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
          body: `<p class="note note-refused" role="alert">That person is no longer active in this company. Nothing changed.</p><a href="${path}">Back to Teams</a>`,
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
