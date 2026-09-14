/**
 * THROWAWAY (prototype #241): the portal's routes. `/` and `/patches/<name>`
 * render the two columns; the pages under a card's URL confirm the
 * destructive moves; every POST is a plain form, same-origin checked, carrying
 * the row's revision. A stale revision re-renders the page it was posted from
 * at 409 with a line saying what changed. The prototype-only role switch is a
 * cookie read here and nowhere else.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { pageResponse, RequireSession, Session, signOutForm, returnPath } from "@patchy/auth";
import type { Companies, Users } from "@patchy/companies";
import { Pages } from "@patchy/serving";
import * as PortalQueries from "./PortalQueries.js";
import * as render from "./render.js";

const PROTO_ROLE_COOKIE = "proto_role";
const MAX_DESCRIPTION = 500;

type Action =
  | { readonly kind: "index" }
  | { readonly kind: "card"; readonly name: string }
  | {
      readonly kind: "retire" | "delete" | "restore" | "reassign" | "versions";
      readonly name: string;
      readonly method: "GET" | "POST";
    }
  | {
      readonly kind: "description" | "scope" | "rollback";
      readonly name: string;
      readonly method: "POST";
    };

interface Page {
  readonly title: string;
  readonly body: string;
  readonly status?: number;
  readonly redirect?: string;
}

const isName = (value: string | undefined): value is string =>
  value !== undefined && /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(value);

/** The viewer the pages act as: the real one, lowered to member by the prototype cookie. */
const effectiveViewer = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const lowered = viewer.role === "admin" && request.cookies[PROTO_ROLE_COOKIE] === "member";
  return {
    user: viewer.user,
    company: viewer.company,
    role: lowered ? ("member" as const) : viewer.role,
    realRole: viewer.role
  } satisfies render.PortalViewer;
});

/** The difference between two readings of the row, when there is one to name. */
const diffLine = (
  before: PortalQueries.PatchRow,
  after: PortalQueries.PatchRow,
  nowMs: number
): string | null => {
  const was = PortalQueries.stateOf(before);
  const now = PortalQueries.stateOf(after);
  if (was !== now) {
    if (now === "retired")
      return `retired by ${after.retiredByName ?? "someone"} ${render.ago(after.retiredAt!, nowMs)}`;
    if (now === "deleted")
      return `deleted by ${after.deletedByName ?? "someone"} ${render.ago(after.deletedAt!, nowMs)}`;
    return "restored, live again";
  }
  if (before.currentVersionId !== after.currentVersionId && after.currentVersionNumber !== null)
    return `now version ${after.currentVersionNumber}`;
  if (before.description !== after.description)
    return `description edited by ${after.descriptionUpdatedByName ?? "someone"}${after.descriptionUpdatedAt === null ? "" : ` ${render.ago(after.descriptionUpdatedAt, nowMs)}`}`;
  if (before.ownerId !== after.ownerId)
    return `reassigned to ${after.ownerName} by ${after.reassignedByName ?? "someone"}`;
  if (before.scope !== after.scope)
    return after.scope === "public"
      ? "now open to anyone on the internet"
      : "now open to the company only";
  return null;
};

/**
 * What changed since the form's revision, for the 409 line: the difference
 * between the row this request read and the row now when the form matched the
 * former, otherwise the newest actor stamp since the form, otherwise the
 * current state and when it last changed.
 */
const staleLine = (
  before: PortalQueries.PatchRow,
  after: PortalQueries.PatchRow,
  formRevision: number,
  nowMs: number
): string => {
  const state = PortalQueries.stateOf(after);
  const fallback = `now ${state}, last changed ${render.ago(after.updatedAt, nowMs)}`;
  if (before.revision === formRevision) return diffLine(before, after, nowMs) ?? fallback;
  const events: Array<{ at: Date; text: string }> = [];
  if (after.retiredAt !== null)
    events.push({
      at: after.retiredAt,
      text: `retired by ${after.retiredByName ?? "someone"} ${render.ago(after.retiredAt, nowMs)}`
    });
  if (after.deletedAt !== null)
    events.push({
      at: after.deletedAt,
      text: `deleted by ${after.deletedByName ?? "someone"} ${render.ago(after.deletedAt, nowMs)}`
    });
  if (after.descriptionUpdatedAt !== null)
    events.push({
      at: after.descriptionUpdatedAt,
      text: `description edited by ${after.descriptionUpdatedByName ?? "someone"} ${render.ago(after.descriptionUpdatedAt, nowMs)}`
    });
  if (after.reassignedAt !== null)
    events.push({
      at: after.reassignedAt,
      text: `reassigned to ${after.ownerName} by ${after.reassignedByName ?? "someone"} ${render.ago(after.reassignedAt, nowMs)}`
    });
  if (after.publishedAt !== null && after.currentVersionNumber !== null)
    events.push({
      at: after.publishedAt,
      text: `now version ${after.currentVersionNumber}, published by ${after.publisherName ?? "someone"} ${render.ago(after.publishedAt, nowMs)}`
    });
  const since = events
    .filter((event) => event.at.getTime() >= formRevision - 1000)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  if (since.length > 0) return since[0]!.text;
  // Restore, a scope change and a rollback leave no actor stamp; say what is true now.
  return diffLine(before, after, nowMs) ?? fallback;
};

