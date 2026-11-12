// What more than one portal surface's handlers need: the request context, error wiring, patch-name
// guards, the Share dialog over a page and the way back to it, and the reads several pages make.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { Analytics } from "@patchy/analytics";
import { PatchName } from "@patchy/api";
import {
  type AgentConnections,
  type MachineTokens,
  pageResponse,
  RequireSession,
  Session
} from "@patchy/auth";
import { ago, type Cryptography, escapeHtml } from "@patchy/core";
import { Teams, type Companies, type Users } from "@patchy/companies";
import type { Feedback } from "@patchy/feedback";
import type { ConnectionStore, PatchVisibility } from "@patchy/integrations";
import type { Limits } from "@patchy/limits";
import { GuestGrants, Patches } from "@patchy/patches";
import { InvocationLog, Prewarm } from "@patchy/runtime";
import { renderShareDialog, type ShareRefusal } from "../share.js";
import { manages } from "./presentation.js";

/** The services the portal's routes run on, which the server provides. */
export type PortalServices =
  | Cryptography.Cryptography
  | Session.Session
  | Companies.Companies
  | Users.Users
  | Teams.Teams
  | Patches.Patches
  | GuestGrants.GuestGrants
  | MachineTokens.MachineTokens
  | AgentConnections.AgentConnections
  | InvocationLog.InvocationLog
  | ConnectionStore.ConnectionStore
  | Feedback.Feedback
  | Analytics.Analytics
  | Limits.Limits
  | SqlClient.SqlClient
  | PatchVisibility.PatchVisibility;

/** A surface's routes: they need only the portal's services and answer every failure themselves. */
export type Routes = Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", PortalServices>
>;

/** A page drawn for the request's signed-in viewer, failing only as `pageErrors` and `errors` answer. */
export type Page = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  SqlError | Patches.PatchUnavailable | Patches.WrongState,
  | PortalServices
  | RequireSession.Viewer
  | RequireSession.SignedIn
  | HttpServerRequest.HttpServerRequest
>;

export const isName = Schema.is(PatchName);
export const maxNameLength = 32;

export const forbidden = "Only the owner or an admin can do that. Nothing was done.";

/** Who is asking, where, and what they can open: every portal handler starts here. */
export const context = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const canOpen = yield* Patches.Openability;
  const url = new URL(request.url, session.publicBaseUrl);
  return {
    viewer,
    session,
    url,
    query: request.method === "GET" ? (url.searchParams.get("q") ?? "") : "",
    access: {
      companyId: viewer.company.id,
      userId: viewer.user.id,
      canOpen: (patch: Patches.Patch) => canOpen(patch, viewer.user.id)
    }
  };
});

export const errorPage = Effect.fn("Portal.errorPage")(function* (
  status: number,
  title: string,
  message: string
) {
  const { viewer, session } = yield* context;
  return pageResponse(
    {
      title,
      status,
      body: `<p>${escapeHtml(message)}</p><p><a href="/">Back to Home</a></p>`,
      app: { viewer, section: "patches" }
    },
    session
  );
});

export const overlongName = errorPage(
  414,
  "Patch name is too long",
  `Patch names have at most ${maxNameLength} characters.`
);

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

export const pageErrors = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
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

/**
 * What a form posted after its patch changed says: what changed, by whom and when, and the state
 * it's in now when that's why. Nothing was done.
 */
export const staleNotice = Effect.fn("Portal.staleNotice")(function* (
  patchId: string,
  state?: Patches.Patch["state"]
) {
  const { access } = yield* context;
  const fresh = yield* (yield* Patches.Patches).portalCard(patchId, access);
  const when =
    fresh.patch.lastChangedAt === null
      ? ""
      : ` ${ago(fresh.patch.lastChangedAt, yield* Clock.currentTimeMillis)}`;
  return `${state === undefined ? "" : `This patch is ${state}. `}This patch changed while you had this page open: ${fresh.lastChangedAction ?? "updated"} by ${fresh.actorNames.lastChanged ?? fresh.owner.name}${when}. Nothing was done.`;
});

/**
 * A Share dialog a page shows over itself: the patch it shares, the page's own URL, and what a
 * refused form of the dialog's left to say. `?share=<name>` asks for one on Home, All patches and
 * a card's tabs, and `&confirm=public` has it ask about going public.
 */
