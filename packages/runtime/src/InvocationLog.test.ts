import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { DEV_SEED } from "@patchy/auth/seed";
import * as Testing from "@patchy/sql/testing";
import * as InvocationLog from "./InvocationLog.js";
import * as RuntimeLog from "./RuntimeLog.js";

const NOW = Date.UTC(2026, 0, 1);
const begin = (id: string): InvocationLog.Begin => ({
  id,
  companyId: DEV_SEED.companyId,
  patchId: "invocationpatch",
  versionId: "ver_invocation",
  handler: "leads.approve",
  kind: "mutation",
  initiatingViewerId: DEV_SEED.userId,
  parentId: null,
  correlationId: `correlation-${id}`,
  startedAt: NOW,
  deadline: NOW + 5_000,
  argsBytes: 42
});
const finish = (id: string): InvocationLog.Finish => ({
  id,
  outcome: "success",
  outcomeCode: null,
  settledAt: NOW + 120,
  durationMs: 120,
  guestMs: 80,
  dbMs: 70,
  callbacks: 3,
  resultBytes: 24,
  attempts: 1,
  logLines: [{ message: "Approved", fields: { ids: ["lead_1"], count: 1, active: true } }],
  replyDelivered: true
});

it.layer(InvocationLog.layer.pipe(Layer.provideMerge(Testing.layer())))("InvocationLog", (it) => {
  it.effect("persists admission and settlement independently of the service lifetime", () =>
    Effect.gen(function* () {
      const log = yield* InvocationLog.InvocationLog;
      const input = { ...begin("invocation-roundtrip"), parentId: "invocation-parent" };
      assert.strictEqual(yield* log.begin(input), input.id);
      const restarted = yield* InvocationLog.make;
      const lookup = { companyId: input.companyId, invocationId: input.id };
      const pending = yield* restarted.find(lookup);
      assert.deepStrictEqual(
        pending,
        new InvocationLog.Invocation({
          ...input,
          effectivePrincipal: "patch",
          startedAt: new Date(input.startedAt),
          deadline: new Date(input.deadline),
          settledAt: null,
          outcome: "pending",
          outcomeCode: null,
          durationMs: null,
          guestMs: 0,
          dbMs: 0,
          callbacks: 0,
          resultBytes: 0,
          attempts: 0,
          logLines: [],
          replyDelivered: false
        })
      );
      const settled = finish(input.id);
      yield* log.finish(settled);
      assert.deepStrictEqual(
        yield* restarted.find(lookup),
        new InvocationLog.Invocation({
          ...pending!,
          ...settled,
          settledAt: new Date(settled.settledAt)
        })
      );
      assert.isNull(yield* restarted.find({ ...lookup, companyId: "cmp_other" }));
      assert.isNull(yield* restarted.find({ ...lookup, invocationId: "invocation-missing" }));
    })
  );

  it.effect("retains declared handler errors and outcomes when the reply was not delivered", () =>
    Effect.gen(function* () {
      const log = yield* InvocationLog.InvocationLog;
      const input = { ...begin("invocation-handler-error"), kind: "action" as const };
      yield* log.begin(input);
      const settled: InvocationLog.Finish = {
        ...finish(input.id),
        outcome: "handler_error",
        outcomeCode: "approval_required",
        replyDelivered: false,
        logLines: ["Approval refused", { attempts: 1 }, null]
      };
      yield* log.finish(settled);
      const lookup = { companyId: input.companyId, invocationId: input.id };
      const retained = yield* log.find(lookup);
      assert.strictEqual(retained?.kind, "action");
      assert.strictEqual(retained?.outcome, "handler_error");
      assert.strictEqual(retained?.outcomeCode, "approval_required");
      assert.deepStrictEqual(retained?.logLines, settled.logLines);
      assert.strictEqual(retained?.replyDelivered, false);
      yield* log.finish(finish(input.id));
      assert.deepStrictEqual(yield* log.find(lookup), retained);
    })
  );

  for (const outcome of ["success", "handler_error", "failure"] as const) {
    it.effect(`reconciles an unknown outcome to ${outcome} without allowing timeouts`, () =>
      Effect.gen(function* () {
        const log = yield* InvocationLog.InvocationLog;
        const input = begin(`invocation-unknown-${outcome}`);
        const lookup = { companyId: input.companyId, invocationId: input.id };
        yield* log.begin(input);
        const unresolved: InvocationLog.Finish = {
          ...finish(input.id),
          outcome: "unknown_outcome",
          outcomeCode: "unknown_outcome",
          settledAt: input.deadline + 5_000,
          durationMs: 10_000,
          replyDelivered: false
        };
        yield* log.finish(unresolved);
        const restarted = yield* InvocationLog.make;
        const unknown = yield* restarted.find(lookup);
        assert.strictEqual(unknown?.outcome, "unknown_outcome");
        assert.strictEqual(unknown?.durationMs, 10_000);
        yield* log.finish({ ...unresolved, durationMs: 11_000, logLines: [] });
        assert.deepStrictEqual(yield* restarted.find(lookup), unknown);
        const timeout: InvocationLog.Finish = {
          ...unresolved,
          outcome: "handler_timeout",
          outcomeCode: "handler_timeout",
          durationMs: 11_000,
          logLines: []
        };
        yield* log.finish(timeout);
        assert.deepStrictEqual(yield* restarted.find(lookup), unknown);

        const reconciled = {
          ...finish(input.id),
          outcome,
          outcomeCode: outcome === "success" ? null : "approval_failed",
          settledAt: NOW + 12_000,
          durationMs: 12_000,
          attempts: 2,
          replyDelivered: false
        };
        yield* restarted.finish(reconciled);
        const completed = yield* log.find(lookup);
        assert.strictEqual(completed?.outcome, outcome);
        assert.strictEqual(completed?.outcomeCode, reconciled.outcomeCode);
        assert.strictEqual(completed?.durationMs, 12_000);
        assert.strictEqual(completed?.attempts, 2);
        yield* log.finish(timeout);
        yield* log.finish(unresolved);
        yield* log.finish(finish(input.id));
        assert.deepStrictEqual(yield* restarted.find(lookup), completed);
      })
    );
  }

  it.effect(
    "presents overdue pending admissions as unknown without preventing late settlement",
    () =>
      Effect.gen(function* () {
        const log = yield* InvocationLog.InvocationLog;
        const input = begin("invocation-overdue");
        const lookup = { companyId: input.companyId, invocationId: input.id };
        yield* TestClock.setTime(input.deadline - 1);
        yield* log.begin(input);
        assert.strictEqual((yield* log.find(lookup))?.outcome, "pending");
        yield* TestClock.adjust(1);
        const overdue = yield* log.find(lookup);
        assert.strictEqual(overdue?.outcome, "unknown_outcome");
        assert.isNull(overdue?.settledAt);
        assert.isNull(overdue?.durationMs);
        yield* log.finish(finish(input.id));
        assert.strictEqual((yield* log.find(lookup))?.outcome, "success");
      })
  );

  it.effect(
    "keeps commit proof while a late original finalizer fills pending settlement facts",
    () =>
      Effect.gen(function* () {
        const log = yield* InvocationLog.InvocationLog;
        const input = begin("invocation-committed-pending");
        const lookup = { companyId: input.companyId, invocationId: input.id };
        yield* log.begin(input);
        yield* TestClock.setTime(input.deadline + 1);
        const overdue = yield* log.find(lookup);
        assert.strictEqual(overdue?.outcome, "unknown_outcome");
        assert.isNull(overdue?.settledAt);
        yield* log.reconcileMutation({ ...lookup, companyId: "cmp_other" });
        assert.deepStrictEqual(yield* log.find(lookup), overdue);
        yield* log.reconcileMutation(lookup);
        const proven = yield* log.find(lookup);
        assert.deepStrictEqual(
          proven,
          new InvocationLog.Invocation({ ...overdue!, outcome: "success", outcomeCode: null })
        );
        const late: InvocationLog.Finish = {
          ...finish(input.id),
          outcome: "unknown_outcome",
          outcomeCode: "unknown_outcome",
          replyDelivered: false
        };
        yield* log.finish(late);
        const settled = yield* log.find(lookup);
        assert.deepStrictEqual(
          settled,
          new InvocationLog.Invocation({
            ...proven!,
            ...late,
            outcome: "success",
            outcomeCode: null,
            settledAt: new Date(late.settledAt)
          })
        );
        yield* log.finish({ ...late, callbacks: 0, guestMs: 0, dbMs: 0, replyDelivered: true });
        yield* log.reconcileMutation(lookup);
        assert.deepStrictEqual(yield* log.find(lookup), settled);
      })
  );

  it.effect("refuses duplicate admission ids and correlations without replacing attribution", () =>
    Effect.gen(function* () {
      const log = yield* InvocationLog.InvocationLog;
      const input = { ...begin("invocation-duplicate"), kind: "query" as const };
      yield* log.begin(input);
      const lookup = { companyId: input.companyId, invocationId: input.id };
      const original = yield* log.find(lookup);
      for (const duplicate of [
        { ...input, handler: "leads.remove", correlationId: "different-correlation" },
        { ...input, id: "invocation-same-correlation", initiatingViewerId: "usr_other" }
      ]) {
        const error = yield* log.begin(duplicate).pipe(Effect.flip);
        assert.strictEqual(error._tag, "SqlError");
      }
      assert.deepStrictEqual(yield* log.find(lookup), original);
      assert.isNull(yield* log.find({ ...lookup, invocationId: "invocation-same-correlation" }));
    })
  );

  it.effect(
    "bounds an entry's tree, reads unsettled overdue entries as unknown and scopes cursors",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const log = yield* InvocationLog.InvocationLog;
        const calls = yield* RuntimeLog.make;
        const scope = { companyId: DEV_SEED.companyId, patchId: "treepatch" };
        const root = { ...begin("tree-root"), ...scope, kind: "action" as const };
        yield* log.begin(root);
        for (let index = 0; index <= InvocationLog.TREE_LIMIT; index++) {
          yield* TestClock.adjust(1);
          yield* calls.begin({
            companyId: scope.companyId,
            patchId: scope.patchId,
            versionId: root.versionId,
            userId: null,
            effectivePrincipal: "patch",
            invocationId: root.id,
            credentialKind: "session",
            op: "tables.insert",
            resource: "leads",
            connectionId: null,
            correlationId: `tree-call-${index}`,
            deadlineMs: 1_000
          });
        }
        const overdue = { ...begin("tree-overdue"), ...scope, startedAt: NOW + 100 };
        yield* log.begin(overdue);
        yield* TestClock.setTime(overdue.deadline);

        const page = yield* log.page({ ...scope, limit: 1 });
        assert.deepStrictEqual(
          page.entries.map((entry) => [entry.invocation.id, entry.invocation.outcome]),
          [["tree-overdue", "unknown_outcome"]]
        );
        assert.isTrue(page.more);
        const older = yield* log.page({ ...scope, before: "tree-overdue", limit: 1 });
        const [entry] = older.entries;
        assert.strictEqual(entry?.invocation.id, root.id);
        assert.strictEqual(entry?.tree.length, InvocationLog.TREE_LIMIT);
        assert.strictEqual(entry?.treeTotal, InvocationLog.TREE_LIMIT + 1);
        assert.deepStrictEqual(entry?.tree[0]?.outcome, "unknown_outcome");
        assert.isFalse(older.more);
        assert.deepStrictEqual(
          (yield* log.page({ ...scope, filter: { outcome: "unknown" }, limit: 5 })).entries.length,
          2
        );
        assert.deepStrictEqual(
          yield* log.page({ ...scope, patchId: "otherpatch", before: "tree-overdue", limit: 5 }),
          { entries: [], more: false }
        );
        assert.deepStrictEqual(yield* log.choices(scope), {
          handlers: ["leads.approve"],
          viewerIds: [DEV_SEED.userId]
        });
      })
  );
});
