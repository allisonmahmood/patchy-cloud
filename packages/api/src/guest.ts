import * as Schema from "effect/Schema";
import { HandlerDescriptors, HandlerName } from "./handlers.js";
import { FileBody, RuntimeFailure, RuntimeReply } from "./runtime.js";
import { Identity } from "./schemas.js";
import { limitRefusal } from "./limits.js";

/** Private execution wire, never mounted on the public HttpApi. Stored versions retain it. */
export const wireVersion = 1;
export const compatibilityDate = "2026-09-24";
export const workerdVersion = "1.20260924.1";
// This date enables Node compatibility by default; wire 1 explicitly refuses it.
export const compatibilityFlags = ["no_nodejs_compat", "no_nodejs_compat_v2"] as const;
export const callbackFileLimit = limitRefusal("tier2.callbacks.fileBytes");
/** The refusal of a callback body over the cap, given inside workerd before the host sees it. */
export const callbackFileTooLarge = {
  ok: false,
  source: "patchy",
  error: "The file exceeds the callback byte limit.",
  ...callbackFileLimit
} as const satisfies RuntimeFailure;

const identity = Schema.NonEmptyString;
const sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const milliseconds = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const args = Schema.Record(Schema.String, Schema.Json);
const viewer = Schema.Struct({
  user: Identity.fields.user,
  company: Identity.fields.company,
  admin: Schema.Boolean,
  /** Older stored bundles may omit this; current hosts always send it. */
  guest: Schema.optionalKey(Schema.Boolean)
});
/**
 * The worker agent an invocation runs for, by the name its person approved: a label, never proof.
 * Only Patchy's own agent callers set it. It is absent for a page's call, so older loaders and
 * guests, which refuse unknown keys, keep serving pages, and handler code reads it as null.
 */
export const Agent = Schema.Struct({ name: Schema.NonEmptyString });
export type Agent = typeof Agent.Type;

export const BundleBinding = Schema.Struct({
  companyId: identity,
  patchId: identity,
  versionId: identity,
  sha256
});
export type BundleBinding = typeof BundleBinding.Type;
export const Bundle = Schema.Struct({ ...BundleBinding.fields, bundle: Schema.String });
export type Bundle = typeof Bundle.Type;

export const Attempt = Schema.Struct({
  invocationId: identity,
  attemptId: identity,
  processGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  deadline: milliseconds
});
export type Attempt = typeof Attempt.Type;
export const Callback = Schema.Struct({
  op: identity,
  args,
  body: Schema.optionalKey(FileBody)
});
export type Callback = typeof Callback.Type;
export const CallbackReply = Schema.Union([
  RuntimeReply,
  Schema.Struct({ ok: Schema.Literal(true), body: FileBody })
]);
export type CallbackReply = typeof CallbackReply.Type;

/** Only the loader sees the callback address and capability; neither enters guest props. */
export const Invoke = Schema.Struct({
  wire: Schema.Literal(wireVersion),
  binding: BundleBinding,
  ...Attempt.fields,
  handler: HandlerName,
  args,
  viewer,
  agent: Schema.optionalKey(Agent),
  callback: Schema.Struct({ url: identity, capability: identity })
});
export type Invoke = typeof Invoke.Type;
export const GuestRequest = Schema.Union([
  Schema.Struct({ wire: Schema.Literal(wireVersion), type: Schema.Literal("describe") }),
  Schema.Struct({
    wire: Schema.Literal(wireVersion),
    type: Schema.Literal("invoke"),
    handler: HandlerName,
    args,
    viewer,
    agent: Schema.optionalKey(Agent)
  })
]);
export type GuestRequest = typeof GuestRequest.Type;
/** Guest-authored claims, including source: "patchy" and correlationId, are untrusted. */
export const GuestReply = RuntimeReply;
export type GuestReply = typeof GuestReply.Type;
export const InspectRequest = Schema.Struct({
  wire: Schema.Literal(wireVersion),
  bundle: Schema.String
});
export type InspectRequest = typeof InspectRequest.Type;
export const InspectionReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), handlers: HandlerDescriptors }),
  RuntimeFailure
]);
export type InspectionReply = typeof InspectionReply.Type;
/** Engine observations are separate from guest claims; only the host classifies settlement. */
export const InvokeReply = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("returned"), reply: GuestReply, guestMs: milliseconds }),
  Schema.Struct({ outcome: Schema.Literal("deadline"), guestMs: milliseconds }),
  Schema.Struct({ outcome: Schema.Literal("guest_failed"), guestMs: milliseconds })
]);
export type InvokeReply = typeof InvokeReply.Type;
export const BindRequest = Schema.Struct({ wire: Schema.Literal(wireVersion), ...Bundle.fields });
export type BindRequest = typeof BindRequest.Type;
export const BindReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    code: Schema.Literals([
      "bundle_required",
      "invalid_bundle",
      "binding_conflict",
      "load_failed",
      "invalid_request"
    ])
  })
]);
export type BindReply = typeof BindReply.Type;