export interface Sharing {
  readonly name: string;
  readonly at: URL;
  readonly status?: number;
  readonly notice?: string;
  readonly refused?: { readonly email: string; readonly refusal: ShareRefusal };
  readonly confirmPublic?: boolean;
  /** What General access's refused form chose, drawn again as it was. */
  readonly submitted?: { readonly scope: string; readonly teamIds: readonly string[] };
  /** The live patches a narrowing would leave without readers, which Save now acknowledges. */
  readonly narrowing?: {
    readonly dependants: readonly { readonly patchId: string; readonly name: string }[];
    readonly hiddenCount: number;
  };
}

/** The Share dialog `url` asks for, if it asks, and whether it asks about going public. */
export const asked = (url: URL): Sharing | undefined => {
  const name = url.searchParams.get("share");
  if (name === null || name === "") return undefined;
  return url.searchParams.get("confirm") === "public"
    ? { name, at: url, confirmPublic: true }
    : { name, at: url };
};

/** A page's own path and query without the dialog: where Share's forms return and Done goes. */
export const pagePath = (url: URL) => {
  const params = new URLSearchParams(url.search);
  params.delete("share");
  params.delete("confirm");
  const search = params.toString();
  return `${url.pathname}${search ? `?${search}` : ""}`;
};

/**
 * Where a Share dialog's form returns: the page it opened over, when that is Home, All patches or
 * the patch's own card, with only the query those pages read: the search, All patches' filter and
 * its page. Anything else is the card.
 */
export const behind = (back: string | undefined, name: string, base: string): URL => {
  const card = `/patches/${encodeURIComponent(name)}`;
  const fallback = new URL(card, base);
  if (back === undefined || !back.startsWith("/") || back.startsWith("//")) return fallback;
  const url = new URL(back, base);
  if (
    url.origin !== fallback.origin ||
    !["/", "/patches", card, `${card}/versions`, `${card}/settings`].includes(url.pathname)
  )
    return fallback;
  const kept = new URL(url.pathname, base);
  for (const key of ["q", "show", "owner", "page"]) {
    const value = url.searchParams.get(key);
    if (value) kept.searchParams.set(key, value);
  }
  return kept;
};

/**
 * The pages a Share dialog opens over, drawn again with it open: Home, All patches and a patch's
 * card, which also answers the dialog's refusals that close it. The portal's route list hands
 * them to the Share routes, so no surface imports another.
 */
export interface PagesBehind {
  readonly home: (sharing: Sharing) => Page;
  readonly allPatches: (sharing: Sharing) => Page;
  readonly card: (
    name: string,
    options: {
      readonly tab?: "versions" | "settings";
      readonly status?: number;
      readonly notice?: string;
      /** No forms at all, for a refusal of a form that was rendered for another patch. */
      readonly readOnly?: boolean;
      readonly sharing?: Sharing;
    }
  ) => Page;
}

/**
 * The Share dialog over a page, for a patch among `rows` the viewer manages that can still change
 * its audience: live, retired, or deleted inside its recovery window. None otherwise, so a stale
 * or foreign `?share=` shows just the page. It shows the receipt its last form left, which the
 * page behind then leaves out, why the patch's guests can't open it, and who its audience reaches
 * that its sources and connections don't.
 */
export const shareOverlay = Effect.fn("Portal.shareOverlay")(function* (
  rows: readonly Patches.ReadPatch[],
  sharing: Sharing | undefined
) {
  if (sharing === undefined) return undefined;
  const { viewer, session } = yield* context;
  const row = rows.find((candidate) => candidate.patch.name === sharing.name);
  if (
    row === undefined ||
    !manages(row) ||
    (row.patch.state === "deleted" &&
      (row.patch.purgeAt === null ||
        Date.parse(row.patch.purgeAt) <= (yield* Clock.currentTimeMillis)))
  )
    return undefined;
  // Someone deactivated since this request began gets the page alone.
  const teams = yield* (yield* Teams.Teams)
    .list({ companyId: viewer.company.id, actorId: viewer.user.id })
    .pipe(
      Effect.map(Option.some),
      Effect.catchTags({ RoleForbidden: () => Effect.succeed(Option.none()) })
    );
  if (Option.isNone(teams)) return undefined;
  const grants = yield* GuestGrants.GuestGrants;
  const guests = yield* grants.guests(row.patch.id);
  // Why its guests can't open it now, read only while it has any.
  const blocked =
    guests.length === 0
      ? undefined
      : (yield* grants
          .unavailableToGuests(viewer.company.id)
          .pipe(Effect.catchTags({ ConnectionStorageFailed: Effect.die }))).get(row.patch.id);
  return renderShareDialog({
    row,
    teams: teams.value,
    viewer,
    publicBaseUrl: session.publicBaseUrl,
    back: pagePath(sharing.at),
    guests,
    suggestions: yield* grants.sharedBefore(viewer.company.id),
    reach: yield* (yield* Patches.Patches).reach(row.patch.id, {
      companyId: viewer.company.id,
      userId: viewer.user.id
    }),
    ...(blocked === undefined ? {} : { turnedAway: blocked }),
    ...(viewer.receipt === undefined ? {} : { receipt: viewer.receipt }),
    ...(sharing.notice === undefined ? {} : { notice: sharing.notice }),
    ...(sharing.refused === undefined ? {} : { refused: sharing.refused }),
    ...(sharing.submitted === undefined ? {} : { submitted: sharing.submitted }),
    ...(sharing.narrowing === undefined ? {} : { narrowing: sharing.narrowing }),
    ...(sharing.confirmPublic === true ? { confirmPublic: true } : {})
  });
});

