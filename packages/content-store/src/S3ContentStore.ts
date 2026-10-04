/** Neon Object Storage, addressed through its branch endpoint and a private bucket. */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException
} from "@aws-sdk/client-s3";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ContentStore from "./ContentStore.js";

/** Selecting a bucket selects S3; every other setting is then required at startup. */
export const bucket = Config.NonEmptyString("PATCHY_S3_BUCKET");

/** All five settings; a production host checks them before acquiring Postgres. */
export const config = Config.all({
  name: bucket,
  endpoint: Config.URL("PATCHY_S3_ENDPOINT"),
  region: Config.NonEmptyString("PATCHY_S3_REGION"),
  accessKeyId: Config.schema(Schema.Redacted(Schema.NonEmptyString), "PATCHY_S3_ACCESS_KEY_ID"),
  secretAccessKey: Config.schema(
    Schema.Redacted(Schema.NonEmptyString),
    "PATCHY_S3_SECRET_ACCESS_KEY"
  )
});

export const make = Effect.gen(function* () {
  const { name, endpoint, region, accessKeyId, secretAccessKey } = yield* config;
  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new S3Client({
          region,
          endpoint: endpoint.href,
          forcePathStyle: true,
          credentials: {
            accessKeyId: Redacted.value(accessKeyId),
            secretAccessKey: Redacted.value(secretAccessKey)
          },
          // Neon supports core S3, not AWS's optional streaming checksum extensions.
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED"
        })
    ),
    (client) => Effect.sync(() => client.destroy())
  );

  const putBytes = Effect.fn("S3ContentStore.putBytes")(function* (key: string, bytes: Uint8Array) {
    yield* ContentStore.checkKey(key);
    yield* Effect.tryPromise({
      try: (abortSignal) =>
        client.send(
          new PutObjectCommand({
            Bucket: name,
            Key: key,
            Body: bytes,
            ContentType: "application/octet-stream"
          }),
          { abortSignal }
        ),
      catch: (cause) => new ContentStore.StoreUnavailable({ operation: "put", key, cause })
    });
  });

  const getBytes = Effect.fn("S3ContentStore.getBytes")(function* (key: string) {
    yield* ContentStore.checkKey(key);
    return yield* Effect.tryPromise({
      try: async (abortSignal) => {
        const response = await client.send(new GetObjectCommand({ Bucket: name, Key: key }), {
          abortSignal
        });
        if (!response.Body) throw new Error("S3 returned no object body.");
        // Keep body consumption inside the abortable operation: late stream errors
        // are store failures too. Only the existing byte-returning boundary buffers.
        return await response.Body.transformToByteArray();
      },
      catch: (cause) =>
        cause instanceof S3ServiceException && cause.name === "NoSuchKey"
          ? new ContentStore.ObjectNotFound({ key })
          : new ContentStore.StoreUnavailable({ operation: "get", key, cause })
    });
  });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const put = (key: string, html: string) => putBytes(key, encoder.encode(html));
  const get = (key: string) => Effect.map(getBytes(key), (bytes) => decoder.decode(bytes));

  const remove = Effect.fn("S3ContentStore.delete")(function* (key: string) {
    yield* ContentStore.checkKey(key);
    yield* Effect.tryPromise({
      try: (abortSignal) =>
        client.send(new DeleteObjectCommand({ Bucket: name, Key: key }), { abortSignal }),
      catch: (cause) => new ContentStore.StoreUnavailable({ operation: "delete", key, cause })
    });
  });

  const list = (prefix: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (prefix !== "") yield* ContentStore.checkKey(prefix);
        // Any repeated token, not only the last one, would page forever.
        const seen = new Set<string>();
        return Stream.paginate(undefined as string | undefined, (continuationToken) =>
          Effect.tryPromise({
            try: async (abortSignal) => {
              const page = await client.send(
                new ListObjectsV2Command({
                  Bucket: name,
                  Prefix: prefix,
                  ContinuationToken: continuationToken
                }),
                { abortSignal }
              );
              const objects = (page.Contents ?? []).map((object) => {
                if (object.Key === undefined || !object.LastModified) {
                  throw new Error("S3 listing omitted object metadata.");
                }
                const lastModified = object.LastModified.getTime();
                if (!Number.isFinite(lastModified)) {
                  throw new Error("S3 listing returned an invalid modification time.");
                }
                return { key: object.Key, lastModified };
              });
              if (
                page.IsTruncated &&
                (!page.NextContinuationToken || seen.has(page.NextContinuationToken))
              ) {
                throw new Error("S3 listing omitted a progressing continuation token.");
              }
              if (page.NextContinuationToken) seen.add(page.NextContinuationToken);
              return [
                objects,
                page.IsTruncated ? Option.some(page.NextContinuationToken!) : Option.none()
              ] as const;
            },
            catch: (cause) =>
              new ContentStore.StoreUnavailable({ operation: "list", key: prefix, cause })
          })
        );
      })
    );

  return ContentStore.ContentStore.of({ put, get, putBytes, getBytes, delete: remove, list });
});

export const layer = Layer.effect(ContentStore.ContentStore, make);
