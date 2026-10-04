/**
 * One-off fleet operations, run as a disposable task from the host task
 * definition so they reach the platform database the way a host does.
 *
 * `node dist/fleet.js promote <revision>` stages the revision and promotes it
 * once its hosts have warmed its spares. The deploy workflow runs it after ECS
 * has settled on the revision's hosts; promoting earlier would leave a staged
 * revision with no hosts if the rollout failed. A rollback runs it for the
 * earlier revision. It exits nonzero if the revision has no hosts or its
 * spares are not ready within five minutes.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Fleet from "@patchy/execution/fleet";
import * as Sql from "@patchy/sql";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";

const promote = Command.make(
  "promote",
  {
    revision: Argument.String("revision").pipe(
      Argument.withDescription("The deployment revision whose hosts are running")
    )
  },
  Effect.fn(function* ({ revision }) {
    yield* Fleet.promote(revision, "5 minutes").pipe(Effect.provide(Sql.layer));
    yield* Console.log(`Promoted deployment revision ${revision}.`);
  })
).pipe(
  Command.withDescription("Stage a deployment revision and promote it once its spares are warm")
);

Command.make("fleet").pipe(
  Command.withSubcommands([promote]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
);
