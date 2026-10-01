import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as DeploymentConfig from "./DeploymentConfig.js";
import { registry } from "./registry.js";

const load = (values: Readonly<Record<string, unknown>> = {}) =>
  DeploymentConfig.load.pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ PATCHY_LIMITS_JSON: JSON.stringify(values) })
      )
    )
  );

it.effect("loads operating deployment values and registry defaults from Effect Config", () =>
  Effect.gen(function* () {
    const deployment = yield* load({ "company.connections": 8, "execution.pool.spares": 3 });
    assert.strictEqual(deployment.get("company.connections"), 8);
    assert.strictEqual(deployment.get("execution.pool.spares"), 3);
    assert.strictEqual(
      deployment.get("execution.probe.interval"),
      registry["execution.probe.interval"].default
    );
  })
);

it.effect(
  "uses the same revision for the same effective values regardless of JSON order or explicit defaults",
  () =>
    Effect.gen(function* () {
      const defaults = yield* DeploymentConfig.load.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
      );
      const explicitDefaults = yield* load(
        Object.fromEntries(
          Object.entries(registry)
            .filter(
              ([, definition]) =>
                definition.kind === "operating" && !("configuration" in definition)
            )
            .reverse()
            .map(([id, definition]) => [id, definition.default])
        )
      );
      assert.strictEqual(
        defaults.get("company.connections"),
        registry["company.connections"].default
      );
      assert.strictEqual(explicitDefaults.revision, defaults.revision);
      const first = yield* load({ "company.connections": 8, "execution.pool.spares": 3 });
      const reordered = yield* load({ "execution.pool.spares": 3, "company.connections": 8 });
      assert.strictEqual(reordered.revision, first.revision);
      const changed = yield* load({ "execution.pool.spares": 3, "company.connections": 9 });
      assert.notStrictEqual(changed.revision, first.revision);
    })
);

it.effect(
  "changes the revision for a changed resolved registry default but keeps loaded values stable",
  () =>
    Effect.gen(function* () {
      const definition: { default: number } = registry["company.connections"];
      const originalDefault = definition.default;
      const before = yield* load();
      const overriddenBefore = yield* load({ "company.connections": 8 });
      try {
        definition.default = originalDefault + 1;
        const after = yield* load();
        assert.strictEqual(after.get("company.connections"), originalDefault + 1);
        assert.notStrictEqual(after.revision, before.revision);
        assert.strictEqual(before.get("company.connections"), originalDefault);
        const overriddenAfter = yield* load({ "company.connections": 8 });
        assert.strictEqual(overriddenAfter.revision, overriddenBefore.revision);
      } finally {
        definition.default = originalDefault;
      }
    })
);

it.effect(
  "excludes contract and legacy defaults and named environment settings from the revision",
  () =>
    Effect.gen(function* () {
      const before = yield* load();
      for (const definition of [
        registry["runtime.call.bytes"],
        registry["rate.publish.perMinute"]
      ]) {
        const mutable: { default: number } = definition;
        const originalDefault = mutable.default;
        try {
          mutable.default = originalDefault + 1;
          assert.strictEqual((yield* load()).revision, before.revision);
        } finally {
          mutable.default = originalDefault;
        }
      }
      const namedSettings = yield* DeploymentConfig.load.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              PATCHY_AUTHENTICATED_PUBLISH_RATE_LIMIT_PER_MINUTE: "999",
              PATCHY_COMPANY_DB_MAX_BACKENDS: "999"
            })
          )
        )
      );
      assert.strictEqual(namedSettings.revision, before.revision);
    })
);

it.effect("rejects contract, legacy and unknown IDs at the public config boundary", () =>
  Effect.gen(function* () {
    const legacyIds = Object.entries(registry)
      .filter(([, definition]) => "configuration" in definition)
      .map(([id]) => id);
    for (const [limitId, reason] of [
      ["runtime.calls.perMinute", "contract"],
      ["unknown.limit", "unknown"],
      ...legacyIds.map((id) => [id, "legacy_configuration"] as const)
    ] as const) {
      const failure = yield* load({ [limitId]: 1 }).pipe(Effect.flip);
      assert.instanceOf(failure, DeploymentConfig.InvalidLimit);
      assert.strictEqual((failure as DeploymentConfig.InvalidLimit).limitId, limitId);
      assert.strictEqual((failure as DeploymentConfig.InvalidLimit).reason, reason);
    }
  })
);

it.effect("rejects malformed JSON and invalid operating values", () =>
  Effect.gen(function* () {
    for (const value of [0, -1, Infinity, NaN, "8", null]) {
      assert.strictEqual(
        (yield* load({ "company.connections": value }).pipe(Effect.flip))._tag,
        "ConfigError"
      );
    }
    const failure = yield* DeploymentConfig.load.pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_LIMITS_JSON: "{broken" }))
      ),
      Effect.flip
    );
    assert.strictEqual(failure._tag, "ConfigError");
  })
);
