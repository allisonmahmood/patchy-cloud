/**
 * Throwaway #1235 vertical slice. Only mounted with local dev personas; nothing
 * here changes production patch audiences. Teams and versions disappear on restart.
 */
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { PatchName } from "@patchy/api";
import { pageResponse, RequireSession, type Session } from "@patchy/auth";
import { Users } from "@patchy/companies";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import * as Schema from "effect/Schema";

export const root = "/dev/teams-access";
const teamsPath = `${root}/company/people/teams`;
const publishPath = `${root}/publish`;
const patchesPath = `${root}/patches`;

const shortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));
const command = HttpServerRequest.schemaBodyUrlParams(
  Schema.Union([
    Schema.Struct({ action: Schema.Literal("create"), name: shortText }),
    Schema.Struct({
      action: Schema.Literals(["add", "remove"]),
      user: Schema.String
    }),
    Schema.Struct({
      action: Schema.Literal("publish"),
      name: PatchName,
      title: shortText,
      text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
      audience: Schema.optionalKey(Schema.Literals(["company", "team"]))
    })
  ])
);

interface Patch {
  readonly name: string;
  readonly title: string;
  readonly text: string;
  readonly owner: string;
  readonly audience: "company" | "team";
  readonly version: number;
}
interface State {
  team: { readonly name: string; readonly members: Set<string> } | undefined;
  readonly patches: Map<string, Patch>;
}

/** One decision for the local list, direct-open, first publish and republish. No role/owner bypass. */
const canOpen = (state: State, audience: Patch["audience"], user: string) =>
  audience === "company" || state.team?.members.has(user) === true;

const input = (name: string, label: string, value = "") =>
  `<label class="field-label" for="${name}">${label}</label><input class="field" id="${name}" name="${name}" value="${escapeAttribute(value)}" required>`;
const post = (action: string, fields: string, label: string) =>
  `<form method="post" action="${root}"><input type="hidden" name="action" value="${action}">${fields}<div class="actions"><button class="btn btn-primary">${label}</button></div></form>`;

