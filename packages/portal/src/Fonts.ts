import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Cryptography, type Font, fontFile, fontUrl, servedFonts } from "@patchy/core";

/** A font file whose bytes aren't the ones its URL names, which a browser would keep for a year. */
export class FontMismatch extends Schema.TaggedError<FontMismatch>()("FontMismatch", {
  file: Schema.String,
  expected: Schema.String,
  found: Schema.String
}) {
  override get message() {
    return `${this.file} has SHA-256 ${this.found}, not the pinned ${this.expected}; put the official file there, or remove it.`;
  }
}

/**
 * Serves each font at its digest URL, read from `file`. They sit outside the viewer gate, since a
 * signed-out door draws in them as Home does, and they set no cookie. A URL names its bytes, so a
 * browser keeps them for a year without asking again. Read and checked once on the way up: the
 * files belong to the release, and a release with a missing or different file is broken.
 */
export const serve = (
  files: ReadonlyArray<{ readonly font: Font; readonly file: URL }>
): Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | FileSystem.FileSystem | Path.Path | Cryptography.Cryptography
> =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cryptography = yield* Cryptography.Cryptography;
      for (const { font, file } of files) {
        const bytes = yield* path.fromFileUrl(file).pipe(
          Effect.flatMap((name) => fs.readFile(name)),
          Effect.orDie
        );
        const found = yield* cryptography.sha256(bytes);
        if (found !== font.sha256)
          return yield* Effect.die(
            new FontMismatch({ file: file.pathname, expected: font.sha256, found })
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

/** The release's fonts from core's `fonts/`: the committed ones, and the display font if it's there. */
export const layer = serve(servedFonts.map((font) => ({ font, file: fontFile(font) })));
