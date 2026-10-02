// @effect-diagnostics nodeBuiltinImport:off -- IPC connects only the credential-free supervisor and its detached local provider owner.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Management from "./management.js";
import * as Supervisor from "./supervisor.js";

// The owner passes only task configuration, never database, storage or login credentials.
NodeRuntime.runMain(
  Effect.gen(function* () {
    yield* Effect.callback<void>((resume) => {
      const message = (value: unknown) => {
        if (value === "start") resume(Effect.void);
      };
      const disconnected = () => resume(Effect.interrupt);
      process.on("message", message);
      process.once("disconnect", disconnected);
      process.send?.("initialize");
      return Effect.sync(() => {
        process.off("message", message);
        process.off("disconnect", disconnected);
      });
    });
    const options = yield* Management.config;
    const callbackUrls = yield* Config.schema(
      Schema.fromJsonString(Schema.Array(Schema.String)),
      "EXECUTION_CALLBACK_URLS"
    );
    const deploymentRevision = yield* Config.String("EXECUTION_DEPLOYMENT_REVISION");
    const taskId = yield* Config.String("EXECUTION_TASK_ID");
    const supervisor = yield* Supervisor.make({ callbackUrls, deploymentRevision, taskId });
    // Even a failed bundle load may have installed the requested epoch before it failed.
    const epochs = new Set([0]);
    const listener = yield* Management.serve(options).pipe(
      Effect.provideService(Supervisor.Supervisor, {
        ...supervisor,
        bind: (request) =>
          Effect.suspend(() => {
            epochs.add(request.bindingEpoch);
            return supervisor.bind(request);
          })
      })
    );
    yield* Effect.callback<void>((resume) => {
      const message = (value: unknown) => {
        if (value === "stop") resume(Effect.void);
      };
      const disconnected = () => resume(Effect.void);
      process.on("message", message);
      process.once("disconnect", disconnected);
      process.send?.({ url: listener.url });
      return Effect.sync(() => {
        process.off("message", message);
        process.off("disconnect", disconnected);
      });
    });
    for (const bindingEpoch of [...epochs].sort((a, b) => b - a)) {
      const stopped = yield* supervisor.stop({ bindingEpoch }).pipe(Effect.result);
      if (stopped._tag === "Failure") {
        if (stopped.failure.reason === "stale_epoch") continue;
        return yield* stopped.failure;
      }
      const finalStats = yield* supervisor.stats({ bindingEpoch });
      if (process.connected) {
        yield* Effect.callback<void>((resume) => {
          process.send?.({ bindingEpoch, finalStats }, () => resume(Effect.void));
        });
      }
      break;
    }
    // An open IPC channel must not keep a stopped supervisor alive after its scope closes.
    if (process.connected) process.disconnect();
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer))
);
