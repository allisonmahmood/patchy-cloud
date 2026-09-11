import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { PatchyApi, Release } from "@patchy/api";
import * as Artifact from "./Artifact.js";

const encodeRelease = Schema.encodeSync(Release);

/** Release discovery has no bearer middleware: installing the package precedes sign-in. */
export const layer = HttpApiBuilder.group(PatchyApi, "sdk", (handlers) =>
  Effect.gen(function* () {
    const artifact = yield* Artifact.Artifact;
    return handlers.handle("release", () =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(encodeRelease(artifact.release), {
          headers: { "cache-control": "no-store" }
        })
      )
    );
  })
);

/** Only the exact tarball path is reserved; `sdk` remains a valid company handle. */
export const tarballLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const artifact = yield* Artifact.Artifact;
    yield* router.add(
      "GET",
      `/sdk/${artifact.filename}`,
      HttpServerResponse.uint8Array(artifact.bytes, {
        contentType: "application/octet-stream",
        headers: {
          "cache-control": "public, max-age=31536000, immutable",
          "content-disposition": `attachment; filename="${artifact.filename}"`,
          "x-content-type-options": "nosniff"
        }
      })
    );
  })
);
