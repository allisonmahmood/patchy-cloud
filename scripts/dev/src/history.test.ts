import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { AgentConnections, MachineTokens } from "@patchy/auth";
import { Companies, Users } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import {
  AttioSource,
  ConnectionStore,
  CredentialKeys,
  ImapNetwork,
  ImapSource,
  PidgeonSource,
  PostgresSource,
  PostHogSource,
  SqlConnectionStore
} from "@patchy/integrations";
import { InvocationLog, RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import { saveConnections } from "./connections.js";
import { writeHistory } from "./history.js";
import { ids, loadScenario, offlineConnections, seedScenario } from "./scenario.js";

const repo = new URL("../../..", import.meta.url).pathname;

// The production sources, which nothing here calls: an offline connection never reaches one.
const sources = Layer.mergeAll(
  PostgresSource.layer,
  PostHogSource.layer,
  PidgeonSource.layer,
  AttioSource.layer,
  ImapSource.layer.pipe(Layer.provide(ImapNetwork.layer))
);

it.layer(
  Layer.mergeAll(
    SqlConnectionStore.layer.pipe(Layer.provide(sources)),
    Companies.layer,
    Users.layer,
    InvocationLog.layer,
    MachineTokens.layer,
    AgentConnections.layer
  ).pipe(
    Layer.provideMerge(RuntimeLog.layer),
    Layer.provideMerge(
      CredentialKeys.layerFromKeys(
        Redacted.make("test:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=")
      )
    ),
    Layer.provideMerge(Testing.layer()),
    Layer.provideMerge(NodeCryptography.layer),
    Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
  )
)("dense's history", (it) => {
  // History is measured back from now, and the database's own clock ends an app, so both run on
  // the live clock: the block shares one database, and the second sees the first's rows.
  it.effect("saves its connections as connect does, then leaves each in its state", () =>
    Effect.gen(function* () {
      const store = yield* ConnectionStore.ConnectionStore;
      const { scenario } = yield* loadScenario(repo, "dense");
      const companyId = `cmp_env_${scenario.company.handle}`;
      yield* seedScenario(scenario);
      yield* saveConnections(scenario);
      const saved = yield* store.list(companyId);
      expect(saved.map((connection) => connection.status)).toEqual(
        offlineConnections(scenario).map(() => "connected")
      );

      yield* writeHistory(scenario, []);
      // A resumed `up` saves again, which changes nothing.
      yield* saveConnections(scenario);
      const settled = new Map(
        (yield* store.list(companyId)).map((connection) => [
          `${connection.integration}/${connection.handle}`,
          connection
        ])
      );
      for (const { integration, handle, state } of offlineConnections(scenario)) {
        const connection = settled.get(`${integration}/${handle}`)!;
        const reason =
          connection.integration === "attio"
            ? connection.display.writable
            : connection.integration === "imap"
              ? connection.display.paused
              : connection.integration === "pidgeon"
                ? connection.display.retired
                : undefined;
        expect({ handle, status: connection.status, reason: reason !== undefined }).toEqual({
          handle,
          status:
            state === "paused" || (state === "needs-attention" && integration === "attio")
              ? "disconnected"
              : "connected",
          reason: state === "needs-attention"
        });
        // The pages read what patches can use from its snapshot.
        const detail = yield* store.detail(companyId, integration, handle);
        expect(detail.snapshot, handle).not.toBeNull();
      }
    }).pipe(TestClock.withLive)
  );

  it.effect(
    "dates a patch's versions, opens and log, and a retirement as the services stamp it",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { scenario } = yield* loadScenario(repo, "dense");
        const allison = ids(
          scenario,
          scenario.people.find((person) => person.key === "allison")!
        );
        const patchOf = (name: string) =>
          scenario.patches.find((patch) => ("repo" in patch ? patch.repo : patch.name) === name)!;
        yield* seedScenario(scenario);
        // As `up` leaves them: published just now, Holiday rota then retired.
        for (const [id, name, versions] of [
          ["densenewbiz1", "new-business", 3],
          ["denseholiday", "holiday-rota", 1],
          ["densetimesht", "timesheets", 1]
        ] as const) {
          yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name,
              last_changed_at, description_updated_at)
            VALUES (${id}, ${allison.companyId}, ${allison.userId}, ${name}, ${name}, now(), now())`;
          for (let number = 1; number <= versions; number++)
            yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key,
            content_hash, file_size, created_by_machine_token_id, owner_user_id, tier, release,
            manifest_version, wire_version, schema_revision, manifest, publish_key,
            payload_digest, publish_response, publish_status)
            VALUES (${`${id}_${number}`}, ${id}, ${number}, ${`dense/${id}/${number}`}, 'test', 1,
              ${allison.tokenId}, ${allison.userId}, 2, 'test', 1, 1, 0, '{}'::jsonb,
              ${`${id}-${number}`}, 'test', '{}'::jsonb, 201)`;
        }
        yield* sql`UPDATE patches SET retired_at = now() WHERE id = 'denseholiday'`;
        yield* writeHistory(scenario, [
          { patch: patchOf("new-business"), name: "new-business" },
          { patch: patchOf("holiday-rota"), name: "holiday-rota" },
          { patch: patchOf("timesheets"), name: "timesheets" }
        ]);

        const days = (column: string, table: string, id: string) =>
          sql<{ readonly days: number }>`SELECT round(extract(epoch FROM now() - ${sql(column)})
          / 86400, 1)::float AS days FROM ${sql(table)} WHERE id = ${id}`.pipe(
            Effect.map(([row]) => row?.days)
          );
        // New Business: first published 30 days ago, its latest version 2 hours ago.
        expect(yield* days("created_at", "patch_versions", "densenewbiz1_1")).toBe(30);
        expect(yield* days("created_at", "patch_versions", "densenewbiz1_3")).toBe(0.1);
        expect(yield* days("description_updated_at", "patches", "densenewbiz1")).toBe(30);
        const [opened] = yield* sql<{ readonly score: number; readonly visits: number }>`
        SELECT o.score, p.visit_count::int AS visits FROM patch_opens o
        JOIN patches p ON p.id = o.patch_id
        WHERE o.patch_id = 'densenewbiz1' AND o.user_id = ${allison.userId}`;
        expect(opened).toEqual({ score: 18, visits: 41 });
        // Two failures today; the refusal was yesterday, and neither Running nor Unknown fails.
        const summary = yield* (yield* InvocationLog.InvocationLog).calls({
          companyId: allison.companyId,
          since: (yield* Clock.currentTimeMillis) - 86_400_000
        });
        expect(summary.get("densenewbiz1")?.failures).toBe(2);
        const outcomes = yield* sql<{ readonly handler: string; readonly outcome: string }>`
        SELECT handler, outcome FROM runtime_invocations
        WHERE patch_id = 'densenewbiz1' AND handler IN ('deals.importLeads', 'deals.update')
        ORDER BY handler`;
        expect(outcomes).toEqual([
          { handler: "deals.importLeads", outcome: "pending" },
          { handler: "deals.update", outcome: "unknown_outcome" }
        ]);
        // Timesheets' running call is running at its connection too, until its deadline.
        const warehouse = yield* (yield* RuntimeLog.RuntimeLog).recent({
          companyId: allison.companyId,
          connectionId: "conn_env_brightline_postgres_warehouse"
        });
        expect(warehouse.map((call) => call.outcome)).toEqual(["pending", "success", "success"]);
        // Holiday rota: retired 2 days ago, which is its last change.
        expect(yield* days("retired_at", "patches", "denseholiday")).toBe(2);
        expect(yield* days("updated_at", "patches", "denseholiday")).toBe(2);
        expect(yield* days("last_changed_at", "patches", "denseholiday")).toBe(2);
      }).pipe(TestClock.withLive)
  );

  it.effect("writes none of a patch's log when the history is interrupted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { scenario } = yield* loadScenario(repo, "dense");
      const allison = ids(
        scenario,
        scenario.people.find((person) => person.key === "allison")!
      );
      const spend = scenario.patches.find((patch) => "repo" in patch && patch.repo === "spend")!;
      yield* seedScenario(scenario);
      yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
        VALUES ('densespend01', ${allison.companyId}, ${allison.userId}, 'spend', 'spend')`;
      yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key,
        content_hash, file_size, created_by_machine_token_id, owner_user_id, tier, release,
        manifest_version, wire_version, schema_revision, manifest, publish_key, payload_digest,
        publish_response, publish_status)
        VALUES ('densespend01_1', 'densespend01', 1, 'dense/spend/1', 'test', 1,
          ${allison.tokenId}, ${allison.userId}, 2, 'test', 1, 1, 0, '{}'::jsonb, 'densespend01-1',
          'test', '{}'::jsonb, 201)`;
      // The first call begins, then settling it fails, as a stop mid-write would.
      const interrupted = Layer.effect(
        InvocationLog.InvocationLog,
        Effect.map(InvocationLog.make, (log) =>
          InvocationLog.InvocationLog.of({ ...log, finish: () => Effect.die("stopped") })
        )
      );
      const exit = yield* Effect.exit(
        writeHistory(scenario, [{ patch: spend, name: "spend" }]).pipe(Effect.provide(interrupted))
      );
      expect(exit._tag).toBe("Failure");
      const begun = yield* sql`SELECT 1 FROM runtime_invocations WHERE patch_id = 'densespend01'`;
      expect(begun.length).toBe(0);

      // The next `up` writes it whole.
      yield* writeHistory(scenario, [{ patch: spend, name: "spend" }]);
      const written = yield* sql<{ readonly outcome: string }>`
        SELECT outcome FROM runtime_invocations WHERE patch_id = 'densespend01'`;
      expect(written.map((row) => row.outcome)).toEqual(["success", "success"]);
    }).pipe(TestClock.withLive)
  );

  it.effect("gives people their computers, apps and invitations, and deactivates who it says", () =>
    Effect.gen(function* () {
      const { scenario } = yield* loadScenario(repo, "dense");
      const person = (key: string) =>
        ids(
          scenario,
          scenario.people.find((someone) => someone.key === key)!
        );
      yield* seedScenario(scenario);
      yield* writeHistory(scenario, []);

      // What still acts as Allison: a computer and apps used within 30 days, not older ones.
      const allison = person("allison");
      const computers = yield* (yield* MachineTokens.MachineTokens).list(allison.userId);
      expect(computers.map((computer) => computer.name)).toEqual([
        "Dev environment",
        "Studio Mac mini"
      ]);
      const apps = yield* (yield* AgentConnections.AgentConnections).list(allison.userId);
      expect(apps.map((app) => app.clientName).sort()).toEqual(["Claude", "Codex"]);
      expect(yield* (yield* MachineTokens.MachineTokens).list(person("priya").userId)).toEqual([]);

      const invites = yield* (yield* Companies.Companies).listInvites(allison.companyId);
      const now = yield* Clock.currentTimeMillis;
      expect(invites.map((invite) => [invite.email, invite.expiresAt.getTime() > now])).toEqual([
        ["lee@brightline.example", false],
        ["noah@brightline.example", true],
        ["ines@brightline.example", true]
      ]);

      const rowan = yield* (yield* Users.Users).findByClerkId(person("rowan").clerkUserId);
      expect(rowan?.deactivatedAt).not.toBeNull();
      // Every start seeds again, and leaves a deactivated person deactivated.
      yield* seedScenario(scenario);
      const again = yield* (yield* Users.Users).findByClerkId(person("rowan").clerkUserId);
      expect(again?.deactivatedAt).not.toBeNull();
    }).pipe(TestClock.withLive)
  );
});
