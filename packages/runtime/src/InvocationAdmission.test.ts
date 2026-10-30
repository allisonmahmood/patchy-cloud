import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import { Limits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Invocation from "./Invocation.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";
import { me } from "./me.js";
import { NodeCryptography } from "@patchy/core";

const viewer = {
  user: { id: "usr_viewer", name: "Viewer", email: "viewer@example.test" },
  company: { id: "cmp_test", name: "Test", handle: "test" },
  admin: false
};
const version: LoadedVersions.LoadedVersion = {
  patchId: "testpatch001",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  companyId: viewer.company.id,
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: {}
  },
  scope: "company",
  wireVersion: WIRE_VERSION
};
const request = HttpServerRequest.fromWeb(
  new Request("http://localhost/api/runtime/call", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "x-patchy-wire": String(WIRE_VERSION),
      "x-patchy-principal": JSON.stringify({ userId: viewer.user.id })
    }
  })
);

it.effect(
  "refuses direct primitive operations from a tier 2 document even after rollback to tier 1",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      // The gate is by prefix: one operation each for tables, files, shared, members and each
      // integration.
      const operations = [
        "tables.insert",
        "files.list",
        "shared.files.get",
        "members.search",
        "postgres.list",
        "posthog.query"
      ];
      const handlers = Object.fromEntries(
        operations.map((op) => [
          op,
          {
            kind: "read" as const,
            run: () =>
              Effect.sync(() => {
                calls++;
                return null;
              })
          }
        ])
      );
      const runtime = yield* Runtime.make(
        { me, ...handlers },
        {
          origin: "http://localhost",
          identity: () => Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
        }
      );
      for (const op of operations) {
        const error = yield* runtime
          .call({
            patchId: version.patchId,
            versionId: version.versionId,
            wire: WIRE_VERSION,
            principal: { userId: viewer.user.id },
            op,
            args: {}
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.code, "server_required");
      }
      assert.strictEqual(calls, 0);
      assert.deepStrictEqual(
        yield* runtime.call({
          patchId: version.patchId,
          versionId: version.versionId,
          wire: WIRE_VERSION,
          principal: { userId: viewer.user.id },
          op: "me",
          args: {}
        }),
        viewer
      );
    }).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(LoadedVersions.LoadedVersions, {
        find: () => Effect.succeed(Option.some({ ...version, patchTier: 1 }))
      }),
      Effect.provide(Limits.layer),
      Effect.provide(NodeCryptography.layer)
    )
);

// A pinned shell sends a first server call without asking `me`, so admission alone stops another viewer.
it.effect(
  "refuses a server call pinned to another viewer before invoking it or counting it",
  () => {
    let invoked = 0;
    const called: unknown[] = [];
    return Effect.gen(function* () {
      const runtime = yield* Runtime.make(
        { me },
        {
          origin: "http://localhost",
          identity: () => Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) }),
          called: (call) => Effect.sync(() => called.push(call))
        }
      );
      const call = (userId: string) =>
        runtime
          .call({
            patchId: version.patchId,
            versionId: version.versionId,
            wire: WIRE_VERSION,
            principal: { userId },
            op: "server.call",
            args: { handler: "notes.create", args: {} }
          })
          .pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("http://localhost/api/runtime/call", {
                  method: "POST",
                  headers: {
                    origin: "http://localhost",
                    "x-patchy-wire": String(WIRE_VERSION),
                    "x-patchy-principal": JSON.stringify({ userId })
                  }
                })
              )
            )
          );
      const error = yield* call("usr_other").pipe(Effect.flip);
      assert.strictEqual(error.code, "principal_changed");
      assert.strictEqual(invoked, 0);
      assert.deepStrictEqual(called, []);
      yield* call(viewer.user.id);
      assert.strictEqual(invoked, 1);
      // Only the admitted call is the viewer's activity on their open documents.
      assert.deepStrictEqual(called, [
        {
          companyId: viewer.company.id,
          patchId: version.patchId,
          versionId: version.versionId,
          viewerId: viewer.user.id
        }
      ]);
    }).pipe(
      Effect.provideService(Invocation.Invocation, {
        call: () =>
          Effect.sync(() => {
            invoked++;
            return { ok: true as const, value: null };
          })
      }),
      Effect.provideService(LoadedVersions.LoadedVersions, {
        find: () => Effect.succeed(Option.some({ ...version, patchTier: 2 }))
      }),
      Effect.provide(Limits.layer),
      Effect.provide(NodeCryptography.layer)
    );
  }
);

