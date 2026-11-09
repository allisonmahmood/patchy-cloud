import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as UrlParams from "effect/http/UrlParams";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";
import { escapeHtml, escapeAttribute, avatar } from "@patchy/core";
import * as Teams from "./Teams.js";
import * as Users from "./Users.js";
import { RoleForbidden } from "./Users.js";

export const path = "/settings/company/teams";
export const styles = `
  .teams-layout { display: grid; grid-template-columns: minmax(160px, 240px) minmax(0, 1fr); gap: 32px; margin-top: 24px; }
  .teams-heading, .teams-person { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .teams-person-name { display: flex; align-items: center; gap: 12px; }
  .teams-form { margin-block: 16px; }
  .teams-form .field { margin-block: 8px; }
  .teams-picker { max-height: 320px; overflow-y: auto; margin-block: 16px; }
  @media (max-width: 640px) { .teams-layout { grid-template-columns: 1fr; } }
`;
const NameForm = Schema.Struct({ name: Schema.String });
const PersonForm = Schema.Struct({ userId: Schema.String });
const decodeName = Schema.decodeUnknownEffect(NameForm);
const decodePerson = Schema.decodeUnknownEffect(PersonForm);
export type Action = "view" | "create" | "rename" | "add" | "remove";
interface Viewer {
  readonly company: { readonly id: string };
  readonly user: { readonly id: string };
  readonly role: Users.Role;
}
const address = (id: string) => `${path}?team=${encodeURIComponent(id)}`;
const nameForm = (action: string, label: string, name = "") =>
  `<form class="teams-form" method="post" action="${escapeAttribute(action)}"><label class="field-label" for="team-name-${label.replaceAll(" ", "-")}">Name</label><input class="field" id="team-name-${label.replaceAll(" ", "-")}" name="name" value="${escapeAttribute(name)}" required maxlength="200"><button class="btn btn-primary" type="submit">${label}</button></form>`;

/** Plain session forms; the service reloads authority inside every write transaction. */
export const handle = Effect.fn("TeamsPage.handle")(function* (viewer: Viewer, action: Action) {
  const teams = yield* Teams.Teams;
  const users = yield* Users.Users;
  const sql = yield* SqlClient.SqlClient;
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
        const team =
          action === "create"
            ? yield* teams.create({ ...ref, name })
            : yield* teams.rename({ ...target, name });
        return {
          title: "Teams",
          body: "",
          redirect: address(team.id),
          receipt: action === "create" ? "Team created." : "Team name saved."
        };
      }
      if (action === "remove") {
        const { userId } = yield* decodePerson(Object.fromEntries(form));
        yield* teams.setMembership({ ...target, userId, added: false });
      } else {
        const ids = UrlParams.getAll(form, "userId");
        // One submit is atomic, including a stale choice which became inactive.
        yield* sql.withTransaction(
          Effect.forEach(ids, (userId) => teams.setMembership({ ...target, userId, added: true }), {
            discard: true
          })
        );
      }
      return {
        title: "Teams",
        body: "",
        redirect: address(selectedId),
        receipt: "Team membership saved."
      };
    }
    const all = yield* teams.list(ref);
    const selected = selectedId ? all.find((team) => team.id === selectedId) : all[0];
    if (selectedId && !selected)
      return { title: "Team not found", body: `<a href="${path}">Back to Teams</a>`, status: 404 };
    const editable = viewer.role !== "member";
    const people = (yield* users.list(ref.companyId)).filter(
      (person) => person.deactivatedAt === null
    );
    const ids = selected
      ? new Set(yield* teams.members({ ...ref, teamId: selected.id }))
      : new Set<string>();
    const heading = `<nav class="tabs" aria-label="Company settings"><a class="tab" href="/settings/company">Company</a><a class="tab" href="/company">People</a><a class="tab" href="${path}" aria-current="page">Teams</a></nav>`;
    const create = editable
      ? `<details class="teams-form"><summary class="btn">Create team</summary>${nameForm(`${path}/create`, "Create team")}</details>`
      : "";
    const directory = `<nav class="list" aria-label="Teams">${all.map((team) => `<a class="list-row list-link" href="${escapeAttribute(address(team.id))}"${team.id === selected?.id ? ' aria-current="page"' : ""}>${escapeHtml(team.name)}</a>`).join("")}</nav>`;
    let detail = `<p>No teams yet.</p>`;
    if (selected) {
      const base = `${path}/`;
      const query = `?team=${encodeURIComponent(selected.id)}`;
      const members = people.filter((person) => ids.has(person.id));
      const candidates = people.filter((person) => !ids.has(person.id));
      const rename = editable
        ? `<details class="teams-form"><summary class="btn btn-quiet">Rename</summary>${nameForm(`${base}rename${query}`, "Save name", selected.name)}</details>`
        : "";
      const add =
        editable && candidates.length > 0
          ? `<details class="teams-form"><summary class="btn">Add people</summary><form method="post" action="${escapeAttribute(`${base}add${query}`)}"><div class="teams-picker">${candidates.map((person) => `<label class="field-choice"><input class="field-checkbox" type="checkbox" name="userId" value="${escapeAttribute(person.id)}">${escapeHtml(person.name)}${person.id === viewer.user.id ? ' <span class="tag">You</span>' : ""}</label>`).join("")}</div><button class="btn btn-primary" type="submit">Add selected people</button></form></details>`
          : "";
      detail = `<section aria-label="${escapeAttribute(selected.name)}"><div class="teams-heading"><h2>${escapeHtml(selected.name)}</h2><span class="supporting-text">${members.length} ${members.length === 1 ? "person" : "people"}</span></div>${rename}${add}<div class="list">${members.length ? members.map((person) => `<div class="list-row teams-person"><div class="teams-person-name">${avatar(person.id, person.name)}<span>${escapeHtml(person.name)}${person.id === viewer.user.id ? ' <span class="tag">You</span>' : ""}</span></div>${editable ? `<form method="post" action="${escapeAttribute(`${base}remove${query}`)}"><input type="hidden" name="userId" value="${escapeAttribute(person.id)}"><button class="btn btn-quiet" type="submit" aria-label="Remove ${escapeAttribute(person.name)} from ${escapeAttribute(selected.name)}">Remove</button></form>` : ""}</div>`).join("") : "<p>No people yet.</p>"}</div></section>`;
    }
    return {
      title: "Teams",
      body: `${heading}${create}<div class="teams-layout">${directory}${detail}</div>`
    };
  }).pipe(
    Effect.catchTags({
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
      TeamNameTaken: (error) =>
        Effect.succeed({
          title: "Teams",
          body: `<p class="note note-refused" role="alert">${escapeHtml(error.message)}</p><a href="${path}">Back to Teams</a>`,
          status: 409
        }),
      InvalidTeamName: (error) =>
        Effect.succeed({
          title: "Teams",
          body: `<p class="note note-refused" role="alert">${escapeHtml(error.message)}</p><a href="${path}">Back to Teams</a>`,
          status: 400
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
