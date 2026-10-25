import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { readPlan } from "../../../scripts/dev/src/state.js";
import { supervise } from "../../../scripts/dev/src/supervisor.js";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const root = new URL("../../../", import.meta.url).pathname;
    const plan = Option.getOrThrow(yield* readPlan(`${root}.local/dev`));
    yield* supervise(
      plan,
      new URL(
        process.argv.includes("--slack") ? "./slackServer.ts" : "./localServer.ts",
        import.meta.url
      ).pathname
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
