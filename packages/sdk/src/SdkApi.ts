import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  type Authorization,
  Catalog,
  CurrentIdentity,
  Generated,
  PatchyApi,
  PublishRefused,
  PublishUnavailable,
  Release,
  refuse
} from "@patchy/api";
import type { ConnectionStore } from "@patchy/integrations";
import type { Patches } from "@patchy/patches";
import * as Artifact from "./Artifact.js";
import * as Generation from "./Generation.js";

const encodeRelease = Schema.encodeSync(Release);
const encodeCatalog = Schema.encodeSync(Catalog);
const encodeGenerated = Schema.encodeSync(Generated);
const noStore = { headers: { "cache-control": "private, no-store" } };
const rejected = (error: Generation.GenerationRefused) =>
  Effect.succeed(
    refuse(PublishRefused, { ok: false, code: error.code, error: error.message }, noStore.headers)
  );

/** Release discovery has no bearer middleware: installing the package precedes sign-in. */
export const layer: Layer.Layer<
  HttpApiGroup.Service<"patchy", "sdk">,
  never,
  | Artifact.Artifact
  | Authorization
  | ConnectionStore.ConnectionStore
  | Patches.Patches
  | FileSystem.FileSystem
> = HttpApiBuilder.group(PatchyApi, "sdk", (handlers) =>
  Effect.gen(function* () {
    const artifact = yield* Artifact.Artifact;
    return handlers
      .handle("release", () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(encodeRelease(artifact.release), {
            headers: { "cache-control": "no-store" }
          })
        )
      )
      .handle("catalog", ({ query }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const result = yield* Generation.catalog(identity.company.id, query.all ?? false).pipe(
            Effect.catchTags({
              Busy: (error) =>
                Effect.succeed(
                  refuse(
                    PublishUnavailable,
                    { ok: false, code: "busy", error: error.message },
                    noStore.headers
                  )
                ),
              GenerationUnavailable: (error) =>
                Effect.succeed(
                  refuse(
                    PublishUnavailable,
                    { ok: false, code: "source_unavailable", error: error.message },
                    noStore.headers
                  )
                )
            })
          );
          return HttpServerResponse.isHttpServerResponse(result)
            ? result
            : HttpServerResponse.jsonUnsafe(encodeCatalog(result), noStore);
        })
      )
      .handle("generate", ({ payload }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const result = yield* Generation.generate(identity.company.id, payload).pipe(
            Effect.catchTags({
              Busy: (error) =>
                Effect.succeed(
                  refuse(
                    PublishUnavailable,
                    { ok: false, code: "busy", error: error.message },
                    noStore.headers
                  )
                ),
              SdkReleaseMismatch: rejected,
              UnsupportedManifestVersion: rejected,
              UnknownProjectSkill: rejected,
              UnsafeGeneratedPath: rejected,
              SdkConnectionNotConnected: rejected,
              SdkPatchNotOpenable: rejected,
              GenerationUnavailable: (error) =>
                Effect.succeed(
                  refuse(
                    PublishUnavailable,
                    { ok: false, code: "source_unavailable", error: error.message },
                    noStore.headers
                  )
                )
            })
          );
          return HttpServerResponse.isHttpServerResponse(result)
            ? result
            : HttpServerResponse.jsonUnsafe(encodeGenerated(result), noStore);
        })
      );
  })
).pipe(
  HttpRouter.provideRequest(
    Layer.effectContext(
      Effect.context<ConnectionStore.ConnectionStore | Patches.Patches | FileSystem.FileSystem>()
    )
  )
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
