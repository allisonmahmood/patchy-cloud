import { assert, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  Cryptography,
  displayFont,
  type Font,
  fontFile,
  fontUrl,
  fonts,
  NodeCryptography
} from "@patchy/core";
import * as Fonts from "./Fonts.js";

const committed = fonts.map((font) => ({ font, file: fontFile(font) }));

/** A file in a fresh directory holding `bytes`, as a `file:` URL. */
const fileOf = Effect.fn(function* (bytes: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const name = path.join(yield* fs.makeTempDirectoryScoped(), "font.woff2");
  yield* fs.writeFile(name, bytes);
  return yield* path.toFileUrl(name);
});

/** GET `path` from the routes `Fonts.serve` makes of `files`, as the browser would receive it. */
const get = Effect.fn(function* (
  files: ReadonlyArray<{ readonly font: Font; readonly file: URL }>,
  path: string
) {
  const app = yield* HttpRouter.toHttpEffect(Fonts.serve(files));
  const response = yield* app.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(new URL(path, "http://patchy.test")))
    ),
    // An unrouted path, which the server answers 404.
    Effect.catchTags({
      HttpServerError: (error) =>
        error.reason._tag === "RouteNotFound"
          ? Effect.succeed(HttpServerResponse.empty({ status: 404 }))
          : Effect.die(error)
    })
  );
  return HttpServerResponse.toWeb(response);
});

it.layer(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCryptography.layer))(
  "the font routes",
  (it) => {
    it.effect("serve a font beside the committed ones at the URL naming its bytes, for good", () =>
      Effect.gen(function* () {
        const bytes = new TextEncoder().encode("wOF2 stands in for the display font");
        const font = {
          family: "Stand-in",
          file: "StandIn-Extrabold.woff2",
          sha256: yield* (yield* Cryptography.Cryptography).sha256(bytes)
        };
        const files = [...committed, { font, file: yield* fileOf(bytes) }];
        const response = yield* get(files, fontUrl(font));
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("content-type"), "font/woff2");
        assert.strictEqual(
          response.headers.get("cache-control"),
          "public, max-age=31536000, immutable"
        );
        assert.deepStrictEqual(
          new Uint8Array(yield* Effect.promise(() => response.bytes())),
          bytes
        );
      })
    );

    it.effect("serve nothing at the display font's URL when the release lacks its file", () =>
      Effect.gen(function* () {
        assert.strictEqual((yield* get(committed, fontUrl(displayFont))).status, 404);
        assert.strictEqual((yield* get(committed, fontUrl(fonts[0]))).status, 200);
      })
    );

    it.effect("refuse to start on a file that isn't the bytes its URL names", () =>
      Effect.gen(function* () {
        const file = yield* fileOf(new TextEncoder().encode("a subset, or another cut"));
        const exit = yield* Effect.exit(get([{ font: displayFont, file }], fontUrl(displayFont)));
        assert.isTrue(Exit.isFailure(exit));
        const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
        assert.instanceOf(defect, Fonts.FontMismatch);
        assert.strictEqual(defect.expected, displayFont.sha256);
      })
    );
  }
);
