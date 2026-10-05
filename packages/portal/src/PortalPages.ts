import * as Clock from "effect/Clock";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as SqlClient from "effect/sql/SqlClient";
import * as WideEvents from "@patchy/analytics/wide-events";
import { AgentMode, PatchName, PatchState, SharingScope } from "@patchy/api";
import { pageResponse, RequireSession, Session } from "@patchy/auth";
import { escapeHtml } from "@patchy/core";
import { type Companies, Users } from "@patchy/companies";
import { AgentAccess, Patches } from "@patchy/patches";
import { ConnectionStore } from "@patchy/integrations";
import { InvocationLog } from "@patchy/runtime";
import { type LogNames, outcomeFilters, renderLog, renderRecentActivity } from "./log.js";
import {
  ago,
  type ConfirmationAction,
  type PatchAction,
  renderConfirmation,
  renderPortal,
  renderVersions,
  styles
} from "./render.js";
import { renderAgentAccess } from "./agentAccess.js";
import * as UserLifecyclePage from "./UserLifecyclePage.js";

const isName = Schema.is(PatchName);
const maxNameLength = 32;
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
const decodeRetire = Schema.decodeUnknownEffect(
  Schema.Struct({ expectedState: Schema.Literal("live") })
);
const decodeDelete = Schema.decodeUnknownEffect(
  Schema.Struct({
    expectedState: Schema.Literal("not-deleted"),
    confirm: Schema.String
  })
);
const decodeReassign = Schema.decodeUnknownEffect(
  Schema.Struct({ expectedOwnerUserId: Schema.String, user: Schema.String })
);

const forbidden = "Only the owner or an admin can do that. Nothing was done.";
const logForbidden = "Only the owner or an admin can read this patch's log.";
const isOutcomeFilter = Schema.is(Schema.Literals(outcomeFilters.map(([value]) => value)));
const maxFilterLength = 256;
const adminRequired = "Only an admin can reassign this patch. Nothing was done.";

