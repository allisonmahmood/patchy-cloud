/**
 * The content store over an Azure Blob container: one block blob per object
 * key, served as HTML. The container client is its own service so the error
 * mapping can be exercised without an account.
 */
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, RestError } from "@azure/storage-blob";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as ContentStore from "./ContentStore.js";

/** The container the objects live in. Its presence is what selects this layer. */
export const container = Config.string("AZURE_STORAGE_CONTAINER");

/** The account, reached with a managed identity when no connection string is set. */
export const account = Config.option(Config.string("AZURE_STORAGE_ACCOUNT"));

/** Connection-string auth, for local Azure testing and deployments without a managed identity. */
export const connectionString = Config.option(Config.redacted("AZURE_STORAGE_CONNECTION_STRING"));

/** What the store needs of the container: three blob calls, as the SDK's promises. */
export class BlobContainer extends Context.Service<
  BlobContainer,
  {
    readonly upload: (key: string, html: string) => Promise<void>;
    readonly download: (key: string) => Promise<string>;
    readonly deleteIfExists: (key: string) => Promise<void>;
  }
>()("@patchy/content-store/AzureContentStore/BlobContainer") {}

export const make = Effect.gen(function* () {
  const blobs = yield* BlobContainer;

  const put = Effect.fn("AzureContentStore.put")((key: string, html: string) =>
    Effect.tryPromise({
      try: () => blobs.upload(key, html),
      catch: (cause) => new ContentStore.StoreUnavailable({ operation: "put", key, cause })
    })
  );

  const get = Effect.fn("AzureContentStore.get")((key: string) =>
    Effect.tryPromise({
      try: () => blobs.download(key),
      catch: (cause) =>
        cause instanceof RestError && cause.statusCode === 404
          ? new ContentStore.ObjectNotFound({ key })
          : new ContentStore.StoreUnavailable({ operation: "get", key, cause })
    })
  );

  const remove = Effect.fn("AzureContentStore.delete")((key: string) =>
    Effect.tryPromise({
      try: () => blobs.deleteIfExists(key),
      catch: (cause) => new ContentStore.StoreUnavailable({ operation: "delete", key, cause })
    })
  );

  return ContentStore.ContentStore.of({ put, get, delete: remove });
});

/** The real container, from the Azure config slice. */
export const layerBlobContainer = Layer.effect(
  BlobContainer,
  Effect.gen(function* () {
    const name = yield* container;
    const secret = yield* connectionString;
    const service = Option.isSome(secret)
      ? BlobServiceClient.fromConnectionString(Redacted.value(secret.value))
      : new BlobServiceClient(
          `https://${yield* Config.string("AZURE_STORAGE_ACCOUNT")}.blob.core.windows.net`,
          new DefaultAzureCredential()
        );
    const client = service.getContainerClient(name);

    return BlobContainer.of({
      upload: async (key, html) => {
        await client.getBlockBlobClient(key).upload(html, Buffer.byteLength(html, "utf8"), {
          blobHTTPHeaders: {
            blobContentType: "text/html; charset=utf-8",
            blobCacheControl: "no-store"
          }
        });
      },
      download: async (key) => {
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
      deleteIfExists: async (key) => {
        await client.getBlobClient(key).deleteIfExists();
      }
    });
  })
);

export const layer = Layer.effect(ContentStore.ContentStore, make).pipe(
  Layer.provide(layerBlobContainer)
);
