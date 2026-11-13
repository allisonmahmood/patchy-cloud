// Owns deactivating and reactivating a person at `/settings/people/users/<id>/<action>`: a Flow
// page choosing what happens to their patches, and the confirmation when that changes any, at the
// same address with the choice in its query. What other surfaces need is in `shared/`.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as UrlParams from "effect/http/UrlParams";
import { capBody } from "@patchy/api";
import { pageResponse, RequireSession, Session } from "@patchy/auth";
import { Users } from "@patchy/companies";
import {
  avatar,
  button,
  checklist,
  choiceCards,
  escapeAttribute,
  escapeHtml,
  flowPage,
  linkButton,
  notice,
  patchTitle,
  refusal,
  row,
  rows,
  section,
  type Template
} from "@patchy/core";
import { Patches } from "@patchy/patches";
import { errors, type Routes } from "./shared/handlers.js";
import { hidden } from "./shared/presentation.js";

type Action = "deactivate" | "reactivate";
type Choice = "keep" | "selected" | "all" | "confirm";
const decodeChoice = Schema.decodeUnknownEffect(
  Schema.Literals(["keep", "selected", "all", "confirm"])
);
const people = { label: "People", href: "/settings/people" };
const verb = (action: Action) => (action === "deactivate" ? "Deactivate" : "Reactivate");
const lifecyclePath = (user: Users.User, action: Action) =>
  `/settings/people/users/${encodeURIComponent(user.id)}/${action}`;
/**
 * The confirmation's own address, `?choice=all` or `?choice=selected&patch=…`, so a reload, Back
 * or a new tab draws the same decision. Only its final button acts, by POST.
 */
const confirmationPath = (
  user: Users.User,
  action: Action,
  choice: "selected" | "all",
  selected: readonly Patches.ReadPatch[]
) =>
  `${lifecyclePath(user, action)}?${UrlParams.toString([
    ["choice", choice],
    ...(choice === "all" ? [] : selected.map((row) => ["patch", row.patch.id] as const))
  ])}`;
