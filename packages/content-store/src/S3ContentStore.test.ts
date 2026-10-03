import { it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { contentStoreContract, pagedListingContract } from "../test/ContentStoreContract.js";
import { makeTestStore } from "../test/S3HttpFixture.js";
import * as ContentStore from "./ContentStore.js";

const localStore = Layer.effect(ContentStore.ContentStore, makeTestStore());

it.layer(localStore, { timeout: "30 seconds" })("S3ContentStore (local S3)", (it) => {
  contentStoreContract(it);
  pagedListingContract(it);
});
