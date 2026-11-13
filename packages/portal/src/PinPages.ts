// Personal pin forms and the adapter that supplies every app page's sidebar.
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { RequireSession, returnPath } from "@patchy/auth";
import { patchTitle } from "@patchy/core";
import { Patches } from "@patchy/patches";
import { context, errorPage, errors, pageErrors, type Routes } from "./shared/handlers.js";
import { patchAddress } from "./shared/presentation.js";

export const navigation = Layer.effect(
  RequireSession.Pins,
  Effect.gen(function* () {
    const patches = yield* Patches.Patches;
    const canOpen = yield* Patches.Openability;
    return Effect.fn("PinPages.navigation")(function* (viewer: RequireSession.Viewer["Service"]) {
      const entries = yield* patches.pins({
        companyId: viewer.company.id,
        userId: viewer.user.id,
        canOpen: (patch) => canOpen(patch, viewer.user.id)
      });
      return entries.map(({ patch, tier }) => ({
        id: patch.id,
        name: patch.name,
        title: patchTitle(patch, viewer.company.name),
        tier,
        href: patchAddress(patch)
      }));
    });
  })
);

const setPinned = Effect.fn("PinPages.setPinned")(function* (pinned: boolean) {
  const { viewer, session, access } = yield* context;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = new URLSearchParams(
    yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(4096))
    )
  );
  if (form.get("user") !== viewer.user.id)
    return yield* errorPage(
      409,
      "Signed in as someone else",
      "This page was open for another account. Nothing changed."
    );
  const params = yield* HttpRouter.params;
  yield* (yield* Patches.Patches).setPinned(access, params.patchId ?? "", pinned);
  return HttpServerResponse.redirect(returnPath(form.get("return"), session.publicBaseUrl) ?? "/", {
    status: 303,
    headers: { "cache-control": "private, no-store" }
  });
});

export const layer: Routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    for (const [action, pinned] of [
      ["pin", true],
      ["unpin", false]
    ] as const)
      yield* router.add(
        "POST",
        `/patches/:patchId/${action}`,
        errors(
          RequireSession.sameOrigin(RequireSession.withViewer(setPinned(pinned).pipe(pageErrors)))
        )
      );
  })
);
