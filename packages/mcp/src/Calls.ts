/**
 * The door's calls of a patch's agent tools, `read_patch` and `change_patch` (docs/product.md ›
 * The door). A call finds the patch among those
 * the person can open, reads the tool from the version served when the call arrives, and checks
 * its kind and arguments against that same version, so a publish can't turn a read into a
 * write. It runs there through Runtime's agent invocation as the person, `ctx.agent` being the
 * name they approved, and every company callback first rechecks the connection, the person and
 * the company's agent access, on the database's clock.
 *
 * Every refusal is a tool result, and nothing runs until the checks pass. A patch the person
 * couldn't open is "not found"; a retired one they could says who retired it and when. The
 * host's admission (`Admission`) then holds the person to their limits. A change after that
 * claims its change key (`ChangeKeys`), which decides whether it runs, answers its first result
 * again or is refused, before Runtime sees it; an action Runtime refuses before it starts gives
 * its key back.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as WideEvents from "@patchy/analytics/wide-events";
import {
  agentToolEntries,
  agentToolKind,
  type AgentToolKind,
  callAnswer,
  type CallSuccess,
  changeAnswer,
  handlerArgsSchema,
  type HandlerDescriptor,
  invalidArgsRefusal,
  readAnswer,
  runtimeRefusal,
  type RuntimeFailure,
  type RuntimeMe,
  type ServerCallReply,
  toolAnswer,
  type ToolCallResult,
  toolRefusal,
  unknownToolRefusal,
  wrongKindRefusal
} from "@patchy/api";
import { AgentConnections } from "@patchy/auth";
import { Companies } from "@patchy/companies";
import { dateLabel } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import { LoadedVersions, Patches } from "@patchy/patches";
import {
  ExecutionLifecycle,
  Invocation,
  type LoadedVersions as Served,
  Runtime
} from "@patchy/runtime";
import type * as Admission from "./Admission.js";
import * as Catalogue from "./Catalogue.js";
import * as ChangeKeys from "./ChangeKeys.js";
import * as Tools from "./Tools.js";

/** What `read_patch` takes, and `change_patch` with its key. */
export const CallArgs = Schema.Struct({
  patch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(Tools.PATCH_CHARS)),
  tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(Tools.TOOL_CHARS)),
  args: Schema.Record(Schema.String, Schema.Json)
});
export type CallArgs = typeof CallArgs.Type;

/** What `change_patch` takes: a call and the change key the agent names it by. */
export const ChangeArgs = Schema.Struct({
  ...CallArgs.fields,
  // Any string: Patchy keeps only its hash.
  key: Schema.String
});

const strict = { onExcessProperty: "error" } as const;
const decodeRead = Schema.decodeUnknownResult(CallArgs, strict);
const decodeChange = Schema.decodeUnknownResult(ChangeArgs, strict);
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const parseJsonText = Schema.decodeSync(Schema.fromJsonString(Schema.Json));
const encoder = new TextEncoder();

const counted = (count: number) => count.toLocaleString("en-US");

/** The most of a tool's name an event keeps. */
const RECORDED_TOOL = 128;

/** What a call reaches once every check passes: the tool on the version served at arrival. */
export interface Target {
  readonly patch: Patches.ReadPatch;
  /** The version served when the call arrived: the checks read it and the call runs on it. */
  readonly version: Served.LoadedVersion;
  /** That version's number, which a success answers as `version`. */
  readonly versionNumber: number;
  readonly tool: string;
  readonly descriptor: HandlerDescriptor;
  readonly args: CallArgs["args"];
}

/** A call's target, or the tool result that refuses it before anything runs. */
export type Reached = { readonly target: Target } | { readonly refused: ToolCallResult };

/** The person a connection acts as, as Runtime's viewer: the role is read with the identity. */
const personOf = (identity: AgentConnections.AgentIdentity): NonNullable<RuntimeMe> => ({
  user: identity.user,
  company: identity.company,
  admin: identity.role === "admin"
});

