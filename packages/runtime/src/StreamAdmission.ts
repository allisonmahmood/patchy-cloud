import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { RequireSession, Session } from "@patchy/auth";
import { runtimeActorId, type RuntimeGuest, type RuntimeMember } from "@patchy/api";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";

type Dependencies =
  | Session.Session
  | LoadedVersions.LoadedVersions
  | Exclude<
      Effect.Services<ReturnType<typeof RequireSession.resolveCompanyIdentity>>,
      RequireSession.SignedIn
    >;
export interface Identity {
  readonly companyId: string;
  readonly viewerId: string;
  readonly expiresAt: number;
  readonly identity: RuntimeMember | RuntimeGuest;
}

/** Production verifies cookies; dev supplies its two explicit mount identities.
 * @effect-expect-leaking HttpServerRequest
 */
export class StreamAdmission extends Context.Service<
  StreamAdmission,
  {
    /** Targeted admission retains a guest's patch/version/grant rather than a member Viewer. */
    readonly forVersion?: (
      version: LoadedVersions.LoadedVersion
    ) => Effect.Effect<
      Identity & { readonly recheck: Effect.Effect<Identity, Runtime.RuntimeError> },
      Runtime.RuntimeError,
      HttpServerRequest.HttpServerRequest
    >;
    readonly admit: Effect.Effect<
      Identity & { readonly recheck: Effect.Effect<Identity, Runtime.RuntimeError> },
      Runtime.RuntimeError,
      HttpServerRequest.HttpServerRequest
    >;
  }
>()("@patchy/runtime/StreamAdmission") {}

export const make: Effect.Effect<StreamAdmission["Service"], never, Dependencies> = Effect.gen(
  function* () {
    const session = yield* Session.Session;
    const versions = yield* LoadedVersions.LoadedVersions;
    const viewerContext =
      yield* Effect.context<
        Exclude<
          Effect.Services<ReturnType<typeof RequireSession.resolveCompanyIdentity>>,
          RequireSession.SignedIn
        >
      >();
    const admit = (version?: LoadedVersions.LoadedVersion) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const browserRequest = new Request(new URL(request.url, session.publicBaseUrl), {
          method: request.method,
          headers: request.headers
        });
        const authenticate = session
          .authenticate(browserRequest)
          .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
        const signedIn = yield* authenticate;
        if (signedIn.status !== "signed-in") {
          if (
            signedIn.status === "handshake" ||
            signedIn.reason === "token-expired" ||
            signedIn.reason === "session-token-expired" ||
            signedIn.reason?.startsWith("session-token-expired-refresh-")
          )
            return yield* new Runtime.SessionRefreshRequired({});
          return yield* new Runtime.SessionExpired({});
        }
        if (signedIn.claims.exp * 1_000 <= (yield* Clock.currentTimeMillis))
          return yield* new Runtime.SessionRefreshRequired({});
        const resolved = yield* (
          version === undefined
            ? RequireSession.resolveViewer.pipe(
                Effect.map((viewer) =>
                  viewer === null || HttpServerResponse.isHttpServerResponse(viewer)
                    ? viewer
                    : { kind: "member" as const, viewer }
                )
              )
            : RequireSession.resolveCompanyIdentity(version.companyId)
        ).pipe(
          Effect.provideContext(viewerContext),
          Effect.provideService(RequireSession.SignedIn, signedIn.claims),
          Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
        );
        if (resolved === null || HttpServerResponse.isHttpServerResponse(resolved))
          return yield* new Runtime.AccessDenied({});
        let identity: RuntimeMember | RuntimeGuest;
        if (resolved.kind === "guest") {
          if (version === undefined || versions.guestGrant === undefined)
            return yield* new Runtime.AccessDenied({});
          const grantId = yield* versions
            .guestGrant({
              companyId: version.companyId,
              patchId: version.patchId,
              versionId: version.versionId,
              guestId: resolved.guest.id
            })
            .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
          if (grantId === null || version.manifest.tier !== 1)
            return yield* new Runtime.AccessDenied({});
          identity = {
            kind: "guest",
            guest: resolved.guest,
            company: { id: version.companyId },
            patchId: version.patchId,
            versionId: version.versionId,
            grantId
          };
        } else {
          const viewer = resolved.viewer;
          identity = {
            user: { id: viewer.user.id, name: viewer.user.name, email: viewer.user.email },
            company: {
              id: viewer.company.id,
              name: viewer.company.name,
              handle: viewer.company.handle
            },
            admin: viewer.role === "admin"
          };
        }
        return {
          companyId: identity.company.id,
          viewerId: runtimeActorId(identity),
          expiresAt: signedIn.claims.exp * 1_000,
          identity
        };
      });
    const withRecheck = (version?: LoadedVersions.LoadedVersion) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const identity = yield* admit(version);
        return {
          ...identity,
          recheck: admit(version).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request)
          )
        };
      });
    return StreamAdmission.of({ admit: withRecheck(), forVersion: withRecheck });
  }
);

export const layer = Layer.effect(StreamAdmission, make);
