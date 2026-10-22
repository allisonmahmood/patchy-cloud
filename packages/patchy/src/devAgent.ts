/**
 * The dev daemon's side of `patchy dev agent`: what `open_patch` would answer for the running
 * binding, or one tool's call made the way Patchy MCP's door makes it, through Runtime's agent
 * invocation as a dev person, with `ctx.agent` `{ name: "patchy dev" }`. Answers take the door's
 * shapes from the shared module. The company's agent access switch is not consulted.
 */
import * as WideEvents from "@patchy/analytics/wide-events";
import {
  agentToolEntries,
  agentToolKind,
  agentTools,
  callAnswer,
  changeAnswer,
  handlerArgsSchema,
  invalidArgsRefusal,
  openPatchAnswer,
  readAnswer,
  runtimeRefusal,
  toolAnswer,
  unknownToolRefusal,
  type RuntimeMe,
  type ToolCallResult
} from "@patchy/api";
import { MutationTransaction } from "@patchy/runtime/core";
import { Invocation, Runtime, type LoadedVersions } from "@patchy/runtime/dev";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AgentReply, AgentRequest } from "./devState.js";

/** The worker agent every dev call runs for, as handler code and `dev.log` see it. */
export const agent = { name: "patchy dev" } as const;

export interface Dev {
  /** The server binding a call runs on, read once per answer. */
  readonly binding: () => {
    readonly version: LoadedVersions.LoadedVersion;
    readonly build: number;
    /** The latest rebuild failed, so this build is the last good one. */
    readonly rebuildFailed: boolean;
  };
  /** The patch as `open_patch` names it; its address is the answering mount's dev URL. */
  readonly patch: { readonly name: string; readonly description: string; readonly owner: string };
}

/** A dev mount: the person its pages and agent calls act as, at its dev URL. */
export interface Mount {
  readonly person: NonNullable<RuntimeMe>;
  readonly address: string;
}

const noAgentTools = (error: string): AgentReply => ({ ok: false, code: "no_agent_tools", error });

/** Answers one `patchy dev agent` request for a mount. Runtime's refusals become the door's. */
export const answer = Effect.fn("DevAgent.answer")(function* (
  dev: Dev,
  mount: Mount,
  request: AgentRequest
): Effect.fn.Return<AgentReply, never, WideEvents.WideEvents> {
  const { version, build, rebuildFailed } = dev.binding();
  const invocation = yield* Effect.serviceOption(Invocation.Invocation);
  // Only tier 2 runs server code, so only tier 2 has an invocation to call through.
  if (Option.isNone(invocation))
    return noAgentTools(
      `This patch is tier ${version.manifest.tier}. Agents reach only a tier 2 patch's agent area: the tools it exports from agent/.`
    );
  const tools = agentTools(version.manifest);
  if (tools.length === 0)
    return noAgentTools(
      "This patch has no agent tools. Every export of a file in agent/ is one; the dev build picks new files up."
    );
  const answered = (answer: ToolCallResult): AgentReply => ({
    ok: true,
    person: mount.person.user.name,
    build,
    rebuildFailed,
    answer
  });
  if (request.call === undefined)
    return answered(toolAnswer(openPatchAnswer({ ...dev.patch, address: mount.address }, tools)));
  const { tool, args } = request.call;
  const descriptor = agentToolEntries(version.manifest.handlers).find(
    ([name]) => name === tool
  )?.[1];
  const names = tools.map((entry) => entry.name);
  if (descriptor === undefined) return answered(unknownToolRefusal(dev.patch.name, tool, names));
  // Checked against the version the call runs on, as the door checks, so the refusal speaks
  // the tool's schema rather than Runtime's.
  const problem = yield* Schema.decodeUnknownEffect(
    handlerArgsSchema(descriptor.args, version.manifest.tables),
    { onExcessProperty: "error" }
  )(args).pipe(
    Effect.as(undefined),
    Effect.catch((error) => Effect.succeed(error.message.replace(/\s*\n\s*/g, " ")))
  );
  if (problem !== undefined) return answered(invalidArgsRefusal(tool, problem, names));
  // Each change gets a fresh change key; in dev a mutation's becomes its mutation key, kept by
  // its retries, so a retried mutation writes once. An action is never retried.
  const mutationKey = descriptor.kind === "mutation" ? yield* MutationTransaction.mint : undefined;
  const call = Invocation.callAgent({
    version,
    person: mount.person,
    agent,
    tool,
    args,
    ...(mutationKey === undefined ? {} : { mutationKey }),
    recheck: Effect.succeed(mount.person)
  }).pipe(Effect.provideService(Invocation.Invocation, invocation.value));
  const events = yield* WideEvents.WideEvents;
  const result = yield* events.withEvent(
    { type: "request" },
    (mutationKey === undefined
      ? call
      : // An unknown outcome resolves on a retry with the same key.
        call.pipe(Effect.retry({ times: 2, while: (error) => error.code === "unknown_outcome" }))
    ).pipe(
      Effect.map((reply) => callAnswer(dev.patch.name, tool, build, reply)),
      Effect.catch((error) => Effect.succeed(runtimeRefusal(Runtime.toFailure(error), descriptor))),
      // Answers keep the read cap here as at the door: a read past it is refused, and a change
      // past it succeeds with its result left out.
      Effect.map((answer) =>
        agentToolKind(descriptor) === "read"
          ? readAnswer(dev.patch, tool, answer)
          : changeAnswer(tool, build, answer)
      )
    )
  );
  return answered(result);
});
