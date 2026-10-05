import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { SqlError } from "effect/sql/SqlError";
import { AgentMode, Manifest, type Identity } from "@patchy/api";
import { MachineTokens } from "@patchy/auth";
import { Users } from "@patchy/companies";
import { AgentPolicies } from "@patchy/runtime";

export class AgentAccessDenied extends Schema.TaggedError<AgentAccessDenied>()(
  "AgentAccessDenied",
  {
    patchId: Schema.String
  }
) {
  get message() {
    return "Only this patch's owner or a company admin can manage agent access.";
  }
}
export class AgentAccessInvalid extends Schema.TaggedError<AgentAccessInvalid>()(
  "AgentAccessInvalid",
  {
    reason: Schema.Literals(["patch", "handler", "machine", "stale"])
  }
) {
  get message() {
    switch (this.reason) {
      case "patch":
        return "Agent access requires a live company patch with server handlers.";
      case "handler":
        return "Choose operations declared by the current patch version.";
      case "machine":
        return "Choose an active connected machine belonging to this company.";
      case "stale":
        return "Agent access changed while this page was open. Reload before saving.";
    }
  }
}
const encodeHandlers = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
class Policy extends Schema.Class<Policy>("AgentAccessPolicy")({
  mode: AgentMode,
  handlers: Schema.Array(Schema.String),
  revision: Schema.Number
}) {}
class ManagementPatch extends Schema.Class<ManagementPatch>("AgentAccessManagementPatch")({
  owner: Schema.String,
  role: Schema.String,
  retired: Schema.NullOr(Schema.Date),
  deleted: Schema.NullOr(Schema.Date),
  disabled: Schema.NullOr(Schema.Date),
  scope: Schema.String,
  manifest: Manifest
}) {}
class Grant extends Schema.Class<Grant>("AgentAccessGrant")({ machineId: Schema.String }) {}
export interface Manager {
  readonly userId: string;
  readonly companyId: string;
}
export interface Connection {
  readonly machineId: string;
  readonly name: string;
  readonly userId: string;
  readonly person: string;
  readonly email: string;
  readonly granted: boolean;
}
export type AccessError = AgentAccessDenied | AgentAccessInvalid | SqlError;
export class AgentAccess extends Context.Service<
  AgentAccess,
  {
    readonly inspect: (
      patchId: string,
      actor: Manager
    ) => Effect.Effect<
      {
        readonly policy: Policy;
        readonly manifest: typeof Manifest.Type;
        readonly connections: readonly Connection[];
      },
      AccessError
    >;
    readonly save: (
      patchId: string,
      actor: Manager,
      input: {
        readonly mode: typeof AgentMode.Type;
        readonly handlers: readonly string[];
        readonly revision: number;
      }
    ) => Effect.Effect<void, AccessError>;
    readonly grant: (
      patchId: string,
      actor: Manager,
      machineId: string
    ) => Effect.Effect<void, AccessError>;
    readonly revoke: (
      patchId: string,
      actor: Manager,
      machineId: string
    ) => Effect.Effect<void, AccessError>;
    readonly read: AgentPolicies.AgentPolicies["Service"]["read"];
  }
