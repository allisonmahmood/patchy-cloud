import { assert, it } from "@effect/vitest";
import { RuntimeFailure, runtimeOperations } from "@patchy/api";
import { ContractLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Binding from "./Binding.js";
import * as CallbackGateway from "./CallbackGateway.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeLog from "./RuntimeLog.js";
import * as Fixtures from "./test/callbacks.js";

it.layer(RuntimeLog.layer.pipe(Layer.provide(Testing.layer())))("CallbackGateway", (it) => {
  it.effect(
    "kind checks refuse query writes, mutation file/shared access, and unknown nested calls",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.make;
        let writes = 0;
        const gateway = yield* CallbackGateway.make({
          "tables.insert": { kind: "mutation", run: () => Effect.sync(() => ++writes) },
          "shared.list": { kind: "read", run: () => Effect.succeed([]) },
          "files.list": { kind: "read", run: () => Effect.succeed([]) },
          "files.redeem": {
            kind: "read",
            transport: "bytes-get",
            run: () => Effect.die(new Error("Guests must not reach handle redemption."))
          },
          "files.stage": {
            kind: "read",
            transport: "bytes-put",
            run: () => Effect.die("Guests must not stage uploads.")
          },
          "files.discard": {
            kind: "read",
            run: () => Effect.die("Guests must not discard uploads.")
          },
          "files.inspectUpload": {
            kind: "read",
            run: () => Effect.die("Only actions may inspect uploads.")
          },
          "files.put": {
            kind: "mutation",
            transport: "bytes-put",
            run: () => Effect.die("Only actions may adopt uploads.")
          }
        }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
        for (const [kind, op] of [
          ["query", "tables.insert"],
          ["mutation", "files.list"],
          ["mutation", "shared.list"],
          ["query", "shared.files.get"],
          ["mutation", "shared.files.list"],
          ["mutation", "shared.files.stat"],
          ["mutation", "shared.files.get"],
          ["query", "files.redeem"],
          ["mutation", "files.redeem"],
          ["action", "files.redeem"],
          ["query", "files.stage"],
          ["mutation", "files.stage"],
          ["action", "files.stage"],
          ["query", "files.discard"],
          ["mutation", "files.discard"],
          ["action", "files.discard"],
          ["query", "files.inspectUpload"],
          ["mutation", "files.inspectUpload"],
          ["query", "files.put"],
          ["mutation", "files.put"],
          ["action", "server.call"],
          ["action", "not.an.operation"]
        ] as const) {
          const capability = yield* Fixtures.issue(capabilities, { kind });
          assert.include(
            yield* gateway.callback(capability.token, capability.attempt, { op, args: {} }),
            { ok: false, code: "access_denied" }
          );
        }
        assert.strictEqual(writes, 0);
        const action = yield* Fixtures.issue(capabilities, { kind: "action" });
        assert.deepStrictEqual(
          yield* gateway.callback(action.token, action.attempt, { op: "tables.insert", args: {} }),
          { ok: true, value: 1 }
        );
      }).pipe(Effect.scoped)
  );

  it.effect(
    "action inspection stays unlogged and JSON adoption uses the files.put mutation log",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.make;
        const log = yield* RuntimeLog.RuntimeLog;
        let inspectionCorrelation = "";
        const upload = { token: "opaque-stage-token", size: 10, contentType: "image/png" };
        let adopted = false;
        let correlationId = "";
        const gateway = yield* CallbackGateway.make({
          "files.inspectUpload": Runtime.handler(
            {
              kind: "read",
              input: runtimeOperations["files.inspectUpload"].request.fields.args,
              output: runtimeOperations["files.inspectUpload"].response
            },
            () =>
              Effect.gen(function* () {
                inspectionCorrelation = (yield* Binding.Binding).correlationId;
                return upload;
              })
          ),
          "files.put": {
            kind: "mutation",
            transport: "bytes-put",
            resource: () => "docs/photo.png",
            run: (args, bytes) =>
              Effect.gen(function* () {
                assert.isUndefined(bytes);
                assert.deepStrictEqual(args, { store: "docs", name: "photo.png", upload });
                const binding = yield* Binding.Binding;
                correlationId = binding.correlationId;
                assert.strictEqual(binding.identity?.user.id, Fixtures.identity.user.id);
                assert.strictEqual(binding.versionId, Fixtures.binding.versionId);
                const pending = yield* log
                  .find({ companyId: binding.companyId, correlationId })
                  .pipe(Effect.orDie);
                assert.include(pending, {
                  op: "files.put",
                  resource: "docs/photo.png",
                  outcome: "pending",
                  effectivePrincipal: "patch"
                });
                adopted = true;
                return null;
              })
          }
        }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
        const capability = yield* Fixtures.issue(capabilities, { kind: "action" });
        assert.deepStrictEqual(
          yield* gateway.callback(capability.token, capability.attempt, {
            op: "files.inspectUpload",
            args: { upload: { ...upload, size: 0, contentType: "text/plain" } }
          }),
          { ok: true, value: upload }
        );
        assert.isNull(
          yield* log.find({
            companyId: Fixtures.identity.company.id,
            correlationId: inspectionCorrelation
          })
        );
        for (const args of [
          { store: "docs", name: "photo.png", contentType: "image/png" },
          { store: "docs", name: "photo.png", upload, contentType: "text/plain" },
          { store: "docs", name: "photo.png", upload: upload.token }
        ] as const) {
          assert.include(
            yield* gateway.callback(capability.token, capability.attempt, {
              op: "files.put",
              args
            }),
            { ok: false, code: "invalid_request" }
          );
          assert.isFalse(adopted);
        }
        assert.deepStrictEqual(
          yield* gateway.callback(capability.token, capability.attempt, {
            op: "files.put",
            args: { store: "docs", name: "photo.png", upload }
          }),
          { ok: true, value: null }
        );
        assert.isTrue(adopted);
        assert.include(
          yield* log.find({ companyId: Fixtures.identity.company.id, correlationId }),
          {
            op: "files.put",
            outcome: "success",
            invocationId: capability.attempt.invocationId
          }
        );
      }).pipe(Effect.scoped)
  );

  it.effect("fencing an in-flight adoption preserves an unknown side-effect outcome", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.make;
      const log = yield* RuntimeLog.RuntimeLog;
      const started = yield* Deferred.make<string>();
      const gateway = yield* CallbackGateway.make({
        "files.put": {
          kind: "mutation",
          transport: "bytes-put",
          run: () =>
            Effect.gen(function* () {
              const binding = yield* Binding.Binding;
              yield* Deferred.succeed(started, binding.correlationId);
              return yield* Effect.never;
            })
        }
      }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
      const capability = yield* Fixtures.issue(capabilities, { kind: "action" });
      const callback = yield* gateway
        .callback(capability.token, capability.attempt, {
          op: "files.put",
          args: {
            store: "docs",
            name: "photo.png",
            upload: { token: "opaque-stage-token", size: 10, contentType: "image/png" }
          }
        })
        .pipe(Effect.forkChild);
      const correlationId = yield* Deferred.await(started);
      assert.isFalse(yield* capabilities.settle(capability.token, "deadline"));
      assert.include(yield* Fiber.join(callback), { ok: false, code: "access_denied" });
      assert.include(yield* log.find({ companyId: Fixtures.identity.company.id, correlationId }), {
        op: "files.put",
        outcome: "unknown",
        outcomeCode: "unknown_outcome"
      });
    }).pipe(Effect.scoped)
  );

  it.effect(
    "own callbacks inherit admission while company callbacks require the same live viewer and fresh authority",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.make;
        let live = Fixtures.identity;
        let sessionValid = true;
        let authorizations = 0;
        const reauthorize = Effect.suspend(() => {
          authorizations++;
          return sessionValid ? Effect.succeed(live) : Effect.fail(new Runtime.SessionExpired({}));
        });
        const handler: Runtime.JsonHandler = {
          kind: "read",
          run: () =>
            Effect.gen(function* () {
              const binding = yield* Binding.Binding;
              return binding.effectivePrincipal === "patch"
                ? "own"
                : binding.identity!.admin
                  ? "admin"
                  : "member";
            })
        };
        const gateway = yield* CallbackGateway.make({
          "tables.get": handler,
          "shared.get": handler
        }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
        const capability = yield* Fixtures.issue(capabilities, { reauthorize });
        sessionValid = false;
        assert.deepStrictEqual(
          yield* gateway.callback(capability.token, capability.attempt, {
            op: "tables.get",
            args: {}
          }),
          { ok: true, value: "own" }
        );
        assert.strictEqual(authorizations, 0);
        assert.include(
          yield* gateway.callback(capability.token, capability.attempt, {
            op: "shared.get",
            args: {}
          }),
          { ok: false, code: "session_expired" }
        );
        sessionValid = true;
        live = { ...Fixtures.identity, admin: true };
        assert.deepStrictEqual(
          yield* gateway.callback(capability.token, capability.attempt, {
            op: "shared.get",
            args: {}
          }),
          { ok: true, value: "admin" }
        );
        for (const identity of [
          { ...live, user: { ...live.user, id: "usr_other" } },
          { ...live, company: { ...live.company, id: "cmp_other" } }
        ]) {
          live = identity;
          assert.include(
            yield* gateway.callback(capability.token, capability.attempt, {
              op: "shared.get",
              args: {}
            }),
            { ok: false, code: "access_denied" }
          );
        }
      }).pipe(Effect.scoped)
  );

  it.effect("traces refused shared-store reads and reauthorizes metadata and action bytes", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.make;
      let live = false;
      const dependencies = new Set<string>();
      const body = {
        bytes: new Uint8Array([0, 128, 255]),
        contentType: "application/octet-stream"
      };
      const gateway = yield* CallbackGateway.make({
        "shared.files.list": {
          kind: "read",
          run: () => Effect.succeed({ files: [], cursor: null })
        },
        "shared.files.stat": { kind: "read", run: () => Effect.succeed(null) },
        "shared.files.get": {
          kind: "read",
          transport: "bytes-get",
          run: () => Effect.succeed(body)
        }
      }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
      for (const kind of ["query", "action"] as const) {
        const capability = yield* Fixtures.issue(capabilities, {
          kind,
          binding: {
            ...Fixtures.binding,
            manifest: {
              ...Fixtures.binding.manifest,
              uses: {
                documents: {
                  kind: "sharedStore",
                  patchId: "sourceshared",
                  store: "docs",
                  id: "sourceshared/docs",
                  revision: 1
                }
              }
            }
          },
          onDependency: (key) => dependencies.add(key),
          reauthorize: Effect.suspend(() =>
            live ? Effect.succeed(Fixtures.identity) : Effect.fail(new Runtime.AccessDenied({}))
          )
        });
        const ops =
          kind === "query"
            ? ["shared.files.list", "shared.files.stat"]
            : ["shared.files.list", "shared.files.stat", "shared.files.get"];
        for (const op of ops) {
          live = false;
          assert.include(
            yield* gateway.callback(capability.token, capability.attempt, {
              op,
              args: { alias: "documents", name: "one.bin" }
            }),
            { ok: false, code: "access_denied" }
          );
          assert.deepStrictEqual([...dependencies].sort(), [
            "patch:sourceshared",
            "store:sourceshared:docs"
          ]);
          live = true;
          assert.deepStrictEqual(
            yield* gateway.callback(capability.token, capability.attempt, {
              op,
              args: { alias: "documents", name: "one.bin" }
            }),
            op === "shared.files.get"
              ? { ok: true, body }
              : { ok: true, value: op === "shared.files.list" ? { files: [], cursor: null } : null }
          );
        }
      }
    }).pipe(Effect.scoped)
  );

  it.effect(
    "eight callbacks execute concurrently and queued callbacks complete instead of being refused",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.make;
        const starts = yield* Queue.unbounded<number>();
        const release = yield* Deferred.make<void>();
        let active = 0;
        let peak = 0;
        const gateway = yield* CallbackGateway.make({
          "tables.get": {
            kind: "read",
            run: (args) =>
              Effect.gen(function* () {
                active++;
                peak = Math.max(peak, active);
                const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number }))(args);
                yield* Queue.offer(starts, id);
                yield* Deferred.await(release);
                return id;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    active--;
                  })
                )
              )
          }
        }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
        const capability = yield* Fixtures.issue(capabilities);
        const pending = yield* Effect.all(
          Array.from({ length: 12 }, (_, id) =>
            gateway.callback(capability.token, capability.attempt, {
              op: "tables.get",
              args: { id }
            })
          ),
          { concurrency: "unbounded" }
        ).pipe(Effect.forkChild);
        for (let index = 0; index < 8; index++) yield* Queue.take(starts);
        assert.strictEqual(active, 8);
        yield* Deferred.succeed(release, undefined);
        const replies = yield* Fiber.join(pending);
        assert.deepStrictEqual(
          replies,
          Array.from({ length: 12 }, (_, value) => ({ ok: true, value }))
        );
        assert.strictEqual(peak, 8);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "ending an attempt refuses queued work and interrupts active work before settlement",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.make;
        const starts = yield* Queue.unbounded<void>();
        let started = 0;
        let active = 0;
        const gateway = yield* CallbackGateway.make({
          "tables.get": {
            kind: "read",
            run: () =>
              Effect.gen(function* () {
                started++;
                active++;
                yield* Queue.offer(starts, undefined);
                return yield* Effect.never;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    active--;
                  })
                )
              )
          }
        }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
        const capability = yield* Fixtures.issue(capabilities);
        const pending = yield* Effect.all(
          Array.from({ length: 9 }, () =>
            gateway.callback(capability.token, capability.attempt, { op: "tables.get", args: {} })
          ),
          { concurrency: "unbounded" }
        ).pipe(Effect.forkChild);
        for (let index = 0; index < 8; index++) yield* Queue.take(starts);
        assert.isTrue(yield* capabilities.settle(capability.token, "returned"));
        const replies = yield* Fiber.join(pending);
        for (const reply of replies) {
          assert.include(reply, { ok: false, code: "access_denied" });
          assert.include(Schema.decodeUnknownSync(RuntimeFailure)(reply).error, "returned");
        }
        assert.strictEqual(started, 8);
        assert.strictEqual(active, 0);
        assert.include(
          yield* gateway.callback(capability.token, capability.attempt, {
            op: "tables.get",
            args: {}
          }),
          { ok: false, code: "access_denied" }
        );
      }).pipe(Effect.scoped)
  );

  it.effect(
    "callback count, callback bytes, file bytes, and UTF-8 log bytes are host-enforced",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.make;
        const gateway = yield* CallbackGateway.make({
          "tables.get": { kind: "read", run: () => Effect.succeed("x".repeat(100)) },
          "files.get": {
            kind: "read",
            transport: "bytes-get",
            run: () => Effect.succeed({ bytes: new Uint8Array(11), contentType: "text/plain" })
          },
          "files.put": { kind: "mutation", transport: "bytes-put", run: () => Effect.succeed(null) }
        }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
        const count = yield* Fixtures.issue(capabilities);
        for (let index = 0; index < 2; index++)
          assert.deepStrictEqual(
            yield* gateway.callback(count.token, count.attempt, {
              op: "log",
              args: { message: "a" }
            }),
            { ok: true, value: null }
          );
        assert.include(
          yield* gateway.callback(count.token, count.attempt, {
            op: "log",
            args: { message: "a" }
          }),
          { ok: false, limitId: "tier2.callbacks.count", value: 2 }
        );
        const first = yield* Fixtures.issue(capabilities);
        assert.deepStrictEqual(
          yield* gateway.callback(first.token, first.attempt, { op: "tables.get", args: {} }),
          { ok: true, value: "x".repeat(100) }
        );
        assert.include(
          yield* gateway.callback(first.token, first.attempt, { op: "tables.get", args: {} }),
          { ok: false, limitId: "tier2.callbacks.bytes", value: 250 }
        );
        const file = yield* Fixtures.issue(capabilities, { kind: "action" });
        assert.include(
          yield* gateway.callback(file.token, file.attempt, { op: "files.get", args: {} }),
          { ok: false, limitId: "tier2.callbacks.fileBytes", value: 10 }
        );
        assert.include(
          yield* gateway.callback(file.token, file.attempt, {
            op: "files.put",
            args: {},
            body: { bytes: new Uint8Array(11), contentType: "text/plain" }
          }),
          { ok: false, limitId: "tier2.callbacks.fileBytes" }
        );
        const logs = yield* Fixtures.issue(capabilities);
        assert.include(
          yield* gateway.callback(logs.token, logs.attempt, {
            op: "log",
            args: { message: "é".repeat(20) }
          }),
          { ok: false, limitId: "tier2.log.bytes", value: 32 }
        );
        assert.deepStrictEqual(logs.logs, []);
      }).pipe(
        Effect.scoped,
        Effect.provideService(ContractLimits.overrides, {
          "tier2.callbacks.count": 2,
          "tier2.callbacks.bytes": 250,
          "tier2.callbacks.fileBytes": 10,
          "tier2.log.bytes": 32
        })
      )
  );

  it.effect("a fenced integration records an unknown outcome rather than a confirmed failure", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.make;
      const log = yield* RuntimeLog.RuntimeLog;
      const started = yield* Deferred.make<string>();
      const gateway = yield* CallbackGateway.make({
        "postgres.query": {
          kind: "integration",
          run: () =>
            Effect.gen(function* () {
              const binding = yield* Binding.Binding;
              yield* Deferred.succeed(started, binding.correlationId);
              return yield* Effect.never;
            })
        }
      }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
      const capability = yield* Fixtures.issue(capabilities, { kind: "action" });
      const callback = yield* gateway
        .callback(capability.token, capability.attempt, {
          op: "postgres.query",
          args: {}
        })
        .pipe(Effect.forkChild);
      const correlationId = yield* Deferred.await(started);
      assert.isFalse(yield* capabilities.settle(capability.token, "deadline"));
      assert.include(yield* Fiber.join(callback), { ok: false, code: "access_denied" });
      assert.include(yield* log.find({ companyId: Fixtures.identity.company.id, correlationId }), {
        outcome: "unknown",
        outcomeCode: "unknown_outcome"
      });
    }).pipe(Effect.scoped)
  );

  it.effect("operation attribution precedes effects and integration reauthorization refusals", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.make;
      const log = yield* RuntimeLog.RuntimeLog;
      let writeCorrelation = "";
      const gateway = yield* CallbackGateway.make({
        "tables.insert": {
          kind: "mutation",
          run: () =>
            Effect.gen(function* () {
              const binding = yield* Binding.Binding;
              writeCorrelation = binding.correlationId;
              const pending = yield* log.find({
                companyId: binding.companyId,
                correlationId: writeCorrelation
              });
              assert.include(pending, {
                outcome: "pending",
                userId: null,
                effectivePrincipal: "patch"
              });
              return null;
            })
        },
        "postgres.query": {
          kind: "integration",
          connectionId: () => "integration-order",
          run: () => Effect.die("A refused viewer must not execute an integration")
        }
      }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
      const capability = yield* Fixtures.issue(capabilities, {
        kind: "action",
        reauthorize: Effect.gen(function* () {
          const [pending] = yield* log.recent({
            companyId: Fixtures.identity.company.id,
            connectionId: "integration-order"
          });
          assert.strictEqual(pending?.outcome, "pending");
          return yield* new Runtime.SessionExpired({});
        })
      });
      assert.deepStrictEqual(
        yield* gateway.callback(capability.token, capability.attempt, {
          op: "tables.insert",
          args: {}
        }),
        { ok: true, value: null }
      );
      const refusal = yield* gateway.callback(capability.token, capability.attempt, {
        op: "postgres.query",
        args: {}
      });
      const write = yield* log.find({
        companyId: Fixtures.identity.company.id,
        correlationId: writeCorrelation
      });
      assert.include(write, {
        outcome: "success",
        userId: null,
        effectivePrincipal: "patch",
        invocationId: capability.attempt.invocationId
      });
      const [denied] = yield* log.recent({
        companyId: Fixtures.identity.company.id,
        connectionId: "integration-order"
      });
      assert.include(denied, {
        outcome: "failure",
        outcomeCode: "session_expired",
        userId: Fixtures.identity.user.id,
        effectivePrincipal: Fixtures.identity.user.id,
        invocationId: capability.attempt.invocationId
      });
      assert.include(refusal, {
        ok: false,
        code: "session_expired",
        correlationId: denied!.correlationId
      });
      assert.deepStrictEqual(capability.refusals, [{ failure: refusal, status: 401 }]);
    }).pipe(Effect.scoped)
  );
});
