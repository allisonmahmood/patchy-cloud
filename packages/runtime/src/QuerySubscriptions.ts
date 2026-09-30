import { ServerCall, canonicalArgs, handlerArgsSchema, type Manifest } from "@patchy/api";
import { newInternalId } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Invocation from "./Invocation.js";
import * as Runtime from "./Runtime.js";
import * as SubscriptionReads from "./SubscriptionReads.js";

class LifecycleChanged extends Schema.TaggedError<LifecycleChanged>()("QueryLifecycleChanged", {
  patchId: Schema.String
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "A query source changed while its snapshot was running.";
  }
}
const decodeQuery = Schema.decodeUnknownEffect(
  Schema.Struct({ handler: ServerCall.fields.handler, args: ServerCall.fields.args }),
  { onExcessProperty: "error" }
);
const encoder = new TextEncoder();

/** Adds hosted queries to the same storage reader and revision reconciliation path. */
export const make = Effect.gen(function* () {
  const reads = yield* SubscriptionReads.SubscriptionReads;
  const invocation = yield* Effect.serviceOption(Invocation.Invocation);
  const argsBytes = yield* ContractLimits.get("tier2.args.bytes");
  const codecs = new WeakMap<
    typeof Manifest.Type,
    Map<string, (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>>
  >();
  const admit = Effect.fn("QuerySubscriptions.admit")(function* (input: SubscriptionReads.Input) {
    if (input.op !== "server.call") return yield* reads.admit(input);
    const { binding } = input;
    if (binding.scope === "public") return yield* new Runtime.PublicUnavailable({});
    if (binding.manifest.tier !== 2 || binding.identity === null)
      return yield* new Runtime.AccessDenied({});
    const call = yield* decodeQuery(input.args).pipe(
      Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
    );
    if (encoder.encode(canonicalArgs(call.args)).byteLength > argsBytes)
      return yield* new Runtime.TooLarge({ maxBytes: argsBytes, limitId: "tier2.args.bytes" });
    const descriptor = Object.hasOwn(binding.manifest.handlers ?? {}, call.handler)
      ? binding.manifest.handlers?.[call.handler]
      : undefined;
    if (descriptor === undefined)
      return yield* new Invocation.HandlerFailed({ correlationId: binding.correlationId });
    if (descriptor.kind !== "query") return yield* new Runtime.InvalidRequest({});
    let handlers = codecs.get(binding.manifest);
    if (handlers === undefined) {
      handlers = new Map();
      codecs.set(binding.manifest, handlers);
    }
    let decode = handlers.get(call.handler);
    if (decode === undefined) {
      decode = Schema.decodeUnknownEffect(
        handlerArgsSchema(descriptor.args, binding.manifest.tables),
        {
          onExcessProperty: "error"
        }
      );
      handlers.set(call.handler, decode);
    }
    yield* decode(call.args).pipe(
      Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
    );
    if (Option.isNone(invocation)) return yield* new Runtime.InvocationUnavailable();
    if (input.dependencies === undefined || input.dependencies.length === 0) return [];
    const allowed = new Set([
      ...Object.keys(binding.manifest.tables).map((name) => `table:${binding.patchId}:${name}`),
      ...Object.keys(binding.manifest.files).map((name) => `store:${binding.patchId}:${name}`)
    ]);
    for (const declaration of Object.values(binding.manifest.uses)) {
      if (declaration.kind === "sharedTable") {
        allowed.add(`table:${declaration.patchId}:${declaration.table}`);
        allowed.add(`patch:${declaration.patchId}`);
      } else if (declaration.kind === "sharedStore") {
        allowed.add(`store:${declaration.patchId}:${declaration.store}`);
        allowed.add(`patch:${declaration.patchId}`);
      }
    }
    // Resume keys are untrusted. Only fence declared resources; callbacks still
    // trace the actual dependencies, including accesses which fail.
    return input.dependencies.filter((key) => allowed.delete(key));
  });
  const read = Effect.fn("QuerySubscriptions.read")(function* (input: SubscriptionReads.Input) {
    if (input.op !== "server.call") return yield* reads.read(input);
    if (Option.isNone(invocation)) return yield* new Runtime.InvocationUnavailable();
    if (input.reauthorize === undefined) return yield* new Runtime.AccessDenied({});
    const { binding } = input;
    // Platform authority is outside the company snapshot. Fence every possible source
    // before invocation, then keep only the sources actually attempted by the guest.
    const sources = new Set<string>();
    for (const declaration of Object.values(binding.manifest.uses))
      if (declaration.kind === "sharedTable" || declaration.kind === "sharedStore")
        sources.add(`patch:${declaration.patchId}`);
    const before = yield* reads.revisions(binding.companyId, [...sources]);
    const attempted = new Set<string>();
    let watermark: Readonly<Record<string, string>> = {};
    const reply = yield* invocation.value.call(
      input.args,
      { ...binding, correlationId: newInternalId("call") },
      input.reauthorize,
      {
        onDependency: (key) => {
          attempted.add(key);
          input.onDependency?.(key);
        },
        onSnapshot: (vector) => {
          watermark = vector;
        }
      }
    );
    if (!reply.ok) return yield* new SubscriptionReads.HandlerRefusal({ failure: reply });
    const sourceKeys = [...attempted].filter((key) => key.startsWith("patch:"));
    const after = yield* reads.revisions(binding.companyId, sourceKeys);
    const changed = sourceKeys.find((key) => before[key] !== after[key]);
    if (changed !== undefined)
      return yield* new LifecycleChanged({ patchId: changed.slice("patch:".length) });
    const vector: Record<string, string> = {};
    for (const key of attempted)
      vector[key] = (key.startsWith("patch:") ? before[key] : watermark[key]) ?? "-1";
    return { result: reply.value, vector };
  });
  return { admit, read, revisions: reads.revisions };
});
