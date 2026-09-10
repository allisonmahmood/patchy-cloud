// @effect-diagnostics nodeBuiltinImport:off — Node supplies SHA-512 and file-URL conversion; Effect has no digest service.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CURRENT_RELEASE, MANIFEST_VERSION, Release, WIRE_VERSION } from "@patchy/api";

export class ArtifactUnavailable extends Schema.TaggedError<ArtifactUnavailable>()(
  "ArtifactUnavailable",
  { path: Schema.String, stage: Schema.Literals(["read", "decode"]), cause: Schema.Defect() }
) {
  override get message() {
    return `Cannot ${this.stage} the SDK release artifact at ${this.path}; build the patchy package before starting the server.`;
  }
}

export class ArtifactMismatch extends Schema.TaggedError<ArtifactMismatch>()("ArtifactMismatch", {
  field: Schema.Literals(["release", "manifestVersion", "wireVersion", "integrity"]),
  expected: Schema.Union([Schema.String, Schema.Number]),
  actual: Schema.Union([Schema.String, Schema.Number])
}) {
  override get message() {
    return `The SDK artifact has ${this.field} ${this.actual}; expected ${this.expected}. Rebuild the release.`;
  }
}

const Metadata = Schema.Struct({
  release: Schema.String,
  integrity: Schema.String,
  manifestVersion: Schema.Int,
  wireVersion: Schema.Int
});
const decodeMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(Metadata));

export class Artifact extends Context.Service<
  Artifact,
  {
    readonly release: Release;
    readonly filename: string;
    readonly bytes: Uint8Array;
  }
>()("@patchy/sdk/Artifact") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const base = yield* Config.string("PATCHY_PUBLIC_BASE_URL");
  const metadataPath = fileURLToPath(new URL("../artifacts/release.json", import.meta.url));
  const metadataText = yield* fs
    .readFileString(metadataPath)
    .pipe(
      Effect.mapError(
        (cause) => new ArtifactUnavailable({ path: metadataPath, stage: "read", cause })
      )
    );
  const metadata = yield* decodeMetadata(metadataText).pipe(
    Effect.mapError(
      (cause) => new ArtifactUnavailable({ path: metadataPath, stage: "decode", cause })
    )
  );
  const expected = {
    release: CURRENT_RELEASE,
    manifestVersion: MANIFEST_VERSION,
    wireVersion: WIRE_VERSION
  };
  for (const field of ["release", "manifestVersion", "wireVersion"] as const) {
    if (metadata[field] !== expected[field]) {
      return yield* new ArtifactMismatch({
        field,
        expected: expected[field],
        actual: metadata[field]
      });
    }
  }
  const filename = `patchy-${metadata.release}.tgz`;
  const tarballPath = fileURLToPath(new URL(`../artifacts/${filename}`, import.meta.url));
  const bytes = yield* fs
    .readFile(tarballPath)
    .pipe(
      Effect.mapError(
        (cause) => new ArtifactUnavailable({ path: tarballPath, stage: "read", cause })
      )
    );
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== metadata.integrity) {
    return yield* new ArtifactMismatch({
      field: "integrity",
      expected: metadata.integrity,
      actual: integrity
    });
  }
  return Artifact.of({
    filename,
    bytes,
    release: new Release({
      release: metadata.release,
      package: { tarball: `${base.replace(/\/+$/, "")}/sdk/${filename}`, integrity },
      manifestVersion: metadata.manifestVersion,
      wireVersion: metadata.wireVersion
    })
  });
});

export const layer = Layer.effect(Artifact, make);
