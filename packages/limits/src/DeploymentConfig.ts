import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { registry, type OperatingLimitId } from "./registry.js";

export const isOperatingLimitId = (id: string): id is OperatingLimitId =>
  Object.hasOwn(registry, id) && registry[id as keyof typeof registry].kind === "operating";

export const LimitValue = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));
const Values = Schema.Record(Schema.String, LimitValue).check(
  Schema.makeFilter(
    (values) =>
      Object.keys(values).every(
        (id) =>
          isOperatingLimitId(id) &&
          !id.startsWith("rate.") &&
          id !== "company.connections.hostBackends"
      ),
    {
      message:
        "Use operating limit IDs; legacy rates and the host backend budget keep their named configuration."
    }
  )
);
const Settings = Schema.Struct({ revision: Schema.NonEmptyString, values: Values });
const decodeSettings = Schema.decodeUnknownEffect(Settings);

export class InvalidDeploymentConfig extends Schema.TaggedError<InvalidDeploymentConfig>()(
  "InvalidDeploymentConfig",
  { cause: Schema.Defect() }
) {
  override get message() {
    return "Limits deployment configuration requires a revision and positive finite operating values.";
  }
}

/**
 * PATCHY_LIMITS_JSON is an operating-ID-to-number JSON object, defaulting to {}.
 * PATCHY_LIMITS_DEPLOYMENT_REVISION is required when this layer is used. Give it
 * a new immutable revision whenever the deployment values or release defaults
 * change. Contract limits are never accepted, including in development.
 * Legacy rate settings and the host backend budget keep their existing
 * configuration sources; accepting them here would not change enforcement.
 */
export const config = Config.all({
  revision: Config.schema(Schema.NonEmptyString, "PATCHY_LIMITS_DEPLOYMENT_REVISION"),
  values: Config.schema(Schema.fromJsonString(Values), "PATCHY_LIMITS_JSON").pipe(
    Config.withDefault({})
  )
});

export class DeploymentConfig extends Context.Service<
  DeploymentConfig,
  {
    readonly revision: string;
    readonly values: Readonly<Partial<Record<OperatingLimitId, number>>>;
    readonly get: (limitId: OperatingLimitId) => number;
  }
>()("@patchy/limits/DeploymentConfig") {}

/** Explicit settings use the same validation as environment configuration. */
export const make = Effect.fn("DeploymentConfig.make")(function* (input: unknown) {
  const settings = yield* decodeSettings(input).pipe(
    Effect.mapError((cause) => new InvalidDeploymentConfig({ cause }))
  );
  const values = Object.freeze({ ...settings.values });
  return DeploymentConfig.of({
    revision: settings.revision,
    values,
    get: (limitId) => values[limitId] ?? registry[limitId].default
  });
});

export const layer = Layer.effect(DeploymentConfig, Effect.flatMap(config, make));
export const layerWith = (settings: unknown) => Layer.effect(DeploymentConfig, make(settings));
