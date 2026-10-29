import { describe } from "vitest";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Files, TableOperations, SubscriptionReads } from "@patchy/primitives";
import * as TestMemberDirectory from "../../primitives/src/test/memberDirectory.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";
import {
  RuntimeMe,
  RuntimeStreamFrame,
  TableRow,
  FilePage,
  FileMetadata,
  sharedTableId,
  sharedStoreId,
  runtimeOperations,
  runtimePrincipal,
  WIRE_VERSION,
  type RuntimeEnvelope,
  type RuntimePrincipal
} from "@patchy/api";
import { Analytics } from "@patchy/analytics";
import { Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { CompanyDatabases } from "@patchy/company-database";
import { Companies, Guests, Users } from "@patchy/companies";
import { Limits, OperatingLimits } from "@patchy/limits";
import {
  CompanyAdmission,
  Binding,
  Runtime,
  RuntimeProduction,
  RuntimeLog,
  StreamAdmission,
  StreamLimits,
  RuntimeStream,
  Subscriptions,
  SubscriptionReads as RuntimeSubscriptionReads,
  me
} from "@patchy/runtime";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const owner = Fixtures.identities.uploader;
const actor = { userId: owner.user.id, admin: false };
const claims = { sub: "clerk_runtime_guest", email: "guest@runtime.example", name: "Real Guest" };
const companyId = owner.company.id;
const dependencies = Layer.mergeAll(
  Patches.layer,
  Session.layer,
  Companies.layer,
  Users.layer,
  RuntimeLog.layer,
  Limits.layer,
  OperatingLimits.layer
).pipe(
  Layer.provideMerge(Analytics.layerNoop),
  Layer.provideMerge(Fixtures.database),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);
const layer = StreamAdmission.layer.pipe(
  Layer.provideMerge(LoadedVersions.layer),
  Layer.provideMerge(TestMemberDirectory.layer),
  Layer.provideMerge(Layer.unwrap(Effect.sync(() => Fixtures.memoryStore().layer))),
  Layer.provideMerge(dependencies)
);
const decodeMe = Schema.decodeUnknownSync(RuntimeMe);
const handlers: Record<string, Runtime.Handler> = Object.fromEntries(
  Object.entries(runtimeOperations).map(([op, definition]) => [
    op,
    {
      kind: definition.kind,
      run: () => Effect.die(`Guest operation reached handler: ${op}`)
    }
  ])
);
handlers.me = me;
handlers["future.read"] = { kind: "read", run: () => Effect.die("Unlisted read ran") };

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_runtime_home', 'runtime-home', 'Home')`;
  yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
    VALUES ('usr_runtime_home', ${claims.sub}, 'cmp_runtime_home', ${claims.email}, ${claims.name}, 'admin')`;
  const guest = yield* Guests.create({
    companyId,
    clerkUserId: claims.sub,
    email: claims.email,
    name: claims.name
  });
  const published = yield* Fixtures.record(Fixtures.recordInput(owner));
  const patches = yield* Patches.Patches;
  const grant = yield* patches.grantGuest(published.patchId, guest.id, actor);
  const runtime = yield* RuntimeProduction.make(handlers).pipe(
    Effect.provide(CompanyAdmission.layer)
  );
  return { guest, published, grant, patches, runtime };
});

const call = (
  runtime: Runtime.Runtime["Service"],
  target: { patchId: string; versionId: string },
  op = "me",
  principal: RuntimePrincipal = null,
  headers: Record<string, string> = {},
  input: Partial<RuntimeEnvelope> = {}
) =>
  runtime
    .call({
      ...target,
      op,
      args: {},
      wire: WIRE_VERSION,
      principal,
      ...input
    })
    .pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`${PUBLIC_BASE_URL}/api/runtime/call`, {
            method: "POST",
            headers: {
              cookie: signedInCookies(signSession(claims)),
              origin: PUBLIC_BASE_URL,
              "x-patchy-wire": String(WIRE_VERSION),
              "x-patchy-principal": JSON.stringify(principal),
              ...headers
            }
          })
        )
      )
    );

const decodeRow = Schema.decodeUnknownSync(TableRow);
const decodePage = Schema.decodeUnknownSync(FilePage);
const decodeMetadata = Schema.decodeUnknownSync(Schema.NullOr(FileMetadata));
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(RuntimeStreamFrame));
const setupReads = Effect.gen(function* () {
  const initial = yield* setup;
  const manifest = {
    ...Fixtures.manifest,
    tier: 1 as const,
    tables: {
      notes: {
        description: "All notes, including hidden rows",
        columns: { body: { kind: "text" as const } },
        indexes: {},
        shared: true
      }
    },
    files: { docs: { description: "All documents", shared: true } },
    uses: { members: { kind: "members" as const } }
  };
  // Another patch has the same owned names. Its shared declarations must confer no guest access.
  yield* (yield* CompanyDatabases.CompanyDatabases).ensureReady(companyId);
  const other = yield* Fixtures.record(Fixtures.recordInput(owner, { manifest }));
  const definition = {
    ...manifest,
    uses: {
      ...manifest.uses,
      foreignNotes: {
        kind: "sharedTable" as const,
        patchId: other.patchId,
        table: "notes",
        id: sharedTableId(other.patchId, "notes"),
        revision: 1
      },
      foreignDocs: {
        kind: "sharedStore" as const,
        patchId: other.patchId,
        store: "docs",
        id: sharedStoreId(other.patchId, "docs"),
        revision: 1
      }
    }
  };
  const published = yield* Fixtures.record(
    Fixtures.recordInput(owner, {
      intent: "update",
      patchId: initial.published.patchId,
      manifest: definition
    })
  );
  const tables = yield* TableOperations.make;
  const files = yield* Files.makeLocal;
  const memberBinding = Binding.Binding.of({
    companyId,
    ...published,
    manifest: definition,
    wireVersion: WIRE_VERSION,
    scope: "company",
    identity: { user: owner.user, company: owner.company, admin: false },
    principal: { userId: owner.user.id },
    correlationId: "seed-owned-reads"
  });
  const row = decodeRow(
    yield* tables["tables.insert"]
      .run({ table: "notes", row: { body: "Hidden raw row" } })
      .pipe(Effect.provideService(Binding.Binding, memberBinding))
  );
  const bytes = new Uint8Array([0, 255, 128, 10]);
  yield* files["files.put"]
    .run({ store: "docs", name: "hidden/raw.bin", contentType: "application/octet-stream" }, bytes)
    .pipe(Effect.provideService(Binding.Binding, memberBinding));
  const runtime = yield* RuntimeProduction.make({ ...handlers, ...tables, ...files }).pipe(
    Effect.provide(CompanyAdmission.layer)
  );
  const identity = decodeMe(yield* call(runtime, published));
  const principal = runtimePrincipal(identity);
  const read = (op: string, args: unknown, target = published, as = principal) =>
    call(runtime, target, op, as, {}, { args });
  const request = (
    method = "GET",
    as = principal,
    cookies = signedInCookies(signSession(claims))
  ) =>
    HttpServerRequest.fromWeb(
      new Request(
        `${PUBLIC_BASE_URL}/api/runtime/files/${published.patchId}/${published.versionId}/docs/hidden/raw.bin`,
        {
          method,
          headers: {
            cookie: cookies,
            origin: PUBLIC_BASE_URL,
            "sec-fetch-site": "same-origin",
            "x-patchy-wire": String(WIRE_VERSION),
            "x-patchy-principal": JSON.stringify(as)
          }
        }
      )
    );
  const download = (
    args: unknown = { store: "docs", name: "hidden/raw.bin" },
    target = published,
    op = "files.get",
    as = principal
  ) =>
    runtime
      .getFile({ ...target, wire: WIRE_VERSION, principal: as, op, args })
      .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request("GET", as)));
  return {
    ...initial,
    published,
    definition,
    other,
    runtime,
    row,
    bytes,
    read,
    download,
    principal,
    identity,
    request,
    memberBinding,
    tables
  };
});

describe("guest runtime authority", () => {
  it.effect("resolves A's admin as B's guest, with only the explicit identity handshake", () =>
    Effect.gen(function* () {
      const { guest, published, grant, runtime } = yield* setup;
      const identity = decodeMe(yield* call(runtime, published));
      assert.deepStrictEqual(identity, {
        kind: "guest",
        guest: { id: guest.id, email: claims.email, name: claims.name },
        company: { id: companyId },
        patchId: published.patchId,
        versionId: published.versionId,
        grantId: grant.id
      });
      assert.notProperty(identity, "user");
      assert.notProperty(identity, "admin");
      const principal = runtimePrincipal(identity);
      for (const op of [
        ...Object.keys(runtimeOperations),
        "future.read",
        "subscriptions.subscribe",
        "subscriptions.unsubscribe"
      ]) {
        if (op === "me") continue;
        const error = yield* call(runtime, published, op, principal).pipe(Effect.flip);
        assert.instanceOf(error, Runtime.AccessDenied, op);
      }
      // An unrelated company's membership suspension conveys no control over B's grant.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = 'usr_runtime_home'`;
      assert.deepStrictEqual(decodeMe(yield* call(runtime, published, "me", principal)), identity);
      const member = decodeMe(
        yield* call(runtime, published, "me", null, {
          cookie: signedInCookies(
            signSession({
              sub: `clerk_${owner.user.id}`,
              email: owner.user.email,
              name: owner.user.name
            })
          )
        })
      );
      assert.deepStrictEqual(member, { user: owner.user, company: owner.company, admin: false });
    }).pipe(Effect.provide(layer))
  );

  it.effect(
    "keeps an explicitly shared deactivated same-company admin a guest until membership returns",
    () =>
      Effect.gen(function* () {
        const { guest, published, patches, runtime } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const ref = { companyId, clerkUserId: claims.sub };
        yield* Guests.end(ref);
        yield* sql`UPDATE users SET deactivated_at = now(), company_id = ${companyId}
        WHERE id = 'usr_runtime_home'`;
        yield* Guests.reopenForShare(ref);
        const grant = yield* patches.grantGuest(published.patchId, guest.id, actor);
        const identity = decodeMe(yield* call(runtime, published));
        assert.deepStrictEqual(identity, {
          kind: "guest",
          guest: { id: guest.id, email: claims.email, name: claims.name },
          company: { id: companyId },
          patchId: published.patchId,
          versionId: published.versionId,
          grantId: grant.id
        });
        assert.deepStrictEqual(
          yield* sql`SELECT role, deactivated_at IS NOT NULL AS deactivated
        FROM users WHERE id = 'usr_runtime_home'`,
          [{ role: "admin", deactivated: true }]
        );
        yield* sql`UPDATE users SET deactivated_at = NULL WHERE id = 'usr_runtime_home'`;
        assert.instanceOf(
          yield* call(runtime, published, "me", runtimePrincipal(identity)).pipe(Effect.flip),
          Runtime.PrincipalChanged
        );
        assert.include(decodeMe(yield* call(runtime, published)), { admin: true });
        yield* sql`UPDATE users SET deactivated_at = now() WHERE id = 'usr_runtime_home'`;
        assert.instanceOf(yield* call(runtime, published).pipe(Effect.flip), Runtime.AccessDenied);
      }).pipe(Effect.provide(layer))
  );

  it.effect("refuses forged patch, company, guest, grant, principal and browser boundaries", () =>
    Effect.gen(function* () {
      const { published, runtime } = yield* setup;
      const principal = runtimePrincipal(decodeMe(yield* call(runtime, published)));
      if (principal === null || !("guestId" in principal))
        return assert.fail("Expected a guest principal");
      const unrelated = yield* Fixtures.record(Fixtures.recordInput(owner));
      assert.instanceOf(yield* call(runtime, unrelated).pipe(Effect.flip), Runtime.AccessDenied);
      for (const replacement of [
        { guestId: "gst_forged" },
        { grantId: "grt_forged" },
        { companyId: "cmp_runtime_home" },
        { patchId: unrelated.patchId },
        { versionId: unrelated.versionId },
        { userId: "usr_runtime_home" }
      ]) {
        const forged: RuntimePrincipal =
          "userId" in replacement
            ? { userId: replacement.userId! }
            : { ...principal, ...replacement };
        assert.instanceOf(
          yield* call(runtime, published, "me", forged).pipe(Effect.flip),
          Runtime.PrincipalChanged
        );
      }
      assert.instanceOf(
        yield* call(runtime, published, "me", principal, {
          "x-patchy-principal": "null"
        }).pipe(Effect.flip),
        Runtime.InvalidRequest
      );
      const refusedHeaders: Array<Record<string, string>> = [
        { authorization: "Bearer fake" },
        { "x-patchy-wire": "999" },
        { cookie: "" },
        { cookie: signedInCookies(signSession({ ...claims, exp: 1 })) }
      ];
      for (const headers of refusedHeaders) {
        assert.isTrue(
          (yield* call(runtime, published, "me", principal, headers).pipe(Effect.exit))._tag ===
            "Failure"
        );
      }
      assert.instanceOf(
        yield* call(runtime, published, "tables.insert", principal, {
          origin: "https://elsewhere.example"
        }).pipe(Effect.flip),
        Runtime.AccessDenied
      );
      assert.instanceOf(
        yield* call(runtime, published, "principal", principal).pipe(Effect.flip),
        Runtime.AccessDenied
      );
    }).pipe(Effect.provide(layer))
  );

  it.effect(
    "refuses revoked grants, suspended or ended guests, stale versions and non-live patches",
    () =>
      Effect.gen(function* () {
        const { guest, published, grant, patches, runtime } = yield* setup;
        const principal = runtimePrincipal(decodeMe(yield* call(runtime, published)));
        const ref = { companyId, clerkUserId: claims.sub };
        yield* Guests.setDeactivated({ ...ref, deactivated: true });
        assert.instanceOf(
          yield* call(runtime, published, "me", principal).pipe(Effect.flip),
          Runtime.AccessDenied
        );
        yield* Guests.setDeactivated({ ...ref, deactivated: false });
        yield* call(runtime, published, "me", principal);
        yield* patches.revokeGuest(published.patchId, guest.id, actor);
        assert.instanceOf(
          yield* call(runtime, published, "me", principal).pipe(Effect.flip),
          Runtime.AccessDenied
        );
        const fresh = yield* patches.grantGuest(published.patchId, guest.id, actor);
        assert.notStrictEqual(fresh.id, grant.id);
        assert.instanceOf(
          yield* call(runtime, published, "me", principal).pipe(Effect.flip),
          Runtime.PrincipalChanged
        );
        const freshPrincipal = runtimePrincipal(decodeMe(yield* call(runtime, published)));
        const next = yield* Fixtures.record(
          Fixtures.recordInput(owner, {
            intent: "update",
            patchId: published.patchId,
            manifest: { ...Fixtures.manifest, tier: 1 }
          })
        );
        assert.instanceOf(yield* call(runtime, published).pipe(Effect.flip), Runtime.AccessDenied);
        yield* call(runtime, next);
        // Discovery follows the current eligible tier 1 contract and existing grant.
        assert.deepStrictEqual(
          (yield* patches.sharedWithGuest(claims.sub, PUBLIC_BASE_URL)).map(
            (share) => share.patchId
          ),
          [published.patchId]
        );
        yield* patches.rollback(published.patchId, actor, 1);
        assert.instanceOf(yield* call(runtime, next).pipe(Effect.flip), Runtime.AccessDenied);
        yield* call(runtime, published, "me", freshPrincipal);
        yield* patches.retire(published.patchId, actor);
        assert.instanceOf(yield* call(runtime, published).pipe(Effect.flip), Runtime.AccessDenied);
        yield* patches.restore(published.patchId, actor);
        yield* call(runtime, published);
        yield* Guests.end(ref);
        assert.instanceOf(yield* call(runtime, published).pipe(Effect.flip), Runtime.AccessDenied);
      }).pipe(Effect.provide(layer))
  );

  it.effect(
    "retains real guest and grant attribution after access ends, including an admitted request finishing",
    () =>
      Effect.gen(function* () {
        const { guest, published, grant, patches } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        let correlationId = "";
        const runtime = yield* RuntimeProduction.make({
          ...handlers,
          me: {
            kind: "read",
            run: () =>
              Effect.gen(function* () {
                const binding = yield* Binding.Binding;
                correlationId = binding.correlationId;
                yield* patches.revokeGuest(published.patchId, guest.id, actor).pipe(Effect.orDie);
                yield* Guests.setDeactivated({
                  companyId,
                  clerkUserId: claims.sub,
                  deactivated: true
                }).pipe(Effect.orDie);
                yield* Guests.end({ companyId, clerkUserId: claims.sub }).pipe(Effect.orDie);
                return binding.identity;
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
          }
        }).pipe(Effect.provide(CompanyAdmission.layer));
        const identity = decodeMe(yield* call(runtime, published));
        assert.isTrue(identity !== null && "guest" in identity);
        const log = yield* RuntimeLog.RuntimeLog;
        const retained = yield* log.find({ companyId, correlationId });
        assert.include(retained, {
          userId: null,
          companyId,
          patchId: published.patchId,
          versionId: published.versionId,
          effectivePrincipal: guest.id,
          outcome: "success"
        });
        assert.deepStrictEqual(retained?.guest, { id: guest.id, grantId: grant.id });
        assert.strictEqual((yield* Guests.findById(retained!.guest!.id))?.name, claims.name);
        assert.instanceOf(yield* call(runtime, published).pipe(Effect.flip), Runtime.AccessDenied);
      }).pipe(Effect.provide(layer))
  );

  it.effect("reads all declared owned rows and files through normal guest runtime paths", () =>
    Effect.gen(function* () {
      const {
        read,
        download,
        row,
        bytes,
        guest,
        grant,
        published,
        runtime,
        principal,
        memberBinding
      } = yield* setupReads;
      assert.deepStrictEqual(yield* read("tables.get", { table: "notes", id: row.id }), row);
      assert.deepStrictEqual(
        yield* read("tables.getMany", { table: "notes", ids: [row.id, "missing"] }),
        [row, null]
      );
      assert.deepStrictEqual(yield* read("tables.list", { table: "notes" }), {
        rows: [row],
        cursor: null
      });
      assert.deepStrictEqual(
        decodePage(yield* read("files.list", { store: "docs" })).files.map((file) => file.name),
        ["hidden/raw.bin"]
      );
      assert.strictEqual(
        decodeMetadata(yield* read("files.stat", { store: "docs", name: "hidden/raw.bin" }))?.size,
        bytes.length
      );
      assert.deepStrictEqual((yield* download()).bytes, bytes);
      // Members keep writes and reads on exactly the same paths.
      const memberCookies = {
        cookie: signedInCookies(
          signSession({
            sub: `clerk_${owner.user.id}`,
            email: owner.user.email,
            name: owner.user.name
          })
        )
      };
      const inserted = decodeRow(
        yield* call(runtime, published, "tables.insert", memberBinding.principal, memberCookies, {
          args: { table: "notes", row: { body: "Member write" } }
        })
      );
      assert.strictEqual(
        decodeRow(yield* read("tables.get", { table: "notes", id: inserted.id })).body,
        "Member write"
      );
      const log = yield* RuntimeLog.RuntimeLog;
      const sql = yield* SqlClient.SqlClient;
      const calls = yield* sql<{
        correlationId: string;
      }>`SELECT correlation_id AS "correlationId" FROM runtime_calls WHERE guest_id = ${guest.id} AND op <> 'me'`;
      assert.strictEqual(calls.length, 7);
      for (const entry of calls) {
        const recorded = yield* log.find({ companyId, correlationId: entry.correlationId });
        assert.include(recorded, {
          userId: null,
          patchId: published.patchId,
          versionId: published.versionId,
          outcome: "success",
          effectivePrincipal: guest.id
        });
        assert.deepStrictEqual(recorded?.guest, { id: guest.id, grantId: grant.id });
      }
      assert.isNotNull(principal);
    }).pipe(Effect.provide(layer))
  );

  it.effect(
    "fails closed on crafted guest operations, resource names and foreign authorities",
    () =>
      Effect.gen(function* () {
        const { read, download, runtime, published, principal, other, request } = yield* setupReads;
        const allowed = new Set([
          "me",
          "tables.get",
          "tables.getMany",
          "tables.list",
          "files.list",
          "files.stat",
          "files.get"
        ]);
        for (const op of [...Object.keys(runtimeOperations), "future.read"]) {
          if (allowed.has(op)) continue;
          assert.instanceOf(
            yield* read(op, { table: "notes", store: "docs", alias: "foreignNotes" }).pipe(
              Effect.flip
            ),
            Runtime.AccessDenied,
            op
          );
        }
        for (const table of ["missing", "foreignNotes", `${other.patchId}/notes`, "__proto__"]) {
          assert.isTrue(
            (yield* read("tables.list", { table }).pipe(Effect.exit))._tag === "Failure"
          );
        }
        for (const store of ["missing", "foreignDocs", `${other.patchId}/docs`, "__proto__"]) {
          assert.isTrue(
            (yield* download({ store, name: "hidden/raw.bin" }).pipe(Effect.exit))._tag ===
              "Failure"
          );
        }
        assert.instanceOf(
          yield* read("tables.list", { table: "notes" }, other).pipe(Effect.flip),
          Runtime.AccessDenied
        );
        assert.instanceOf(
          yield* download(undefined, other).pipe(Effect.flip),
          Runtime.AccessDenied
        );
        for (const args of [
          { table: "notes", patchId: other.patchId },
          { table: "notes", companyId: "cmp_runtime_home" }
        ])
          assert.instanceOf(
            yield* read("tables.list", args).pipe(Effect.flip),
            Runtime.InvalidRequest
          );
        for (const op of ["shared.files.get", "files.redeem"])
          assert.instanceOf(
            yield* download(
              { alias: "foreignDocs", name: "hidden/raw.bin", handle: "forged" },
              published,
              op
            ).pipe(Effect.flip),
            Runtime.AccessDenied
          );
        let consumed = false;
        assert.instanceOf(
          yield* runtime
            .putFile(
              {
                ...published,
                wire: WIRE_VERSION,
                principal,
                op: "files.put",
                args: { store: "docs", name: "hidden/raw.bin" }
              },
              Effect.sync(() => {
                consumed = true;
                return new Uint8Array([1]);
              })
            )
            .pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, request("PUT")),
              Effect.flip
            ),
          Runtime.AccessDenied
        );
        assert.isFalse(consumed);
      }).pipe(Effect.provide(layer))
  );

  it.effect(
    "rechecks ended access and the current version before every fresh table or file read",
    () =>
      Effect.gen(function* () {
        const { read, download, guest, patches, published, definition, runtime } =
          yield* setupReads;
        const ref = { companyId, clerkUserId: claims.sub };
        const refused = Effect.gen(function* () {
          assert.instanceOf(
            yield* read("tables.list", { table: "notes" }).pipe(Effect.flip),
            Runtime.AccessDenied
          );
          assert.instanceOf(yield* download().pipe(Effect.flip), Runtime.AccessDenied);
        });
        yield* Guests.setDeactivated({ ...ref, deactivated: true });
        yield* refused;
        yield* Guests.setDeactivated({ ...ref, deactivated: false });
        yield* download();
        const next = yield* Fixtures.record(
          Fixtures.recordInput(owner, {
            intent: "update",
            patchId: published.patchId,
            manifest: definition
          })
        );
        yield* refused;
        yield* call(runtime, next);
        yield* patches.rollback(published.patchId, actor, 2);
        yield* download();
        yield* patches.revokeGuest(published.patchId, guest.id, actor);
        yield* refused;
      }).pipe(Effect.provide(layer))
  );
  it.effect(
    "keeps retained data inaccessible once its resource is omitted from the current manifest",
    () =>
      Effect.gen(function* () {
        const { published, definition, runtime, download } = yield* setupReads;
        const current = yield* Fixtures.record(
          Fixtures.recordInput(owner, {
            intent: "update",
            patchId: published.patchId,
            manifest: {
              ...definition,
              name: "guest-retained-resources",
              tables: {},
              files: {},
              uses: {}
            }
          })
        );
        const principal = runtimePrincipal(decodeMe(yield* call(runtime, current)));
        const denied = yield* call(
          runtime,
          current,
          "tables.list",
          principal,
          {},
          { args: { table: "notes" } }
        ).pipe(Effect.flip);
        assert.strictEqual(denied.code, "table_not_declared");
        assert.strictEqual(
          (yield* download(
            { store: "docs", name: "hidden/raw.bin" },
            current,
            "files.get",
            principal
          ).pipe(Effect.flip)).code,
          "invalid_request"
        );
        assert.instanceOf(yield* download().pipe(Effect.flip), Runtime.AccessDenied);
      }).pipe(Effect.provide(layer))
  );

  it.effect("runs guest owned-table subscriptions and retains real guest attribution", () =>
    Effect.gen(function* () {
      const { published, row, request, principal, guest, grant, tables, memberBinding } =
        yield* setupReads;
      const events = yield* Queue.unbounded<WideEvents.WideEvent>();
      const eventLayer = WideEvents.layerWithSink.pipe(
        Layer.provide(
          Layer.succeed(WideEvents.Sink, {
            write: (event) => Queue.offer(events, event).pipe(Effect.asVoid)
          })
        ),
        Layer.provide(WideEvents.layerMetadata),
        Layer.orDie
      );
      const streams = yield* RuntimeStream.make.pipe(
        Effect.provideServiceEffect(Subscriptions.Subscriptions, Subscriptions.make),
        Effect.provide(SubscriptionReads.layer),
        Effect.provide(StreamLimits.layer),
        Effect.provide(eventLayer)
      );
      const document = { ...published, documentId: "guest_owned_subscription_document" };
      const pull = yield* Stream.toPull(
        yield* streams
          .open(document)
          .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()))
      );
      const frame = Effect.map(pull, (chunks) =>
        decodeFrame(new TextDecoder().decode(chunks[0]).slice(6).trim())
      );
      const hello = yield* frame;
      assert(hello.type === "hello");
      yield* frame; // served
      let sequence = 0;
      const subscribe = (
        op: "tables.list" | "tables.get" | "shared.list" | "members.list" | "server.call",
        args: Record<string, unknown>
      ) =>
        streams
          .update({
            ...document,
            generation: hello.generation,
            sequence: ++sequence,
            type: "replace",
            subscriptions: [{ id: "read", op, args }]
          })
          .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()));
      const snapshot = Effect.gen(function* () {
        let current = yield* frame;
        while (current.type === "admitted" || current.type === "served") current = yield* frame;
        return current;
      });
      yield* subscribe("tables.list", { table: "notes" });
      assert.deepInclude(yield* snapshot, {
        type: "snapshot",
        result: { rows: [row], cursor: null }
      });
      let event = yield* Queue.take(events);
      while (event.type !== "re-run") event = yield* Queue.take(events);
      assert.include(event, {
        viewerId: guest.id,
        guestId: guest.id,
        grantId: grant.id,
        patchId: published.patchId,
        versionId: published.versionId
      });
      // Existing wake/reconciliation path delivers changed rows, without polling in the client.
      const changed = decodeRow(
        yield* tables["tables.update"]
          .run({ table: "notes", id: row.id, patch: { body: "Live guest update" } })
          .pipe(Effect.provideService(Binding.Binding, memberBinding))
      );
      assert.deepInclude(yield* snapshot, {
        type: "snapshot",
        result: { rows: [changed], cursor: null }
      });
      yield* subscribe("tables.get", { table: "notes", id: row.id });
      assert.deepInclude(yield* snapshot, { type: "snapshot", result: changed });
      for (const [op, args] of [
        ["shared.list", { alias: "foreignNotes" }],
        ["members.list", {}],
        ["server.call", { handler: "hidden.read", args: {} }]
      ] as const) {
        yield* subscribe(op, args);
        const refused = yield* snapshot;
        assert(refused.type === "error");
        assert.strictEqual(refused.error.code, "access_denied");
      }
      assert.isNotNull(principal);
    }).pipe(Effect.scoped, Effect.provide(layer))
  );

  for (const change of ["revoke", "deactivate", "publish"] as const) {
    it.effect(`refuses new subscription work and reconnect after guest ${change}`, () =>
      Effect.gen(function* () {
        const { published, request, guest, patches, definition, tables, row, memberBinding } =
          yield* setupReads;
        let reads = 0;
        const reader = yield* SubscriptionReads.make;
        const streams = yield* RuntimeStream.make.pipe(
          Effect.provideServiceEffect(Subscriptions.Subscriptions, Subscriptions.make),
          Effect.provideService(RuntimeSubscriptionReads.SubscriptionReads, {
            ...reader,
            read: (input) =>
              Effect.sync(() => {
                reads++;
              }).pipe(Effect.andThen(reader.read(input)))
          }),
          Effect.provide(StreamLimits.layer),
          Effect.provide(WideEvents.layerNoop)
        );
        const document = { ...published, documentId: "guest_ended_subscription_document" };
        const pull = yield* Stream.toPull(
          yield* streams
            .open(document)
            .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()))
        );
        const frame = Effect.map(pull, (chunks) =>
          decodeFrame(new TextDecoder().decode(chunks[0]).slice(6).trim())
        );
        const hello = yield* frame;
        assert(hello.type === "hello");
        yield* frame;
        const update = (sequence: number) =>
          streams
            .update({
              ...document,
              generation: hello.generation,
              sequence,
              type: "replace",
              subscriptions: [{ id: "read", op: "tables.list", args: { table: "notes" } }]
            })
            .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()));
        yield* update(1);
        yield* frame;
        assert.strictEqual((yield* frame).type, "snapshot");
        if (change === "revoke") yield* patches.revokeGuest(published.patchId, guest.id, actor);
        else if (change === "deactivate")
          yield* Guests.setDeactivated({ companyId, clerkUserId: claims.sub, deactivated: true });
        else
          yield* Fixtures.record(
            Fixtures.recordInput(owner, {
              intent: "update",
              patchId: published.patchId,
              manifest: definition
            })
          );
        assert.instanceOf(yield* update(2).pipe(Effect.flip), Runtime.AccessDenied);
        assert.instanceOf(
          yield* streams
            .open(document)
            .pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, request()),
              Effect.flip
            ),
          Runtime.AccessDenied
        );
        // Wake the old subscription through a member write: it must not start another guest read.
        yield* tables["tables.update"]
          .run({ table: "notes", id: row.id, patch: { body: "Must remain private" } })
          .pipe(Effect.provideService(Binding.Binding, memberBinding));
        assert.strictEqual((yield* frame).type, "access_denied");
        assert.strictEqual(reads, 1, "Ended authority must not start another storage read");
      }).pipe(Effect.scoped, Effect.provide(layer))
    );
  }
});
