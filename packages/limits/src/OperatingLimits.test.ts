import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { ddl } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";
import * as DeploymentConfig from "./DeploymentConfig.js";
import * as OperatingLimits from "./OperatingLimits.js";
import { registry } from "./registry.js";

const services = OperatingLimits.layer.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        PATCHY_LIMITS_JSON: JSON.stringify({ "company.connections": 6 }),
        PATCHY_AUTHENTICATED_PUBLISH_RATE_LIMIT_PER_MINUTE: "999",
        PATCHY_COMPANY_DB_MAX_BACKENDS: "999"
      })
    )
  ),
  Layer.provideMerge(Testing.layer())
);
const createCompany = Effect.fn("createCompany")(function* (name: string) {
  const sql = yield* SqlClient.SqlClient;
  const companyId = `cmp_limits_${name}`;
  yield* sql`INSERT INTO companies (id, handle, name) VALUES (${companyId}, ${name}, ${name})`;
  return { companyId, limitId: "company.connections" };
});

it.layer(services)("operating limits", (it) => {
  it.effect("reads named defaults and live overrides with one company revision", () =>
    Effect.gen(function* () {
      const limits = yield* OperatingLimits.OperatingLimits;
      const company = yield* createCompany("limits-batch");
      const other = yield* createCompany("limits-batch-other");
      const settings = {
        connections: company.limitId,
        sameConnections: company.limitId,
        rate: "company.admission.rate",
        spares: "execution.pool.spares"
      } as const;
      const input = { companyId: company.companyId, limits: settings };
      const original = yield* limits.getMany(input);
      assert.deepStrictEqual(original.connections, yield* limits.get(company));
      assert.deepStrictEqual(original.sameConnections, original.connections);
      assert.strictEqual(original.connections.value, 6);
      assert.strictEqual(original.rate.value, registry["company.admission.rate"].default);
      assert.strictEqual(original.spares.value, registry["execution.pool.spares"].default);
      for (const setting of Object.values(original)) {
        assert.strictEqual(setting.companyId, company.companyId);
        assert.isNull(setting.overrideValue);
        assert.deepStrictEqual(setting.configRevision, original.connections.configRevision);
        assert.strictEqual(setting.configRevision.overrideRevision, "0");
      }
      yield* limits.setOverride({ ...company, value: 9, actor: "operator" });
      yield* limits.setOverride({
        ...company,
        limitId: settings.rate,
        value: 2.5,
        actor: "operator"
      });
      const updated = yield* limits.getMany(input);
      assert.strictEqual(updated.connections.overrideValue, 9);
      assert.strictEqual(updated.connections.value, 9);
      assert.strictEqual(updated.rate.overrideValue, 2.5);
      assert.strictEqual(updated.rate.value, 2.5);
      assert.strictEqual(updated.spares.value, original.spares.value);
      for (const setting of Object.values(updated)) {
        assert.strictEqual(setting.configRevision.overrideRevision, "2");
        assert.deepStrictEqual(setting.configRevision, updated.connections.configRevision);
        assert.strictEqual(
          setting.configRevision.deploymentRevision,
          original.connections.configRevision.deploymentRevision
        );
      }
      const isolated = yield* limits.getMany({ companyId: other.companyId, limits: settings });
      assert.strictEqual(isolated.connections.value, 6);
      assert.strictEqual(isolated.rate.value, original.rate.value);
      assert.strictEqual(isolated.rate.configRevision.overrideRevision, "0");
      yield* limits.removeOverride({ ...company, actor: "operator" });
      const removed = yield* limits.getMany(input);
      assert.strictEqual(removed.connections.value, 6);
      assert.isNull(removed.connections.overrideValue);
      assert.strictEqual(removed.rate.value, 2.5);
      assert.strictEqual(removed.rate.configRevision.overrideRevision, "3");
      assert.deepStrictEqual(removed.connections.configRevision, removed.rate.configRevision);
      assert.deepStrictEqual(yield* limits.getMany({ ...input, limits: {} }), {});
    })
  );

  it.effect("rejects invalid batch IDs before resolving the company", () =>
    Effect.gen(function* () {
      const limits = yield* OperatingLimits.OperatingLimits;
      const company = yield* createCompany("limits-batch-invalid");
      for (const [limitId, reason] of [
        ["not-a-limit", "unknown"],
        ["runtime.calls.perMinute", "contract"],
        ["company.connections.pools", "legacy_configuration"]
      ] as const) {
        for (const companyId of [company.companyId, "cmp_limits_missing"]) {
          const failure = yield* limits
            .getMany({ companyId, limits: { valid: company.limitId, invalid: limitId } })
            .pipe(Effect.flip);
          assert.instanceOf(failure, DeploymentConfig.InvalidLimit);
          assert.strictEqual((failure as DeploymentConfig.InvalidLimit).limitId, limitId);
          assert.strictEqual((failure as DeploymentConfig.InvalidLimit).reason, reason);
        }
      }
    })
  );

  it.effect("keeps batched values coherent while related overrides commit together", () =>
    Effect.gen(function* () {
      const limits = yield* OperatingLimits.OperatingLimits;
      const sql = yield* SqlClient.SqlClient;
      const company = yield* createCompany("limits-batch-snapshot");
      const settings = { rate: "company.admission.rate", burst: "company.admission.burst" };
      const update = Effect.fn("updateRelatedLimits")(function* (value: number) {
        yield* limits.setOverride({
          ...company,
          limitId: settings.rate,
          value,
          actor: "operator"
        });
        yield* limits.setOverride({
          ...company,
          limitId: settings.burst,
          value,
          actor: "operator"
        });
      }, sql.withTransaction);
      yield* update(10);
      yield* Effect.all(
        [
          Effect.gen(function* () {
            for (let value = 11; value <= 20; value++) yield* update(value);
          }),
          Effect.gen(function* () {
            for (let read = 0; read < 20; read++) {
              const { rate, burst } = yield* limits.getMany({
                companyId: company.companyId,
                limits: settings
              });
              assert.strictEqual(rate.value, burst.value);
              assert.strictEqual(rate.overrideValue, rate.value);
              assert.strictEqual(burst.overrideValue, burst.value);
              assert.deepStrictEqual(rate.configRevision, burst.configRevision);
              assert.strictEqual(
                rate.configRevision.overrideRevision,
                String((rate.value - 9) * 2)
              );
            }
          })
        ],
        { concurrency: "unbounded" }
      );
      const final = yield* limits.getMany({ companyId: company.companyId, limits: settings });
      assert.strictEqual(final.rate.value, 20);
      assert.strictEqual(final.burst.value, 20);
      assert.strictEqual(final.rate.configRevision.overrideRevision, "22");
    })
  );

  it.effect("sets, replaces and removes one company's override with attributed history", () =>
    Effect.gen(function* () {
      const limits = yield* OperatingLimits.OperatingLimits;
      const company = yield* createCompany("limits-history");
      const other = yield* createCompany("limits-other");
      const original = yield* limits.get(company);
      const deploymentRevision = original.configRevision.deploymentRevision;
      assert.strictEqual(original.value, 6);
      yield* TestClock.setTime(1_000);
      const first = yield* limits.setOverride({ ...company, value: 8, actor: "operator-a" });
      assert.deepStrictEqual(
        { ...first.configRevision },
        {
          deploymentRevision,
          overrideRevision: "1"
        }
      );
      assert.strictEqual((yield* limits.get(company)).value, 8);
      assert.strictEqual((yield* limits.get(other)).value, 6);
      assert.deepStrictEqual(yield* limits.history(other), []);
      yield* TestClock.setTime(2_000);
      yield* limits.setOverride({ ...company, value: 10, actor: "operator-b" });
      yield* TestClock.setTime(3_000);
      const removed = yield* limits.removeOverride({ ...company, actor: "operator-c" });
      assert.strictEqual(removed.value, 6);
      assert.isNull(removed.overrideValue);
      assert.strictEqual(removed.configRevision.overrideRevision, "3");
      assert.deepStrictEqual(yield* limits.get(company), removed);
      assert.deepStrictEqual(
        (yield* limits.history(company)).map((row) => ({
          ...row,
          changedAt: row.changedAt.getTime()
        })),
        [
          {
            ...company,
            revision: "1",
            deploymentRevision,
            oldValue: 6,
            newValue: 8,
            oldOverride: null,
            newOverride: 8,
            actor: "operator-a",
            changedAt: 1_000
          },
          {
            ...company,
            revision: "2",
            deploymentRevision,
            oldValue: 8,
            newValue: 10,
            oldOverride: 8,
            newOverride: 10,
            actor: "operator-b",
            changedAt: 2_000
          },
          {
            ...company,
            revision: "3",
            deploymentRevision,
            oldValue: 10,
            newValue: 6,
            oldOverride: 10,
            newOverride: null,
            actor: "operator-c",
            changedAt: 3_000
          }
        ]
      );
      assert.deepStrictEqual(
        yield* limits.removeOverride({ ...company, actor: "operator-c" }),
        removed
      );
      assert.strictEqual((yield* limits.history(company)).at(-1)?.revision, "3");
      assert.strictEqual((yield* limits.get(other)).configRevision.overrideRevision, "0");
    })
  );

  it.effect("keeps deployment and override revisions distinct when the base changes", () =>
    Effect.gen(function* () {
      const limits = yield* OperatingLimits.OperatingLimits;
      const company = yield* createCompany("limits-redeploy");
      const first = yield* limits.setOverride({ ...company, value: 8, actor: "operator" });
      const nextDeployment = yield* OperatingLimits.make.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              PATCHY_LIMITS_JSON: JSON.stringify({ "company.connections": 12 })
            })
          )
        )
      );
      const afterDeploy = yield* nextDeployment.get(company);
      assert.strictEqual(afterDeploy.value, 8);
      assert.notStrictEqual(
        afterDeploy.configRevision.deploymentRevision,
        first.configRevision.deploymentRevision
      );
      assert.strictEqual(
        afterDeploy.configRevision.overrideRevision,
        first.configRevision.overrideRevision
      );
      const removed = yield* nextDeployment.removeOverride({ ...company, actor: "operator" });
      assert.strictEqual(removed.value, 12);
      assert.deepStrictEqual(
        { ...removed.configRevision },
        {
          deploymentRevision: afterDeploy.configRevision.deploymentRevision,
          overrideRevision: "2"
        }
      );
      assert.deepStrictEqual(
        (yield* nextDeployment.history(company)).map((row) => [
          row.deploymentRevision,
          row.revision,
          row.oldValue,
          row.newValue
        ]),
        [
          [first.configRevision.deploymentRevision, "1", 6, 8],
          [afterDeploy.configRevision.deploymentRevision, "2", 8, 12]
        ]
      );
    })
  );

  it.effect("rejects invalid override requests without changing values, history or revisions", () =>
    Effect.gen(function* () {
      const limits = yield* OperatingLimits.OperatingLimits;
      const company = yield* createCompany("limits-invalid");
      for (const [limitId, reason] of [
        ["runtime.calls.perMinute", "contract"],
        ["execution.pool.spares", "not_overridable"],
        ["not-a-limit", "unknown"]
      ] as const) {
        const input = { ...company, limitId, value: 8, actor: "operator" };
        const failure = yield* limits.setOverride(input).pipe(Effect.flip);
        assert.instanceOf(failure, DeploymentConfig.InvalidLimit);
        assert.strictEqual((failure as DeploymentConfig.InvalidLimit).reason, reason);
        assert.instanceOf(
          yield* limits.removeOverride(input).pipe(Effect.flip),
          DeploymentConfig.InvalidLimit
        );
      }
      // Positive, finite, and a whole number for a connection count.
      for (const value of [0, Infinity, 0.5]) {
        assert.instanceOf(
          yield* limits.setOverride({ ...company, value, actor: "operator" }).pipe(Effect.flip),
          OperatingLimits.InvalidOverride
        );
      }
      for (const limitId of ["company.connections.waiters", "company.admission.burst"]) {
        for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
          assert.instanceOf(
            yield* limits
              .setOverride({
                ...company,
                limitId,
                value,
                actor: "operator"
              })
              .pipe(Effect.flip),
            OperatingLimits.InvalidOverride
          );
        }
      }
      assert.instanceOf(
        yield* limits.setOverride({ ...company, value: 8, actor: " " }).pipe(Effect.flip),
        OperatingLimits.InvalidOverride
      );
      assert.deepStrictEqual(yield* limits.history(company), []);
      const unchanged = yield* limits.get(company);
      assert.strictEqual(unchanged.value, 6);
      assert.strictEqual(unchanged.configRevision.overrideRevision, "0");
      assert.instanceOf(
        yield* limits.get({ ...company, limitId: "runtime.calls.perMinute" }).pipe(Effect.flip),
        DeploymentConfig.InvalidLimit
      );
      const missing = { companyId: "cmp_limits_missing", limitId: company.limitId };
      for (const operation of [
        limits.get(missing),
        limits.getMany({ companyId: missing.companyId, limits: { connections: company.limitId } }),
        limits.getMany({ companyId: missing.companyId, limits: {} }),
        limits.history(missing),
        limits.setOverride({ ...missing, value: 8, actor: "operator" }),
        limits.removeOverride({ ...missing, actor: "operator" })
      ]) {
        assert.instanceOf(yield* operation.pipe(Effect.flip), OperatingLimits.CompanyNotFound);
      }
    })
  );

  it.effect(
    "refuses every legacy-configured limit at every boundary even with named settings",
    () =>
      Effect.gen(function* () {
        const limits = yield* OperatingLimits.OperatingLimits;
        const company = yield* createCompany("limits-legacy");
        for (const [limitId, definition] of Object.entries(registry)) {
          if (!("configuration" in definition)) continue;
          const input = { ...company, limitId, value: 8, actor: "operator" };
          const operations: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
            limits.get(input),
            limits.getMany({ companyId: company.companyId, limits: { legacy: limitId } }),
            limits.history(input),
            limits.setOverride(input),
            limits.removeOverride(input)
          ];
          for (const operation of operations) {
            const failure = yield* operation.pipe(Effect.flip);
            assert.instanceOf(failure, DeploymentConfig.InvalidLimit);
            assert.strictEqual((failure as DeploymentConfig.InvalidLimit).limitId, limitId);
            assert.strictEqual(
              (failure as DeploymentConfig.InvalidLimit).reason,
              "legacy_configuration"
            );
          }
        }
        assert.deepStrictEqual(yield* limits.history(company), []);
        assert.strictEqual((yield* limits.get(company)).configRevision.overrideRevision, "0");
      })
  );

  it.effect("serializes simultaneous updates into one old/new chain", () =>
    Effect.gen(function* () {
      const limits = yield* OperatingLimits.OperatingLimits;
      const company = yield* createCompany("limits-concurrent");
      yield* Effect.all(
        [
          limits.setOverride({ ...company, value: 8, actor: "operator-a" }),
          limits.setOverride({ ...company, value: 12, actor: "operator-b" })
        ],
        { concurrency: "unbounded" }
      );
      const history = yield* limits.history(company);
      assert.deepStrictEqual(
        history.map((row) => row.revision),
        ["1", "2"]
      );
      assert.strictEqual(history[0]!.oldValue, 6);
      assert.strictEqual(history[1]!.oldValue, history[0]!.newValue);
      assert.deepStrictEqual(
        history.map((row) => row.newValue).sort((a, b) => a - b),
        [8, 12]
      );
      const current = yield* limits.get(company);
      assert.strictEqual(current.value, history[1]!.newValue);
      assert.strictEqual(current.configRevision.overrideRevision, "2");
    })
  );

  it.effect("rolls back the value and revision if its history cannot be recorded", () =>
    Effect.gen(function* () {
      const limits = yield* OperatingLimits.OperatingLimits;
      const company = yield* createCompany("limits-atomic");
      yield* limits.setOverride({ ...company, value: 8, actor: "operator" });
      yield* ddl(
        `CREATE FUNCTION refuse_limit_history() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.company_id = 'cmp_limits_limits-atomic' THEN
              RAISE EXCEPTION 'history unavailable';
            END IF;
            RETURN NEW;
          END;
        $$`,
        `CREATE TRIGGER refuse_limit_history BEFORE INSERT ON limits_override_history
          FOR EACH ROW EXECUTE FUNCTION refuse_limit_history()`
      );
      assert.strictEqual(
        (yield* limits.removeOverride({ ...company, actor: "operator" }).pipe(Effect.flip))._tag,
        "SqlError"
      );
      const current = yield* limits.get(company);
      assert.strictEqual(current.value, 8);
      assert.strictEqual(current.configRevision.overrideRevision, "1");
      assert.deepStrictEqual(
        (yield* limits.history(company)).map((row) => [row.revision, row.newValue]),
        [["1", 8]]
      );
    })
  );
});
