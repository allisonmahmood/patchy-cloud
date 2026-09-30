import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { InvocationCapabilities, QuerySnapshot, Runtime } from "@patchy/runtime/core";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as ReadSnapshot from "./ReadSnapshot.js";
import * as TableOperations from "./TableOperations.js";
import * as ResourceRevisions from "./ResourceRevisions.js";

const databaseFailures = {
  Busy: (cause: CompanyDatabases.Busy) =>
    Effect.fail(
      new TableOperations.Busy({
        cause,
        resource: cause.resource,
        scope: cause.scope,
        limitId: cause.limitId,
        value: cause.value,
        retryAfterSeconds: cause.retryAfterSeconds
      })
    ),
  CompanyDatabaseError: (cause: CompanyDatabases.CompanyDatabaseError) =>
    Effect.fail(new Runtime.SourceUnavailable({ cause })),
  CompanyDatabaseNotReady: (cause: CompanyDatabases.CompanyDatabaseNotReady) =>
    Effect.fail(new Runtime.SourceUnavailable({ cause })),
  CompanyIdentityMismatch: (cause: CompanyDatabases.CompanyIdentityMismatch) =>
    Effect.fail(new Runtime.SourceUnavailable({ cause }))
};

export const make = Effect.gen(function* () {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const inventory = yield* Inventory.Inventory;
  const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
  const scope = yield* Effect.scope;

  const open = Effect.fn("QuerySnapshot.open")(function* (
    capability: InvocationCapabilities.Capability
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* capabilities.resolve(capability.token, capability.attempt);
        const jobs = yield* Queue.unbounded<Effect.Effect<void>>();
        const ready = yield* Deferred.make<QuerySnapshot.Resource, Runtime.RuntimeError>();
        const settled = yield* Deferred.make<void>();
        let owner: Fiber.Fiber<void, Runtime.RuntimeError> | undefined;
        let lease: CompanyDatabases.Lease | undefined;
        let closed = false;
        let watermark: Readonly<Record<string, string>> = Object.freeze({});
        let callbackContext: Context.Context<never> | undefined;
        const refused = () => new InvocationCapabilities.CapabilityRefused({ reason: "returned" });
        const resource: QuerySnapshot.Resource = {
          get watermark() {
            return watermark;
          },
          run: (effect) =>
            Effect.gen(function* () {
              if (closed || callbackContext === undefined) return yield* refused();
              yield* capabilities.resolve(capability.token, capability.attempt);
              const caller = yield* Effect.context<Effect.Services<typeof effect>>();
              const result = yield* Deferred.make<
                Effect.Success<typeof effect>,
                Effect.Error<typeof effect>
              >();
              const job = effect.pipe(
                Effect.provideContext(Context.merge(caller, callbackContext)),
                Effect.onExit((exit) => Deferred.done(result, exit)),
                Effect.exit,
                Effect.asVoid
              );
              yield* Queue.offer(jobs, job);
              return yield* Deferred.await(result);
            }),
          cancel: Effect.suspend(() => {
            closed = true;
            // Interrupting a native Pg query sends its protocol CancelRequest
            // and drains ReadyForQuery before withTransaction rolls back.
            owner?.interruptUnsafe();
            return Deferred.await(settled);
          }),
          settled: Deferred.await(settled),
          destroy: () => {
            if (Deferred.isDoneUnsafe(settled)) return;
            closed = true;
            lease?.destroy();
            owner?.interruptUnsafe();
          }
        };
        yield* capabilities.retain(capability.token, capability.attempt, resource);
        owner = yield* Effect.gen(function* () {
          const { binding } = capability;
          const keys = new Set([
            ...Object.keys(binding.manifest.tables).map(
              (name) => `table:${binding.patchId}:${name}`
            ),
            ...Object.keys(binding.manifest.files).map((name) => `store:${binding.patchId}:${name}`)
          ]);
          for (const declaration of Object.values(binding.manifest.uses)) {
            if (declaration.kind === "sharedTable")
              keys.add(`table:${declaration.patchId}:${declaration.table}`);
            else if (declaration.kind === "sharedStore")
              keys.add(`store:${declaration.patchId}:${declaration.store}`);
          }
          if (keys.size === 0) {
            callbackContext = yield* Effect.context();
            yield* Deferred.succeed(ready, resource);
            while (!closed) yield* Queue.take(jobs).pipe(Effect.flatten);
            return yield* Effect.interrupt;
          }
          const reserveAuthority = Object.values(capability.binding.manifest.uses).some(
            (declaration) =>
              declaration.kind === "sharedTable" || declaration.kind === "sharedStore"
          );
          lease = yield* databases
            .lease(capability.binding.companyId, reserveAuthority)
            .pipe(Effect.catchTags(databaseFailures));
          const held = lease;
          const sql = held.sql;
          return yield* held
            .run(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
                  watermark = Object.freeze(yield* ResourceRevisions.read([...keys]));
                  const snapshot = ReadSnapshot.ReadSnapshot.of({
                    companyId: capability.binding.companyId,
                    sql,
                    authority: (patchId) =>
                      held.authority(inventory.read(patchId)).pipe(
                        Effect.catchTags({
                          ...databaseFailures,
                          SqlError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
                        })
                      )
                  });
                  callbackContext = (yield* Effect.context()).pipe(
                    Context.add(ReadSnapshot.ReadSnapshot, snapshot)
                  );
                  yield* Deferred.succeed(ready, resource);
                  while (!closed) yield* Queue.take(jobs).pipe(Effect.flatten);
                  return yield* Effect.interrupt;
                })
              )
            )
            .pipe(
              Effect.onError((cause) =>
                Effect.sync(() => {
                  // A failed rollback must not return a suspect session to the pool.
                  if (Cause.hasDies(cause)) held.destroy();
                })
              ),
              Effect.catchTags({
                SqlError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
              })
            );
        }).pipe(
          Effect.scoped,
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              closed = true;
              owner = undefined;
              if (Exit.isFailure(exit)) yield* Deferred.failCause(ready, exit.cause);
              yield* Deferred.succeed(settled, undefined);
              yield* Queue.shutdown(jobs);
            })
          ),
          Effect.interruptible,
          Effect.forkIn(scope)
        );
        return yield* restore(Deferred.await(ready)).pipe(
          Effect.onInterrupt(() => resource.cancel)
        );
      })
    );
  });
  return QuerySnapshot.QuerySnapshot.of({ open });
});

export const layer = Layer.effect(QuerySnapshot.QuerySnapshot, make);
