/** Development-only adapter; Invocation owns execution, transactions and business rules. */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AgentCall,
  AgentConnections,
  AgentPatch,
  type Identity,
  type ServerCallReply,
  WIRE_VERSION
} from "@patchy/api";
import { MachineTokens } from "@patchy/auth";
import * as WideEvents from "@patchy/analytics/wide-events";
import { ContractLimits, Limits } from "@patchy/limits";
import { newInternalId } from "@patchy/core";
import * as Invocation from "./Invocation.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";

const decodeConnections = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentConnections), {
  onExcessProperty: "error"
});

export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    readonly describe: (
      patchId: string,
      identity: Identity
    ) => Effect.Effect<typeof AgentPatch.Type, Runtime.RuntimeError>;
    readonly call: (
      patchId: string,
      input: typeof AgentCall.Type,
      identity: Identity,
      token: string
    ) => Effect.Effect<ServerCallReply, Runtime.RuntimeError>;
  }
>()("@patchy/runtime/AgentRuntime") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const versions = yield* LoadedVersions.LoadedVersions;
  const invocation = yield* Effect.serviceOption(Invocation.Invocation);
  const tokens = yield* MachineTokens.MachineTokens;
  const limits = yield* Limits.Limits;
  const callsPerMinute = yield* ContractLimits.get("runtime.calls.perMinute");
  const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
  const file = yield* Config.String("PATCHY_AGENT_CONNECTIONS_FILE").pipe(
    Config.withDefault(".local/dev/agent-connections.json")
  );

  const admit = Effect.fn("AgentRuntime.admit")(function* (patchId: string, identity: Identity) {
    if (environment !== "development" && environment !== "test")
      return yield* new Runtime.AccessDenied({});
    const exists = yield* fs
      .exists(file)
      .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
    if (!exists) return yield* new Runtime.AccessDenied({});
    const connections = yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeConnections),
      Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
    );
    if (
      !connections.grants.some(
        (grant) => grant.machineId === identity.machine.id && grant.patchId === patchId
      )
    )
      return yield* new Runtime.AccessDenied({});
    const policy = connections.patches.find((patch) => patch.patchId === patchId);
    if (policy === undefined) return yield* new Runtime.AccessDenied({});
    const loaded = yield* versions
      .find(patchId)
      .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
    if (
      Option.isNone(loaded) ||
      loaded.value.companyId !== identity.company.id ||
      loaded.value.manifest.tier !== 2 ||
      loaded.value.scope !== "company"
    )
      return yield* new Runtime.AccessDenied({});
    const version = loaded.value;
    if (version.wireVersion !== WIRE_VERSION) return yield* new Runtime.ShellOutdated({});
    const handlers = Object.fromEntries(
      Object.entries(version.manifest.handlers ?? {}).filter(
        ([name, descriptor]) =>
          policy.handlers.includes(name) &&
          (policy.mode === "actions" || descriptor.kind === "query")
      )
    );
    return { version, policy, handlers };
  });

  const describe = Effect.fn("AgentRuntime.describe")(function* (
    patchId: string,
    identity: Identity
  ) {
    const { version, policy, handlers } = yield* admit(patchId, identity);
    return { patchId, versionId: version.versionId, mode: policy.mode, handlers };
  });

  const call = Effect.fn("AgentRuntime.call")(function* (
    patchId: string,
    input: typeof AgentCall.Type,
    identity: Identity,
    token: string
  ) {
    const { version, handlers } = yield* admit(patchId, identity);
    if (input.versionId !== version.versionId) return yield* new Runtime.PrincipalChanged({});
    if (!Object.hasOwn(handlers, input.handler)) return yield* new Runtime.AccessDenied({});
    if (Option.isNone(invocation)) return yield* new Runtime.InvocationUnavailable();
    const viewer = {
      user: identity.user,
      company: identity.company,
      admin: identity.role === "admin"
    };
    const agent = { id: identity.machine.id, name: identity.machine.name };
    const reauthorize = Effect.gen(function* () {
      const current = yield* tokens
        .authenticate(token)
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
      if (
        current === null ||
        current.user.id !== identity.user.id ||
        current.company.id !== identity.company.id
      )
        return yield* new Runtime.AccessDenied({});
      const live = yield* admit(patchId, current);
      if (!Object.hasOwn(live.handlers, input.handler)) return yield* new Runtime.AccessDenied({});
      return { user: current.user, company: current.company, admin: current.role === "admin" };
    });
    const attempt = yield* limits.consume({
      key: `runtime:${identity.user.id}:${patchId}`,
      limit: callsPerMinute,
      window: "1 minute"
    });
    if (!attempt.allowed)
      return yield* new Runtime.RateLimited({
        retryAfterSeconds: attempt.retryAfterSeconds,
        limitId: attempt.reason === "capacity" ? "rate.trackedKeys" : "runtime.calls.perMinute",
        value: attempt.reason === "capacity" ? Limits.MAX_TRACKED_KEYS : callsPerMinute
      });
    yield* WideEvents.enrich({
      companyId: identity.company.id,
      viewerId: identity.user.id,
      patchId,
      versionId: version.versionId,
      tier: 2
    });
    return yield* invocation.value.call(
      {
        handler: input.handler,
        args: input.args,
        ...(input.mutationKey === undefined ? {} : { mutationKey: input.mutationKey })
      },
      {
        ...version,
        identity: viewer,
        agent,
        principal: { userId: identity.user.id },
        correlationId: newInternalId("call")
      },
      reauthorize
    );
  });
  return AgentRuntime.of({ describe, call });
});

export const layer = Layer.effect(AgentRuntime, make);
