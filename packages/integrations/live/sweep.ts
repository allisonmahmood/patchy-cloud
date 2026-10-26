/**
 * `pnpm test:pidgeon:sweep`: what a live Pidgeon run left behind, gone. CI runs it after the
 * suite, even when the job was cancelled, with the same `PIDGEON_TEST_RUN_ID`, so that run's keys
 * and addresses go, and anyone's stale ones with them. Without a test key there's nothing to do.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Live from "./harness.js";

NodeRuntime.runMain(
  Live.ADMIN_KEY === undefined
    ? Effect.sync(() => console.log("No PIDGEON_TEST_ADMIN_KEY, so there's nothing to sweep."))
    : Live.sweep(true).pipe(
        Effect.flatMap((swept) =>
          swept.problem === undefined
            ? Effect.sync(() =>
                console.log(
                  `Pidgeon sweep for ${Live.RUN}: revoked ${swept.keys} keys and deleted ${swept.addresses} test addresses.`
                )
              )
            : Effect.die(`The Pidgeon sweep for ${Live.RUN} couldn't list: ${swept.problem}.`)
        ),
        Effect.provide(Live.layer)
      )
);
