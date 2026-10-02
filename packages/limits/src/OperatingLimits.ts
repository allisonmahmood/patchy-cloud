import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as DeploymentConfig from "./DeploymentConfig.js";
import { InvalidLimit } from "./DeploymentConfig.js";
import { registry } from "./registry.js";

export class InvalidOverride extends Schema.TaggedError<InvalidOverride>()("InvalidOverride", {
  limitId: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    const value =
      this.limitId === "company.connections" ||
      this.limitId === "company.connections.waiters" ||
      this.limitId === "company.admission.burst"
        ? "positive safe integer"
        : "positive finite value";
    return `Override for ${this.limitId} requires a ${value} and an actor.`;
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
const decodeSetting = Schema.decodeUnknownEffect(DeploymentConfig.LimitSetting);
const ReadRequest = Schema.Struct({
  companyId: Schema.String,
  limitIds: Schema.Array(Schema.String)
});
class State extends Schema.Class<State>("Limits.State")({
  overrides: Schema.Record(Schema.String, DeploymentConfig.LimitValue),
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
    readonly getMany: <const Limits extends Readonly<Record<string, string>>>(input: {
      readonly companyId: string;
      readonly limits: Limits;
    }) => Effect.Effect<
      { readonly [Key in keyof Limits]: EffectiveLimit },
      InvalidLimit | CompanyNotFound | SqlError
    >;
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
  const deployment = yield* DeploymentConfig.load.pipe(
    Effect.catchTags({
      InvalidLimit: (cause) =>
        Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "Invalid operating limits configuration.",
              cause
            })
          )
        )
    })
  );
  const readState = SqlSchema.findOneOption({
    Request: ReadRequest,
    Result: State,
    execute: ({ companyId, limitIds }) => sql`
      SELECT COALESCE(
        jsonb_object_agg(o.limit_id, o.value) FILTER (WHERE o.limit_id IS NOT NULL),
        '{}'::jsonb
      ) AS overrides, COALESCE(r.revision, 0)::text AS "overrideRevision"
      FROM companies c
      LEFT JOIN limits_revisions r ON r.company_id = c.id
      LEFT JOIN limits_overrides o ON o.company_id = c.id
        AND ${limitIds.length === 0 ? sql`false` : sql`o.limit_id IN ${sql.in(limitIds)}`}
      WHERE c.id = ${companyId}
      GROUP BY c.id, r.revision`
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
        deployment_revision AS "deploymentRevision",
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
    const managedId = yield* DeploymentConfig.validateLimitId(limitId);
    if (override && !registry[managedId].overridable) {
      return yield* new InvalidLimit({ limitId, reason: "not_overridable" });
    }
    return managedId;
  });
  const getMany = Effect.fn("OperatingLimits.getMany")(function* <
    const Limits extends Readonly<Record<string, string>>
  >(input: { readonly companyId: string; readonly limits: Limits }) {
    const entries: Array<[string, DeploymentConfig.ManagedOperatingLimitId]> = [];
    for (const [key, limitId] of Object.entries(input.limits)) {
      entries.push([key, yield* validateLimit(limitId, false)]);
    }
    // Every requested value and the company revision share one statement snapshot.
    const state = yield* readState({
      companyId: input.companyId,
      limitIds: entries.map(([, limitId]) => limitId)
    }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    if (Option.isNone(state)) return yield* new CompanyNotFound({ companyId: input.companyId });
    const configRevision = new ConfigRevision({
      deploymentRevision: deployment.revision,
      overrideRevision: state.value.overrideRevision
    });
    const { overrides } = state.value;
    return Object.fromEntries(
      entries.map(([key, limitId]) => {
        const overrideValue = overrides[limitId] ?? null;
        return [
          key,
          new EffectiveLimit({
            companyId: input.companyId,
            limitId,
            value: overrideValue ?? deployment.get(limitId),
            overrideValue,
            configRevision
          })
        ];
      })
    ) as { readonly [Key in keyof Limits]: EffectiveLimit };
  });
  const get = Effect.fn("OperatingLimits.get")(function* (input: LimitRef) {
    const result = yield* getMany({
      companyId: input.companyId,
      limits: { limit: input.limitId }
    });
    return result.limit;
  });
  const change = Effect.fn("OperatingLimits.change")(function* (
    input: typeof Change.Type,
    remove: boolean
  ) {
    const limitId = yield* validateLimit(input.limitId, true);
    const validated = yield* (remove ? decodeChange(input) : decodeSet(input)).pipe(
      Effect.mapError((cause) => new InvalidOverride({ limitId, cause }))
    );
    if (validated.value !== null)
      yield* decodeSetting({ limitId, value: validated.value }).pipe(
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
        company_id, limit_id, revision, deployment_revision,
        old_value, new_value, old_override, new_override, actor, changed_at
      ) VALUES (
        ${input.companyId}, ${limitId}, ${revision},
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
    getMany,
    setOverride: (input) => change(input, false),
    removeOverride: (input) => change({ ...input, value: null }, true),
    history
  });
});

export const layer = Layer.effect(OperatingLimits, make);