/** "a, b and c" in plain words, for helpers that escape their own text. */
const listed = (items: readonly string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const stateLabels = { live: "Live", retired: "Retired", deleted: "Deleted" } as const;

/**
 * What the change means for the person, credentials included: deactivation ends every computer
 * and app acting as them, and reactivation brings none back. Its section leads a wrapper, so the
 * flow's own gap sets it apart.
 */
const consequence = (user: Users.User, action: Action) =>
  `<div>${section({
    title: action === "deactivate" ? "Once deactivated" : "Once reactivated",
    body: `<p class="prose">${
      action === "deactivate"
        ? `${escapeHtml(user.name)} can’t sign in, and their computers and apps stop acting as them. Patches left live keep serving; retired ones can be restored later, one by one, from their pages.`
        : `${escapeHtml(user.name)} can sign in again. Their computers and apps don’t come back: they connect each one again. Patches reassigned while they were away stay with their new owners, and deleted ones stay deleted.`
    }</p>`
  })}</div>`;

/** A refusal no field owns, just above the buttons, where the page's focus starts. */
const refused = (message: string | undefined) =>
  message === undefined ? "" : refusal(notice({ tone: "danger", title: message }));

/**
 * A patch by its title and, when that differs, its name, which no other patch shares: two
 * patches may have the same title. `company` is the patch's own.
 */
const named = (patch: Patches.Patch, company: string) => {
  const title = patchTitle(patch, company);
  return title === patch.name ? title : `${title} (${patch.name})`;
};

/**
 * The Flow page: keep their patches as they are, act on some, or on all, with each patch and what
 * reads it. Keep finishes at once; the others go to the confirmation.
 */
const renderPick = (input: {
  user: Users.User;
  /** The viewer's company, whose patches these are. */
  company: string;
  action: Action;
  rows: readonly Patches.ReadPatch[];
  selected: ReadonlySet<string>;
  choice: Choice | undefined;
  /** Under the list of patches, whose first box then takes the focus. */
  problem?: string;
  /** Above the buttons. */
  message?: string;
}): Template => {
  const { user, action, rows: owned, selected } = input;
  const deactivating = action === "deactivate";
  const state = deactivating ? "live" : "retired";
  // A fresh pick starts on Keep; a refused one stays on what was asked, and a refused
  // confirmation goes back to the selection it was confirming, never to Keep.
  const choice =
    input.choice === undefined ? "keep" : input.choice === "confirm" ? "selected" : input.choice;
  const cards = choiceCards("choice", [
    {
      value: "keep",
      title: deactivating ? "Keep them live" : "Keep them retired",
      points: [
        deactivating
          ? "They stay open. An admin can reassign them later."
          : "They stay retired, for an admin to restore later."
      ],
      checked: choice === "keep"
    },
    {
      value: "selected",
      title: deactivating ? "Retire some" : "Restore some",
      points: [deactivating ? "Choose which below. Everything is kept." : "Choose which below."],
      checked: choice === "selected"
    },
    {
      value: "all",
      title: deactivating ? "Retire all" : "Restore all",
      points: [
        deactivating
          ? "Nobody can open them until someone restores them."
          : "They serve at their addresses again."
      ],
      checked: choice === "all"
    }
  ]);
  const list = checklist({
    id: "patches",
    legend: deactivating ? "Which to retire" : "Which to restore",
    name: "patch",
    ...(input.problem === undefined ? {} : { error: input.problem }),
    items: owned.map(({ patch, dependants }) => {
      const eligible = patch.state === state;
      // Each reading patch once, whatever tables or stores it reads.
      const readers = [...new Map(dependants.map((reader) => [reader.patchId, reader])).values()];
      return {
        value: patch.id,
        label: named(patch, input.company),
        description:
          deactivating && eligible
            ? readers.length === 0
              ? "Nothing else reads it"
              : `Read by ${listed(readers.map((reader) => `${reader.name} (${reader.owner.id === user.id ? "theirs" : reader.owner.name})`))}`
            : stateLabels[patch.state],
        checked: eligible && selected.has(patch.id),
        disabled: !eligible
      };
    })
  });
  return flowPage({
    parent: people,
    mark: avatar(user.id, user.name),
    title: `${verb(action)} ${user.name}`,
    sections: [
      { title: deactivating ? "Their patches" : "Their retired patches", body: `${cards}${list}` }
    ],
    outcome: `${consequence(user, action)}${refused(input.message)}`,
    submit: `${button(`${verb(action)} ${user.name}`, { kind: deactivating ? "danger-solid" : "primary" })}${linkButton("Cancel", people.href, { kind: "quiet" })}`,
    form: { action: lifecyclePath(user, action) }
  });
};

type Warning = { readonly name: string; readonly sources: Patches.PortalCard["offSources"] };

/**
 * The confirmation: what changes, what breaks outside the selection, and for that, a box to tick
 * before the final button acts.
 */
const renderConfirm = (input: {
  user: Users.User;
  /** The viewer's company, whose patches these are. */
  company: string;
  action: Action;
  selected: readonly Patches.ReadPatch[];
  dependants: readonly Patches.ReadPatch["dependants"][number][];
  /** How many more of those dependants the admin can't open. */
  hiddenDependants: number;
  warnings: readonly Warning[];
  /** Under the acknowledgement, whose box then takes the focus. */
  problem?: string;
}): Template => {
  const { user, action, selected, dependants, hiddenDependants, warnings } = input;
  const deactivating = action === "deactivate";
  const breaks = dependants.length + hiddenDependants > 0 || warnings.length > 0;
  const titles = listed(selected.map((row) => named(row.patch, input.company)));
  const change =
    selected.length === 0
      ? "Their patches stay as they are."
      : deactivating
        ? `Retire ${titles}. Nobody can open them until they are restored; their pages, versions, tables, files and names are kept.`
        : `Restore ${titles}. They serve again.`;
  const again =
    selected.length === 0
      ? ""
      : ` <a href="${escapeAttribute(lifecyclePath(user, action))}">Choose again</a>`;
  const damage = deactivating
    ? `<p class="prose">These live patches outside the selection lose access on their next read, until the sources are restored.</p>${rows(
        dependants.map((dependant) =>
          row({ name: dependant.name, description: `${dependant.owner.name}’s` })
        ),
        true
      )}${
        hiddenDependants === 0
          ? ""
          : `<p class="meta">${dependants.length === 0 ? "" : "And "}${hiddenDependants} ${hiddenDependants === 1 ? "patch" : "patches"} you can’t open.</p>`
      }`
    : `<p class="prose">These will serve, but error when they read these tables or stores until their sources are restored too.</p>${rows(
        warnings.map((warning) =>
          row({
            name: warning.name,
            description: warning.sources
              .map(
                (source) =>
                  `${source.name ?? source.patchId} / ${source.table ?? source.store}: ${source.state}`
              )
              .join(" · ")
          })
        ),
        true
      )}`;
  const acknowledgement = checklist({
    id: "ack",
    legend: "Before you confirm",
    name: "ack",
    ...(input.problem === undefined ? {} : { error: input.problem }),
    items: [
      {
        value: "1",
        label: deactivating
          ? "I understand these patches will lose access to the retired patches’ shared tables and stores."
          : "I understand these patches will error when they read these tables or stores."
      }
    ]
  });
  return flowPage({
    parent: people,
    mark: avatar(user.id, user.name),
    title: `${verb(action)} ${user.name}?`,
    sections: [],
    outcome: `<div class="stack"><p class="prose">${escapeHtml(change)}${again}</p>${breaks ? `${damage}${acknowledgement}` : '<p class="prose">Nothing breaks.</p>'}</div>${consequence(user, action)}`,
    submit: `${button(`${verb(action)} ${user.name}${selected.length === 0 ? "" : deactivating ? " and retire selected" : " and restore selected"}`, { kind: deactivating ? "danger-solid" : "primary" })}${linkButton("Cancel", people.href, { kind: "quiet" })}`,
    form: {
      action: lifecyclePath(user, action),
      fields: `${hidden("choice", "confirm")}${selected.map((row) => hidden("patch", row.patch.id)).join("")}`
    }
  });
};

/** A refusal that ends the flow, in its frame, with the way back to People. */
const renderRefusal = (action: Action, name: string | undefined, message: string): Template =>
  flowPage({
    parent: people,
    title: name === undefined ? verb(action) : `${verb(action)} ${name}`,
    sections: [],
    outcome: refused(message),
    submit: linkButton("Back to People", people.href)
  });

/** Previews take no mutation locks; commits change patches before the user in one transaction. */
const handle = Effect.fn("UserLifecyclePage.handle")(function* (id: string, action: Action) {
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
  const respond = (template: Template, title: string, status = 200) =>
    pageResponse({ title, ...template, status, app: { viewer, section: "people" } }, session);
  /** A refusal that ends the flow; `name` titles it once the person is known. */
  const refuse = (message: string, status: number, name?: string) =>
    respond(
      renderRefusal(action, name, message),
      name === undefined ? verb(action) : `${verb(action)} ${name}`,
      status
    );
  if (viewer.role !== "admin")
    return refuse("Only an admin can manage this company. Nothing was done.", 403);
  const submission =
    request.method === "POST"
      ? yield* request.urlParamsBody.pipe(capBody(65_536), Effect.result)
      : Result.succeed(UrlParams.empty);
  if (Result.isFailure(submission))
    return refuse("Check the submitted form and try again. Nothing was done.", 422);
  // A GET reads its choice from the query, and only a choice the confirmation draws: it never acts.
  const fields =
    request.method === "POST"
      ? submission.success
      : UrlParams.fromInput(new URL(request.url, session.publicBaseUrl).searchParams);
  const decoded = yield* decodeChoice(
    Option.getOrUndefined(UrlParams.getFirst(fields, "choice"))
  ).pipe(Effect.catchTags({ SchemaError: () => Effect.succeed(undefined) }));
  const choice =
    request.method === "POST" || decoded === "selected" || decoded === "all" ? decoded : undefined;
  // Names the person in a refusal's title; what the flow acts on is read again under its lock.
  const named = (yield* users.list(viewer.company.id)).find((user) => user.id === id)?.name;
  const refuseNamed = (message: string, status: number) => refuse(message, status, named);
  const run = Effect.gen(function* () {
    const ref = { companyId: viewer.company.id, userId: id };
    // Retire and restore lock the company row before each patch, and deactivate and reactivate
    // lock it again: taking it first keeps that order when a share waits on one of the patches.
    if (choice === "keep" || choice === "confirm")
      yield* Users.lockAdministrator({ companyId: viewer.company.id, actorId: viewer.user.id });
    const user =
      action === "deactivate"
        ? yield* users.checkDeactivation(ref)
        : (yield* users.list(viewer.company.id)).find((user) => user.id === id);
    if (!user) return yield* new Users.UserNotFound(ref);
    const alreadyInTargetState =
      action === "deactivate" ? user.deactivatedAt !== null : user.deactivatedAt === null;
    if (alreadyInTargetState)
      return refuseNamed(
        `This user is already ${user.deactivatedAt === null ? "active" : "deactivated"}. Nothing was done.`,
        409
      );
    // Every patch they own, the ones the admin manages without opening included.
    const rows = (yield* patches.read({ ...access, state: "all", managed: true }))
      .filter((row) => row.owner.id === id)
      .sort((a, b) => a.patch.name.localeCompare(b.patch.name));
    const eligible = rows.filter(
      (row) => row.patch.state === (action === "deactivate" ? "live" : "retired")
    );
    const selectedIds = new Set(
      choice === "all"
        ? eligible.map((row) => row.patch.id)
        : choice === "selected" || choice === "confirm"
          ? UrlParams.getAll(fields, "patch")
          : []
    );
    const title = `${verb(action)} ${user.name}`;
    const pick = (refused: { problem?: string; message?: string } = {}, status = 200) =>
      respond(
        renderPick({
          user,
          company: viewer.company.name,
          action,
          rows,
          selected: selectedIds,
          choice,
          ...refused
        }),
        title,
        status
      );
    if (request.method === "POST" && choice === undefined)
      return pick(
        { message: "Choose whether to keep, select or act on all patches. Nothing was done." },
        422
      );
    if (choice === undefined && eligible.length > 0) return pick();
    if (choice === "selected" && selectedIds.size === 0)
      return pick(
        {
          problem:
            action === "deactivate"
              ? "Select at least one, or keep their patches live."
              : "Select at least one, or keep them retired."
        },
        422
      );
    const selected = eligible.filter((row) => selectedIds.has(row.patch.id));
    if (selected.length !== selectedIds.size)
      return pick(
        { message: "The selected patches changed. Choose again. Nothing was done." },
        409
      );
    if (request.method === "POST" && (choice === "selected" || choice === "all"))
      return HttpServerResponse.redirect(confirmationPath(user, action, choice, selected), {
        status: 303,
        headers: { "cache-control": "private, no-store" }
      });
    const dependants = new Map<string, Patches.ReadPatch["dependants"][number]>();
    const hiddenDependants = new Set<string>();
    const warnings: Warning[] = [];
    for (const row of selected) {
      const card = yield* patches.portalCard(row.patch.id, access);
      if (action === "deactivate") {
        for (const dependant of card.dependants) {
          if (!selectedIds.has(dependant.patchId)) dependants.set(dependant.patchId, dependant);
        }
        for (const patchId of card.hiddenDependants)
          if (!selectedIds.has(patchId)) hiddenDependants.add(patchId);
      } else {
        const sources = card.offSources.filter((source) => !selectedIds.has(source.patchId));
        if (sources.length > 0) warnings.push({ name: row.patch.name, sources });
      }
    }
    const confirm = (problem?: string, status = 200) =>
      respond(
        renderConfirm({
          user,
          company: viewer.company.name,
          action,
          selected,
          dependants: [...dependants.values()],
          hiddenDependants: hiddenDependants.size,
          warnings,
          ...(problem === undefined ? {} : { problem })
        }),
        title,
        status
      );
    if (choice !== "keep" && choice !== "confirm") return confirm();
    if (
      (dependants.size + hiddenDependants.size > 0 || warnings.length > 0) &&
      !Option.contains(UrlParams.getFirst(fields, "ack"), "1")
    )
      return confirm("Acknowledge what breaks before confirming. Nothing was done.", 409);
    const actor = { userId: viewer.user.id, admin: true };
    // Use ID order across the selection; keep patch rows before the user row as reassign does.
    for (const row of selected.sort((a, b) => a.patch.id.localeCompare(b.patch.id))) {
      if (action === "deactivate") yield* patches.retire(row.patch.id, actor, true, id);
      else yield* patches.restore(row.patch.id, actor, true, "retired", id);
    }
    if (action === "deactivate") yield* users.deactivate(ref);
    else yield* users.reactivate(ref);
    // Reported with the patch events once the dependency lock's transaction commits.
    // That lock serializes these commits, so a repeat is refused above.
    yield* patches.reportOnCommit({
      name: action === "deactivate" ? "user.deactivated" : "user.reactivated",
      principalId: viewer.user.id,
      companyId: viewer.company.id,
      properties: { userId: id }
    });
    return HttpServerResponse.redirect("/settings/people", {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    });
  });
  return yield* (
    choice === "keep" || choice === "confirm"
      ? patches.withDependencyLock(viewer.user.id)(run)
      : run
  ).pipe(
    Effect.catchTags({
      UserNotFound: (error) => Effect.succeed(refuse(error.message, 404)),
      RoleForbidden: (error) => Effect.succeed(refuse(error.message, 403)),
      OwnerAccessLost: (error) => Effect.succeed(refuse(error.message, 403)),
      LastAdmin: (error) => Effect.succeed(refuseNamed(error.message, 409)),
      PatchRetired: (error) =>
        Effect.succeed(refuseNamed(`${error.message} Nothing was done.`, 409)),
      InvalidOwner: (error) =>
        Effect.succeed(refuseNamed(`${error.message} Nothing was done.`, 409)),
      InvalidDescription: (error) =>
        Effect.succeed(refuseNamed(`${error.message} Nothing was done.`, 422)),
      ReservedName: (error) =>
        Effect.succeed(refuseNamed(`${error.message} Nothing was done.`, 422)),
      VersionUnavailable: (error) =>
        Effect.succeed(refuseNamed(`${error.message} Nothing was done.`, 422)),
      WrongState: () =>
        Effect.succeed(refuseNamed("A selected patch changed. Nothing was done.", 409)),
      StaleAction: () =>
        Effect.succeed(refuseNamed("A selected patch changed. Nothing was done.", 409)),
      PatchUnavailable: () =>
        Effect.succeed(refuseNamed("A selected patch is unavailable. Nothing was done.", 404)),
      NotOwner: () =>
        Effect.succeed(refuseNamed("A selected patch changed owner. Nothing was done.", 409)),
      PatchDeleted: () =>
        Effect.succeed(refuseNamed("A selected patch is deleted. Nothing was done.", 409)),
      HasDependants: () =>
        Effect.succeed(refuseNamed("A selected patch has new dependants. Nothing was done.", 409)),
      SourcesOff: () =>
        Effect.succeed(
          refuseNamed("A selected patch has unavailable sources. Nothing was done.", 409)
        )
    })
  );
});

export const layer: Routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    for (const action of ["deactivate", "reactivate"] as const) {
      for (const method of ["GET", "POST"] as const) {
        const handler = RequireSession.withViewer(
          Effect.flatMap(HttpRouter.params, (params) => handle(params.id ?? "", action))
        );
        yield* router.add(
          method,
          `/settings/people/users/:id/${action}`,
          errors(method === "POST" ? RequireSession.sameOrigin(handler) : handler)
        );
      }
    }
  })
);
