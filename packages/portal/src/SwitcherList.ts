/**
 * The switcher's list at `GET /switcher.json`: the patches a signed-in person can jump to. It
 * holds their company's live patches they can open, with their own open times, and the patches
 * other companies shared with them that they can open now. Never another company's public
 * patch: a grant outlives its patch going public and back, so a shared patch drops out while it
 * is public.
 *
 * Only a script on a Patchy page asks for it, with the browser's session; it is not part of the
 * agents' API. Anything else, a machine token included, is refused before authentication, and
 * every refusal is JSON the script can act on, never a page or a redirect. Once Clerk has read
 * the session, every answer carries the cookies it set, as a page's does, so a session it
 * refreshed on the way stays refreshed.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as WideEvents from "@patchy/analytics/wide-events";
import { RequireSession, Session, withCookies } from "@patchy/auth";
import type { Companies, Users } from "@patchy/companies";
import { WhatsNew } from "@patchy/core";
import { GuestGrants, Patches } from "@patchy/patches";

/** What `/switcher.json` answers a signed-in person. Titles are as published, possibly blank. */
export interface SwitcherList {
  readonly viewer: { readonly id: string; readonly companyId: string; readonly role: Users.Role };
  readonly company: { readonly handle: string; readonly name: string };
  /** How many What's new changes shipped since the viewer last looked. */
  readonly whatsNewUnseen: number;
  /** The company's live patches the viewer can open, its public ones included. */
  readonly patches: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly title: string;
    readonly tier: number;
    /** The viewer owns it. */
    readonly mine: boolean;
    /** When the viewer last opened it; absent until they do. */
    readonly openedAt?: string;
    /** The viewer's halving open score, as Home's Your usual ranks by; absent with `openedAt`. */
    readonly score?: number;
  }>;
  /** Other companies' patches shared with the viewer that they can open now and aren't public. */
  readonly shared: ReadonlyArray<{
    readonly id: string;
    readonly company: { readonly handle: string; readonly name: string };
    readonly name: string;
    readonly title: string;
    readonly tier: number;
  }>;
}

const noStore = { "cache-control": "private, no-store" };

/**
 * Each refusal's status and words. The script acts on `code`, and the session's codes are the
 * runtime stream's: `session_refresh_required` asks it to refresh the session and ask again,
 * `session_expired` means signed out, and `unavailable` to keep what it has and try later.
 */
const refusals = {
  access_denied: [403, "Only a Patchy page, for someone signed in to their company, can ask."],
  session_expired: [401, "Sign in to Patchy."],
  session_refresh_required: [401, "Refresh your session and ask again."],
  unavailable: [503, "The list is unavailable. Try again."]
} as const;

const refuse = (code: keyof typeof refusals) => {
  const [status, error] = refusals[code];
  return HttpServerResponse.jsonUnsafe({ ok: false, code, error }, { status, headers: noStore });
};

/** The answer to a request Clerk has read: the list, or why not. */
const answer = Effect.fn("SwitcherList.answer")(
  function* (result: Exclude<Session.SessionResult, { readonly status: "handshake" }>) {
    if (Session.refreshable(result, yield* Clock.currentTimeMillis))
      return refuse("session_refresh_required");
    if (result.status === "signed-out") return refuse("session_expired");
    const viewer = yield* RequireSession.resolveViewer.pipe(
      Effect.provideService(RequireSession.SignedIn, result.claims)
    );
    // No membership yet, or deactivated.
    if (viewer === null || HttpServerResponse.isHttpServerResponse(viewer))
      return refuse("access_denied");
    yield* WideEvents.enrich({ viewerId: viewer.user.id, companyId: viewer.company.id });

    const patches = yield* Patches.Patches;
    const canOpen = yield* Patches.Openability;
    const rows = yield* patches
      .list({
        companyId: viewer.company.id,
        userId: viewer.user.id,
        canOpen: (patch) => canOpen(patch, viewer.user.id),
        state: "live"
      })
      // Only a `patchRef` read can fail these.
      .pipe(Effect.catchTags({ PatchUnavailable: Effect.die, WrongState: Effect.die }));
    const opens = new Map(
      (yield* patches.opens(viewer.user.id)).map((open) => [open.patchId, open])
    );
    const shared = yield* (yield* GuestGrants.GuestGrants).sharedWith(viewer.user.id);
    const body: SwitcherList = {
      viewer: { id: viewer.user.id, companyId: viewer.company.id, role: viewer.role },
      company: { handle: viewer.company.handle, name: viewer.company.name },
      whatsNewUnseen: WhatsNew.changesSince(viewer.whatsNewSeen).length,
      patches: rows.map(({ patch, tier }) => {
        const open = opens.get(patch.id);
        return {
          id: patch.id,
          name: patch.name,
          title: patch.title,
          tier,
          mine: patch.ownerUserId === viewer.user.id,
          ...(open === undefined ? {} : { openedAt: open.lastOpenedAt, score: open.score })
        };
      }),
      shared: shared
        .filter((entry) => Option.isNone(entry.unavailable) && entry.scope !== "public")
        .map(({ patchId, company, name, title, tier }) => ({
          id: patchId,
          company,
          name,
          title,
          tier
        }))
    };
    return HttpServerResponse.jsonUnsafe(body, { headers: noStore });
  },
  Effect.catchTags({
    SqlError: () => Effect.succeed(refuse("unavailable")),
    ConnectionStorageFailed: () => Effect.succeed(refuse("unavailable"))
  })
);

const list = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // Before authentication, which could start a handshake: only this origin's scripts ask.
  if (
    request.headers.authorization !== undefined ||
    request.headers["sec-fetch-site"] !== "same-origin"
  )
    return refuse("access_denied");
  const session = yield* Session.Session;
  const result = yield* session.authenticate(
    new Request(new URL(request.url, session.publicBaseUrl), {
      method: request.method,
      headers: request.headers
    })
  );
  // A script can't follow Clerk's handshake: it refreshes the session and asks again.
  if (result.status === "handshake") return refuse("session_refresh_required");
  return withCookies(yield* answer(result), result.cookies);
}).pipe(Effect.catchTags({ SessionError: () => Effect.succeed(refuse("unavailable")) }));

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
      | GuestGrants.GuestGrants
      | SqlClient.SqlClient
    >
> = HttpRouter.use((router) => router.add("GET", "/switcher.json", list));
