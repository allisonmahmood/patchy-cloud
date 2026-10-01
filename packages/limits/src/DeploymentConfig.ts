import { createHash } from "node:crypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { registry, type OperatingLimitId } from "./registry.js";

export class InvalidLimit extends Schema.TaggedError<InvalidLimit>()("InvalidLimit", {
  limitId: Schema.String,
  reason: Schema.Literals(["unknown", "contract", "legacy_configuration", "not_overridable"])
}) {
  override get message() {
    return `Limit ${this.limitId} cannot be configured: ${this.reason}.`;
  }
}

export const LimitValue = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));
export const LimitSetting = Schema.Struct({ limitId: Schema.String, value: LimitValue }).check(
  Schema.makeFilter(
    ({ limitId, value }) =>
      (limitId !== "company.connections" &&
        limitId !== "company.connections.waiters" &&
        limitId !== "company.admission.burst") ||
      Number.isSafeInteger(value),
    {
      message:
        "Company connection, waiter and admission burst counts must be positive safe integers."
    }
  )
);
const decodeSetting = Schema.decodeUnknownEffect(LimitSetting);
export type ManagedOperatingLimitId = {
  [Id in OperatingLimitId]: (typeof registry)[Id] extends { readonly configuration: "legacy" }
    ? never
    : Id;
}[OperatingLimitId];

const managedIds = Object.keys(registry)
  .filter((id): id is ManagedOperatingLimitId => {
    const definition = registry[id as keyof typeof registry];
    return definition.kind === "operating" && !("configuration" in definition);
  })
  .sort();

export const validateLimitId = Effect.fnUntraced(function* (limitId: string) {
  if (!Object.hasOwn(registry, limitId)) {
    return yield* new InvalidLimit({ limitId, reason: "unknown" });
  }
  const definition = registry[limitId as keyof typeof registry];
  if (definition.kind !== "operating") {
    return yield* new InvalidLimit({ limitId, reason: "contract" });
  }
  if ("configuration" in definition) {
    return yield* new InvalidLimit({ limitId, reason: "legacy_configuration" });
  }
  return limitId as ManagedOperatingLimitId;
});

const valuesJson = Schema.fromJsonString(Schema.Record(Schema.String, LimitValue));
const encodeValues = Schema.encodeSync(valuesJson);
const config = Config.schema(valuesJson, "PATCHY_LIMITS_JSON").pipe(
  Config.withDefault<Readonly<Record<string, number>>>({})
);

/** Load managed operating values once, with a revision derived from resolved defaults and overrides. */
export const load = Effect.gen(function* () {
  const overrides = yield* config;
  for (const [limitId, value] of Object.entries(overrides)) {
    yield* validateLimitId(limitId);
    yield* decodeSetting({ limitId, value }).pipe(
      Effect.mapError((cause) => new Config.ConfigError(cause))
    );
  }
  const values = Object.fromEntries(
    managedIds.map((limitId) => [limitId, overrides[limitId] ?? registry[limitId].default])
  ) as Record<ManagedOperatingLimitId, number>;
  return {
    revision: createHash("sha256").update(encodeValues(values)).digest("hex"),
    get: (limitId: ManagedOperatingLimitId): number => values[limitId]
  };
});