/** A retired patch, to someone who could open it: who retired it and when, and what to do. */
const retired = Effect.fn("Calls.retired")(function* (
  access: Patches.ReadAccess,
  row: Patches.ReadPatch
) {
  const notice = yield* (yield* Patches.Patches).addressNotice(row.patch.id, access);
  const by = Option.isSome(notice) ? notice.value.actorName : null;
  const on = row.patch.retiredAt === null ? "" : ` on ${dateLabel(row.patch.retiredAt)}`;
  return toolRefusal({
    code: "patch_retired",
    from: "patchy",
    message:
      by === null
        ? `${row.patch.name} was retired${on}; its owner, ${row.owner.name}, or an admin can restore it. Tell the person.`
        : `${row.patch.name} was retired by ${by}${on}; they can restore it. Tell the person.`
  });
});

/**
 * Finds what a call names and checks it, all against the version served when it arrived: the
 * patch among those the person can open, the tool among that version's agent tools, its kind
 * against the door's tool, then the arguments' size and schema. The checks name the tools the
 * patch has now, since a publish may have changed them since the agent looked.
 */
export const reach = Effect.fn("Calls.reach")(
  function* (
    identity: AgentConnections.AgentIdentity,
    call: CallArgs,
    publicUrl: URL,
    door: AgentToolKind
  ): Effect.fn.Return<Reached, SqlError, Patches.Patches> {
    yield* WideEvents.enrich({ agentTool: [...call.tool].slice(0, RECORDED_TOOL).join("") });
    const patches = yield* Patches.Patches;
    const canOpen = yield* Patches.Openability;
    const access: Patches.ReadAccess = {
      companyId: identity.company.id,
      userId: identity.user.id,
      canOpen: (patch) => canOpen(patch, identity.user.id)
    };
    // Retired patches too, so one the person could open can say who retired it.
    const rows = yield* patches
      .read({ ...access, state: "all" })
      .pipe(Effect.catchTags({ PatchUnavailable: Effect.die, WrongState: Effect.die }));
    const found = yield* Catalogue.resolve(identity, rows, call.patch, publicUrl);
    if (found === undefined || found.row.patch.state === "deleted")
      return { refused: Catalogue.notFound(identity) };
    const { row } = found;
    yield* WideEvents.enrich({ patchRef: found.by, ...Patches.eventFields(row.patch) });
    if (row.patch.state === "retired") return { refused: yield* retired(access, row) };

    // The version the list read: everything below reads it, and the call runs on it.
    const served =
      row.patch.currentVersionId === null
        ? Option.none()
        : yield* patches.find(row.patch.id, undefined, row.patch.currentVersionId);
    if (Option.isNone(served)) return { refused: Catalogue.notFound(identity) };
    const { manifest } = served.value.version;
    const tools = agentToolEntries(manifest.handlers);
    const names = tools.map(([name]) => name);
    const descriptor = tools.find(([name]) => name === call.tool)?.[1];
    if (descriptor === undefined)
      return { refused: unknownToolRefusal(row.patch.name, call.tool, names) };
    const kind = agentToolKind(descriptor);
    yield* WideEvents.enrich({ agentToolKind: kind });
    if (kind !== door) return { refused: wrongKindRefusal(row.patch.name, call.tool, kind, names) };

    // Measured as Runtime measures it, before anything starts the patch.
    const cap = yield* ContractLimits.get("tier2.args.bytes");
    const bytes = encoder.encode(jsonText(call.args)).byteLength;
    if (bytes > cap) {
      yield* WideEvents.enrich({ limitId: "tier2.args.bytes" });
      return {
        refused: toolRefusal({
          code: "too_large",
          from: "patchy",
          message: `${call.tool}'s arguments are ${counted(bytes)} bytes of JSON, more than the ${counted(cap)} one call takes, so nothing ran. Send less in each call.`
        })
      };
    }
    // The tool's own schema, so the refusal speaks it rather than Runtime's words.
    const problem = yield* Schema.decodeUnknownEffect(
      handlerArgsSchema(descriptor.args, manifest.tables),
      strict
    )(call.args).pipe(
      Effect.as(undefined),
      Effect.catch((error) => Effect.succeed(Catalogue.problemOf(error)))
    );
    if (problem !== undefined) return { refused: invalidArgsRefusal(call.tool, problem, names) };
    return {
      target: {
        patch: row,
        version: LoadedVersions.loaded(served.value),
        versionNumber: served.value.version.versionNumber,
        tool: call.tool,
        descriptor,
        args: call.args
      }
    };
  },
  Effect.catchTags({ SqlError: Effect.die })
);

