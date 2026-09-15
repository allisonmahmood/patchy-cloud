import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as UrlParams from "effect/unstable/http/UrlParams";
import { pageResponse, RequireSession, Session } from "@patchy/auth";
import { Users } from "@patchy/companies";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import { Patches } from "@patchy/patches";
import { confirmationAcknowledgement, hidden, refusal, styles } from "./render.js";

type Action = "deactivate" | "reactivate";
const decodeChoice = Schema.decodeUnknownEffect(
  Schema.Literals(["keep", "selected", "all", "confirm"])
);
const patchName = (name: string) => `<code>${escapeHtml(name)}</code>`;
const verb = (action: Action) => (action === "deactivate" ? "Deactivate" : "Reactivate");
const consequence = (user: Users.User, action: Action) =>
  action === "deactivate"
    ? `${escapeHtml(user.name)} loses access and their machine tokens stop. Their patches keep serving unless you retire them here. Retired ones can be restored later, one by one, from their cards.`
    : `${escapeHtml(user.name)} gets access back and will need new machine tokens. Their retired patches can come back with them. Patches reassigned while they were away stay with their new owners. Deleted patches stay deleted.`;

const renderPick = (input: {
  user: Users.User;
  action: Action;
  rows: readonly Patches.ReadPatch[];
  selected: ReadonlySet<string>;
  message?: string;
}) => {
  const { user, action, rows, selected } = input;
  const state = action === "deactivate" ? "live" : "retired";
  const items = rows
    .map((row) => {
      const eligible = row.patch.state === state;
      const dependants = new Map(row.dependants.map((dependant) => [dependant.patchId, dependant]));
      const badges =
        action === "deactivate" && eligible
          ? [...dependants.values()]
              .map(
                (dependant) =>
                  `<p class="supporting-text"><span class="pill">Read by</span> ${patchName(dependant.name)} (${escapeHtml(dependant.owner.name)}${dependant.owner.id === user.id ? ", theirs" : ""})</p>`
              )
              .join("") || '<p class="supporting-text">Nothing else reads this patch.</p>'
          : "";
      return `<li class="list-row"><label class="field-choice"><input class="field-checkbox" type="checkbox" name="patch" value="${escapeAttribute(row.patch.id)}"${eligible ? (selected.has(row.patch.id) ? " checked" : "") : " disabled"}><span>${patchName(row.patch.name)} <span class="pill">${escapeHtml(row.patch.state)}</span></span></label>${badges}</li>`;
    })
    .join("");
  return `<article class="portal-subpage"><p><a href="/company">Back to Company</a></p><h1 class="page-heading">${verb(action)} ${escapeHtml(user.name)}</h1><p>${consequence(user, action)}</p>${refusal(input.message)}<form method="post" action="/company/users/${encodeURIComponent(user.id)}/${action}"><ul class="list">${items}</ul><div class="actions"><button class="btn btn-quiet" type="submit" name="choice" value="keep">${action === "deactivate" ? "Keep their patches live" : "Keep them retired"}</button><button class="btn btn-primary" type="submit" name="choice" value="selected">${action === "deactivate" ? "Retire selected" : "Restore selected"}</button><button class="btn${action === "deactivate" ? " btn-danger" : ""}" type="submit" name="choice" value="all">${action === "deactivate" ? "Retire all" : "Restore all"}</button><a class="btn btn-quiet" href="/company">Cancel</a></div><p class="supporting-text">${action === "deactivate" ? "Keep their patches live deactivates them now." : "Keep them retired reactivates them now."} The other two go to a confirmation.</p></form></article>`;
};

