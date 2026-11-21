import { assert, it } from "@effect/vitest";
import { PatchyApi, authorizationClient } from "@patchy/api";
import { Authorization as BearerAuthorization, MachineTokens } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as ConnectionAttention from "../ConnectionAttention.js";
import * as ConnectionsApi from "../ConnectionsApi.js";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as Pages from "../test/pages.js";

/** The integrations the release before Models shipped. */
const before = ["postgres", "posthog", "pidgeon", "attio", "imap", "github"] as const;
/** What a CLI from before Models asks the instance for. */
const olderCli = before.join(",");

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

/** A live patch of the owner's whose current version declares `role`. */
const declare = Effect.fn(function* (
  owner: Owner,
  name: string,
  role: ConnectionStore.ModelsConnection
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
  yield* sql`UPDATE patches SET current_version_id = ${versionId} WHERE id = ${patchId}`;
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
        // Pausing the provider, or the role, reaches the live patch that declares it.
        for (const id of [provider.id, role.id])
          assert.deepStrictEqual(
            (yield* store.changeModels({ ...who, id, change: { kind: "pause" } }, report)).affected,
            ["sorter"]
          );
        assert.strictEqual(reports.length, 4);

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
            assert.deepInclude(listed.connections[0], {
              status: "connected",
              hint: "patchy add models/triage"
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
        for (const integration of ["openai", "models"])
          assert.strictEqual(
            (yield* Pages.read(`/settings/integrations/connect/${integration}`, owner.user)).status,
            404
          );
        const catalogue = yield* Pages.read("/settings/integrations/connect", owner.user);
        assert.notInclude(catalogue.html, "/settings/integrations/connect/models");
        assert.notInclude(catalogue.html, "/settings/integrations/connect/openai");

        // Attention names the role its provider stopped, never the provider.
        yield* store.changeModels({ ...who, id: provider.id, change: { kind: "pause" } });
        assert.deepStrictEqual(
          (yield* ConnectionAttention.needingAttention(who.companyId)).map((item) => [
            item.name,
            item.problem
          ]),
          [["models/triage", "Its model provider is paused"]]
        );
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
        const { owner, who, provider, role } = yield* setup("models-off");
        yield* declare(owner, "sorter", role);
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
        assert.deepStrictEqual(yield* off.list(who.companyId), []);
        assert.isFalse((yield* off.usage(who.companyId)).has(role.id));
        const hidden = yield* Effect.all([
          Effect.flip(off.get(who.companyId, role.id)),
          Effect.flip(off.snapshot(who.companyId, role.id, 1)),
          Effect.flip(off.detail(who.companyId, "models", "triage")),
          Effect.flip(off.disconnect({ ...who, id: provider.id }))
        ]);
        assert.isTrue(hidden.every((error) => error._tag === "ConnectionNotFound"));

        // Its API neither lists nor offers a role, and refuses one by handle before any lookup.
        yield* api(
          owner,
          (client) =>
            Effect.gen(function* () {
              const listed = yield* client.listConnections({
                query: { integrations: [...before, "models"].join(","), all: true }
              });
              assert.deepStrictEqual(listed.connections, []);
              assert.notInclude(
                (listed.offered ?? []).map((offer) => offer.integration),
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

  it.effect(
    "an older release hides what it doesn't know: an old CLI, an old host and an unknown provider",
    () =>
      Effect.gen(function* () {
        const { owner, who, provider, role } = yield* setup("models-older");
        yield* declare(owner, "sorter", role);
        // A CLI from before Models asks for the integrations it decodes, and Models isn't one.
        yield* api(owner, (client) =>
          Effect.map(
            client.listConnections({ query: { integrations: olderCli, all: true } }),
            (listed) => {
              assert.deepStrictEqual(listed.connections, []);
              assert.notInclude(
                (listed.offered ?? []).map((offer) => offer.integration),
                "models"
              );
            }
          )
        );

        // A host from before Models reads neither, by id, handle, snapshot or declaration.
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
          { ...older, detail: () => Effect.die("an older host looked up a role") }
        );

        // A release that knows Models but not this role's provider reads the role as unavailable,
        // and makes or moves nothing to that provider.
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
