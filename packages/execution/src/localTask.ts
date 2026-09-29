// @effect-diagnostics nodeBuiltinImport:off -- IPC reports the private listener to the local task provider.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Management from "./management.js";
import * as Supervisor from "./supervisor.js";

// The parent passes only task configuration, never its database, storage or login environment.
NodeRuntime.runMain(
  Effect.gen(function* () {
    const options = yield* Management.config;
    const callbackUrls = yield* Config.schema(
      Schema.fromJsonString(Schema.Array(Schema.String)),
      "EXECUTION_CALLBACK_URLS"
    );
    const deploymentRevision = yield* Config.String("EXECUTION_DEPLOYMENT_REVISION");
    const taskId = yield* Config.String("EXECUTION_TASK_ID");
    const supervisor = yield* Supervisor.make({ callbackUrls, deploymentRevision, taskId });
    const listener = yield* Management.serve(options).pipe(
      Effect.provideService(Supervisor.Supervisor, supervisor)
    );
    yield* Effect.sync(() => process.send?.({ url: listener.url }));
    return yield* Effect.never;
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer))
);
