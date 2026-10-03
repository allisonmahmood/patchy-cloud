import { it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as S3ContentStore from "../src/S3ContentStore.js";
import { contentStoreContract, pagedListingContract } from "../test/ContentStoreContract.js";

const names: Readonly<Record<string, string>> = {
  PATCHY_S3_ENDPOINT: "AWS_ENDPOINT_URL_S3",
  PATCHY_S3_REGION: "AWS_REGION",
  PATCHY_S3_ACCESS_KEY_ID: "AWS_ACCESS_KEY_ID",
  PATCHY_S3_SECRET_ACCESS_KEY: "AWS_SECRET_ACCESS_KEY",
  PATCHY_S3_BUCKET: "NEON_BUCKET"
};

// Read the spike's settings through Config without changing the process environment.
const config = ConfigProvider.fromEnv().pipe(
  ConfigProvider.mapInput((path) =>
    path.map((segment) => (typeof segment === "string" ? (names[segment] ?? segment) : segment))
  )
);

// The contract only deletes exact keys it generated under random test prefixes.
// The existing branch-scoped bucket is never created, emptied, or deleted.
it.layer(S3ContentStore.layer.pipe(Layer.provide(ConfigProvider.layer(config))), {
  timeout: "30 seconds"
})("S3ContentStore (live Neon)", (it) => {
  contentStoreContract(it);
  pagedListingContract(it);
});