/** A fresh closure per server layer: no database migrations or durable audience state. */
export const layer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", Session.Session | Users.Users>
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const companies = new Map<string, State>();
    const handle = Effect.gen(function* () {
      const viewer = yield* RequireSession.Viewer;
      const request = yield* HttpServerRequest.HttpServerRequest;
      let state = companies.get(viewer.company.id);
      if (!state) {
        state = { team: undefined, patches: new Map() };
        companies.set(viewer.company.id, state);
      }
      const people = (yield* (yield* Users.Users).list(viewer.company.id)).filter(
        (person) => person.deactivatedAt === null
      );
      const personName = (id: string) => people.find((person) => person.id === id)?.name ?? id;
      const audienceName = (audience: Patch["audience"]) =>
        audience === "company" ? "Company" : (state.team?.name ?? "Team");
      const receipt = (patch: Patch) =>
        `<p role="status" class="note note-ok">${escapeHtml(patch.title)} published · Version ${patch.version}<br>Who can open: ${escapeHtml(audienceName(patch.audience))} — ${people
          .filter((person) => canOpen(state, patch.audience, person.id))
          .map((person) => escapeHtml(person.name))
          .join(", ")}</p>`;
      const page = (title: string, body: string, status = 200) =>
        pageResponse({
          title,
          status,
          app: { viewer, section: "people" },
          body: `<p class="note note-warn">Local teams prototype · State resets on server restart.</p><nav class="tabs"><a href="${teamsPath}">Company → People → Teams</a><a href="${patchesPath}">All patches</a><a href="${publishPath}">Publish</a><a href="/dev/sign-in?return=${patchesPath}">Switch person</a></nav>${body}`
        });
      const refused = (message: string, status = 403) =>
        page(
          "Request refused",
          `<p class="note note-refused" role="alert">${escapeHtml(message)}</p>`,
          status
        );
      const missing = () => refused("This patch is unavailable to you.", 404);
      const publishForm = (patch?: Patch) => {
        const audience = patch
          ? `<p>Who can open: ${escapeHtml(audienceName(patch.audience))}</p>`
          : `<fieldset><legend>Who can open?</legend><label class="field-choice"><input type="radio" name="audience" value="company" required> Company</label>${state.team ? `<label class="field-choice"><input type="radio" name="audience" value="team" required> ${escapeHtml(state.team.name)}</label>` : ""}</fieldset>`;
        return post(
          "publish",
          patch
            ? `<input type="hidden" name="name" value="${escapeAttribute(patch.name)}">${input("title", "Title", patch.title)}${input("text", "Page text", patch.text)}${audience}`
            : `${input("name", "Patch name", "review-room")}${input("title", "Title", "Review room")}${input("text", "Page text", "A quiet place to review this week's work.")}${audience}`,
          patch ? "Publish next version" : "Publish"
        );
      };

      if (request.method === "POST") {
        const parsed = yield* command.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(16_384)),
          Effect.result
        );
        if (parsed._tag === "Failure")
          return refused("Check the submitted fields and audience.", 400);
        const fields = parsed.success;
        if (fields.action !== "publish") {
          if (viewer.role !== "admin") return refused("Only an admin can manage teams.");
          if (fields.action === "create") {
            if (state.team) return refused("This prototype already has a team.", 409);
            if (!fields.name.trim()) return refused("Give the team a name.", 400);
            state.team = { name: fields.name.trim(), members: new Set() };
          } else {
            if (!state.team) return refused("Create a team first.", 400);
            if (!people.some((person) => person.id === fields.user))
              return refused("Choose an active company person.", 400);
            if (fields.action === "add") state.team.members.add(fields.user);
            else state.team.members.delete(fields.user);
          }
          // Render current membership in this response; no stale client-side permission cache.
        } else {
          const previous = state.patches.get(fields.name);
          if (previous) {
            if (!canOpen(state, previous.audience, viewer.user.id)) return missing();
            if (previous.owner !== viewer.user.id)
              return refused("Only the owner can publish this patch.");
            if (fields.audience !== undefined && fields.audience !== previous.audience)
              return refused("Later publishes retain the audience in this prototype.", 400);
          } else {
            if (fields.audience === undefined)
              return refused("Choose Company or a team before first publish.", 400);
            if (!canOpen(state, fields.audience, viewer.user.id))
              return refused("Join the selected team before first publish.");
          }
          const audience = previous?.audience ?? fields.audience;
          if (audience === undefined) return refused("Choose an audience.", 400);
          const patch: Patch = {
            name: fields.name,
            title: fields.title,
            text: fields.text,
            owner: previous?.owner ?? viewer.user.id,
            audience,
            version: (previous?.version ?? 0) + 1
          };
          // One synchronous commit publishes the version and audience together. No yield between check and commit.
          state.patches.set(patch.name, patch);
          return page(
            "Published",
            `${receipt(patch)}<a class="btn" href="${patchesPath}/${patch.name}">Open ${escapeHtml(patch.title)}</a>`,
            previous ? 200 : 201
          );
        }
      }

      const path = new URL(request.url, "http://prototype.local").pathname;
      if (path.startsWith(`${patchesPath}/`)) {
        const patch = state.patches.get(path.slice(patchesPath.length + 1));
        if (!patch || !canOpen(state, patch.audience, viewer.user.id)) return missing();
        return page(
          patch.title,
          `<p class="supporting-text">Version ${patch.version} · Who can open: ${escapeHtml(audienceName(patch.audience))}</p><article><p>${escapeHtml(patch.text)}</p></article>${patch.owner === viewer.user.id ? `<section class="section"><h2 class="section-heading">Publish an update</h2>${publishForm(patch)}</section>` : ""}`
        );
      }
      if (path === patchesPath) {
        const patches = [...state.patches.values()].filter((patch) =>
          canOpen(state, patch.audience, viewer.user.id)
        );
        return page(
          "All patches",
          patches.length === 0
            ? "<p>No patches to show.</p>"
            : `<ul class="list">${patches.map((patch) => `<li class="list-row"><a class="list-link" href="${patchesPath}/${patch.name}"><strong>${escapeHtml(patch.title)}</strong></a><span class="supporting-text">${escapeHtml(audienceName(patch.audience))} · By ${escapeHtml(personName(patch.owner))}</span></li>`).join("")}</ul>`
        );
      }
      if (path === publishPath) return page("Publish a patch", publishForm());
      if (viewer.role !== "admin") return refused("Only an admin can manage teams.");
      const team = state.team;
      return page(
        "Company → People → Teams",
        team
          ? `<h2 class="section-heading">${escapeHtml(team.name)}</h2><ul class="list">${people
              .map((person) => {
                const member = team.members.has(person.id);
                return `<li class="list-row"><strong>${escapeHtml(person.name)}</strong> · ${escapeHtml(person.role)} · ${member ? "On team" : "Not on team"}${post(member ? "remove" : "add", `<input type="hidden" name="user" value="${escapeAttribute(person.id)}">`, `${member ? "Remove" : "Add"} ${escapeHtml(person.name)}`)}</li>`;
              })
              .join("")}</ul>`
          : post("create", input("name", "Team name"), "Create team")
      );
    });
    const admitted = RequireSession.sameOrigin(RequireSession.withViewer(handle)).pipe(
      Effect.orDie
    );
    yield* router.add("GET", `${root}/*`, admitted);
    yield* router.add("POST", root, admitted);
  })
);
