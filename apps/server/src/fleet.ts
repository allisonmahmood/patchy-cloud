/**
 * One-off fleet operations, run as a disposable task from the host task
 * definition so they reach the platform database the way a host does.
 *
 * `bun dist/fleet.js promote <revision>` stages the revision and promotes it
 * once its hosts have warmed its spares. The deploy workflow runs it after ECS
 * has settled on the revision's hosts; promoting earlier would leave a staged
 * revision with no hosts if the rollout failed. A rollback runs it for the
 * earlier revision. It exits nonzero if the revision has no hosts or its
 * spares are not ready within five minutes.
 *
 * `bun dist/fleet.js share-by-default` shares every existing table and file
 * store unless the newest retained version that defines it says `shared: false`,
 * in every ready company database, once the release that made sharing the
 * default is live (docs/OPERATIONS.md › Sharing existing tables). It never
 * unshares, and a rerun writes nothing. It exits nonzero if any company fails
 * or anything meant to be shared is still unshared.
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
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";

class ShareByDefaultFailed extends Schema.TaggedError<ShareByDefaultFailed>()(
  "ShareByDefaultFailed",
  { companyIds: Schema.Array(Schema.String) }
) {
  override get message() {
    const shown = this.companyIds.slice(0, 5).join(", ");
    const extra = this.companyIds.length - 5;
    const suffix = extra > 0 ? `, and ${extra} more` : "";
    return `${this.companyIds.length} company databases failed to flip: ${shown}${suffix}.`;
  }
}

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

// The pool registry keeps idle company entries for 60s; retrying Busy lets older entries
// expire when walking more than 100 ready company databases in one process.
const isBusy = Schema.is(CompanyDatabases.Busy);

const shareByDefault = Command.make(
  "share-by-default",
  {},
  Effect.fn(function* () {
    const databases = yield* CompanyDatabases.CompanyDatabases;
    const visited = new Set<string>();
    const failed: string[] = [];

    const flip = Effect.fn("fleet.shareByDefault.company")(function* (companyId: string) {
      visited.add(companyId);
      const outcome = yield* ShareByDefault.company(companyId).pipe(
        Effect.retry({
          times: 18,
          schedule: Schedule.spaced("5 seconds"),
          while: isBusy
        }),
        Effect.exit
      );
      if (Exit.isFailure(outcome)) {
        failed.push(companyId);
        yield* Console.error(`Company ${companyId}: failed\n${Cause.pretty(outcome.cause)}`);
        return;
      }
      const report = outcome.value;
      yield* Console.log(
        `Company ${report.companyId}: checked ${report.patches} patches and shared ${report.shared.length} tables and stores; skipped ${report.skipped} patches with no platform row.`
      );
      for (const resource of report.leftShared)
        yield* Console.log(
          `  Left shared: ${resource.kind} ${resource.patchId}/${resource.name}, though the newest version that defines it says shared: false.`
        );
    });

    for (const placement of yield* databases.listReady) yield* flip(placement.companyId);
    // Catch any company database that finished provisioning while the first pass ran.
    for (const placement of yield* databases.listReady)
      if (!visited.has(placement.companyId)) yield* flip(placement.companyId);

    if (failed.length > 0) return yield* new ShareByDefaultFailed({ companyIds: failed });
    yield* Console.log("Every table and store meant to be shared is shared.");
  }, Effect.provide(companyDatabases))
).pipe(
  Command.withDescription(
    "Share every existing table and store unless the newest version that defines it opts out (one-off, #1259)"
  )
);

Command.make("fleet").pipe(
  Command.withSubcommands([promote, shareByDefault]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
);