type Warning = { readonly name: string; readonly sources: Patches.PortalCard["offSources"] };
const renderConfirm = (input: {
  user: Users.User;
  action: Action;
  selected: readonly Patches.ReadPatch[];
  dependants: readonly Patches.ReadPatch["dependants"][number][];
  warnings: readonly Warning[];
  message?: string;
}) => {
  const { user, action, selected, dependants, warnings } = input;
  const breaks = dependants.length > 0 || warnings.length > 0;
  const damage =
    action === "deactivate"
      ? dependants
          .map(
            (dependant) =>
              `<li>${patchName(dependant.name)} (${escapeHtml(dependant.owner.name)})</li>`
          )
          .join("")
      : warnings
          .map(
            (warning) =>
              `<li>${patchName(warning.name)} will serve, but it will error when it reads these tables until their sources are restored too:<ul class="confirmation-list">${warning.sources.map((source) => `<li>${patchName(source.name ?? source.patchId)} / ${patchName(source.table)}: ${escapeHtml(source.state)}</li>`).join("")}</ul></li>`
          )
          .join("");
  const summary =
    selected.length === 0
      ? action === "deactivate"
        ? "Their patches keep their current state."
        : "Their patches stay as they are."
      : `${action === "deactivate" ? "Retire" : "Restore"} ${selected.map((row) => patchName(row.patch.name)).join(", ")}. ${action === "deactivate" ? "Nobody can open these patches until they are restored. Their pages, versions, tables, files and names are kept indefinitely." : "These patches will serve again."}`;
  const acknowledgement = breaks
    ? confirmationAcknowledgement(
        action === "deactivate"
          ? "I understand these patches will lose access to the retired patches' tables."
          : "I understand these patches will error when they read these tables.",
        false
      )
    : "";
  const back =
    selected.length === 0
      ? '<a href="/company">Back to Company</a>'
      : `<a href="/company/users/${encodeURIComponent(user.id)}/${action}">Back to selection</a>`;
  return `<article class="portal-subpage"><p>${back}</p><h1 class="page-heading">${verb(action)} ${escapeHtml(user.name)}?</h1>${refusal(input.message)}<form class="confirmation-form" method="post" action="/company/users/${encodeURIComponent(user.id)}/${action}"><p class="confirmation-consequence">${consequence(user, action)}</p><p>${summary}</p>${hidden("choice", "confirm")}${selected.map((row) => hidden("patch", row.patch.id)).join("")}${breaks ? `${action === "deactivate" ? "<p>These live patches outside the selection will lose access on their next read, until the sources are restored.</p>" : ""}<ul class="confirmation-list">${damage}</ul>` : '<p class="note note-ok">Nothing breaks</p>'}${acknowledgement}<div class="confirmation-actions"><button class="btn ${action === "deactivate" ? "btn-danger" : "btn-primary"}" type="submit">${verb(action)} ${escapeHtml(user.name)}${selected.length === 0 ? "" : action === "deactivate" ? " and retire selected" : " and restore selected"}</button><a class="btn btn-quiet" href="/company">Cancel</a></div></form></article>`;
};

