import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Management from "@patchy/execution/management";
import * as Supervisor from "@patchy/execution/supervisor";
import * as DeploymentConfig from "@patchy/limits/deployment-config";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as PrivateInterface from "./PrivateInterface.js";

// This entrypoint loads no host services, database, object store or auth credentials.
NodeRuntime.runMain(
  Effect.gen(function* () {
    const management = yield* Management.config;
    const host = yield* PrivateInterface.resolve(management.host ?? "127.0.0.1");
    const callbackUrls = yield* Config.schema(
      Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
      "EXECUTION_CALLBACK_URLS"
    );
    const deploymentRevision = yield* Config.String("EXECUTION_DEPLOYMENT_REVISION");
    const taskId = yield* Config.String("EXECUTION_TASK_ID");
    const limits = yield* DeploymentConfig.load;
    const supervisor = yield* Supervisor.make({
      callbackUrls,
      deploymentRevision,
      taskId,
      configRevision: { deploymentRevision: limits.revision, overrideRevision: "0" },
      operatingLimits: {
        "execution.probe.interval": limits.get("execution.probe.interval"),
        "execution.process.rss": limits.get("execution.process.rss"),
        "execution.residency.processes": limits.get("execution.residency.processes"),
        "execution.residency.bytes": limits.get("execution.residency.bytes"),
        "execution.process.idle": limits.get("execution.process.idle")
      }
    });
    const listener = yield* Management.serve({
      ...management,
      host,
      maxRequestBytes: limits.get("execution.management.bodyBytes")
    }).pipe(Effect.provideService(Supervisor.Supervisor, supervisor));
    yield* Console.log(`Patchy execution supervisor listening on ${listener.url}`);
    return yield* Effect.never;
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer))
);
