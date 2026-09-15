import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { PatchName, PatchState, SharingScope } from "@patchy/api";
import { pageResponse, RequireSession, Session } from "@patchy/auth";
import { escapeHtml } from "@patchy/core";
import type { Companies, Users } from "@patchy/companies";
import { Patches } from "@patchy/patches";
import { ago, renderPortal, renderRestoreConflict, renderVersions, styles } from "./render.js";

const isName = Schema.is(PatchName);
const decodeDescription = Schema.decodeUnknownEffect(
  Schema.Struct({
    description: Schema.String,
    expectedDescriptionUpdatedAt: Schema.String
  })
);
const decodeScope = Schema.decodeUnknownEffect(
  Schema.Struct({
    scope: SharingScope,
    expectedScope: SharingScope
  })
);
const decodeRollback = Schema.decodeUnknownEffect(
  Schema.Struct({
    versionNumber: Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(2147483647)
    ),
    expectedCurrentVersionId: Schema.String
  })
);
const decodeRestore = Schema.decodeUnknownEffect(Schema.Struct({ expectedState: PatchState }));

type Action = "description" | "scope" | "rollback" | "restore";
const forbidden = "Only the owner or an admin can do that. Nothing was done.";

const context = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const canOpen = yield* Patches.Openability;
  return {
    viewer,
    session,
    all: new URL(request.url, session.publicBaseUrl).searchParams.get("all") === "1",
    access: {
      companyId: viewer.company.id,
      userId: viewer.user.id,
      canOpen: (patch: Patches.Patch) => canOpen(patch, viewer.user.id)
    }
  };
});

const errorPage = Effect.fn("PortalPages.errorPage")(function* (
  status: number,
  title: string,
  message: string
) {
  const { viewer, session } = yield* context;
  return pageResponse(
    {
      title,
      status,
      body: `<p>${escapeHtml(message)}</p><p><a href="/">Return to patches</a></p>`,
      app: { viewer, section: "patches" }
    },
    session
  );
});

const render = Effect.fn("PortalPages.render")(function* (
  name?: string,
  options: {
    status?: number;
    notice?: string;
    submittedDescription?: string;
    versions?: boolean;
    restoreConflict?: boolean;
  } = {}
) {
  const { viewer, session, all, access } = yield* context;
  if (name !== undefined && name.length > 32)
    return yield* errorPage(
      414,
      "Patch name is too long",
      "Patch names have at most 32 characters."
    );
  if (name !== undefined && !isName(name))
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  const patches = yield* Patches.Patches;
  const rows = yield* patches.read({ ...access, state: "all" });
  const ordered =
    name === undefined ? [...rows].sort((a, b) => a.patch.name.localeCompare(b.patch.name)) : rows;
  const selected =
    name === undefined
      ? (ordered.find((row) => row.patch.state === "live" && row.owner.id === viewer.user.id) ??
        ordered.find((row) => row.patch.state === "live"))
      : rows.find((row) => row.patch.name === name);
  if (name !== undefined && selected === undefined)
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  const card = selected ? yield* patches.portalCard(selected.patch.id, access) : null;
  const now = yield* Clock.currentTimeMillis;
  const body =
    options.versions && card
      ? renderVersions({ card, viewer, all, now })
      : options.restoreConflict && card
        ? renderRestoreConflict({ card, viewer, all, now })
        : renderPortal({
            rows,
            card,
            viewer,
            all,
            now,
            publicBaseUrl: session.publicBaseUrl,
            ...(options.notice === undefined ? {} : { notice: options.notice }),
            ...(options.submittedDescription === undefined
              ? {}
              : { submittedDescription: options.submittedDescription })
          });
  return pageResponse(
    {
      title: card ? `${card.patch.name}${options.versions ? " versions" : ""}` : "Patches",
      heading: "",
      body,
      styles,
      status: options.status ?? 200,
      app: { viewer, section: "patches" }
    },
    session
  );
});

