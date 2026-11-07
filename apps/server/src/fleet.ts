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
 *
 * `node dist/fleet.js share-by-default` shares every existing table and file
 * store whose patch's newest version doesn't say `shared: false`, in every ready
 * company database, once the release that made sharing the default is live
 * (docs/OPERATIONS.md › Sharing existing tables). It never unshares, and a rerun
 * writes nothing. It exits nonzero if anything meant to be shared is still unshared.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CompanyDatabases,
  Inventory,
  PgCompanyDatabases,
  ResourceChanges
} from "@patchy/company-database";
import { NodeCryptography } from "@patchy/core";
import * as Fleet from "@patchy/execution/fleet";
import { ShareByDefault } from "@patchy/patches";
import { Wakes, WakesPostgres } from "@patchy/runtime";
import * as Sql from "@patchy/sql";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

// Company databases as a host reaches them. Changes wake live queries on every host
// through Postgres, as a host's own writes do.
const companyDatabases = Layer.mergeAll(PgCompanyDatabases.layer, Inventory.layer).pipe(
  Layer.provide(
    Layer.effect(
      ResourceChanges.ResourceChanges,
      Effect.map(Wakes.Wakes, (wakes) =>
        ResourceChanges.ResourceChanges.of({ publish: wakes.publish })
      )
    ).pipe(Layer.provide(WakesPostgres.layer))
  ),
  Layer.provide(NodeCryptography.layer),
  Layer.provideMerge(Sql.layer)
);

const shareByDefault = Command.make(
  "share-by-default",
  {},
  Effect.fn(function* () {
    const databases = yield* CompanyDatabases.CompanyDatabases;
    for (const placement of yield* databases.listReady) {
      const report = yield* ShareByDefault.company(placement.companyId);
      yield* Console.log(
        `Company ${report.companyId}: checked ${report.patches} patches and shared ${report.shared.length} tables and stores; skipped ${report.skipped} patches with no platform row.`
      );
      for (const resource of report.leftShared)
        yield* Console.log(
          `  Left shared: ${resource.kind} ${resource.patchId}/${resource.name}, though its newest version says shared: false.`
        );
    }
    yield* Console.log("Every table and store meant to be shared is shared.");
  }, Effect.provide(companyDatabases))
).pipe(
  Command.withDescription(
    "Share every existing table and store whose newest version doesn't opt out (one-off, #1259)"
  )
);

Command.make("fleet").pipe(
  Command.withSubcommands([promote, shareByDefault]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
);