const context = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const canOpen = yield* Patches.Openability;
  const query = new URL(request.url, session.publicBaseUrl).searchParams;
  return {
    viewer,
    session,
    all: query.get("all") === "1",
    query: request.method === "GET" ? (query.get("q") ?? "") : "",
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

/** Stored ids in the reader's words: company members' names, version numbers and the patch's title. */
const logNames = Effect.fn("PortalPages.logNames")(function* (
  card: Patches.PortalCard,
  companyId: string
) {
  const members = yield* (yield* Users.Users).list(companyId);
  return {
    people: new Map(members.map((member) => [member.id, member.name])),
    versions: new Map(card.versions.map((version) => [version.id, version.versionNumber])),
    patch: card.patch.title.trim() || card.patch.name,
    connections: new Map<string, string>()
  } satisfies LogNames;
});

/** W-2 on the card: the owner's and admins' last three entries, once the patch has any or serves tier 2. */
const recentActivity = Effect.fn("PortalPages.recentActivity")(function* (
  card: Patches.PortalCard,
  all: boolean,
  now: number
) {
  const { viewer } = yield* context;
  if (viewer.role !== "admin" && card.owner.id !== viewer.user.id) return "";
  const { entries } = yield* (yield* InvocationLog.InvocationLog).page({
    companyId: viewer.company.id,
    patchId: card.patch.id,
    limit: 3,
    trees: false
  });
  if (entries.length === 0 && card.tier < 2) return "";
  const names = yield* logNames(card, viewer.company.id);
  return renderRecentActivity({ patch: card.patch, all, now, names, entries });
});

const overlongName = errorPage(
  414,
  "Patch name is too long",
  `Patch names have at most ${maxNameLength} characters.`
);

const render = Effect.fn("PortalPages.render")(function* (
  name?: string,
  options: {
    status?: number;
    notice?: string;
    submittedDescription?: string;
    descriptionError?: string;
    versions?: boolean;
  } = {}
) {
  const { viewer, session, all, access } = yield* context;
  if (name !== undefined && name.length > maxNameLength) return yield* overlongName;
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
  if (name !== undefined && selected !== undefined)
    yield* WideEvents.enrich(Patches.eventFields(selected.patch));
  const card = selected ? yield* patches.portalCard(selected.patch.id, access) : null;
  const now = yield* Clock.currentTimeMillis;
  const body =
    options.versions && card
      ? renderVersions({ card, viewer, all, now })
      : renderPortal({
          rows,
          card,
          viewer,
          all,
          now,
          publicBaseUrl: session.publicBaseUrl,
          activity: card === null ? "" : yield* recentActivity(card, all, now),
          notice: options.notice,
          submittedDescription: options.submittedDescription,
          descriptionError: options.descriptionError
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

const decodeAgentPolicy = Schema.decodeUnknownEffect(
  Schema.Struct({
    mode: AgentMode,
    revision: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  })
);

const agentAccessPage = Effect.fn("PortalPages.agentAccessPage")(
  function* (name: string) {
    const { viewer, session, access, all } = yield* context;
    if (name.length > maxNameLength) return yield* overlongName;
    if (!isName(name))
      return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
    const rows = yield* (yield* Patches.Patches).read({ ...access, state: "all" });
    const selected = rows.find((row) => row.patch.name === name);
    if (selected === undefined)
      return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
    const agents = yield* AgentAccess.AgentAccess;
    const actor = { userId: viewer.user.id, companyId: viewer.company.id };
    const request = yield* HttpServerRequest.HttpServerRequest;
    const choices = rows
      .filter(
        (row) =>
          (row.owner.id === viewer.user.id || viewer.role === "admin") &&
          row.patch.state === "live" &&
          row.tier === 2 &&
          row.patch.scope === "company"
      )
      .map((row) => row.patch.name)
      .sort();
    if (request.method === "GET") {
      const choice = new URL(request.url, session.publicBaseUrl).searchParams.get("patch");
      if (choice !== null) {
        if (!choices.includes(choice))
          return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
        return HttpServerResponse.redirect(
          `/patches/${encodeURIComponent(choice)}/agent-access${all ? "?all=1" : ""}`,
          { status: 303, headers: { "cache-control": "private, no-store" } }
        );
      }
    }
    let notice: string | undefined;
    let status = 200;
    if (request.method === "POST") {
      const entries = yield* request.urlParamsBody.pipe(
        Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(16_384))
      );
      const form = Object.fromEntries(entries);
      const posted = Effect.gen(function* () {
        if (form.expectedPatchId !== selected.patch.id)
          return yield* new AgentAccess.AgentAccessInvalid({ reason: "stale" });
        switch (form.action) {
          case "save": {
            const policy = yield* decodeAgentPolicy(form);
            yield* agents.save(selected.patch.id, actor, {
              ...policy,
              handlers: [...entries].filter(([key]) => key === "handler").map(([, value]) => value)
            });
            break;
          }
          case "grant":
            yield* agents.grant(selected.patch.id, actor, form.machineId ?? "");
            break;
          case "revoke":
            yield* agents.revoke(selected.patch.id, actor, form.machineId ?? "");
            break;
          default:
            return yield* new AgentAccess.AgentAccessInvalid({ reason: "handler" });
        }
        return HttpServerResponse.redirect(
          `/patches/${encodeURIComponent(name)}/agent-access${all ? "?all=1" : ""}`,
          {
            status: 303,
            headers: { "cache-control": "private, no-store" }
          }
        );
      });
      const result = yield* posted.pipe(
        Effect.catchTags({
          AgentAccessInvalid: (error) =>
            Effect.sync(() => {
              notice = error.message;
              status = 409;
              return null;
            }),
          SchemaError: () =>
            Effect.sync(() => {
              notice = "Check the submitted fields.";
              status = 422;
              return null;
            })
        })
      );
      if (result !== null) return result;
    }
    const settings = yield* agents.inspect(selected.patch.id, actor);
    return pageResponse(
      {
        title: `${name} agent access`,
        heading: "",
        styles,
        status,
        body: renderAgentAccess({
          name,
          patchId: selected.patch.id,
          choices,
          access: settings,
          notice,
          all
        }),
        app: { viewer, section: "patches" }
      },
      session
    );
  },
  Effect.catchTags({
    AgentAccessDenied: () =>
      errorPage(
        403,
        "Access refused",
        "Only the patch owner or a company admin can manage agent access. Nothing was done."
      ),
    AgentAccessInvalid: (error) =>
      errorPage(409, "Agent access unavailable", `${error.message} Nothing was done.`)
  })
);

const confirmationPage = Effect.fn("PortalPages.confirmationPage")(function* (
  name: string,
  action: ConfirmationAction,
  form: {
    status?: number;
    notice?: string;
    submittedName?: string;
    nameError?: string;
    selectedOwnerId?: string;
    acknowledged?: boolean;
  } = {}
) {
  const { viewer, session, all, access, query } = yield* context;
  if (name.length > maxNameLength) return yield* overlongName;
  if (!isName(name))
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  const patches = yield* Patches.Patches;
  const rows = yield* patches.read({ ...access, state: "all" });
  const selected = rows.find((row) => row.patch.name === name);
  if (selected === undefined)
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  yield* WideEvents.enrich(Patches.eventFields(selected.patch));
  const card = yield* patches.portalCard(selected.patch.id, access);
  if (viewer.role !== "admin" && (action === "reassign" || card.owner.id !== viewer.user.id))
    return yield* render(name, {
      status: 403,
      notice: action === "reassign" ? adminRequired : forbidden
    });
  if (action === "restore" && form.status === undefined && card.offSources.length === 0)
    return HttpServerResponse.redirect(
      `/patches/${encodeURIComponent(card.patch.name)}${all ? "?all=1" : ""}`,
      { status: 303, headers: { "cache-control": "private, no-store" } }
    );
  if (
    (action === "retire" && card.patch.state !== "live") ||
    (action === "delete" && card.patch.state === "deleted") ||
    (action === "restore" && card.patch.state === "live")
  )
    return yield* render(name, {
      status: 409,
      notice: `This patch is ${card.patch.state}. This action is not available. Nothing was done.`
    });
  const members = action === "reassign" ? yield* (yield* Users.Users).list(viewer.company.id) : [];
  const now = yield* Clock.currentTimeMillis;
  return pageResponse(
    {
      title: `${card.patch.name} ${action}`,
      heading: "",
      body: renderConfirmation({
        card,
        viewer,
        all,
        now,
        action,
        members,
        query,
        notice: form.notice,
        submittedName: form.submittedName,
        nameError: form.nameError,
        selectedOwnerId: form.selectedOwnerId,
        acknowledged: form.acknowledged
      }),
      styles,
      status: form.status ?? 200,
      app: { viewer, section: "patches" }
    },
    session
  );
});

/** The patch's log for its current owner and admins: newest first, filtered and paged by cursor. */
const logPage = Effect.fn("PortalPages.logPage")(function* (name: string) {
  const { viewer, session, all, access } = yield* context;
  if (name.length > maxNameLength) return yield* overlongName;
  if (!isName(name))
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  const patches = yield* Patches.Patches;
  const selected = (yield* patches.read({ ...access, state: "all" })).find(
    (row) => row.patch.name === name
  );
  if (selected === undefined)
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  yield* WideEvents.enrich(Patches.eventFields(selected.patch));
  // Ownership is read now, so reassignment moves who may read the log.
  if (viewer.role !== "admin" && selected.owner.id !== viewer.user.id)
    return yield* render(name, { status: 403, notice: logForbidden });
  const card = yield* patches.portalCard(selected.patch.id, access);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const query = new URL(request.url, session.publicBaseUrl).searchParams;
  const param = (key: string) => {
    const value = query.get(key);
    return value === null || value === "" || value.length > maxFilterLength ? undefined : value;
  };
  const outcome = param("outcome");
  const filter = {
    outcome: isOutcomeFilter(outcome) ? outcome : undefined,
    viewerId: param("person"),
    handler: param("handler")
  };
  const before = param("before");
  const log = yield* InvocationLog.InvocationLog;
  const scope = { companyId: viewer.company.id, patchId: card.patch.id };
  const page = yield* log.page({ ...scope, before, filter, limit: 25 });
  const choices = yield* log.choices(scope);
  const names = yield* logNames(card, viewer.company.id);
  // Calls record the connection's id; readers know it by its handle. A connection deleted
  // since, or a store that cannot answer, leaves the id.
  const connections = page.entries.some((entry) =>
    entry.tree.some((item) => item.connectionId !== null)
  )
    ? yield* (yield* ConnectionStore.ConnectionStore)
        .list(viewer.company.id)
        .pipe(Effect.orElseSucceed(() => []))
    : [];
  return pageResponse(
    {
      title: `${card.patch.name} log`,
      heading: "",
      body: renderLog({
        patch: card.patch,
        all,
        now: yield* Clock.currentTimeMillis,
        names: {
          ...names,
          connections: new Map(connections.map((connection) => [connection.id, connection.handle]))
        },
        entries: page.entries,
        next: page.next,
        windowEnded: page.windowEnded,
        before,
        filter,
        choices
      }),
      styles,
      app: { viewer, section: "patches" }
    },
    session
  );
});

const post = Effect.fn("PortalPages.post")(function* (name: string, action: PatchAction) {
  if (name.length > maxNameLength) return yield* overlongName;
  if (!isName(name))
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  const { viewer, all, access } = yield* context;
  const patches = yield* Patches.Patches;
  const rows = yield* patches.read({ ...access, state: "all" });
  const selected = rows.find((row) => row.patch.name === name);
  if (!selected)
    return yield* errorPage(404, "Patch not found", "The requested patch is unavailable.");
  yield* WideEvents.enrich(Patches.eventFields(selected.patch));
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = Object.fromEntries(
    yield* request.urlParamsBody.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(16_384))
    )
  );
  // Every form carries the id of the patch it was rendered for. A form without it, or
  // whose name now belongs to another patch, stops on the card before any other check:
  // a re-rendered form would post at whichever patch holds the name now.
  if (form.expectedPatchId !== selected.patch.id)
    return yield* render(name, {
      status: 409,
      notice: form.expectedPatchId
        ? "This name now belongs to a different patch. Nothing was done."
        : "This form is out of date. Nothing was done."
    });
  if (viewer.role !== "admin" && (action === "reassign" || selected.owner.id !== viewer.user.id))
    return yield* render(name, {
      status: 403,
      notice: action === "reassign" ? adminRequired : forbidden
    });
  const actor = { userId: viewer.user.id, admin: viewer.role === "admin" };
  const confirmation =
    action === "retire" || action === "delete" || action === "restore" || action === "reassign"
      ? action
      : undefined;
  const redisplay = (status: number, notice: string, nameError?: string) =>
    confirmation === undefined
      ? render(name, { status, notice })
      : confirmationPage(name, confirmation, {
          status,
          notice: nameError === undefined ? notice : undefined,
          nameError,
          submittedName: form.confirm ?? "",
          selectedOwnerId: form.user ?? "",
          acknowledged: form.ack === "1"
        });
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
        const rolledBack = yield* patches.rollback(
          selected.patch.id,
          actor,
          fields.versionNumber,
          fields.expectedCurrentVersionId || null
        );
        yield* WideEvents.enrich(Patches.eventFields(rolledBack.patch));
        break;
      }
      case "restore": {
        const fields = yield* decodeRestore(form);
        yield* patches.restore(selected.patch.id, actor, form.ack === "1", fields.expectedState);
        break;
      }
      case "retire": {
        yield* decodeRetire(form);
        yield* patches.retire(selected.patch.id, actor, form.ack === "1");
        break;
      }
      case "delete": {
        const fields = yield* decodeDelete(form);
        if (fields.confirm !== selected.patch.name) {
          const message = `Type ${selected.patch.name} to confirm. Nothing was done.`;
          return yield* redisplay(422, message, message);
        }
        yield* patches.delete(selected.patch.id, actor, form.ack === "1");
        break;
      }
      case "reassign": {
        const fields = yield* decodeReassign(form);
        yield* patches.reassign(selected.patch.id, actor, fields.user, fields.expectedOwnerUserId);
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
  const stale = Effect.fn("PortalPages.stale")(function* (state?: Patches.Patch["state"]) {
    const fresh = yield* patches.portalCard(selected.patch.id, access);
    const when =
      fresh.patch.lastChangedAt === null
        ? ""
        : ` ${ago(fresh.patch.lastChangedAt, yield* Clock.currentTimeMillis)}`;
    return yield* render(name, {
      status: 409,
      notice: `${state === undefined ? "" : `This patch is ${state}. `}This patch changed while you had this page open: ${fresh.lastChangedAction ?? "updated"} by ${fresh.actorNames.lastChanged ?? fresh.owner.name}${when}. Nothing was done.`
    });
  });
  const invalid = (notice: string) =>
    confirmation === undefined
      ? render(name, {
          status: 422,
          ...(action === "description"
            ? { submittedDescription: form.description ?? "", descriptionError: notice }
            : { notice })
        })
      : redisplay(422, notice);
  return yield* run.pipe(
    Effect.catchTags({
      StaleAction: () => stale(),
      NotOwner: () => render(name, { status: 403, notice: forbidden }),
      AdminRequired: () => render(name, { status: 403, notice: adminRequired }),
      WrongState: (error) => stale(error.state),
      PatchDeleted: (error) =>
        render(name, { status: 409, notice: `${error.message} Nothing was done.` }),
      PatchRetired: (error) =>
        render(name, { status: 409, notice: `${error.message} Nothing was done.` }),
      SourcesOff: () => redisplay(409, "Some sources are off. Nothing was done."),
      InvalidDescription: (error) => invalid(`${error.message} Nothing was done.`),
      Tier2NotPublic: (error) => invalid(`${error.message} Nothing was done.`),
      SchemaError: () => invalid("Check the submitted fields and try again. Nothing was done."),
      VersionUnavailable: (error) => invalid(`${error.message} Nothing was done.`),
      HasDependants: () =>
        redisplay(
          409,
          "These patches read this patch's tables. Acknowledge that they will break before continuing. Nothing was done."
        ),
      ReservedName: (error) => invalid(error.message),
      InvalidOwner: () =>
        redisplay(409, "Choose an active member of this company. Nothing was done.")
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

const patchRoutes = [
  ...(["GET", "POST"] as const).map((method) => ({
    method,
    path: "/patches/:name/agent-access" as const,
    handle: agentAccessPage
  })),
  {
    method: "GET" as const,
    path: "/patches/:name" as const,
    handle: (name: string) => render(name)
  },
  {
    method: "GET" as const,
    path: "/patches/:name/versions" as const,
    handle: (name: string) => render(name, { versions: true })
  },
  {
    method: "GET" as const,
    path: "/patches/:name/log" as const,
    handle: logPage
  },
  ...(["retire", "delete", "restore", "reassign"] as const).map((action) => ({
    method: "GET" as const,
    path: `/patches/:name/${action}` as const,
    handle: (name: string) => confirmationPage(name, action)
  })),
  ...(["description", "scope", "rollback", "retire", "delete", "restore", "reassign"] as const).map(
    (action) => ({
      method: "POST" as const,
      path: `/patches/:name/${action}` as const,
      handle: (name: string) => post(name, action)
    })
  )
];

export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      | Session.Session
      | Companies.Companies
      | Users.Users
      | Patches.Patches
      | AgentAccess.AgentAccess
      | InvocationLog.InvocationLog
      | ConnectionStore.ConnectionStore
      | SqlClient.SqlClient
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    for (const action of ["deactivate", "reactivate"] as const) {
      for (const method of ["GET", "POST"] as const) {
        const handler = RequireSession.withViewer(
          Effect.flatMap(HttpRouter.params, (params) =>
            UserLifecyclePage.handle(params.id ?? "", action)
          )
        );
        yield* router.add(
          method,
          `/company/users/:id/${action}`,
          errors(method === "POST" ? RequireSession.sameOrigin(handler) : handler)
        );
      }
    }
    for (const route of patchRoutes) {
      const handler = RequireSession.withViewer(
        Effect.flatMap(
          HttpRouter.params,
          (
            params
          ): Effect.Effect<
            HttpServerResponse.HttpServerResponse,
            Effect.Error<ReturnType<(typeof patchRoutes)[number]["handle"]>>,
            Effect.Services<ReturnType<(typeof patchRoutes)[number]["handle"]>>
          > => route.handle(params.name ?? "")
        ).pipe(pageErrors)
      );
      yield* router.add(
        route.method,
        route.path,
        errors(route.method === "POST" ? RequireSession.sameOrigin(handler) : handler)
      );
    }
    yield* router.add(
      "GET",
      "/patches/*",
      errors(
        RequireSession.withViewer(
          Effect.flatMap(HttpRouter.params, (params) =>
            (params["*"]?.split("/", 1)[0] ?? "").length > maxNameLength
              ? overlongName
              : errorPage(404, "Patch not found", "The requested patch is unavailable.")
          ).pipe(pageErrors)
        )
      )
    );
  })
);
