/**
 * The door's calls of a patch's agent tools: `read_patch` here, and `change_patch` on the same
 * path once change keys land (docs/product.md › The door). A call finds the patch among those
 * the person can open, reads the tool from the version served when the call arrives, and checks
 * its kind and arguments against that same version, so a publish can't turn a read into a
 * write. It runs there through Runtime's agent invocation as the person, `ctx.agent` being the
 * name they approved, and every company callback first rechecks the connection, the person and
 * the company's agent access, on the database's clock.
 *
 * Every refusal is a tool result, and nothing runs until the checks pass. A patch the person
 * couldn't open is "not found"; a retired one they could says who retired it and when.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as WideEvents from "@patchy/analytics/wide-events";
import {
  agentToolEntries,
  agentToolKind,
  type AgentToolKind,
  handlerArgsSchema,
  type HandlerDescriptor,
  invalidArgsRefusal,
  readAnswer,
  runtimeRefusal,
  type RuntimeMe,
  type ServerCallReply,
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
import { Invocation, type LoadedVersions as Served, Runtime } from "@patchy/runtime";
import * as Catalogue from "./Catalogue.js";
import * as Tools from "./Tools.js";

/** What `read_patch` takes, and `change_patch` with its key. */
export const CallArgs = Schema.Struct({
  patch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(Tools.PATCH_CHARS)),
  tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(Tools.TOOL_CHARS)),
  args: Schema.Record(Schema.String, Schema.Json)
});
export type CallArgs = typeof CallArgs.Type;

const strict = { onExcessProperty: "error" } as const;
const decodeRead = Schema.decodeUnknownResult(CallArgs, strict);
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const encoder = new TextEncoder();

const counted = (count: number) => count.toLocaleString("en-US");

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
    yield* WideEvents.enrich({ agentTool: call.tool });
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
  const current = yield* (yield* AgentConnections.AgentConnections)
    .current(identity.agentConnection.id)
    .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
  if (
    current === null ||
    current.user.id !== identity.user.id ||
    current.company.id !== identity.company.id
  )
    return yield* new Runtime.AccessDenied({});
  const access = yield* (yield* Companies.Companies).agentAccess(current.company.id).pipe(
    Effect.catchTags({
      CompanyNotFound: (cause) => Effect.fail(new Runtime.AccessDenied({ cause })),
      SqlError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
    })
  );
  if (!access.on) return yield* new Runtime.AccessDenied({});
  return personOf(current);
});

/**
 * Runs a reached tool on the version the call read, as the person through their agent, with
 * `mutationKey` for a change: Runtime's reply, or its refusal. A host without an invocation
 * runs no patch code.
 */
export const invoke = Effect.fn("Calls.invoke")(function* (
  identity: AgentConnections.AgentIdentity,
  target: Target,
  invocation: Option.Option<Invocation.Invocation["Service"]>,
  mutationKey?: string
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
    ...(mutationKey === undefined ? {} : { mutationKey }),
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
  invocation: Option.Option<Invocation.Invocation["Service"]>
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
  return yield* invoke(identity, target, invocation).pipe(
    Effect.map((reply) =>
      readAnswer(
        { name: target.patch.patch.name, owner: target.patch.owner.name },
        target.tool,
        target.versionNumber,
        reply
      )
    ),
    Effect.catch((error) =>
      Effect.succeed(runtimeRefusal(Runtime.toFailure(error), target.descriptor))
    )
  );
});
