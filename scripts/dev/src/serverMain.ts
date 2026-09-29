import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Server from "./server.js";

const root = process.argv[2];
if (root === undefined || process.argv.length !== 3)
  throw new Error("Usage: pnpm dev:server <patch-repo-path>");

Server.run(root).pipe(
  Effect.scoped,
  Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
  NodeRuntime.runMain
);
