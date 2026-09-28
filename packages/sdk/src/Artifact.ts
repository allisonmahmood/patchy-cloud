// @effect-diagnostics nodeBuiltinImport:off — Node supplies content hashes and file-URL conversion; Effect has no digest service.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  CURRENT_RELEASE,
  MANIFEST_VERSION,
  Release,
  ReleaseToolchain,
  WIRE_VERSION
} from "@patchy/api";
import { ContentStore } from "@patchy/content-store";

export class ArtifactUnavailable extends Schema.TaggedError<ArtifactUnavailable>()(
  "ArtifactUnavailable",
  { path: Schema.String, stage: Schema.Literals(["read", "decode"]), cause: Schema.Defect() }
) {
  override get message() {
    return `Cannot ${this.stage} the SDK release artifact at ${this.path}; build the patchy package before starting the server.`;
  }
}

export class ArtifactMismatch extends Schema.TaggedError<ArtifactMismatch>()("ArtifactMismatch", {
  field: Schema.Literals(["release", "manifestVersion", "wireVersion", "digest", "integrity"]),
  expected: Schema.Union([Schema.String, Schema.Number]),
  actual: Schema.Union([Schema.String, Schema.Number])
}) {
  override get message() {
    return `The SDK artifact has ${this.field} ${this.actual}; expected ${this.expected}. Rebuild the release.`;
  }
}

export class ArtifactRetentionFailed extends Schema.TaggedError<ArtifactRetentionFailed>()(
  "ArtifactRetentionFailed",
  { key: Schema.String, cause: Schema.Defect() }
) {
  override get message() {
    return `Cannot retain the SDK release archive at ${this.key}; check the instance's content store before advertising this release.`;
  }
}

const Metadata = Schema.Struct({
  release: Schema.String,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  integrity: Release.fields.package.fields.integrity,
  manifestVersion: Schema.Int,
  wireVersion: Schema.Int,
  toolchain: ReleaseToolchain
});
const decodeMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(Metadata));
const ArchiveFilename = Schema.String.check(
  Schema.isPattern(/^patchy-[A-Za-z0-9][A-Za-z0-9.+-]*-[a-f0-9]{64}\.tgz$/)
);
const isArchiveFilename = Schema.is(ArchiveFilename);
const verifyDigest = Effect.fnUntraced(function* (filename: string, bytes: Uint8Array) {
  const expected = filename.slice(-68, -4);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    return yield* new ArtifactMismatch({ field: "digest", expected, actual });
  }
  return bytes;
});

export class Artifact extends Context.Service<
  Artifact,
  {
    readonly release: Release;
    readonly get: (
      filename: string
    ) => Effect.Effect<
      Uint8Array,
      | ArtifactMismatch
      | ContentStore.InvalidObjectKey
      | ContentStore.ObjectNotFound
      | ContentStore.StoreUnavailable
    >;
  }
>()("@patchy/sdk/Artifact") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* ContentStore.ContentStore;
  const base = yield* Config.String("PATCHY_PUBLIC_BASE_URL");
  const directory = fileURLToPath(new URL("../artifacts/", import.meta.url));
  const metadataPath = path.join(directory, "release.json");
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
  const filename = `patchy-${metadata.release}-${metadata.digest}.tgz`;
  const tarballPath = path.join(directory, filename);
  const bytes = yield* fs
    .readFile(tarballPath)
    .pipe(
      Effect.mapError(
        (cause) => new ArtifactUnavailable({ path: tarballPath, stage: "read", cause })
      )
    );
  yield* verifyDigest(filename, bytes);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== metadata.integrity) {
    return yield* new ArtifactMismatch({
      field: "integrity",
      expected: metadata.integrity,
      actual: integrity
    });
  }

  // Persist verified current bytes before discovery, repairing any damaged stored copy.
  // The shared content store keeps historical URLs independently of local build outputs.
  const key = `sdk/${filename}`;
  yield* store
    .putBytes(key, bytes)
    .pipe(Effect.mapError((cause) => new ArtifactRetentionFailed({ key, cause })));

  const get = Effect.fn("Artifact.get")(function* (filename: string) {
    const key = `sdk/${filename}`;
    if (!isArchiveFilename(filename)) {
      return yield* new ContentStore.ObjectNotFound({ key });
    }
    return yield* store
      .getBytes(key)
      .pipe(Effect.flatMap((bytes) => verifyDigest(filename, bytes)));
  });
  return Artifact.of({
    get,
    release: new Release({
      release: metadata.release,
      package: { tarball: `${base.replace(/\/+$/, "")}/sdk/${filename}`, integrity },
      manifestVersion: metadata.manifestVersion,
      wireVersion: metadata.wireVersion,
      toolchain: metadata.toolchain
    })
  });
});

export const layer = Layer.effect(Artifact, make);