const staleNotice = (what: string) =>
  render.notice(
    `This patch changed while you had this page open: ${what}. Nothing was done. Check it and try again.`,
    "stale"
  );

/** Every page under the card's URL and the card itself, one handler. */
const handle = Effect.fn("PortalPages.handle")(
  function* (action: Action) {
    const viewer = yield* effectiveViewer;
    const session = yield* Session.Session;
    const queries = yield* PortalQueries.PortalQueries;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, session.publicBaseUrl);
    const all = url.searchParams.get("all") === "1";
    const nowMs = yield* Clock.currentTimeMillis;
    const companyId = viewer.company.id;
    const publicBaseUrl = session.publicBaseUrl;

    const loadCard = Effect.fn("PortalPages.loadCard")(function* (row: PortalQueries.PatchRow) {
      return {
        row,
        dependants: yield* queries.dependants(companyId, row.id),
        brokenSources: yield* queries.brokenSources(companyId, row.id),
        versions: yield* queries.versions(row.id)
      } satisfies render.CardData;
    });

    const portalPage = Effect.fn("PortalPages.portalPage")(function* (
      selected: PortalQueries.PatchRow | null,
      options: { readonly status?: number; readonly notice?: string } = {}
    ) {
      const rows = yield* queries.list(companyId);
      const chosen =
        selected ??
        rows.find(
          (row) => PortalQueries.stateOf(row) === "live" && row.ownerId === viewer.user.id
        ) ??
        rows.find((row) => PortalQueries.stateOf(row) === "live") ??
        null;
      const card = chosen === null ? null : yield* loadCard(chosen);
      const page: Page = {
        title: chosen === null ? "Patches" : `${chosen.name} · Patches`,
        body: render.portal({
          viewer,
          rows,
          selected: card,
          all,
          currentPath: url.pathname,
          publicBaseUrl,
          nowMs,
          ...(options.notice === undefined ? {} : { notice: options.notice })
        }),
        ...(options.status === undefined ? {} : { status: options.status })
      };
      return page;
    });

    if (action.kind === "index") return yield* portalPage(null);

    if (!isName(action.name)) return null;
    const found = yield* queries.byName(companyId, action.name);
    if (Option.isNone(found)) return null;
    const row = found.value;
    const state = PortalQueries.stateOf(row);
    const cardPath = `/patches/${encodeURIComponent(row.name)}`;
    const toCard: Page = { title: row.name, body: "", redirect: cardPath };
    const manage = render.canManage(row, viewer);

    if (action.kind === "card") return yield* portalPage(row);

    const refused = (message: string, status = 403) =>
      portalPage(row, { status, notice: render.notice(message, "refused") });

    // --- GET pages under the card ------------------------------------------
    if (action.kind === "versions" && action.method === "GET") {
      const data = yield* loadCard(row);
      const page: Page = {
        title: `Versions of ${row.name}`,
        body: render.versionsPage(data, viewer)
      };
      return page;
    }
    if (action.kind === "reassign" && viewer.role !== "admin")
      return yield* refused("Only an admin can reassign a patch.");
    if (action.kind !== "versions" && !manage)
      return yield* refused("Only the owner or an admin can manage this patch.");

    if (action.method === "GET") {
      const data = yield* loadCard(row);
      switch (action.kind) {
        case "retire":
          return state === "live"
            ? { title: `Retire ${row.name}?`, body: render.retirePage(data, viewer) }
            : toCard;
        case "delete":
          return state === "deleted"
            ? toCard
            : { title: `Delete ${row.name}?`, body: render.deletePage(data, viewer) };
        case "restore":
          return state === "live" || data.brokenSources.length === 0
            ? toCard
            : { title: `Restore ${row.name}?`, body: render.restorePage(data, viewer) };
        case "reassign": {
          const q = url.searchParams.get("q") ?? "";
          const members = yield* queries.members(companyId, q);
          return {
            title: `Reassign ${row.name}`,
            body: render.reassignPage(row, members, q, viewer)
          };
        }
        default:
          return toCard;
      }
    }

    // --- POST actions --------------------------------------------------------
    const form = Object.fromEntries(yield* request.urlParamsBody);
    const revision = Number(form.revision);
    const formRevision = Number.isFinite(revision) ? revision : null;

    /** The page a POST came from, re-rendered with a notice at the given status. */
    const again = Effect.fn("PortalPages.again")(function* (
      kind: Action["kind"],
      status: number,
      noticeHtml: string
    ) {
      const fresh = Option.getOrElse(yield* queries.byName(companyId, row.name), () => row);
      const data = yield* loadCard(fresh);
      let page: Page;
      switch (kind) {
        case "retire":
          page = {
            title: `Retire ${row.name}?`,
            status,
            body: render.retirePage(data, viewer, noticeHtml)
          };
          break;
        case "delete":
          page = {
            title: `Delete ${row.name}?`,
            status,
            body: render.deletePage(data, viewer, noticeHtml)
          };
          break;
        case "restore":
          page =
            data.brokenSources.length === 0
              ? yield* portalPage(fresh, { status, notice: noticeHtml })
              : {
                  title: `Restore ${row.name}?`,
                  status,
                  body: render.restorePage(data, viewer, noticeHtml)
                };
          break;
        case "reassign": {
          const members = yield* queries.members(companyId, "");
          page = {
            title: `Reassign ${row.name}`,
            status,
            body: render.reassignPage(fresh, members, "", viewer, noticeHtml)
          };
          break;
        }
        default:
          page = yield* portalPage(fresh, { status, notice: noticeHtml });
      }
      return page;
    });

    const invalid = (message: string) => again(action.kind, 422, render.notice(message, "refused"));
    if (formRevision === null)
      return yield* invalid("This form has no revision; reload the page and try again.");

    const guarded = { patchId: row.id, revision: formRevision };
    const actorId = viewer.user.id;
    let hit: boolean;
    switch (action.kind) {
      case "description": {
        const description = String(form.description ?? "")
          .replace(/\s+/g, " ")
          .trim();
        if (description.length > MAX_DESCRIPTION)
          return yield* invalid(`Keep the description to ${MAX_DESCRIPTION} characters.`);
        if (state !== "live") return yield* invalid("Restore the patch before editing it.");
        hit = yield* queries.setDescription({ ...guarded, description, actorId });
        break;
      }
      case "scope": {
        const scope = form.scope;
        if (scope !== "company" && scope !== "public")
          return yield* invalid("Choose who can open it.");
        if (state !== "live") return yield* invalid("Restore the patch before changing it.");
        hit = yield* queries.setScope({ ...guarded, scope });
        break;
      }
      case "rollback": {
        const versionId = String(form.versionId ?? "");
        const versions = yield* queries.versions(row.id);
        if (!versions.some((version) => version.id === versionId))
          return yield* invalid("That version does not belong to this patch.");
        if (state !== "live")
          return yield* invalid("Restore the patch before changing its version.");
        hit = yield* queries.rollback({ ...guarded, versionId });
        break;
      }
      case "retire": {
        if (state !== "live") return yield* invalid("This patch is already off.");
        const dependants = yield* queries.dependants(companyId, row.id);
        if (dependants.length > 0 && form.ack !== "1")
          return yield* invalid("Tick the acknowledgement first.");
        hit = yield* queries.retire({ ...guarded, actorId });
        break;
      }
      case "delete": {
        if (state === "deleted") return yield* invalid("This patch is already deleted.");
        if (String(form.confirm ?? "").trim() !== row.name)
          return yield* invalid("Type the patch's name exactly to delete it.");
        if (state === "live") {
          const dependants = yield* queries.dependants(companyId, row.id);
          if (dependants.length > 0 && form.ack !== "1")
            return yield* invalid("Tick the acknowledgement first.");
        }
        hit = yield* queries.delete({ ...guarded, actorId });
        break;
      }
      case "restore": {
        if (state === "live") return yield* invalid("This patch is already live.");
        const broken = yield* queries.brokenSources(companyId, row.id);
        if (broken.length > 0 && form.ack !== "1")
          return yield* invalid("Tick the acknowledgement first.");
        hit = yield* queries.restore(guarded);
        break;
      }
      case "reassign": {
        const targetUserId = String(form.user ?? "");
        const members = yield* queries.members(companyId, "");
        if (!members.some((member) => member.id === targetUserId))
          return yield* invalid("Choose an active member of the company.");
        if (targetUserId === row.ownerId) return toCard;
        hit = yield* queries.reassign({ ...guarded, targetUserId, actorId });
        break;
      }
      default:
        return toCard;
    }
    if (hit) return toCard;
    const after = Option.getOrElse(yield* queries.byName(companyId, row.name), () => row);
    return yield* again(action.kind, 409, staleNotice(staleLine(row, after, formRevision, nowMs)));
  },
  Effect.catchTags({ SqlError: Effect.die })
);

