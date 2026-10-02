import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  type Authorization,
  BadRequest,
  CurrentIdentity,
  decodeBody,
  GenerateRequest,
  Generated,
  PatchyApi,
  PayloadTooLarge,
  PublishRefused,
  PublishUnavailable,
  readBody,
  Release,
  refuse
} from "@patchy/api";
import type { ConnectionStore } from "@patchy/integrations";
import type { Patches } from "@patchy/patches";
import * as Artifact from "./Artifact.js";
import * as Generation from "./Generation.js";

const encodeRelease = Schema.encodeSync(Release);
const encodeGenerated = Schema.encodeSync(Generated);
const noStore = { headers: { "cache-control": "private, no-store" } };
/** A manifest and a skill list, never a bundle. */
const MAX_GENERATE_BODY_BYTES = 1024 * 1024;
// Unknown fields are refused here, not stripped: the HttpApi payload decoder ignores them.
const decodeGenerate = decodeBody(GenerateRequest, { onExcessProperty: "error" });
const malformed = (field?: string) =>
  refuse(
    BadRequest,
    {
      ok: false,
      error:
        field === undefined
          ? "Request body must be a JSON generate request."
          : `Invalid generate request field: ${field}.`
    },
    noStore.headers
  );
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
      .handleRaw("generate", () =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const payload = yield* readBody(MAX_GENERATE_BODY_BYTES).pipe(
            Effect.flatMap(decodeGenerate),
            Effect.catchTags({
              MalformedBody: (error) => Effect.succeed(malformed(error.field)),
              BodyTooLarge: () =>
                Effect.succeed(
                  refuse(
                    PayloadTooLarge,
                    { ok: false, error: "Request body is too large." },
                    noStore.headers
                  )
                )
            })
          );
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
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

/** Tarball-shaped paths cannot be patch names; `sdk` remains a valid company handle. */
export const tarballLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const artifact = yield* Artifact.Artifact;
    yield* router.add(
      "GET",
      "/sdk/patchy-:archive.tgz",
      Effect.gen(function* () {
        const { params } = yield* HttpRouter.RouteContext;
        const filename = `patchy-${params.archive}.tgz`;
        return yield* artifact.get(filename).pipe(
          Effect.map((bytes) =>
            HttpServerResponse.uint8Array(bytes, {
              contentType: "application/octet-stream",
              headers: {
                "cache-control": "public, max-age=31536000, immutable",
                "content-disposition": `attachment; filename="${filename}"`,
                "x-content-type-options": "nosniff"
              }
            })
          ),
          Effect.catchTags({
            ObjectNotFound: () =>
              Effect.succeed(HttpServerResponse.empty({ status: 404, ...noStore })),
            InvalidObjectKey: () =>
              Effect.succeed(HttpServerResponse.empty({ status: 404, ...noStore })),
            StoreUnavailable: () =>
              Effect.succeed(HttpServerResponse.empty({ status: 503, ...noStore })),
            ArtifactMismatch: () =>
              Effect.succeed(HttpServerResponse.empty({ status: 503, ...noStore }))
          })
        );
      })
    );
  })
);
