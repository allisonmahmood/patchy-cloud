import * as Live from "./attioHarness.js";
import { afterAll, assert, describe, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { registry } from "@patchy/limits/registry";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as PidgeonSource from "../src/pidgeon/Source.js";
import * as PostgresSource from "../src/postgres/Source.js";
import * as PostHogSource from "../src/posthog/Source.js";
import * as SqlConnectionStore from "../src/SqlConnectionStore.js";
import * as Source from "../src/attio/Source.js";
import { NodeCryptography } from "@patchy/core";

/**
 * Attio connections against Attio itself: Patchy's probe workspace, read with its read-only key.
 * It reads and never writes, so it leaves nothing behind. The key check's refusals and every bound
 * are offline (`src/attio`); this tier proves Attio still answers as Patchy expects, and
 * catches Attio drifting. It's never a required check.
 *
 * The workspace's Pro trial ends around 2026-11-10; on Attio's Free plan it keeps companies,
 * people, deals and lists but no custom object, so a case about one skips when discovery doesn't
 * find it.
 *
 *   node --env-file=$HOME/.config/patchy-cloud/attio-probe.env node_modules/vitest/vitest.mjs \
 *     run --config vitest.attio-live.config.ts
 * with `ATTIO_TEST_READ_KEY` set to that file's read key.
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const services = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 5).toString("base64")}`)),
  RuntimeLog.layer,
  // Never called: these connections reach no database, PostHog project or Pidgeon address.
  Layer.succeed(
    PostgresSource.Source,
    PostgresSource.Source.of({
      test: () => Effect.die("no Postgres here"),
      inspect: () => Effect.die("no Postgres here")
    })
  ),
  PostHogSource.layer,
  PidgeonSource.layer,
  Live.layer
).pipe(Layer.provideMerge(Testing.layer()), Layer.provideMerge(NodeCryptography.layer));

afterAll(Live.summary);

describe.skipIf(Live.READ_KEY === undefined)("Attio, live on Patchy's probe workspace", () => {
  it.layer(services, { timeout: "300 seconds", excludeTestServices: true })(
    "the key check, discovery and Replace key",
    (it) => {
      it.effect("accepts the read key, bound to its workspace and only reading", () =>
        Effect.gen(function* () {
          const attio = yield* Source.Source;
          const self = yield* attio.check(Live.readKey());
          assert.notStrictEqual(self.workspace.id, "");
          for (const scope of Source.requiredScopes) assert.include(self.scopes, scope);
          assert.isTrue(self.scopes.every((scope) => scope.endsWith(":read")));
        })
      );

      it.effect("discovers the workspace within its bounds and deadline", () =>
        Effect.gen(function* () {
          const attio = yield* Source.Source;
          const started = Date.now();
          const { snapshot } = yield* attio.inspect(Live.readKey());
          assert.isBelow(Date.now() - started, registry["attio.discovery.deadline"].default);
          const object = (slug: string) =>
            snapshot.objects.find((item) => item.slug === slug) ??
            assert.fail(`No ${slug} object.`);
          const deals = object("deals");
          object("companies");
          object("people");
          // Attio's standard deal attributes, as the probe found them.
          const attribute = (slug: string) =>
            deals.attributes.find((item) => item.slug === slug) ??
            assert.fail(`deals has no ${slug}.`);
          assert.strictEqual(attribute("stage").type, "status");
          assert.includeMembers([...(attribute("stage").options ?? [])], ["Lead", "Won 🎉"]);
          assert.strictEqual(attribute("owner").type, "actor-reference");
          assert.strictEqual(attribute("value").type, "currency");
          assert.deepInclude(attribute("associated_company").targets ?? [], {
            id: object("companies").id,
            slug: "companies"
          });
          // A workspace this small reads every option.
          assert.isFalse(
            [...snapshot.objects, ...snapshot.lists].some((container) =>
              container.attributes.some((item) => item.optionsSkipped === true)
            )
          );
          for (const list of snapshot.lists)
            assert.isTrue(list.parents.length > 0, `${list.slug} has a parent`);
        })
      );

      it.effect("reads a custom object's references while the plan keeps custom objects", (ctx) =>
        Effect.gen(function* () {
          const attio = yield* Source.Source;
          const { snapshot } = yield* attio.inspect(Live.readKey());
          const custom = snapshot.objects.find((item) => item.slug === "probe_deals");
          // Vitest's skip throws, which ends the case as skipped, not failed.
          if (custom === undefined)
            return ctx.skip("No probe_deals: the workspace's plan has no custom objects.");
          const references = custom.attributes.filter((item) => item.type === "record-reference");
          assert.isAbove(references.length, 0);
          assert.isTrue(references.every((item) => (item.targets ?? []).length > 0));
        })
      );

      it.effect("replaces a connection's key with the same key, rediscovering its workspace", () =>
        Effect.gen(function* () {
          const store = yield* SqlConnectionStore.make;
          const connected = yield* store.connect({
            integration: "attio",
            ...who,
            handle: "crm-live",
            description: "The probe workspace",
            credentials: Live.readKey()
          });
          const replaced = yield* store.rotate({
            ...who,
            id: connected.id,
            credentials: Live.readKey()
          });
          assert.strictEqual(replaced.status, "connected");
          assert.strictEqual(replaced.credentialRevision, connected.credentialRevision + 1);
          assert.strictEqual(replaced.metadataRevision, connected.metadataRevision + 1);
          if (replaced.integration !== "attio" || connected.integration !== "attio")
            return assert.fail("not an Attio connection");
          assert.deepStrictEqual(replaced.display.workspace, connected.display.workspace);
          const tested = yield* store.test({ ...who, id: connected.id });
          assert.strictEqual(tested.status, "connected");
        })
      );
    }
  );
});