/** The app shell's options for a page with or without the Share dialog over it. */
export const withOverlay = (
  viewer: RequireSession.Viewer["Service"],
  overlay: string | undefined
): { viewer: RequireSession.Viewer["Service"]; overlay?: string } =>
  overlay === undefined ? { viewer } : { viewer: { ...viewer, receipt: undefined }, overlay };

const DAY = 86_400_000;

/**
 * The call summary: the last 24 hours' calls and failed calls of each live tier 2 patch the viewer
 * manages, none and none for a patch nobody called, so a page can tell no failures from no calls
 * yet. Nothing when they manage none, so a member's pages never query the log.
 */
export const callSummary = Effect.fn("Portal.callSummary")(function* (
  rows: readonly Patches.ReadPatch[]
) {
  const viewer = yield* RequireSession.Viewer;
  const managed = rows.filter(
    (row) => row.patch.state === "live" && row.tier >= 2 && row.access.canOpen && manages(row)
  );
  if (managed.length === 0) return undefined;
  const counts = yield* (yield* InvocationLog.InvocationLog).calls({
    companyId: viewer.company.id,
    since: (yield* Clock.currentTimeMillis) - DAY
  });
  return new Map(
    managed.map((row) => [row.patch.id, counts.get(row.patch.id) ?? { calls: 0, failures: 0 }])
  );
});

/**
 * Why guests can't open each of the company's patches that has guests and turns them away, or
 * nothing when the viewer manages no live patch here, so a member's pages never read grants.
 */
export const turnedAway = Effect.fn("Portal.turnedAway")(function* (
  rows: readonly Patches.ReadPatch[]
) {
  const { viewer } = yield* context;
  if (!rows.some((row) => row.patch.state === "live" && manages(row))) return undefined;
  return yield* (yield* GuestGrants.GuestGrants)
    .unavailableToGuests(viewer.company.id)
    .pipe(Effect.catchTags({ ConnectionStorageFailed: Effect.die }));
});

/**
 * Starts readying the viewer's company task and the live tier 2 tools they are likeliest to open,
 * theirs by how much they open them and then everyone's by visits, without waiting. Hosts without
 * the execution fleet have nothing to ready.
 */
export const prewarm = Effect.fn("Portal.prewarm")(function* (
  rows: readonly Patches.ReadPatch[],
  opens: ReadonlyMap<string, Patches.Open>
) {
  const service = yield* Effect.serviceOption(Prewarm.Prewarm);
  if (Option.isNone(service)) return;
  const { viewer } = yield* context;
  const score = (row: Patches.ReadPatch) => opens.get(row.patch.id)?.score ?? 0;
  const candidates = rows
    .filter((row) => row.patch.state === "live" && row.tier === 2)
    .sort((a, b) => score(b) - score(a) || b.visits - a.visits)
    .flatMap(({ patch }) =>
      patch.currentVersionId === null
        ? []
        : [{ patchId: patch.id, versionId: patch.currentVersionId }]
    );
  if (candidates.length === 0) return;
  yield* service.value.prewarm({
    companyId: viewer.company.id,
    viewerId: viewer.user.id,
    candidates
  });
});

/**
 * The patch a form posted to `/patches/<name>/<act>` acts on: one the viewer can open, or one they
 * manage or own without opening it, whose content is left out.
 */
export const actionSelection = Effect.fn("Portal.actionSelection")(function* (name: string) {
  const { access } = yield* context;
  return (yield* (yield* Patches.Patches).read({ ...access, state: "all", managed: true })).find(
    (row) => row.patch.name === name
  );
});
