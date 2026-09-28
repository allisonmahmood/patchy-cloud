import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import S3rver from "s3rver";
import { contentStoreContract } from "../test/ContentStoreContract.js";
import * as S3ContentStore from "./S3ContentStore.js";

const localStore = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-s3-contract-" });
    const bucket = "patchy-contract";
    const { address } = yield* Effect.acquireRelease(
      Effect.tryPromise(async () => {
        const server = new S3rver({
          directory,
          address: "127.0.0.1",
          port: 0,
          silent: true,
          vhostBuckets: false,
          configureBuckets: [{ name: bucket, configs: [] }]
        });
        const address = await server.run();
        return { server, address };
      }),
      ({ server }) => Effect.promise(() => server.close())
    );
    return S3ContentStore.layer.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            PATCHY_S3_BUCKET: bucket,
            PATCHY_S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
            PATCHY_S3_REGION: "us-east-1",
            PATCHY_S3_ACCESS_KEY_ID: "S3RVER",
            PATCHY_S3_SECRET_ACCESS_KEY: "S3RVER"
          })
        )
      )
    );
  })
).pipe(Layer.provide(NodeFileSystem.layer));

it.layer(localStore, { timeout: "30 seconds" })("S3ContentStore (local S3)", (it) => {
  contentStoreContract(it);
});