it.effect(
  "a retained tier 1 document gets only me while tier 2 is served, and writes reopen on rollback",
  () =>
    Effect.gen(function* () {
      let patchTier = 2;
      const directWrite = { kind: "mutation" as const, run: () => Effect.succeed({ id: "saved" }) };
      const runtime = yield* Runtime.make(
        { me, "tables.insert": directWrite },
        {
          origin: "http://localhost",
          identity: () => Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
        }
      ).pipe(
        Effect.provideService(LoadedVersions.LoadedVersions, {
          find: () =>
            Effect.sync(() =>
              Option.some({ ...version, manifest: { ...version.manifest, tier: 1 }, patchTier })
            )
        })
      );
      const call = {
        patchId: version.patchId,
        versionId: version.versionId,
        wire: WIRE_VERSION,
        principal: { userId: viewer.user.id },
        args: {}
      };
      for (const op of ["tables.list", "tables.insert", "server.call"]) {
        const error = yield* runtime
          .call({
            patchId: version.patchId,
            versionId: version.versionId,
            wire: WIRE_VERSION,
            principal: { userId: viewer.user.id },
            op,
            args: {}
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.code, "server_required");
      }
      assert.deepStrictEqual(
        yield* runtime.call({
          patchId: version.patchId,
          versionId: version.versionId,
          wire: WIRE_VERSION,
          principal: { userId: viewer.user.id },
          op: "me",
          args: {}
        }),
        viewer
      );
      patchTier = 1;
      assert.deepStrictEqual(yield* runtime.call({ ...call, op: "tables.insert" }), {
        id: "saved"
      });
    }).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provide(Limits.layer),
      Effect.provide(NodeCryptography.layer)
    )
);

it.effect("a public version reaches no data, even one that declared the member directory", () =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.make(
      { me },
      {
        origin: "http://localhost",
        identity: () => Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
      }
    ).pipe(
      Effect.provideService(LoadedVersions.LoadedVersions, {
        find: () =>
          Effect.succeed(
            Option.some({
              ...version,
              scope: "public" as const,
              patchTier: 1,
              manifest: {
                ...version.manifest,
                tier: 1 as const,
                uses: { members: { kind: "members" as const } }
              }
            })
          )
      })
    );
    const input = {
      patchId: version.patchId,
      versionId: version.versionId,
      wire: WIRE_VERSION,
      principal: null,
      args: {}
    };
    for (const op of ["principal", "members.list"])
      assert.strictEqual(
        (yield* runtime.call({ ...input, op }).pipe(Effect.flip)).code,
        "not_available_on_public"
      );
    assert.strictEqual(yield* runtime.call({ ...input, op: "me" }), null);
  }).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request("http://localhost/api/runtime/call", {
          method: "POST",
          headers: {
            origin: "http://localhost",
            "x-patchy-wire": String(WIRE_VERSION),
            "x-patchy-principal": "null"
          }
        })
      )
    ),
    Effect.provide(Limits.layer),
    Effect.provide(NodeCryptography.layer)
  )
);

it.effect("reports unavailable host wiring for an admitted server call", () =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.make(
      {},
      {
        origin: "http://localhost",
        identity: () => Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
      }
    );
    const error = yield* runtime
      .call({
        patchId: version.patchId,
        versionId: version.versionId,
        wire: WIRE_VERSION,
        principal: { userId: viewer.user.id },
        op: "server.call",
        args: { handler: "leads.list", args: {} }
      })
      .pipe(Effect.flip);
    assert.instanceOf(error, Runtime.InvocationUnavailable);
    assert.strictEqual(error.code, "source_unavailable");
    assert.strictEqual(error.status, 503);
    assert.notProperty(error, "cause");
  }).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    Effect.provideService(LoadedVersions.LoadedVersions, {
      find: () => Effect.succeed(Option.some({ ...version, patchTier: 2 }))
    }),
    Effect.provide(Limits.layer),
    Effect.provide(NodeCryptography.layer)
  )
);
