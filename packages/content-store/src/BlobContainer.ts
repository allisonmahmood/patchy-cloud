/**
 * The Azure Blob container the Azure content store writes to, narrowed to
 * the three calls the store makes so the SDK stays behind one adapter. A
 * test that needs a broken container provides another layer of it.
 */
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, RestError } from "@azure/storage-blob";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** A blob call the service refused or never answered; the HTTP status when it gave one. */
export class BlobRequestFailed extends Schema.TaggedError<BlobRequestFailed>()(
  "BlobRequestFailed",
  {
    operation: Schema.Literals(["upload", "download", "deleteIfExists"]),
    statusCode: Schema.Option(Schema.Int),
    cause: Schema.Defect()
  }
) {
  override get message() {
    return `Azure Blob ${this.operation} failed.`;
  }
}

/** The container the objects live in. Its presence is what selects the Azure layer. */
export const container = Config.string("AZURE_STORAGE_CONTAINER");

/** The account, reached with a managed identity; read only when no connection string is set. */
export const account = Config.string("AZURE_STORAGE_ACCOUNT");

/** Connection-string auth, for local Azure testing and deployments without a managed identity. */
export const connectionString = Config.option(Config.redacted("AZURE_STORAGE_CONNECTION_STRING"));

export class BlobContainer extends Context.Service<
  BlobContainer,
  {
    readonly upload: (key: string, html: string) => Effect.Effect<void, BlobRequestFailed>;
    readonly download: (key: string) => Effect.Effect<string, BlobRequestFailed>;
    readonly deleteIfExists: (key: string) => Effect.Effect<void, BlobRequestFailed>;
  }
>()("@patchy/content-store/BlobContainer") {}

const failed =
  (operation: BlobRequestFailed["operation"]) =>
  (cause: unknown): BlobRequestFailed =>
    new BlobRequestFailed({
      operation,
      statusCode:
        cause instanceof RestError ? Option.fromNullishOr(cause.statusCode) : Option.none(),
      cause
    });

/** The real container, from the Azure config slice. */
export const make = Effect.gen(function* () {
  const name = yield* container;
  const secret = yield* connectionString;
  const service = Option.isSome(secret)
    ? BlobServiceClient.fromConnectionString(Redacted.value(secret.value))
    : new BlobServiceClient(
        `https://${yield* account}.blob.core.windows.net`,
        new DefaultAzureCredential()
      );
  const client = service.getContainerClient(name);

  return BlobContainer.of({
    upload: (key, html) =>
      Effect.tryPromise({
        try: () =>
          client.getBlockBlobClient(key).upload(html, Buffer.byteLength(html, "utf8"), {
            blobHTTPHeaders: {
              blobContentType: "text/html; charset=utf-8",
              blobCacheControl: "no-store"
            }
          }),
        catch: failed("upload")
      }),
    download: (key) =>
      Effect.tryPromise({
        try: async () => {
          const response = await client.getBlobClient(key).download();
          if (!response.readableStreamBody) {
            throw new Error("Azure Blob response did not include a readable stream.");
          }
          const chunks: Buffer[] = [];
          for await (const chunk of response.readableStreamBody) {
            chunks.push(Buffer.from(chunk));
          }
          return Buffer.concat(chunks).toString("utf8");
        },
        catch: failed("download")
      }),
    deleteIfExists: (key) =>
      Effect.tryPromise({
        try: () => client.getBlobClient(key).deleteIfExists(),
        catch: failed("deleteIfExists")
      })
  });
});

export const layer = Layer.effect(BlobContainer, make);