/**
 * What every company callback of an agent's call checks first, read now on the database's
 * clock: the connection still works, its person is still theirs, and their company still
 * allows agents. It answers the person as they are now, so a role change shows at once.
 */
const recheck = Effect.fn("Calls.recheck")(function* (identity: AgentConnections.AgentIdentity) {
  // Both reads at once, so a callback waits for one round trip.
  const [current, access] = yield* Effect.all(
    [
      (yield* AgentConnections.AgentConnections)
        .current(identity.agentConnection.id)
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))),
      (yield* Companies.Companies).agentAccess(identity.company.id).pipe(
        // A company outlives every live connection of its people.
        Effect.catchTags({ CompanyNotFound: Effect.die }),
        Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
      )
    ],
    { concurrency: "unbounded" }
  );
  if (
    current === null ||
    current.user.id !== identity.user.id ||
    current.company.id !== identity.company.id ||
    !access.on
  )
    return yield* new Runtime.AccessDenied({});
  return personOf(current);
});

/**
 * Runs a reached tool on the version the call read, as the person through their agent, with
 * `mutationKey` for a change: Runtime's reply, or its refusal. `onReplay` is told when the reply
 * is the key's outcome an earlier invocation committed, and `retain` holds the call's admission
 * until its work settles. A host without an invocation runs no patch code.
 */
export const invoke = Effect.fn("Calls.invoke")(function* (
  identity: AgentConnections.AgentIdentity,
  target: Target,
  invocation: Option.Option<Invocation.Invocation["Service"]>,
  options: Pick<Invocation.AgentCall, "mutationKey" | "onReplay" | "retain"> = {}
): Effect.fn.Return<
  ServerCallReply,
  Runtime.RuntimeError,
  AgentConnections.AgentConnections | Companies.Companies
> {
  if (Option.isNone(invocation)) return yield* new Runtime.InvocationUnavailable();
  const services = yield* Effect.context<AgentConnections.AgentConnections | Companies.Companies>();
  return yield* Invocation.callAgent({
    version: target.version,
    person: personOf(identity),
    agent: { name: identity.agentConnection.clientName },
    tool: target.tool,
    args: target.args,
    ...options,
    recheck: recheck(identity).pipe(Effect.provideContext(services))
  }).pipe(Effect.provideService(Invocation.Invocation, invocation.value));
});

/**
 * `read_patch { patch, tool, args }`: runs a read tool, a query or read-only action, and
 * answers `{ result, version }` within the read cap, or the patch's own refusal or Patchy's.
 */
export const read = Effect.fn("Calls.read")(function* (
  identity: AgentConnections.AgentIdentity,
  args: unknown,
  publicUrl: URL,
  invocation: Option.Option<Invocation.Invocation["Service"]>,
  admit: Admission.Admit
) {
  const decoded = decodeRead(args ?? {});
  if (Result.isFailure(decoded))
    return Catalogue.invalidArgs(
      "read_patch",
      Catalogue.problemOf(decoded.failure),
      "Send { patch, tool, args }: a patch find_patches listed, one of its read tools from open_patch, and that tool's arguments as an object."
    );
  const reached = yield* reach(identity, decoded.success, publicUrl, "read");
  if ("refused" in reached) return reached.refused;
  const { target } = reached;
  return yield* admit(identity, target.patch, (retain) =>
    invoke(identity, target, invocation, { retain }).pipe(
      Effect.map((reply) =>
        callAnswer(target.patch.patch.name, target.tool, target.versionNumber, reply)
      ),
      Effect.catch((error) => refused(Runtime.toFailure(error), target.descriptor)),
      Effect.map((answer) =>
        readAnswer(
          { name: target.patch.patch.name, owner: target.patch.owner.name },
          target.tool,
          answer
        )
      )
    )
  );
});