const post = Effect.fn("PortalPages.post")(function* (name: string, action: Action) {
  if (name.length > 32)
    return yield* errorPage(
      414,
      "Patch name is too long",
      "Patch names have at most 32 characters."
    );
  if (!isName(name))
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  const { viewer, all, access } = yield* context;
  const patches = yield* Patches.Patches;
  const rows = yield* patches.read({ ...access, state: "all" });
  const selected = rows.find((row) => row.patch.name === name);
  if (!selected)
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  if (viewer.role !== "admin" && selected.owner.id !== viewer.user.id)
    return yield* render(name, { status: 403, notice: forbidden });
  const actor = { userId: viewer.user.id, admin: viewer.role === "admin" };
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = Object.fromEntries(
    yield* request.urlParamsBody.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(16_384))
    )
  );
  const run = Effect.gen(function* () {
    switch (action) {
      case "description": {
        const fields = yield* decodeDescription(form);
        yield* patches.setDescription(
          selected.patch.id,
          actor,
          fields.description,
          fields.expectedDescriptionUpdatedAt || null
        );
        break;
      }
      case "scope": {
        const fields = yield* decodeScope(form);
        yield* patches.setScope(selected.patch.id, actor, fields.scope, fields.expectedScope);
        break;
      }
      case "rollback": {
        const fields = yield* decodeRollback(form);
        yield* patches.rollback(
          selected.patch.id,
          actor,
          fields.versionNumber,
          fields.expectedCurrentVersionId || null
        );
        break;
      }
      case "restore": {
        const fields = yield* decodeRestore(form);
        yield* patches.restore(selected.patch.id, actor, false, fields.expectedState);
        break;
      }
    }
    return HttpServerResponse.redirect(
      `/patches/${encodeURIComponent(name)}${all ? "?all=1" : ""}`,
      {
        status: 303,
        headers: { "cache-control": "private, no-store" }
      }
    );
  });
  const stale = Effect.gen(function* () {
    const fresh = yield* patches.portalCard(selected.patch.id, access);
    const when =
      fresh.patch.lastChangedAt === null
        ? ""
        : ` ${ago(fresh.patch.lastChangedAt, yield* Clock.currentTimeMillis)}`;
    return yield* render(name, {
      status: 409,
      notice: `This patch changed while you had this page open: ${fresh.lastChangedAction ?? "updated"} by ${fresh.actorNames.lastChanged ?? fresh.owner.name}${when}. Nothing was done.`
    });
  });
  const invalid = (notice: string) =>
    render(name, {
      status: 422,
      notice,
      ...(action === "description" ? { submittedDescription: form.description ?? "" } : {})
    });
  return yield* run.pipe(
    Effect.catchTags({
      StaleAction: () => stale,
      NotOwner: () => render(name, { status: 403, notice: forbidden }),
      WrongState: () => stale,
      PatchDeleted: (error) =>
        render(name, { status: 409, notice: `${error.message} Nothing was done.` }),
      PatchRetired: (error) =>
        render(name, { status: 409, notice: `${error.message} Nothing was done.` }),
      SourcesOff: () => render(name, { status: 409, restoreConflict: true }),
      InvalidDescription: (error) => invalid(`${error.message} Nothing was done.`),
      SchemaError: () => invalid("Check the submitted fields and try again. Nothing was done."),
      VersionUnavailable: (error) => invalid(`${error.message} Nothing was done.`),
      HasDependants: (error) => render(name, { status: 409, notice: error.message }),
      ReservedName: (error) => invalid(error.message),
      InvalidOwner: (error) => invalid(error.message)
    })
  );
});

/** Refusals keep their status and never leak database or authentication diagnostics. */
export const errors = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  app.pipe(
    Effect.catchTags({
      SqlError: () =>
        Effect.succeed(
          pageResponse({
            title: "Patches unavailable",
            body: "<p>Please try again.</p>",
            status: 503
          })
        ),
      SessionError: () =>
        Effect.succeed(
          pageResponse({
            title: "Sign-in service unavailable",
            body: "<p>Please try again.</p>",
            status: 502
          })
        )
    })
  );

const pageErrors = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  app.pipe(
    Effect.catchTags({
      PatchUnavailable: () =>
        errorPage(404, "Patch not found", "The requested patch is unavailable."),
      WrongState: () =>
        errorPage(
          409,
          "Patch changed",
          "This action is not available in the patch's current state. Nothing was done."
        ),
      HttpServerError: () =>
        errorPage(
          422,
          "Request refused",
          "Check the submitted form and try again. Nothing was done."
        )
    })
  );

/** The server owns GET / and its signed-out door alongside the catch-all. */
export const index = render().pipe(pageErrors);

export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      Session.Session | Companies.Companies | Users.Users | Patches.Patches
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      "GET",
      "/patches/:name",
      errors(
        RequireSession.withViewer(
          Effect.flatMap(HttpRouter.params, (params) => render(params.name ?? "")).pipe(pageErrors)
        )
      )
    );
    yield* router.add(
      "GET",
      "/patches/:name/versions",
      errors(
        RequireSession.withViewer(
          Effect.flatMap(HttpRouter.params, (params) =>
            render(params.name ?? "", { versions: true })
          ).pipe(pageErrors)
        )
      )
    );
    yield* router.add(
      "GET",
      "/patches/*",
      errors(
        RequireSession.withViewer(
          Effect.flatMap(HttpRouter.params, (params) =>
            (params["*"]?.split("/", 1)[0] ?? "").length > 32
              ? errorPage(414, "Patch name is too long", "Patch names have at most 32 characters.")
              : errorPage(404, "Patch not found", "The requested patch is unavailable.")
          ).pipe(pageErrors)
        )
      )
    );
    for (const action of ["description", "scope", "rollback", "restore"] as const) {
      yield* router.add(
        "POST",
        `/patches/:name/${action}`,
        errors(
          RequireSession.sameOrigin(
            RequireSession.withViewer(
              Effect.flatMap(HttpRouter.params, (params) => post(params.name ?? "", action)).pipe(
                pageErrors
              )
            )
          )
        )
      );
    }
  })
);