>()("@patchy/patches/AgentAccess") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tokens = yield* MachineTokens.MachineTokens;
  const users = yield* Users.Users;
  const patchFor = SqlSchema.findOneOption({
    Request: Schema.Struct({
      patchId: Schema.String,
      userId: Schema.String,
      companyId: Schema.String
    }),
    Result: ManagementPatch,
    execute: ({ patchId, userId, companyId }) => sql`
      SELECT p.owner_user_id AS owner, u.role, p.retired_at AS retired,
        p.deleted_at AS deleted, p.disabled_at AS disabled, p.scope, v.manifest
      FROM patches p JOIN patch_versions v ON v.id = p.current_version_id
      JOIN users u ON u.id = ${userId} AND u.company_id = p.company_id AND u.deactivated_at IS NULL
      WHERE p.id = ${patchId} AND p.company_id = ${companyId} FOR UPDATE OF p`
  });
  const policyFor = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Policy,
    execute: (patchId) =>
      sql`SELECT mode, handlers, revision FROM patch_agent_access WHERE patch_id = ${patchId}`
  });
  const grantsFor = SqlSchema.findAll({
    Request: Schema.String,
    Result: Grant,
    execute: (patchId) =>
      sql`SELECT machine_id AS "machineId" FROM patch_agent_grants WHERE patch_id = ${patchId}`
  });
  const check = Effect.fn("AgentAccess.check")(function* (patchId: string, actor: Manager) {
    const found = yield* patchFor({ patchId, ...actor }).pipe(
      Effect.catchTags({ SchemaError: Effect.die })
    );
    if (
      Option.isNone(found) ||
      (found.value.owner !== actor.userId && found.value.role !== "admin")
    )
      return yield* new AgentAccessDenied({ patchId });
    const patch = found.value;
    if (
      patch.retired !== null ||
      patch.deleted !== null ||
      patch.disabled !== null ||
      patch.scope !== "company" ||
      patch.manifest.tier !== 2
    )
      return yield* new AgentAccessInvalid({ reason: "patch" });
    return patch;
  });
  const policy = Effect.fn("AgentAccess.policy")(function* (
    patchId: string,
    manifest: typeof Manifest.Type
  ) {
    const found = yield* policyFor(patchId).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    return Option.getOrElse(
      found,
      () =>
        new Policy({
          mode: "read-only",
          revision: 0,
          handlers: Object.entries(manifest.handlers ?? {})
            .filter(([, h]) => h.kind === "query")
            .map(([name]) => name)
        })
    );
  });
  const connections = Effect.fn("AgentAccess.connections")(function* (
    companyId: string,
    patchId: string
  ) {
    const members = yield* users.list(companyId);
    const grants = yield* grantsFor(patchId).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    return (yield* Effect.forEach(
      members,
      Effect.fn(function* (person) {
        const machines = yield* tokens.list(person.id);
        return machines.map((machine) => ({
          machineId: machine.id,
          name: machine.name,
          userId: person.id,
          person: person.name,
          email: person.email,
          granted: grants.some((grant) => grant.machineId === machine.id)
        }));
      })
    )).flat();
  });
  const inspect = Effect.fn("AgentAccess.inspect")(function* (patchId: string, actor: Manager) {
    const patch = yield* check(patchId, actor);
    return {
      manifest: patch.manifest,
      policy: yield* policy(patchId, patch.manifest),
      connections: yield* connections(actor.companyId, patchId)
    };
  }, sql.withTransaction);
  const save = Effect.fn("AgentAccess.save")(function* (
    patchId: string,
    actor: Manager,
    input: {
      mode: typeof AgentMode.Type;
      handlers: readonly string[];
      revision: number;
    }
  ) {
    const patch = yield* check(patchId, actor);
    const current = yield* policy(patchId, patch.manifest);
    if (current.revision !== input.revision)
      return yield* new AgentAccessInvalid({ reason: "stale" });
    if (input.handlers.some((name) => !Object.hasOwn(patch.manifest.handlers ?? {}, name)))
      return yield* new AgentAccessInvalid({ reason: "handler" });
    yield* sql`INSERT INTO patch_agent_access (patch_id, mode, handlers, revision, changed_by)
      VALUES (${patchId}, ${input.mode}, ${encodeHandlers([...new Set(input.handlers)])}::jsonb, ${current.revision + 1}, ${actor.userId})
      ON CONFLICT (patch_id) DO UPDATE SET mode = excluded.mode, handlers = excluded.handlers,
        revision = excluded.revision, changed_by = excluded.changed_by, changed_at = now()`;
  }, sql.withTransaction);
  const grant = Effect.fn("AgentAccess.grant")(function* (
    patchId: string,
    actor: Manager,
    machineId: string
  ) {
    const patch = yield* check(patchId, actor);
    if (!(yield* connections(actor.companyId, patchId)).some((c) => c.machineId === machineId))
      return yield* new AgentAccessInvalid({ reason: "machine" });
    const current = yield* policy(patchId, patch.manifest);
    yield* sql`INSERT INTO patch_agent_access (patch_id, mode, handlers, changed_by)
      VALUES (${patchId}, ${current.mode}, ${encodeHandlers(current.handlers)}::jsonb, ${actor.userId}) ON CONFLICT DO NOTHING`;
    yield* sql`INSERT INTO patch_agent_grants (patch_id, machine_id, granted_by)
      VALUES (${patchId}, ${machineId}, ${actor.userId}) ON CONFLICT DO NOTHING`;
  }, sql.withTransaction);
  const revoke = Effect.fn("AgentAccess.revoke")(function* (
    patchId: string,
    actor: Manager,
    machineId: string
  ) {
    yield* check(patchId, actor);
    yield* sql`DELETE FROM patch_agent_grants WHERE patch_id = ${patchId} AND machine_id = ${machineId}`;
  }, sql.withTransaction);
  const admittedPolicy = SqlSchema.findOneOption({
    Request: Schema.Struct({
      patchId: Schema.String,
      companyId: Schema.String,
      machineId: Schema.String,
      userId: Schema.String,
      now: Schema.Number
    }),
    Result: Policy,
    execute: ({ patchId, companyId, machineId, userId, now }) => sql`
      SELECT a.mode, a.handlers, a.revision FROM patch_agent_access a
      JOIN patches p ON p.id = a.patch_id JOIN patch_agent_grants g ON g.patch_id = p.id
      JOIN machine_tokens t ON t.id = g.machine_id JOIN users u ON u.id = t.user_id
      WHERE p.id = ${patchId} AND p.company_id = ${companyId} AND u.company_id = p.company_id
        AND t.id = ${machineId} AND u.id = ${userId} AND u.deactivated_at IS NULL
        AND t.revoked_at IS NULL AND t.expires_at >= to_timestamp(${now / 1000})
        AND t.last_used_at >= to_timestamp(${(now - 30 * 86400000) / 1000})
        AND p.retired_at IS NULL AND p.deleted_at IS NULL AND p.disabled_at IS NULL`
  });
  const read = Effect.fn("AgentAccess.read")(function* (patchId: string, identity: Identity) {
    const found = yield* admittedPolicy({
      patchId,
      companyId: identity.company.id,
      machineId: identity.machine.id,
      userId: identity.user.id,
      now: yield* Clock.currentTimeMillis
    }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    return Option.getOrNull(found);
  });
  return AgentAccess.of({ inspect, save, grant, revoke, read });
});
export const layer = Layer.effect(AgentAccess, make);
export const policiesLayer = Layer.effect(
  AgentPolicies.AgentPolicies,
  Effect.map(AgentAccess, (access) => AgentPolicies.AgentPolicies.of({ read: access.read }))
);
