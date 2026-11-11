// Owns core's scripts under `/assets/`, the copy buttons' and the dialogs' enhancer, served
// without a session. The guide's script is Home's (`HomePages.ts`); the fonts are `Fonts.ts`.
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { copyScript, copyScriptPath, uiScript, uiScriptPath } from "@patchy/core";

export const layer: Layer.Layer<never, never, HttpRouter.HttpRouter> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    for (const [path, script] of [
      [copyScriptPath, copyScript],
      [uiScriptPath, uiScript]
    ] as const)
      yield* router.add(
        "GET",
        path,
        HttpServerResponse.text(script, {
          contentType: "text/javascript",
          headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" }
        })
      );
  })
);
