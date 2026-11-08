import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { fontFile, fontUrl, fonts } from "@patchy/core";

/**
 * The app's fonts at their digest URLs. They sit outside the viewer gate, since a signed-out door
 * draws in them as Home does, and they set no cookie. A URL names its bytes, so a browser keeps
 * them for a year without asking again. Read once on the way up: the files belong to the release,
 * and a release without them is broken.
 */
export const layer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | FileSystem.FileSystem | Path.Path
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const font of fonts) {
      const bytes = yield* path.fromFileUrl(fontFile(font)).pipe(
        Effect.flatMap((file) => fs.readFile(file)),
        Effect.orDie
      );
      yield* router.add(
        "GET",
        fontUrl(font),
        HttpServerResponse.uint8Array(bytes, {
          contentType: "font/woff2",
          headers: { "cache-control": "public, max-age=31536000, immutable" }
        })
      );
    }
  })
);
