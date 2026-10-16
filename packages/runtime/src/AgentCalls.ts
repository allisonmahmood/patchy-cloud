import {
  ServerCall,
  type HandlerDescriptor,
  type Manifest,
  type ServerCallReply
} from "@patchy/api";
import type { InvocationAgent } from "@patchy/api/guest";
import * as WideEvents from "@patchy/analytics/wide-events";
import { newInternalId } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Binding from "./Binding.js";
import * as Invocation from "./Invocation.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as MutationTransaction from "./MutationTransaction.js";
import * as Runtime from "./Runtime.js";

/** The served version has no described handler in its agent area by that name. */
export class UnknownTool extends Schema.TaggedError<UnknownTool>()("UnknownTool", {}) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return "This patch has no agent tool by that name.";
  }
}

/** Only tier 2 patches run handlers, so only they have agent tools. */
export class TierTwoRequired extends Schema.TaggedError<TierTwoRequired>()("TierTwoRequired", {
  tier: Schema.Int
}) {
  readonly code = "server_required" as const;
  readonly status = 403;
  override get message() {
    return `Agent tools need a tier 2 patch; this one is tier ${this.tier}.`;
  }
}

export type AgentCallError = Runtime.RuntimeError | UnknownTool | TierTwoRequired;

/** A patch's agent area is its `server/agent.ts` module: handlers named `agent.<export>`. */
const area = "agent.";

/** One handler an agent may call, as Patchy's MCP lists it. */
export interface AgentTool {
  /** The export's name, which the agent sees: `agent.summarize` is `summarize`. */
  readonly name: string;
  readonly handler: string;
  readonly descriptor: HandlerDescriptor & { readonly description: string };
}

/**
 * A manifest's agent tools: the described handlers of its agent area, reads first, then by
 * name. Stored manifests don't keep the builder's key order. An undescribed export stays
 * page-only, so describing it is how a patch offers it to agents.
 */
export const agentTools = (manifest: typeof Manifest.Type): ReadonlyArray<AgentTool> =>
  Object.entries(manifest.handlers ?? {})
    .flatMap(([handler, descriptor]) => {
      const { description } = descriptor;
      return handler.startsWith(area) && description !== undefined
        ? [
            {
              name: handler.slice(area.length),
              handler,
              descriptor: { ...descriptor, description }
            }
          ]
        : [];
    })
    .sort(
      (a, b) =>
        Number(a.descriptor.kind !== "query") - Number(b.descriptor.kind !== "query") ||
        a.name.localeCompare(b.name)
    );

const encodeArgs = Schema.encodeUnknownEffect(Schema.fromJsonString(ServerCall.fields.args));
const textEncoder = new TextEncoder();

/**
 * Patchy's second door into a tier 2 patch's handlers, beside the page's `server.call`: a
 * person's agent calls the served version as that person, with no document, stream or Origin.
 */
export class AgentCalls extends Context.Service<
  AgentCalls,
  {
    /**
     * Runs one agent tool through the same invocation a page's call takes, so its log, its
     * limits and the wakes after a mutation are the page's. Each mutation gets a fresh key:
     * an agent that retries makes a second write.
     */
    readonly call: (input: {
      readonly identity: Runtime.AdmittedIdentity["viewer"];
      /** Re-checks the person's access while the invocation calls back. */
      readonly reauthorize: Runtime.AdmittedIdentity["reauthorize"];
      readonly agent: InvocationAgent;
      readonly patchId: string;
      /** The handler's full name, `agent.<export>`. */
      readonly handler: string;
      readonly args: unknown;
    }) => Effect.Effect<ServerCallReply, AgentCallError>;
  }
>()("@patchy/runtime/AgentCalls") {}

export const make = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const versions = yield* LoadedVersions.LoadedVersions;
  // As for pages, a host without server execution refuses the call instead of failing to start.
  const invocations = yield* Effect.serviceOption(Invocation.Invocation);
  const maxArgsBytes = yield* ContractLimits.get("tier2.args.bytes");

  const call = Effect.fn("AgentCalls.call")(function* (
    input: Parameters<AgentCalls["Service"]["call"]>[0]
  ) {
    if (yield* runtime.draining) return yield* new Runtime.Draining();
    // The page's size refusal, before the patch is loaded or the caller's budget is spent.
    const argsJson = yield* encodeArgs(input.args).pipe(
      Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
    );
    if (textEncoder.encode(argsJson).byteLength > maxArgsBytes)
      return yield* new Runtime.TooLarge({ maxBytes: maxArgsBytes, limitId: "tier2.args.bytes" });
    const loaded = yield* versions
      .find(input.patchId)
      .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
    // A missing patch reads like another company's, so neither is confirmed to exist.
    if (
      Option.isNone(loaded) ||
      loaded.value.companyId !== input.identity.company.id ||
      loaded.value.scope === "public"
    )
      return yield* new Runtime.AccessDenied({});
    const version = loaded.value;
    yield* WideEvents.enrich({
      companyId: version.companyId,
      patchId: version.patchId,
      versionId: version.versionId,
      tier: version.manifest.tier,
      viewerId: input.identity.user.id
    });
    if (version.manifest.tier !== 2)
      return yield* new TierTwoRequired({ tier: version.manifest.tier });
    const tool = agentTools(version.manifest).find(({ handler }) => handler === input.handler);
    if (tool === undefined) return yield* new UnknownTool();
    // Its own budget beside the person's pages, so a busy agent never stalls their open tabs.
    yield* runtime.admitCall({
      key: `agent:${input.identity.user.id}:${version.patchId}`,
      companyId: version.companyId
    });
    if (Option.isNone(invocations)) return yield* new Runtime.InvocationUnavailable();
    return yield* invocations.value.call(
      {
        handler: tool.handler,
        args: input.args,
        ...(tool.descriptor.kind === "mutation"
          ? { mutationKey: yield* MutationTransaction.mint }
          : {})
      },
      Binding.Binding.of({
        ...version,
        principal: { userId: input.identity.user.id },
        identity: input.identity,
        agent: input.agent,
        correlationId: newInternalId("call")
      }),
      input.reauthorize
    );
  });

  return AgentCalls.of({ call });
});

export const layer = Layer.effect(AgentCalls, make);
