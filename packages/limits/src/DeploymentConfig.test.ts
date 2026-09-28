import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as DeploymentConfig from "./DeploymentConfig.js";
import { registry } from "./registry.js";

it.effect("loads operating deployment values and registry defaults from Effect Config", () =>
  Effect.gen(function* () {
    const deployment = yield* DeploymentConfig.DeploymentConfig;
    assert.strictEqual(deployment.revision, "release-a");
    assert.strictEqual(deployment.get("company.connections"), 8);
    assert.strictEqual(deployment.get("execution.pool.spares"), 3);
    assert.strictEqual(
      deployment.get("execution.probe.interval"),
      registry["execution.probe.interval"].default
    );
  }).pipe(
    Effect.provide(DeploymentConfig.layer),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          PATCHY_LIMITS_DEPLOYMENT_REVISION: "release-a",
          PATCHY_LIMITS_JSON: JSON.stringify({
            "company.connections": 8,
            "execution.pool.spares": 3
          })
        })
      )
    )
  )
);

it.effect("allows omitted operating values but requires a deployment revision", () =>
  Effect.gen(function* () {
    const defaults = yield* DeploymentConfig.DeploymentConfig.pipe(
      Effect.provide(DeploymentConfig.layer),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            PATCHY_LIMITS_DEPLOYMENT_REVISION: "release-defaults"
          })
        )
      )
    );
    assert.strictEqual(
      defaults.get("company.connections"),
      registry["company.connections"].default
    );
    const failure = yield* DeploymentConfig.DeploymentConfig.pipe(
      Effect.provide(DeploymentConfig.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      Effect.flip
    );
    assert.strictEqual(failure._tag, "ConfigError");
  })
);

it.effect(
  "rejects contract, legacy, unknown and invalid operating values at the public config boundary",
  () =>
    Effect.gen(function* () {
      for (const values of [
        { "runtime.calls.perMinute": 400 },
        { "unknown.limit": 1 },
        { "rate.publish.perMinute": 40 },
        { "company.connections.hostBackends": 400 },
        { "company.connections": 0 },
        { "company.connections": -1 },
        { "company.connections": Infinity },
        { "company.connections": NaN },
        { "company.connections": "8" },
        { "company.connections": null }
      ]) {
        assert.instanceOf(
          yield* DeploymentConfig.make({ revision: "release", values }).pipe(Effect.flip),
          DeploymentConfig.InvalidDeploymentConfig
        );
      }
      assert.instanceOf(
        yield* DeploymentConfig.make({ revision: "", values: {} }).pipe(Effect.flip),
        DeploymentConfig.InvalidDeploymentConfig
      );
      for (const json of [
        "{broken",
        '{"runtime.calls.perMinute":400}',
        '{"unknown.limit":1}',
        '{"rate.publish.perMinute":40}',
        '{"company.connections.hostBackends":400}'
      ]) {
        const failure = yield* DeploymentConfig.DeploymentConfig.pipe(
          Effect.provide(DeploymentConfig.layer),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                NODE_ENV: "test",
                PATCHY_LIMITS_DEPLOYMENT_REVISION: "release",
                PATCHY_LIMITS_JSON: json
              })
            )
          ),
          Effect.flip
        );
        assert.strictEqual(failure._tag, "ConfigError");
      }
    })
);
