import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as DeploymentConfig from "./DeploymentConfig.js";
import { registry } from "./registry.js";

export class InvalidLimit extends Schema.TaggedError<InvalidLimit>()("InvalidLimit", {
  limitId: Schema.String,
  reason: Schema.Literals(["unknown", "contract", "not_overridable"])
}) {
  override get message() {
    return `Limit ${this.limitId} cannot be configured: ${this.reason}.`;
  }
}

export class InvalidOverride extends Schema.TaggedError<InvalidOverride>()("InvalidOverride", {
  limitId: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `Override for ${this.limitId} requires a positive finite value and an actor.`;
  }
}

export class CompanyNotFound extends Schema.TaggedError<CompanyNotFound>()("CompanyNotFound", {
  companyId: Schema.String
}) {
  override get message() {
    return "The limit's company does not exist.";
  }
}

export class ConfigRevision extends Schema.Class<ConfigRevision>("Limits.ConfigRevision")({
  deploymentRevision: Schema.String,
  overrideRevision: Schema.String
}) {}

export class EffectiveLimit extends Schema.Class<EffectiveLimit>("Limits.EffectiveLimit")({
  companyId: Schema.String,
  limitId: Schema.String,
  value: DeploymentConfig.LimitValue,
  overrideValue: Schema.NullOr(DeploymentConfig.LimitValue),
  configRevision: ConfigRevision
}) {}

export class OverrideHistory extends Schema.Class<OverrideHistory>("Limits.OverrideHistory")({
  companyId: Schema.String,
  limitId: Schema.String,
  revision: Schema.String,
  previousRevision: Schema.String,
  deploymentRevision: Schema.String,
  oldValue: DeploymentConfig.LimitValue,
  newValue: DeploymentConfig.LimitValue,
  oldOverride: Schema.NullOr(DeploymentConfig.LimitValue),
  newOverride: Schema.NullOr(DeploymentConfig.LimitValue),
  actor: Schema.String,
  changedAt: Schema.Date
}) {}

const Ref = Schema.Struct({ companyId: Schema.String, limitId: Schema.String });
type LimitRef = typeof Ref.Type;
const Change = Schema.Struct({
  ...Ref.fields,
  value: Schema.NullOr(DeploymentConfig.LimitValue),
  actor: Schema.String.check(Schema.makeFilter((actor) => actor.trim().length > 0))
});
const decodeChange = Schema.decodeUnknownEffect(Change);
const decodeSet = Schema.decodeUnknownEffect(
  Schema.Struct({ ...Change.fields, value: DeploymentConfig.LimitValue })
);
class State extends Schema.Class<State>("Limits.State")({
  overrideValue: Schema.NullOr(DeploymentConfig.LimitValue),
  overrideRevision: Schema.String
}) {}
class Revision extends Schema.Class<Revision>("Limits.Revision")({ revision: Schema.String }) {}

/** Controller callers authorize the actor; every operation names one company. */
export class OperatingLimits extends Context.Service<
  OperatingLimits,
  {
    readonly get: (
      input: LimitRef
    ) => Effect.Effect<EffectiveLimit, InvalidLimit | CompanyNotFound | SqlError>;
    readonly setOverride: (
      input: LimitRef & { readonly value: number; readonly actor: string }
    ) => Effect.Effect<EffectiveLimit, InvalidLimit | InvalidOverride | CompanyNotFound | SqlError>;
    readonly removeOverride: (
      input: LimitRef & { readonly actor: string }
    ) => Effect.Effect<EffectiveLimit, InvalidLimit | InvalidOverride | CompanyNotFound | SqlError>;
    readonly history: (
      input: LimitRef
    ) => Effect.Effect<ReadonlyArray<OverrideHistory>, InvalidLimit | CompanyNotFound | SqlError>;
  }