/** Previews take no mutation locks; a commit rechecks the selection under Patches' locks. */
export const handle = Effect.fn("UserLifecyclePage.handle")(function* (id: string, action: Action) {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const users = yield* Users.Users;
  const patches = yield* Patches.Patches;
  const canOpen = yield* Patches.Openability;
  const access = {
    companyId: viewer.company.id,
    userId: viewer.user.id,
    canOpen: (patch: Patches.Patch) => canOpen(patch, viewer.user.id)
  };
  const respond = (body: string, status = 200) =>
    pageResponse(
      {
        title: `${verb(action)} user`,
        heading: "",
        body,
        styles,
        status,
        app: { viewer, section: "company" }
      },
      session
    );
  const refuse = (message: string, status: number) =>
    respond(`${refusal(message)}<p><a href="/company">Back to Company</a></p>`, status);
  if (viewer.role !== "admin")
    return refuse("Only an admin can manage this company. Nothing was done.", 403);
  const submission =
    request.method === "POST"
      ? yield* request.urlParamsBody.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(65_536)),
          Effect.result
        )
      : Result.succeed(UrlParams.empty);
  if (Result.isFailure(submission))
    return refuse("Check the submitted form and try again. Nothing was done.", 422);
  const fields = submission.success;
  const choice =
    request.method === "GET"
      ? undefined
      : yield* decodeChoice(Option.getOrUndefined(UrlParams.getFirst(fields, "choice"))).pipe(
          Effect.catchTags({ SchemaError: () => Effect.void })
        );
  const run = Effect.gen(function* () {
    const ref = { companyId: viewer.company.id, userId: id };
    const user =
      action === "deactivate"
        ? yield* users.checkDeactivation(ref)
        : (yield* users.list(viewer.company.id)).find((user) => user.id === id);
    if (!user) return yield* new Users.UserNotFound(ref);
    const alreadyInTargetState =
      action === "deactivate" ? user.deactivatedAt !== null : user.deactivatedAt === null;
    if (alreadyInTargetState)
      return refuse(
        `This user is already ${user.deactivatedAt === null ? "active" : "deactivated"}. Nothing was done.`,
        409
      );
    const rows = (yield* patches.read({ ...access, state: "all" }))
      .filter((row) => row.owner.id === id)
      .sort((a, b) => a.patch.name.localeCompare(b.patch.name));
    const eligible = rows.filter(
      (row) => row.patch.state === (action === "deactivate" ? "live" : "retired")
    );
    const selectedIds = new Set(
      choice === "all"
        ? eligible.map((row) => row.patch.id)
        : choice === "keep"
          ? []
          : UrlParams.getAll(fields, "patch")
    );
    const pick = (message?: string, status = 200) =>
      respond(renderPick({ user, action, rows, selected: selectedIds, message }), status);
    if (request.method === "POST" && choice === undefined)
      return pick("Choose whether to keep, select or act on all patches. Nothing was done.", 422);
    if (request.method === "GET" && eligible.length > 0) return pick();
    if (choice === "selected" && selectedIds.size === 0)
      return pick(
        action === "deactivate"
          ? "Select at least one, or keep their patches live."
          : "Select at least one, or keep them retired.",
        422
      );
    const selected = eligible.filter((row) => selectedIds.has(row.patch.id));
    if (selected.length !== selectedIds.size)
      return pick("The selected patches changed. Choose again. Nothing was done.", 409);
    const dependants = new Map<string, Patches.ReadPatch["dependants"][number]>();
    const warnings: Warning[] = [];
    for (const row of selected) {
      if (action === "deactivate") {
        for (const dependant of row.dependants) {
          if (!selectedIds.has(dependant.patchId)) dependants.set(dependant.patchId, dependant);
        }
      } else {
        const card = yield* patches.portalCard(row.patch.id, access);
        const sources = card.offSources.filter((source) => !selectedIds.has(source.patchId));
        if (sources.length > 0) warnings.push({ name: row.patch.name, sources });
      }
    }
    const confirm = (message?: string, status = 200) =>
      respond(
        renderConfirm({
          user,
          action,
          selected,
          dependants: [...dependants.values()],
          warnings,
          message
        }),
        status
      );
    if (choice !== "keep" && choice !== "confirm") return confirm();
    if (
      (dependants.size > 0 || warnings.length > 0) &&
      !Option.contains(UrlParams.getFirst(fields, "ack"), "1")
    )
      return confirm("Acknowledge what breaks before confirming. Nothing was done.", 409);
    if (action === "deactivate") yield* users.deactivate(ref);
    else yield* users.reactivate(ref);
    const actor = { userId: viewer.user.id, admin: true };
    for (const row of selected) {
      if (action === "deactivate") yield* patches.retire(row.patch.id, actor, true);
      else yield* patches.restore(row.patch.id, actor, true, "retired");
    }
    return HttpServerResponse.redirect("/company", {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    });
  });
  return yield* (
    choice === "keep" || choice === "confirm"
      ? patches.withCompanyLifecycleLock(viewer.user.id)(run)
      : run
  ).pipe(
    Effect.catchTags({
      UserNotFound: (error) => Effect.succeed(refuse(error.message, 404)),
      LastAdmin: (error) => Effect.succeed(refuse(error.message, 409)),
      PatchRetired: (error) => Effect.succeed(refuse(`${error.message} Nothing was done.`, 409)),
      InvalidOwner: (error) => Effect.succeed(refuse(`${error.message} Nothing was done.`, 409)),
      InvalidDescription: (error) =>
        Effect.succeed(refuse(`${error.message} Nothing was done.`, 422)),
      ReservedName: (error) => Effect.succeed(refuse(`${error.message} Nothing was done.`, 422)),
      VersionUnavailable: (error) =>
        Effect.succeed(refuse(`${error.message} Nothing was done.`, 422)),
      WrongState: () => Effect.succeed(refuse("A selected patch changed. Nothing was done.", 409)),
      StaleAction: () => Effect.succeed(refuse("A selected patch changed. Nothing was done.", 409)),
      PatchUnavailable: () =>
        Effect.succeed(refuse("A selected patch is unavailable. Nothing was done.", 404)),
      NotOwner: () =>
        Effect.succeed(refuse("A selected patch changed owner. Nothing was done.", 409)),
      PatchDeleted: () =>
        Effect.succeed(refuse("A selected patch is deleted. Nothing was done.", 409)),
      HasDependants: () =>
        Effect.succeed(refuse("A selected patch has new dependants. Nothing was done.", 409)),
      SourcesOff: () =>
        Effect.succeed(refuse("A selected patch has unavailable sources. Nothing was done.", 409))
    })
  );
});
