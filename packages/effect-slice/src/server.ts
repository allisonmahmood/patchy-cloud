/**
 * The serving capability + apps/server: `/api/*` from the HttpApi, pages as
 * plain router routes, one global middleware for the headers every response
 * carries. `renderDraftWrapper` is stubbed; the headers are the contract.
 */
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { CurrentIdentity, PatchyApi } from "./api.js";
import { AuthorizationLive } from "./auth/index.js";
import { Patches } from "./patches/index.js";

export const DRAFT_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-src 'self' about:; base-uri 'none'; form-action 'none'";

export const MeHandlers = HttpApiBuilder.group(PatchyApi, "me", (handlers) =>
  handlers.handleAll({ me: () => CurrentIdentity })
);

const ApiRoutes = HttpApiBuilder.layer(PatchyApi).pipe(Layer.provide(MeHandlers));

const DraftRoute = HttpRouter.use((router) =>
  router.add(
    "GET",
    "/d/:draftId",
    Effect.gen(function* () {
      const { draftId } = yield* HttpRouter.params;
      const patches = yield* Patches;
      const found = yield* patches.findCurrent(draftId!);
      const headers = { "x-robots-tag": "noindex", "referrer-policy": "no-referrer" };
      if (found._tag === "None") {
        return HttpServerResponse.html("<!doctype html><title>Not found</title>").pipe(
          HttpServerResponse.setStatus(404),
          HttpServerResponse.setHeaders(headers)
        );
      }
      // Best-effort on purpose: a reader one header away from their page gets it.
      yield* patches.recordVisit(draftId!).pipe(Effect.ignoreCause);
      const draft = found.value;
      return HttpServerResponse.html(
        `<!doctype html><title>${draft.title}</title><iframe src="/o/${draft.objectKey}"></iframe>`
      ).pipe(
        HttpServerResponse.setHeaders({
          ...headers,
          "content-security-policy": DRAFT_CONTENT_SECURITY_POLICY,
          "cache-control": "public, max-age=60"
        })
      );
    })
  )
);

/** nosniff everywhere; no-store unless the route chose a cache policy. */
const StandingHeaders = HttpRouter.middleware(
  (httpEffect) =>
    httpEffect.pipe(
      Effect.map((response) =>
        HttpServerResponse.setHeaders(response, {
          "x-content-type-options": "nosniff",
          ...(response.headers["cache-control"] ? {} : { "cache-control": "no-store" })
        })
      )
    ),
  { global: true }
);

/** Every route, with the auth middleware bound. Needs SqlClient + Patches from the caller. */
export const AppRoutes = Layer.mergeAll(ApiRoutes, DraftRoute, StandingHeaders).pipe(
  Layer.provide(AuthorizationLive)
);