/** The same key on another tool or other arguments: a key names one change. */
const keyConflict = (patch: string) =>
  toolRefusal({
    code: "key_conflict",
    from: "patchy",
    message: `That key was used for a different change to ${patch}; pick a new one. A key names one change: one tool with the same arguments.`
  });

/** A retry after a publish: the key is bound to the version its first try ran on. */
const versionChanged = (patch: string) =>
  toolRefusal({
    code: "version_changed",
    from: "patchy",
    message: `${patch} was published since your first try with this key; read before retrying. If the change still needs making, make it with a new key.`
  });

/** A later try with an action's key, which never runs again. */
const keyUsed = (tool: string) =>
  toolRefusal({
    code: "key_used",
    from: "patchy",
    message: `${tool} is an action, and it already ran with this key; an action that writes is not safe to retry, so Patchy never runs its key twice. Read what it changes first, then retry with a new key if it still needs doing.`
  });

/**
 * A retry of a mutation whose outcome Patchy doesn't know, too near the end of its key's 24 hours
 * for Runtime to be sure to keep that outcome until the retry finishes.
 */
const keyExpiring = toolRefusal({
  code: "key_expired",
  from: "patchy",
  message:
    "Patchy doesn't know whether your first try with this key happened, and the key is too close to the end of its 24 hours to retry safely. Read what it changes first, then use a new key if it still needs doing."
});

/** A try while the key's first try, or an earlier retry, is still running. */
const keyBusy = toolRefusal({
  code: "busy",
  from: "patchy",
  message: "The first try with this key is still running. Try again in a second with the same key.",
  retryAfterSeconds: 1
});

/** Runtime's refusal of a call as the agent gets it, with the limit it names in the event. */
const refused = (failure: RuntimeFailure, descriptor: HandlerDescriptor) =>
  WideEvents.enrich(failure.limitId === undefined ? {} : { limitId: failure.limitId }).pipe(
    Effect.as(runtimeRefusal(failure, descriptor))
  );

/**
 * Runtime's refusal of a change. A mutation whose outcome is unknown resolves on a retry under
 * the same key, so its refusal says to retry with it; an action that may have partly happened
 * says to read first, as `runtimeRefusal` does.
 */
const changeRefusal = (error: Runtime.RuntimeError, descriptor: HandlerDescriptor) => {
  const failure = Runtime.toFailure(error);
  return refused(
    descriptor.kind === "mutation" && failure.code === "unknown_outcome"
      ? {
          ...failure,
          error: `${failure.error} Retry with the same key: Patchy answers its result if it happened and makes it if it didn't.`
        }
      : failure,
    descriptor
  );
};

/** Runtime refused the call at its own admission, so the handler never started. */
const neverStarted = Schema.is(
  Schema.Union([Invocation.InvocationBusy, ExecutionLifecycle.LifecycleError])
);

/**
 * `change_patch { patch, tool, args, key }`: runs a change tool, a mutation or an action that
 * can write, under the agent's change key, and answers `{ result, version }`, with the result
 * left out when an agent couldn't read it, or the patch's own refusal or Patchy's. A retry of
 * a committed mutation answers its first result with `replayed: true` and runs nothing.
 */
