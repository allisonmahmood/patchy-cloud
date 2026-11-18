/**
 * `pnpm test:pidgeon:sweep`: what a live Pidgeon run left behind, gone. CI runs it after the
 * suite, even when the job was cancelled, with the same `PIDGEON_TEST_RUN_ID`, so that run's
 * inboxes go, and anyone's stale ones with them. It fails, saying how many, when a deletion it meant
 * didn't happen. Without a test key there's nothing to do.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Live from "./pidgeonHarness.js";

NodeRuntime.runMain(
  Live.ADMIN_KEY === undefined
    ? Effect.sync(() => console.log("No PIDGEON_TEST_ADMIN_KEY, so there's nothing to sweep."))
    : Live.requireTestKey.pipe(
        Effect.andThen(Live.sweep(true)),
        Effect.tap((swept) =>
          swept.problem === undefined
            ? Effect.sync(() =>
                console.log(
                  `Pidgeon sweep for ${Live.RUN}: deleted ${swept.inboxes} test inboxes${swept.failed === 0 ? "" : `; ${swept.failed} failed to delete`}.`
                )
              )
            : Effect.void
        ),
        Effect.flatMap(Live.requireSwept),
        Effect.provide(Live.sweepLayer)
      )
);
