import { assert, it } from "@effect/vitest";
import { PatchyApi, authorizationClient } from "@patchy/api";
import { Authorization as BearerAuthorization, MachineTokens } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { Teams } from "@patchy/companies";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as ConnectionAttention from "../ConnectionAttention.js";
import * as ConnectionsApi from "../ConnectionsApi.js";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as Pages from "../test/pages.js";
import * as Release45 from "../test/release45Connections.js";
import * as Models from "./Models.js";

/** The integrations the release before Models shipped, as its CLI asks for them. */
const before = Release45.integrations;
const olderCli = before.join(",");
const decodeOlderListing = Schema.decodeUnknownEffect(Release45.Connections);
const decodeOlderDetail = Schema.decodeUnknownEffect(Release45.ConnectionDetail);

// The page harness's store, with the switch on as in every test, under the connections API.
const layer = ConnectionsApi.layer.pipe(
  Layer.provideMerge(BearerAuthorization.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provideMerge(Pages.services(PidgeonSource.layer))
);

type Owner = Effect.Success<ReturnType<typeof Pages.createCompany>>;

/** A company with an OpenAI key and a decision role on it, and every change they report. */
const setup = Effect.fn(function* (handle: string) {
  const owner = yield* Pages.createCompany(handle);
  const store = yield* ConnectionStore.ConnectionStore;
  const who = { companyId: owner.company.id, userId: owner.user.id };
  const reports: Array<ConnectionStore.ModelsChanged> = [];
  const report: ConnectionStore.ModelsReport = (changed) =>
    Effect.sync(() => void reports.push(changed));
  const provider = yield* store.connectProvider(
    { ...who, provider: "openai", credentials: Redacted.make("sk-first-key") },
    report
  );
  const role = yield* store.createRole(
    {
      ...who,
      handle: "triage",
      kind: "decision",
      description: "Sorts requests",
      providerId: provider.id,
      model: "gpt-5-mini"
    },
    report
  );
  const roleNow = Effect.flatMap(store.get(who.companyId, role.id), (row) =>
    row.integration === "models" ? Effect.succeed(row) : Effect.die("not a role")
  );
  return { owner, store, who, reports, report, provider, role, roleNow };
});

/** A live patch of the owner's with a version that declares `role`, its current one unless not. */
const declare = Effect.fn(function* (
  owner: Owner,
  name: string,
  role: ConnectionStore.ModelsConnection,
  options: { readonly current: boolean } = { current: true }
) {
  const sql = yield* SqlClient.SqlClient;
  const patchId = `${owner.company.handle}-${name}`;
  const versionId = `${patchId}-v1`;
  const manifest = JSON.stringify({
    uses: { triage: { kind: "models", handle: role.handle, id: role.id, revision: 1 } }
  });
  yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
    VALUES (${patchId}, ${owner.company.id}, ${owner.user.id}, ${name}, ${name})`;
  yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key,
    content_hash, file_size, created_by_machine_token_id, owner_user_id, tier, release,
    manifest_version, wire_version, schema_revision, manifest, publish_key, payload_digest,
    publish_response, publish_status)
    VALUES (${versionId}, ${patchId}, 1, ${`models/${versionId}.html`}, 'test', 1,
      ${DEV_SEED.tokenId}, ${owner.user.id}, 2, 'test', 1, 1, 0, ${manifest}::jsonb, ${versionId},
      'test', '{}'::jsonb, 201)`;
  if (options.current)
    yield* sql`UPDATE patches SET current_version_id = ${versionId} WHERE id = ${patchId}`;
});

/** A Postgres connection of the owner's as an earlier release made it, with its snapshot. */
const legacy = Effect.fn(function* (owner: Owner, handle: string) {
  const sql = yield* SqlClient.SqlClient;
  const id = `${owner.company.handle}-${handle}`;
  yield* sql`INSERT INTO connections
    (id, company_id, integration, handle, description, mode, status, display, credentials,
      key_id, credential_revision, metadata_revision, created_by, last_discovered_at)
    VALUES (${id}, ${owner.company.id}, 'postgres', ${handle}, 'The warehouse', 'company',
      'connected', ${JSON.stringify({ host: "db.example", port: 5432, database: "sales", role: "reader" })},
      'sealed', 'key', 1, 1, ${owner.user.id}, '2026-11-01T00:00:00Z')`;
  yield* sql`INSERT INTO connection_snapshots
    (connection_id, company_id, integration, revision, snapshot, created_at)
    VALUES (${id}, ${owner.company.id}, 'postgres', 1,
      ${JSON.stringify({ version: 1, relations: [], enums: [], exclusions: [] })},
      '2026-11-01T00:00:00Z')`;
  return id;
});

/** Until another session of this database waits on a lock, as a change forked behind one does. */
const someoneWaits = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const [row] = yield* sql<{ readonly waiting: number }>`SELECT count(*)::int AS waiting
      FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((row?.waiting ?? 0) > 0) return;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die("nothing waited on the lock");
});

/**
 * Runs `change` in a transaction of its own and keeps it open, its locks held and nothing
 * committed, until `release` is run: another request's change in flight.
 */
const inFlight = Effect.fn(function* (
  change: Effect.Effect<unknown, unknown, SqlClient.SqlClient>
) {
  const sql = yield* SqlClient.SqlClient;
  const held = yield* Deferred.make<void>();
  const released = yield* Deferred.make<void>();
  const fiber = yield* sql
    .withTransaction(
      change.pipe(
        Effect.andThen(Deferred.succeed(held, undefined)),
        Effect.andThen(Deferred.await(released))
      )
    )
    .pipe(Effect.forkChild);
  yield* Deferred.await(held);
  return Deferred.succeed(released, undefined).pipe(Effect.andThen(Fiber.join(fiber)));
});

const connectionsClient = (token: string) =>
  HttpApiTest.groups(PatchyApi, ["connections"]).pipe(
    Effect.provide(authorizationClient(Redacted.make(token)))
  );
type Client = Effect.Success<ReturnType<typeof connectionsClient>>;

/** The connections API as `owner` calls it with a machine token, over `store` when given. */
const api = <A, E, R>(
  owner: Owner,
  use: (client: Client) => Effect.Effect<A, E, R>,
  store?: ConnectionStore.ConnectionStore["Service"]
) => {
  const calls = Effect.gen(function* () {
    const minted = yield* (yield* MachineTokens.MachineTokens).mint({
      userId: owner.user.id,
      name: "Models"
    });
    return yield* use(yield* connectionsClient(minted.token));
  });
  return store === undefined
    ? calls
    : calls.pipe(
        // Fresh: the suite's own group, over its own store, is already built.
        Effect.provide(
          Layer.fresh(ConnectionsApi.layer).pipe(
            Layer.provide(Layer.succeed(ConnectionStore.ConnectionStore, store))
          )
        )
      );
};

it.effect(
  "the switch is exactly true or false, absent or empty is off, and nothing else reads",
  () =>
    Effect.gen(function* () {
      const read = (env: { readonly PATCHY_MODELS?: string }) =>
        Effect.exit(Models.enabled.parse(ConfigProvider.fromUnknown(env)));
      assert.deepStrictEqual(yield* read({ PATCHY_MODELS: "true" }), Exit.succeed(true));
      for (const env of [{}, { PATCHY_MODELS: "" }, { PATCHY_MODELS: "false" }])
        assert.deepStrictEqual(yield* read(env), Exit.succeed(false));
      // Effect's own boolean reads all of these; the switch reads none, so the launch stops.
      for (const value of ["1", "yes", "on", "y", "TRUE", "True", " true", "0", "no", "off"])
        assert.isTrue(Exit.isFailure(yield* read({ PATCHY_MODELS: value })), value);
    })
);

it.layer(layer)("Models", (it) => {
  it.effect(
    "a role follows a remap, stops while its provider is paused and starts again on resume",
    () =>
      Effect.gen(function* () {
        const { store, who, reports, report, provider, role, roleNow } =
          yield* setup("models-remap");
        assert.deepInclude(provider, {
          integration: "openai",
          handle: "main",
          status: "connected"
        });
        assert.deepStrictEqual(role.role, {
          kind: "decision",
          model: "gpt-5-mini",
          providerId: provider.id,
          provider: { integration: "openai", handle: "main", status: "connected" }
        });
        assert.isTrue(ConnectionStore.serving(role));
        // A second key of the same provider takes a name of its own.
        const unnamed = yield* store
          .connectProvider({ ...who, provider: "openai", credentials: Redacted.make("sk-other") })
          .pipe(Effect.flip);
        assert.strictEqual(unnamed._tag, "ConnectionHandleTaken");
        const backup = yield* store.connectProvider(
          { ...who, provider: "openai", handle: "backup", credentials: Redacted.make("sk-other") },
          report
        );
        assert.deepStrictEqual(
          (yield* store.providers(who.companyId)).map((item) => item.handle),
          ["backup", "main"]
        );

        // A remap keeps the contract patches were published against and moves the role's revision.
        const remap = {
          ...who,
          id: role.id,
          change: { kind: "remap", providerId: backup.id, model: "openai/gpt-5-mini" }
        } as const;
        assert.deepInclude(yield* store.changeModels(remap, report), { change: "remapped" });
        const moved = yield* roleNow;
        assert.deepInclude(moved.role, { providerId: backup.id, model: "openai/gpt-5-mini" });
        assert.strictEqual(moved.metadataRevision, role.metadataRevision);
        assert.strictEqual(moved.credentialRevision, role.credentialRevision + 1);
        yield* store.changeModels(remap, report);

        // Its provider's pause stops it, and leaves its own state alone.
        const pause = { ...who, id: backup.id, change: { kind: "pause" } } as const;
        assert.deepInclude(yield* store.changeModels(pause, report), {
          integration: "openai",
          change: "paused"
        });
        const stopped = yield* roleNow;
        assert.strictEqual(stopped.status, "connected");
        assert.isFalse(ConnectionStore.serving(stopped));
        assert.strictEqual(
          (yield* store.detail(who.companyId, "models", "triage")).status,
          "disconnected"
        );
        yield* store.changeModels(pause, report);
        yield* store.changeModels({ ...pause, change: { kind: "resume" } }, report);
        assert.isTrue(ConnectionStore.serving(yield* roleNow));
        const detail = yield* store.detail(who.companyId, "models", "triage");
        assert.strictEqual(detail.status, "connected");
        assert.deepInclude(detail.snapshot, { version: 1, kind: "decision", revision: 1 });

        // Each change reported once, with its commit; the ones that changed nothing never did.
        assert.deepStrictEqual(
          reports.map((changed) => `${changed.integration} ${changed.change}`),
          [
            "openai connected",
            "models created",
            "openai connected",
            "models remapped",
            "openai paused",
            "openai resumed"
          ]
        );
      })
  );

  it.effect("a remap that waited behind another reads the mapping that one left", () =>
    Effect.gen(function* () {
      const { store, who, provider, role, roleNow } = yield* setup("models-remap-race");
      const backup = yield* store.connectProvider({
        ...who,
        provider: "openai",
        handle: "backup",
        credentials: Redacted.make("sk-backup")
      });
      const sql = yield* SqlClient.SqlClient;
      // A remap to the backup holds the role's lock, as remap does, and hasn't committed.
      const release = yield* inFlight(
        Effect.gen(function* () {
          yield* sql`SELECT 1 FROM connections WHERE id = ${role.id} FOR UPDATE`;
          yield* sql`UPDATE model_roles SET provider_id = ${backup.id} WHERE connection_id = ${role.id}`;
          yield* sql`UPDATE connections SET credential_revision = credential_revision + 1
            WHERE id = ${role.id}`;
        })
      );
      const reports: Array<ConnectionStore.ModelsChanged> = [];
      // Remapping it back waits for that lock, and must then see where the first one left it.
      const back = yield* store
        .changeModels(
          {
            ...who,
            id: role.id,
            change: { kind: "remap", providerId: provider.id, model: "gpt-5-mini" }
          },
          (changed) => Effect.sync(() => void reports.push(changed))
        )
        .pipe(Effect.forkChild);
      yield* someoneWaits;
      yield* release;
      yield* Fiber.join(back);
      assert.strictEqual((yield* roleNow).role.providerId, provider.id);
      assert.deepStrictEqual(
        reports.map((changed) => changed.change),
        ["remapped"]
      );
    })
  );

  it.effect("a remap waits for a change to the provider it leaves, as to the one it joins", () =>
    Effect.gen(function* () {
      const { owner, store, who, provider, role, roleNow } = yield* setup("models-pause-race");
      yield* declare(owner, "sorter", role);
      const backup = yield* store.connectProvider({
        ...who,
        provider: "openai",
        handle: "backup",
        credentials: Redacted.make("sk-backup")
      });
      const sql = yield* SqlClient.SqlClient;
      // A pause of the role's provider holds its lock and hasn't committed: it has named the
      // patch whose role it stops.
      const release = yield* inFlight(
        sql`SELECT 1 FROM connections WHERE id = ${provider.id} FOR UPDATE`.pipe(
          Effect.andThen(
            sql`UPDATE connections SET status = 'disconnected' WHERE id = ${provider.id}`
          )
        )
      );
      const move = yield* store
        .changeModels({
          ...who,
          id: role.id,
          change: { kind: "remap", providerId: backup.id, model: "gpt-5-mini" }
        })
        .pipe(Effect.forkChild);
      // The move can't leave the provider until the pause commits, so the patch it named was
      // stopped.
      yield* someoneWaits;
      assert.strictEqual((yield* roleNow).role.providerId, provider.id);
      yield* release;
      yield* Fiber.join(move);
      assert.strictEqual((yield* roleNow).role.providerId, backup.id);
    })
  );

  it.effect("a pause or resume names only the patches whose role it stops or starts", () =>
    Effect.gen(function* () {
      const { owner, store, who, provider, role } = yield* setup("models-reach");
      yield* declare(owner, "sorter", role);
      const reports: Array<string> = [];
      const change = (id: string, kind: "pause" | "resume") =>
        store
          .changeModels({ ...who, id, change: { kind } }, (changed) =>
            Effect.sync(() => void reports.push(`${changed.integration} ${changed.change}`))
          )
          .pipe(Effect.map((changed) => changed.affected));
      // The role paused first: its provider's pause and resume change nothing for its patch.
      assert.deepStrictEqual(yield* change(role.id, "pause"), ["sorter"]);
      assert.deepStrictEqual(yield* change(provider.id, "pause"), []);
      assert.deepStrictEqual(yield* change(provider.id, "resume"), []);
      assert.deepStrictEqual(yield* change(role.id, "resume"), ["sorter"]);
      // Its provider paused first: the role's own pause and resume change nothing for it.
      assert.deepStrictEqual(yield* change(provider.id, "pause"), ["sorter"]);
      assert.deepStrictEqual(yield* change(role.id, "pause"), []);
      assert.deepStrictEqual(yield* change(role.id, "resume"), []);
      assert.deepStrictEqual(yield* change(provider.id, "resume"), ["sorter"]);
      // A change to the state it already has reports nothing, and reaches no one.
      assert.deepStrictEqual(yield* change(provider.id, "resume"), []);
      assert.deepStrictEqual(reports, [
        "models paused",
        "openai paused",
        "openai resumed",
        "models resumed",
        "openai paused",
        "models paused",
        "models resumed",
        "openai resumed"
      ]);
    })
  );

  it.effect(
    "a role pauses and resumes; a new key keeps a paused provider paused and moves its revision",
    () =>
      Effect.gen(function* () {
        const { store, who, reports, report, provider, role, roleNow } =
          yield* setup("models-keys");
        yield* store.changeModels({ ...who, id: role.id, change: { kind: "pause" } }, report);
        assert.strictEqual((yield* roleNow).status, "disconnected");
        assert.isFalse(ConnectionStore.serving(yield* roleNow));
        yield* store.changeModels({ ...who, id: role.id, change: { kind: "resume" } }, report);
        assert.isTrue(ConnectionStore.serving(yield* roleNow));

        yield* store.changeModels({ ...who, id: provider.id, change: { kind: "pause" } }, report);
        const replaced = yield* store.changeModels(
          {
            ...who,
            id: provider.id,
            change: { kind: "replaceKey", credentials: Redacted.make("sk-replaced-key") }
          },
          report
        );
        assert.strictEqual(replaced.change, "key_replaced");
        const [now] = yield* store.providers(who.companyId);
        assert.deepInclude(now, { status: "disconnected" });
        assert.strictEqual(now!.credentialRevision, provider.credentialRevision + 2);
        // The key is sealed as any connection's credentials are, bound to its provider.
        const sql = yield* SqlClient.SqlClient;
        const [sealed] = yield* sql<{ readonly credentials: string; readonly keyId: string }>`
          SELECT credentials, key_id AS "keyId" FROM connections WHERE id = ${provider.id}`;
        assert.notInclude(sealed!.credentials, "sk-replaced-key");
        const opened = yield* (yield* CredentialKeys.CredentialKeys).decrypt(
          { companyId: who.companyId, id: provider.id, integration: "openai" },
          sealed!
        );
        assert.strictEqual(Redacted.value(opened), "sk-replaced-key");
        assert.deepStrictEqual(
          reports.slice(2).map((changed) => `${changed.integration} ${changed.change}`),
          ["models paused", "models resumed", "openai paused", "openai key_replaced"]
        );
      })
  );

  it.effect(
    "refuses deleting a provider a role uses and a role a stored version declares, and names who a change reaches",
    () =>
      Effect.gen(function* () {
        const { owner, store, who, reports, report, provider, role } =
          yield* setup("models-deletes");
        const used = yield* store
          .changeModels({ ...who, id: provider.id, change: { kind: "delete" } }, report)
          .pipe(Effect.flip);
        assert.instanceOf(used, ConnectionStore.ProviderInUse);
        assert.deepStrictEqual(used.roles, ["triage"]);
        assert.include(used.message, "models/triage");

        yield* declare(owner, "sorter", role);
        const declared = yield* store
          .changeModels({ ...who, id: role.id, change: { kind: "delete" } }, report)
          .pipe(Effect.flip);
        assert.instanceOf(declared, ConnectionStore.ConnectionInUse);
        // Pausing the provider stops the live patch that declares its role, and says so.
        assert.deepStrictEqual(
          (yield* store.changeModels(
            { ...who, id: provider.id, change: { kind: "pause" } },
            report
          )).affected,
          ["sorter"]
        );
        assert.strictEqual(reports.length, 3);

        // A version that isn't any patch's current one still declares a role it keeps.
        const older = yield* store.createRole({
          ...who,
          handle: "older",
          kind: "text",
          description: "",
          providerId: provider.id,
          model: "gpt-5"
        });
        yield* declare(owner, "retired-sorter", older, { current: false });
        assert.instanceOf(
          yield* store
            .changeModels({ ...who, id: older.id, change: { kind: "delete" } })
            .pipe(Effect.flip),
          ConnectionStore.ConnectionInUse
        );

        // Nothing declares a spare role, so it goes, keeping its snapshot, and then its provider.
        const spareKey = yield* store.connectProvider({
          ...who,
          provider: "openai",
          handle: "spare",
          credentials: Redacted.make("sk-spare")
        });
        const spare = yield* store.createRole({
          ...who,
          handle: "drafts",
          kind: "text",
          description: "",
          providerId: spareKey.id,
          model: "gpt-5"
        });
        for (const id of [spare.id, spareKey.id])
          assert.deepInclude(
            yield* store.changeModels({ ...who, id, change: { kind: "delete" } }, report),
            { change: "deleted", affected: [] }
          );
        assert.deepStrictEqual(yield* store.snapshot(who.companyId, spare.id, 1), {
          integration: "models",
          snapshot: { version: 1, kind: "text" }
        });
        assert.deepStrictEqual(
          (yield* store.providers(who.companyId)).map((item) => item.handle),
          ["main"]
        );
      })
  );

  it.effect("a role's own settings change as any connection's, and nothing else of it does", () =>
    Effect.gen(function* () {
      const { store, who, role, roleNow } = yield* setup("models-verbs");
      const identity = { ...who, id: role.id };
      const credentials = { ...identity, credentials: Redacted.make("sk-not-a-role-key") };
      const refusals = yield* Effect.all([
        Effect.flip(store.disconnect(identity)),
        Effect.flip(store.reconnect(identity)),
        Effect.flip(store.test(identity)),
        Effect.flip(store.refresh(identity)),
        Effect.flip(store.delete(identity)),
        Effect.flip(store.rotate(credentials)),
        Effect.flip(store.retarget(credentials))
      ]);
      assert.isTrue(refusals.every((error) => error._tag === "ConnectionNotFound"));
      yield* store.describe({ ...identity, description: "Sorts support requests" });
      yield* store.blockGuests({ ...identity, block: true });
      assert.deepInclude(yield* roleNow, {
        description: "Sorts support requests",
        blockGuests: true,
        status: "connected"
      });
    })
  );

  it.effect("checks a model id, and maps a role only to its own company's provider", () =>
    Effect.gen(function* () {
      const { store, who, provider, role } = yield* setup("models-scope");
      const other = yield* setup("models-scope-other");
      const make = (providerId: string, model: string) =>
        store.createRole({
          ...who,
          handle: "second",
          kind: "text",
          description: "",
          providerId,
          model
        });
      const remap = (id: string, providerId: string, model: string) =>
        store.changeModels({ ...who, id, change: { kind: "remap", providerId, model } });
      const refusals = yield* Effect.all([
        Effect.flip(make(provider.id, "gpt 5")),
        Effect.flip(remap(role.id, provider.id, "")),
        Effect.flip(make(other.provider.id, "gpt-5")),
        Effect.flip(remap(role.id, other.provider.id, "gpt-5")),
        // A provider is no role to remap, and a role holds no key to replace.
        Effect.flip(remap(provider.id, provider.id, "gpt-5")),
        Effect.flip(
          store.changeModels({
            ...who,
            id: role.id,
            change: { kind: "replaceKey", credentials: Redacted.make("sk-role") }
          })
        )
      ]);
      assert.deepStrictEqual(
        refusals.map((error) => error._tag),
        [
          "InvalidModelId",
          "InvalidModelId",
          "ConnectionNotFound",
          "ConnectionNotFound",
          "ConnectionNotFound",
          "ConnectionNotFound"
        ]
      );
    })
  );

  it.effect(
    "never shows a provider where a builder looks: lists, details, offers, forms or attention",
    () =>
      Effect.gen(function* () {
        const { owner, store, who, provider, role } = yield* setup("models-hidden");
        yield* declare(owner, "sorter", role);
        // The store's connection reads know only the public integrations.
        assert.deepStrictEqual(
          (yield* store.list(who.companyId)).map((row) => row.id),
          [role.id]
        );
        assert.strictEqual(
          (yield* Effect.flip(store.get(who.companyId, provider.id)))._tag,
          "ConnectionNotFound"
        );
        assert.isFalse((yield* store.usage(who.companyId)).has(provider.id));
        assert.strictEqual(
          (yield* Effect.flip(store.canUse(who.companyId, provider.id, who.userId)))._tag,
          "ConnectionNotFound"
        );

        // Discovery lists the role, never its provider, even to a caller that asks for one.
        yield* api(owner, (client) =>
          Effect.gen(function* () {
            const listed = yield* client.listConnections({
              query: { integrations: [...before, "models", "openai"].join(","), all: true }
            });
            assert.deepStrictEqual(
              listed.connections.map((row) => `${row.integration}/${row.handle}`),
              ["models/triage"]
            );
            // No patch can declare a role yet, so its hint offers no add.
            assert.deepInclude(listed.connections[0], {
              status: "connected",
              hint: "No patch can declare a model role yet."
            });
            assert.deepStrictEqual(
              listed.offered?.map((offer) => offer.integration),
              ["postgres", "posthog", "pidgeon", "attio", "imap", "models"]
            );
            const hidden = yield* client.getIntegrationConnection({
              params: { integration: "openai", handle: "main" },
              responseMode: "response-only"
            });
            assert.strictEqual(hidden.status, 404);
            const shown = yield* client.getIntegrationConnection({
              params: { integration: "models", handle: "triage" }
            });
            assert.deepInclude(shown, { integration: "models", status: "connected" });
          })
        );

        // The Integrations pages show neither, and their forms reach neither.
        const index = yield* Pages.read("/settings/integrations", owner.user);
        assert.strictEqual(index.status, 200);
        for (const id of [provider.id, role.id]) {
          assert.notInclude(index.html, id);
          assert.strictEqual(
            (yield* Pages.read(`/settings/integrations/${id}`, owner.user)).status,
            404
          );
        }
        for (const [id, action, fields] of [
          [provider.id, "disconnect", {}],
          [provider.id, "delete", {}],
          [role.id, "description", { description: "Changed from the wrong page" }],
          [role.id, "block-guests", {}],
          [role.id, "disconnect", {}]
        ] as const)
          assert.strictEqual(
            (yield* Pages.send(
              `/settings/integrations/${id}/${action}`,
              Pages.post(owner.user, fields)
            )).status,
            404
          );
        assert.deepInclude((yield* store.providers(who.companyId))[0], { status: "connected" });
        assert.deepInclude(yield* store.get(who.companyId, role.id), {
          description: "Sorts requests",
          blockGuests: false,
          status: "connected"
        });
        for (const integration of ["openai", "models"]) {
          const path = `/settings/integrations/connect/${integration}`;
          assert.strictEqual((yield* Pages.read(path, owner.user)).status, 404);
          const posted = yield* Pages.send(
            path,
            Pages.post(owner.user, {
              handle: "posted",
              description: "",
              credentials: "sk-posted-key"
            })
          );
          assert.strictEqual(posted.status, 404);
        }
        assert.deepStrictEqual(
          (yield* store.providers(who.companyId)).map((item) => item.handle),
          ["main"]
        );
        assert.notInclude(
          (yield* store.list(who.companyId)).map((row) => row.handle),
          "posted"
        );

        // A team grant on a provider, however it got there, shows it to no one: the team's
        // connections and a member on the team see only the role the team was given.
        const sql = yield* SqlClient.SqlClient;
        const teams = yield* Teams.Teams;
        const actor = { companyId: who.companyId, actorId: who.userId };
        const team = yield* teams.create({ ...actor, name: "Models team" });
        const member = yield* Pages.addMember(owner);
        yield* teams.setMemberships({ ...actor, teamId: team.id, add: [member.id, who.userId] });
        yield* store.setAudience({
          ...who,
          id: role.id,
          audience: { kind: "teams", teamIds: [team.id] }
        });
        yield* sql`INSERT INTO connection_team_grants (connection_id, company_id, team_id)
          VALUES (${provider.id}, ${who.companyId}, ${team.id})`;
        assert.deepStrictEqual(
          (yield* SqlConnectionStore.teamConnections(who.companyId, store.integrations)).map(
            (row) => `${row.integration}/${row.handle}`
          ),
          ["models/triage"]
        );
        assert.deepStrictEqual(
          (yield* store.list(who.companyId, member.id)).map((row) => row.id),
          [role.id]
        );
        assert.strictEqual(
          (yield* Effect.flip(store.audience(who.companyId, provider.id)))._tag,
          "ConnectionNotFound"
        );
        const catalogue = yield* Pages.read("/settings/integrations/connect", owner.user);
        assert.notInclude(catalogue.html, "/settings/integrations/connect/models");
        assert.notInclude(catalogue.html, "/settings/integrations/connect/openai");

        // Attention names neither, even with the provider paused under a live patch's role: no
        // page fixes a role yet, and a provider is never a connection.
        yield* store.changeModels({ ...who, id: provider.id, change: { kind: "pause" } });
        assert.deepStrictEqual(yield* ConnectionAttention.needingAttention(who.companyId), []);
        yield* api(owner, (client) =>
          Effect.gen(function* () {
            const [row] = (yield* client.listConnections({ query: { integrations: "models" } }))
              .connections;
            assert.deepInclude(row, { status: "disconnected", reason: "not_connected" });
            assert.include(row?.hint, "Its model provider is paused");
          })
        );
      })
  );

  it.effect(
    "with the switch off, none of it is made, found or offered, and nothing else changes",
    () =>
      Effect.gen(function* () {
        const { owner, store, who, provider, role } = yield* setup("models-off");
        yield* declare(owner, "sorter", role);
        const warehouse = yield* legacy(owner, "warehouse");
        const switched = (env: Record<string, string>) =>
          SqlConnectionStore.make.pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
          );
        assert.include((yield* switched({ PATCHY_MODELS: "true" })).integrations, "models");
        const off = yield* switched({});
        assert.deepStrictEqual(off.integrations, before);

        const refusals = yield* Effect.all([
          Effect.flip(off.providers(who.companyId)),
          Effect.flip(
            off.connectProvider({ ...who, provider: "openai", credentials: Redacted.make("sk-x") })
          ),
          Effect.flip(
            off.createRole({
              ...who,
              handle: "second",
              kind: "text",
              description: "",
              providerId: provider.id,
              model: "gpt-5"
            })
          ),
          Effect.flip(off.changeModels({ ...who, id: provider.id, change: { kind: "pause" } }))
        ]);
        assert.isTrue(refusals.every((error) => error._tag === "ModelsUnavailable"));
        assert.isFalse((yield* off.usage(who.companyId)).has(role.id));
        const hidden = yield* Effect.all([
          Effect.flip(off.get(who.companyId, role.id)),
          Effect.flip(off.snapshot(who.companyId, role.id, 1)),
          Effect.flip(off.detail(who.companyId, "models", "triage")),
          Effect.flip(off.disconnect({ ...who, id: provider.id }))
        ]);
        assert.isTrue(hidden.every((error) => error._tag === "ConnectionNotFound"));
        // A role's guest block holds with the switch off, so a retained version that declares it
        // stays closed to guests; and nothing resolves a role to publish against.
        yield* store.blockGuests({ ...who, id: role.id, block: true });
        assert.deepStrictEqual([...(yield* off.blockingGuests([role.id]))], [role.id]);
        assert.strictEqual(
          (yield* Effect.flip(
            off.resolve(who.companyId, {
              kind: "models",
              handle: "triage",
              id: role.id,
              revision: 1
            })
          ))._tag,
          "ConnectionNotConnected"
        );

        // The ordinary connection reads the same either way, from the store and the API.
        assert.deepStrictEqual(
          (yield* off.list(who.companyId)).map((row) => row.id),
          [warehouse]
        );
        assert.deepStrictEqual(
          yield* off.get(who.companyId, warehouse),
          yield* store.get(who.companyId, warehouse)
        );
        assert.deepStrictEqual(
          yield* off.detail(who.companyId, "postgres", "warehouse"),
          yield* store.detail(who.companyId, "postgres", "warehouse")
        );
        const discovered = (over?: ConnectionStore.ConnectionStore["Service"]) =>
          api(
            owner,
            (client) =>
              Effect.all([
                client.listConnections({ query: { integrations: olderCli, all: true } }),
                client.getIntegrationConnection({
                  params: { integration: "postgres", handle: "warehouse" }
                })
              ]),
            over
          );
        const [listed, shown] = yield* discovered(off);
        assert.deepStrictEqual(listed, {
          connections: [
            {
              id: warehouse,
              handle: "warehouse",
              integration: "postgres",
              description: "The warehouse",
              status: "connected",
              hint: "patchy add postgres/warehouse"
            }
          ],
          offered: [
            { integration: "postgres", connected: true },
            { integration: "posthog", connected: false },
            { integration: "pidgeon", connected: false },
            { integration: "attio", connected: false },
            { integration: "imap", connected: false }
          ]
        });
        assert.deepStrictEqual([listed, shown], yield* discovered());

        // Its API neither lists nor offers a role, and refuses one by handle before any lookup.
        yield* api(
          owner,
          (client) =>
            Effect.gen(function* () {
              const withModels = yield* client.listConnections({
                query: { integrations: [...before, "models"].join(","), all: true }
              });
              assert.deepStrictEqual(
                withModels.connections.map((row) => row.id),
                [warehouse]
              );
              assert.notInclude(
                (withModels.offered ?? []).map((offer) => offer.integration),
                "models"
              );
              const detail = yield* client.getIntegrationConnection({
                params: { integration: "models", handle: "triage" },
                responseMode: "response-only"
              });
              assert.strictEqual(detail.status, 404);
            }),
          { ...off, detail: () => Effect.die("looked up a role while Models is off") }
        );
      })
  );

  it.effect("a CLI from before Models decodes what a host with Models on answers it", () =>
    Effect.gen(function* () {
      const { owner, role } = yield* setup("models-older-cli");
      yield* declare(owner, "sorter", role);
      const warehouse = yield* legacy(owner, "warehouse");
      yield* api(owner, (client) =>
        Effect.gen(function* () {
          // Its listing asks for the integrations it decodes, and decodes the answer.
          const answer = yield* client.listConnections({
            query: { integrations: olderCli, all: true },
            responseMode: "response-only"
          });
          const listed = yield* decodeOlderListing(yield* answer.json);
          assert.deepStrictEqual(
            listed.connections.map((row) => row.id),
            [warehouse]
          );
          assert.notInclude(
            (listed.offered ?? []).map((offer) => offer.integration),
            "models"
          );
          // A bare handle is looked up in that listing, then by its integration.
          const found = yield* client.getIntegrationConnection({
            params: { integration: "postgres", handle: "warehouse" },
            responseMode: "response-only"
          });
          assert.deepInclude(yield* decodeOlderDetail(yield* found.json), {
            integration: "postgres",
            handle: "warehouse"
          });
          // The role's handle isn't in its listing, so it asks for it as Postgres, as before
          // other integrations, and is told there's none.
          const missing = yield* client.getIntegrationConnection({
            params: { integration: "postgres", handle: "triage" },
            responseMode: "response-only"
          });
          assert.strictEqual(missing.status, 404);
        })
      );
    })
  );

  it.effect(
    "the store reading only release 45's integrations, as near an older host as a test gets, hides the rest",
    () =>
      Effect.gen(function* () {
        const { owner, who, provider, role } = yield* setup("models-older");
        yield* declare(owner, "sorter", role);
        // This is the current store with release 45's allowlist: it shows that the filters hide
        // what they should, not that release 45's own code does.
        const older = yield* SqlConnectionStore.knowing(before);
        assert.deepStrictEqual(yield* older.list(who.companyId), []);
        assert.isFalse((yield* older.usage(who.companyId)).has(role.id));
        const hidden = yield* Effect.all([
          Effect.flip(older.get(who.companyId, role.id)),
          Effect.flip(older.get(who.companyId, provider.id)),
          Effect.flip(older.snapshot(who.companyId, role.id, 1)),
          Effect.flip(older.detail(who.companyId, "models", "triage"))
        ]);
        assert.isTrue(hidden.every((error) => error._tag === "ConnectionNotFound"));
        yield* api(
          owner,
          (client) =>
            Effect.gen(function* () {
              const detail = yield* client.getIntegrationConnection({
                params: { integration: "models", handle: "triage" },
                responseMode: "response-only"
              });
              assert.strictEqual(detail.status, 404);
            }),
          { ...older, detail: () => Effect.die("the allowlisted store looked up a role") }
        );

        // Knowing Models but not this role's provider, it reads the role as unavailable, and
        // makes or moves nothing to that provider.
        const unaware = yield* SqlConnectionStore.knowing([...before, "models"]);
        const [read] = yield* unaware.list(who.companyId);
        assert.strictEqual(read?.integration, "models");
        if (read?.integration === "models") assert.isNull(read.role.provider);
        assert.isFalse(ConnectionStore.serving(read!));
        assert.strictEqual(
          (yield* unaware.detail(who.companyId, "models", "triage")).status,
          "disconnected"
        );
        assert.deepStrictEqual(yield* unaware.providers(who.companyId), []);
        const refusals = yield* Effect.all([
          Effect.flip(
            unaware.connectProvider({
              ...who,
              provider: "openai",
              credentials: Redacted.make("sk-x")
            })
          ),
          Effect.flip(
            unaware.changeModels({
              ...who,
              id: role.id,
              change: { kind: "remap", providerId: provider.id, model: "gpt-5" }
            })
          )
        ]);
        assert.deepStrictEqual(
          refusals.map((error) => error._tag),
          ["ModelsUnavailable", "ConnectionNotFound"]
        );
        yield* api(
          owner,
          (client) =>
            Effect.gen(function* () {
              const [row] = (yield* client.listConnections({ query: { integrations: "models" } }))
                .connections;
              assert.deepInclude(row, { status: "disconnected", reason: "not_connected" });
              assert.include(row?.hint, "isn't available");
            }),
          unaware
        );
      })
  );
});