const respond = (action: Action) =>
  Effect.gen(function* () {
    const session = yield* Session.Session;
    const page = yield* handle(action);
    if (page === null) return Pages.notFound;
    if (page.redirect !== undefined)
      return HttpServerResponse.redirect(page.redirect, {
        status: 303,
        headers: { "cache-control": "private, no-store" }
      });
    return pageResponse(
      {
        title: page.title,
        heading: "",
        body: page.body,
        styles: render.styles,
        ...(page.status === undefined ? {} : { status: page.status })
      },
      session
    );
  });

/** The prototype switch: a cookie, set or cleared, then back to where the form was. */
const setProtoRole = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = Object.fromEntries(yield* request.urlParamsBody);
  const target = returnPath(request.headers.referer ?? null, session.publicBaseUrl) ?? "/";
  const response = HttpServerResponse.redirect(target, {
    status: 303,
    headers: { "cache-control": "private, no-store" }
  });
  const member = viewer.role === "admin" && form.role === "member";
  return yield* HttpServerResponse.setCookie(response, PROTO_ROLE_COOKIE, member ? "member" : "", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: member ? "30 days" : "0 seconds"
  }).pipe(Effect.catchTags({ CookieError: Effect.die }));
});

/** The same retryable pages the auth routes answer with. */
const errors = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const session = yield* Session.Session;
    return yield* app.pipe(
      Effect.catchTags({
        SessionError: () =>
          Effect.succeed(
            pageResponse(
              {
                title: "Sign-in service unavailable",
                body: `<p>Please try again.</p>${signOutForm()}`,
                status: 502
              },
              session
            )
          ),
        SqlError: () =>
          Effect.succeed(
            pageResponse(
              {
                title: "Company service unavailable",
                body: `<p>Please try again.</p>${signOutForm()}`,
                status: 503
              },
              session
            )
          ),
        HttpServerError: () =>
          Effect.succeed(
            pageResponse(
              {
                title: "Invalid form",
                body: `<p>Return to <a href="/">your patches</a> and submit the form again.</p>${signOutForm()}`,
                status: 400
              },
              session
            )
          )
      })
    );
  });