>()("@patchy/limits/OperatingLimits") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const deployment = yield* DeploymentConfig.DeploymentConfig;
  const readState = SqlSchema.findOneOption({
    Request: Ref,
    Result: State,
    execute: ({ companyId, limitId }) => sql`
      SELECT o.value AS "overrideValue", COALESCE(r.revision, 0)::text AS "overrideRevision"
      FROM companies c
      LEFT JOIN limits_revisions r ON r.company_id = c.id
      LEFT JOIN limits_overrides o ON o.company_id = c.id AND o.limit_id = ${limitId}
      WHERE c.id = ${companyId}`
  });
  const nextRevision = SqlSchema.findOne({
    Request: Schema.String,
    Result: Revision,
    execute: (companyId) => sql`
      INSERT INTO limits_revisions (company_id, revision) VALUES (${companyId}, 1)
      ON CONFLICT (company_id) DO UPDATE SET revision = limits_revisions.revision + 1
      RETURNING revision::text AS revision`
  });
  const readHistory = SqlSchema.findAll({
    Request: Ref,
    Result: OverrideHistory,
    execute: ({ companyId, limitId }) => sql`
      SELECT company_id AS "companyId", limit_id AS "limitId", revision::text AS revision,
        previous_revision::text AS "previousRevision", deployment_revision AS "deploymentRevision",
        old_value AS "oldValue", new_value AS "newValue", old_override AS "oldOverride",
        new_override AS "newOverride", actor, changed_at AS "changedAt"
      FROM limits_override_history
      WHERE company_id = ${companyId} AND limit_id = ${limitId}
      ORDER BY revision`
  });
  const validateLimit = Effect.fn("OperatingLimits.validateLimit")(function* (
    limitId: string,
    override: boolean
  ) {
    if (!DeploymentConfig.isOperatingLimitId(limitId)) {
      return yield* new InvalidLimit({
        limitId,
        reason: Object.hasOwn(registry, limitId) ? "contract" : "unknown"
      });
    }
    if (override && !registry[limitId].overridable) {
      return yield* new InvalidLimit({ limitId, reason: "not_overridable" });
    }
    return limitId;
  });
  const get = Effect.fn("OperatingLimits.get")(function* (input: LimitRef) {
    const limitId = yield* validateLimit(input.limitId, false);
    // Value and revision come from one statement snapshot, never separate reads.
    const state = yield* readState(input).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    if (Option.isNone(state)) return yield* new CompanyNotFound({ companyId: input.companyId });
    return new EffectiveLimit({
      companyId: input.companyId,
      limitId,
      value: state.value.overrideValue ?? deployment.get(limitId),
      overrideValue: state.value.overrideValue,
      configRevision: new ConfigRevision({
        deploymentRevision: deployment.revision,
        overrideRevision: state.value.overrideRevision
      })
    });
  });
  const change = Effect.fn("OperatingLimits.change")(function* (
    input: typeof Change.Type,
    remove: boolean
  ) {
    const limitId = yield* validateLimit(input.limitId, true);
    const validated = yield* (remove ? decodeChange(input) : decodeSet(input)).pipe(
      Effect.mapError((cause) => new InvalidOverride({ limitId, cause }))
    );
    // The company lock serializes the first override, updates and removals.
    yield* sql`SELECT id FROM companies WHERE id = ${input.companyId} FOR UPDATE`;
    const previous = yield* get(input);
    if (previous.overrideValue === validated.value) return previous;
    const { revision } = yield* nextRevision(input.companyId).pipe(
      Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die })
    );
    const value = validated.value ?? deployment.get(limitId);
    if (validated.value === null) {
      yield* sql`DELETE FROM limits_overrides
          WHERE company_id = ${input.companyId} AND limit_id = ${limitId}`;
    } else {
      yield* sql`INSERT INTO limits_overrides (company_id, limit_id, value)
          VALUES (${input.companyId}, ${limitId}, ${validated.value})
          ON CONFLICT (company_id, limit_id) DO UPDATE SET value = EXCLUDED.value`;
    }
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO limits_override_history (
        company_id, limit_id, revision, previous_revision, deployment_revision,
        old_value, new_value, old_override, new_override, actor, changed_at
      ) VALUES (
        ${input.companyId}, ${limitId}, ${revision}, ${previous.configRevision.overrideRevision},
        ${deployment.revision}, ${previous.value}, ${value}, ${previous.overrideValue},
        ${validated.value}, ${validated.actor}, to_timestamp(${now / 1_000})
      )`;
    return new EffectiveLimit({
      companyId: input.companyId,
      limitId,
      value,
      overrideValue: validated.value,
      configRevision: new ConfigRevision({
        deploymentRevision: deployment.revision,
        overrideRevision: revision
      })
    });
  }, sql.withTransaction);
  const history = Effect.fn("OperatingLimits.history")(function* (input: LimitRef) {
    yield* get(input);
    return yield* readHistory(input).pipe(Effect.catchTags({ SchemaError: Effect.die }));
  });

  return OperatingLimits.of({
    get,
    setOverride: (input) => change(input, false),
    removeOverride: (input) => change({ ...input, value: null }, true),
    history
  });
});

export const layer = Layer.effect(OperatingLimits, make);