export const change = Effect.fn("Calls.change")(function* (
  identity: AgentConnections.AgentIdentity,
  args: unknown,
  publicUrl: URL,
  invocation: Option.Option<Invocation.Invocation["Service"]>,
  admit: Admission.Admit
) {
  const decoded = decodeChange(args ?? {});
  if (Result.isFailure(decoded))
    return Catalogue.invalidArgs(
      "change_patch",
      Catalogue.problemOf(decoded.failure),
      "Send { patch, tool, args, key }: a patch find_patches listed, one of its change tools from open_patch, that tool's arguments as an object, and a key naming this change."
    );
  const { key, ...call } = decoded.success;
  const reached = yield* reach(identity, call, publicUrl, "change");
  if ("refused" in reached) return reached.refused;
  const { target } = reached;
  // A host that runs no patch code refuses before the key is taken, so the key stays free.
  if (Option.isNone(invocation))
    return runtimeRefusal(
      Runtime.toFailure(new Runtime.InvocationUnavailable()),
      target.descriptor
    );
  // Admitted before the key is claimed, so a limit's refusal leaves the key free.
  return yield* admit(identity, target.patch, (retain) =>
    changeOn(identity, target, key, invocation, retain)
  );
});

/** An admitted change: claims its key, then runs it, answers its first result or refuses it. */
const changeOn = Effect.fn("Calls.changeOn")(function* (
  identity: AgentConnections.AgentIdentity,
  target: Target,
  key: string,
  invocation: Option.Option<Invocation.Invocation["Service"]>,
  retain: Admission.Retain
) {
  const patch = target.patch.patch.name;
  const kind = target.descriptor.kind === "mutation" ? "mutation" : "action";
  const claimed = yield* (yield* ChangeKeys.ChangeKeys)
    .claim({
      connectionId: identity.agentConnection.id,
      patchId: target.patch.patch.id,
      key,
      versionId: target.version.versionId,
      tool: target.tool,
      args: target.args,
      kind
    })
    .pipe(Effect.catchTags({ SqlError: Effect.die }));
  switch (claimed._tag) {
    case "Conflict":
      return keyConflict(patch);
    case "VersionChanged":
      return versionChanged(patch);
    case "Used":
      return keyUsed(target.tool);
    case "Busy":
      return keyBusy;
    case "TooLate":
      return keyExpiring;
    case "Replay":
      yield* WideEvents.enrich({ replayed: true });
      return changeAnswer(
        target.tool,
        target.versionNumber,
        toolAnswer({
          result: parseJsonText(claimed.result),
          version: target.versionNumber,
          replayed: true
        } satisfies CallSuccess)
      );
    case "Run":
  }
  // Runtime says when its own record of the mutation key answered a retry Patchy hadn't seen
  // commit, such as one after an unknown outcome: that change replayed too.
  const replayed = yield* Ref.make(false);
  // A try that ends settles its key, keeping a committed mutation's result, or gives an action's
  // key back if Runtime refused it before it started. If the agent goes away first, Runtime
  // finishes the try without it and the key stays held until its lease runs out, since the try
  // may still be running; a retry then resolves through Runtime's record.
  const exit = yield* Effect.exit(
    invoke(identity, target, invocation, {
      ...(claimed.mutationKey === undefined ? {} : { mutationKey: claimed.mutationKey }),
      onReplay: Ref.set(replayed, true),
      retain
    })
  );
  yield* (
    kind === "action" &&
    Exit.isFailure(exit) &&
    Option.exists(Cause.findErrorOption(exit.cause), neverStarted)
      ? claimed.discard
      : claimed.settle(
          kind === "mutation" && Exit.isSuccess(exit) && exit.value.ok
            ? jsonText(exit.value.value)
            : undefined
        )
  ).pipe(
    Effect.catchTags({
      SqlError: (cause) => Effect.logError("A change key's try was not settled.", cause)
    })
  );
  const answer = yield* exit.pipe(
    Effect.flatMap((reply) =>
      Effect.map(Ref.get(replayed), (again) =>
        again && reply.ok
          ? toolAnswer({
              result: reply.value,
              version: target.versionNumber,
              replayed: true
            } satisfies CallSuccess)
          : callAnswer(patch, target.tool, target.versionNumber, reply)
      )
    ),
    Effect.catch((error) => changeRefusal(error, target.descriptor))
  );
  yield* WideEvents.enrich({ replayed: yield* Ref.get(replayed) });
  return changeAnswer(target.tool, target.versionNumber, answer);
});