const named = (build: (name: string) => Action) =>
  Effect.flatMap(HttpRouter.params, (params) => respond(build(params.name ?? "")));

export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      | Session.Session
      | Companies.Companies
      | Users.Users
      | SqlClient.SqlClient
      | PortalQueries.PortalQueries
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const get = (path: `/${string}`, build: (name: string) => Action) =>
      router.add("GET", path, errors(RequireSession.withViewer(named(build))));
    const post = (path: `/${string}`, build: (name: string) => Action) =>
      router.add(
        "POST",
        path,
        errors(RequireSession.sameOrigin(RequireSession.withViewer(named(build))))
      );
    yield* router.add("GET", "/", errors(RequireSession.withViewer(respond({ kind: "index" }))));
    yield* get("/patches/:name", (name) => ({ kind: "card", name }));
    yield* get("/patches/:name/versions", (name) => ({ kind: "versions", name, method: "GET" }));
    for (const kind of ["retire", "delete", "restore", "reassign"] as const) {
      yield* get(`/patches/:name/${kind}`, (name) => ({ kind, name, method: "GET" }));
      yield* post(`/patches/:name/${kind}`, (name) => ({ kind, name, method: "POST" }));
    }
    for (const kind of ["description", "scope", "rollback"] as const) {
      yield* post(`/patches/:name/${kind}`, (name) => ({ kind, name, method: "POST" }));
    }
    yield* router.add(
      "POST",
      "/proto/role",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(setProtoRole)))
    );
  })
);
