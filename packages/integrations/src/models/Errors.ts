/**
 * How a model call refuses, in Patchy's codes. Each says in `details.sent` whether Patchy sent the
 * provider a request: `false` means nothing was sent or charged, `true` that a request was
 * dispatched and may be charged. A reply lost on its way to the patch carries no `sent`, as its
 * dispatch is unknown. None carries the instructions, the input, the answer or the provider's own
 * words; the provider's error rides only as a redacted `cause`.
 */
import { registry } from "@patchy/limits/registry";
import * as Schema from "effect/Schema";
import { ModelRoleKind } from "@patchy/api";

const Cause = Schema.optionalKey(Schema.Redacted(Schema.Defect(), { disallowJsonEncode: true }));
/** What the provider counted before the call failed: for the attempt record, never the reply. */
const Usage = Schema.optionalKey(
  Schema.Struct({ inputTokens: Schema.NullOr(Schema.Int), outputTokens: Schema.NullOr(Schema.Int) })
);

/** The alias names no model role this version declares. Nothing was sent. */
export class ConnectionNotDeclared extends Schema.TaggedError<ConnectionNotDeclared>()(
  "ModelsConnectionNotDeclared",
  {}
) {
  readonly code = "connection_not_declared" as const;
  readonly status = 400;
  readonly sent = false;
  get details() {
    return { sent: false };
  }
  override get message() {
    return "This model role is not declared by this version.";
  }
}

/**
 * The action's time ran short. Unsent, too little was left to send by `models.send.floor`; sent,
 * the call reached its cut-off `models.cutoff` before the action's deadline and Patchy closed the
 * connection, and the provider may still charge for it.
 */
export class Timeout extends Schema.TaggedError<Timeout>()("ModelsTimeout", {
  sent: Schema.Boolean,
  /** How long the call had from its start to the floor or the cut-off. */
  milliseconds: Schema.Int
}) {
  readonly code = "timeout" as const;
  readonly status = 504;
  get limitId() {
    return this.sent ? ("models.cutoff" as const) : ("models.send.floor" as const);
  }
  get scope() {
    return registry[this.limitId].scope;
  }
  get value() {
    return registry[this.limitId].default;
  }
  get details() {
    return { sent: this.sent };
  }
  override get message() {
    return this.sent
      ? "The model didn't answer before this action's time ran out, so Patchy closed the request. The provider may still charge for it."
      : "Too little of this action's time was left to call the model, so nothing was sent.";
  }
}

/**
 * Patchy's capacity for model calls refused, so nothing was sent: the model pool, the host's
 * provider requests, one provider record's, or the host's queue for them.
 */
export class Busy extends Schema.TaggedError<Busy>()("ModelsBusy", {
  limitId: Schema.Literals([
    "tier2.models.company",
    "tier2.models.viewer",
    "tier2.models.replica",
    "models.outbound.host",
    "models.outbound.provider",
    "models.queue.waiting"
  ]),
  value: Schema.Number,
  /** How long the call waited for room; 0 when it was refused at once. */
  waitedMs: Schema.Int
}) {
  readonly code = "busy" as const;
  readonly status = 429;
  readonly sent = false;
  get scope() {
    return registry[this.limitId].scope;
  }
  /** Refused at once, room may come in a moment; a call that waited out its time advises none. */
  get retryAfterSeconds() {
    return this.waitedMs === 0 ? 1 : undefined;
  }
  get details() {
    return { sent: false };
  }
  override get message() {
    return this.waitedMs === 0
      ? "Too many model calls are running, so nothing was sent. Try again shortly."
      : "No room to call the model came before this action's time ran short, so nothing was sent.";
  }
}

/** The provider refused for its rate, or for the account's credit, spend or usage limit. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("ModelsRateLimited", {
  limit: Schema.Literals(["requests", "quota"]),
  retryAfterSeconds: Schema.optionalKey(Schema.Int)
}) {
  readonly code = "source_rate_limited" as const;
  readonly status = 429;
  readonly sent = true;
  get details() {
    return { sent: true, limit: this.limit };
  }
  override get message() {
    return this.limit === "quota"
      ? "The model provider refused: the company's account reached its credit or spend limit. Ask an admin."
      : "The model provider is refusing requests for now: its rate limit was reached.";
  }
}

/**
 * The call couldn't be answered: the provider couldn't be reached, refused the key, failed,
 * stopped without finishing, or answered in a shape Patchy doesn't read; or, before anything was
 * sent, the role's provider, model or key changed while the call waited.
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()("ModelsUnavailable", {
  reason: Schema.Literals([
    "unreachable",
    "key",
    "provider",
    "stopped",
    "answer",
    "connection_changed",
    "model"
  ]),
  sent: Schema.Boolean,
  upstreamStatus: Schema.optionalKey(Schema.Int),
  retryAfterSeconds: Schema.optionalKey(Schema.Int),
  usage: Usage,
  cause: Cause
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  get details() {
    return {
      sent: this.sent,
      reason: this.reason,
      ...(this.upstreamStatus === undefined ? {} : { upstreamStatus: this.upstreamStatus })
    };
  }
  override get message() {
    return {
      unreachable: this.sent
        ? "The connection to the model provider dropped after the request was sent, so whether it was answered, and charged, is unknown."
        : "The model provider couldn't be reached.",
      key: "The model provider doesn't accept the company's key. Ask an admin to replace it.",
      provider: "The model provider failed to answer.",
      stopped: "The model stopped before it finished, for a reason Patchy doesn't report.",
      answer: "The model provider answered in a shape Patchy doesn't read.",
      connection_changed:
        "An admin changed this role's provider, model or key while the call waited, so nothing was sent. Try again.",
      model:
        "This role's model can't answer this kind of call on its provider, so nothing was sent. Ask an admin to map it to one that can."
    }[this.reason];
  }
}

/** A call Patchy or the provider can't run as asked; the provider generated nothing. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("ModelsInvalidRequest", {
  reason: Schema.Literals(["kind", "output", "provider"]),
  sent: Schema.Boolean,
  /** Where in `output` the descriptor Patchy can't send is, such as `items[]`. */
  path: Schema.optionalKey(Schema.String),
  /** The role's kind, when the call was for the other kind. */
  kind: Schema.optionalKey(ModelRoleKind),
  upstreamStatus: Schema.optionalKey(Schema.Int),
  cause: Cause
}) {
  readonly code = "invalid_request" as const;
  readonly status = 400;
  get details() {
    return {
      sent: this.sent,
      reason: this.reason,
      ...(this.path === undefined ? {} : { path: this.path }),
      ...(this.kind === undefined ? {} : { kind: this.kind }),
      ...(this.upstreamStatus === undefined ? {} : { upstreamStatus: this.upstreamStatus })
    };
  }
  override get message() {
    return {
      kind:
        this.kind === "decision"
          ? "This is a decision role: call decide, not generate."
          : "This is a text role: call generate, not decide.",
      output: `A typed output is an object whose fields are all required, of text, integer, number, boolean, enum, nullable, object and array, at most ${registry["models.output.depth"].default} levels deep and ${registry["models.output.nodes"].default} parts in all. ${this.path === undefined || this.path === "" ? "The output" : `\`${this.path}\``} isn't one.`,
      provider: "The model provider refused the request as invalid."
    }[this.reason];
  }
}

/**
 * The request Patchy would send is past `models.request.bytes`, and nothing was sent; or the
 * provider's answer, or the body of its refusal, was past `models.answer.bytes`, and nothing of
 * it was decoded.
 */
export class TooLarge extends Schema.TaggedError<TooLarge>()("ModelsTooLarge", {
  limitId: Schema.Literals(["models.request.bytes", "models.answer.bytes"]),
  /** The provider's status, when the oversized body was a refusal's. */
  upstreamStatus: Schema.optionalKey(Schema.Int)
}) {
  readonly code = "too_large" as const;
  get status() {
    return this.limitId === "models.request.bytes" ? 413 : 502;
  }
  get sent() {
    return this.limitId === "models.answer.bytes";
  }
  get scope() {
    return registry[this.limitId].scope;
  }
  get value() {
    return registry[this.limitId].default;
  }
  get details() {
    return {
      sent: this.sent,
      ...(this.upstreamStatus === undefined ? {} : { upstreamStatus: this.upstreamStatus })
    };
  }
  override get message() {
    return this.limitId === "models.request.bytes"
      ? `The request to the model would be larger than ${this.value} bytes, so nothing was sent.`
      : `The model provider's answer was larger than the ${this.value} bytes Patchy reads, so nothing was returned.`;
  }
}

/** The model's answer didn't match the typed output; nothing was returned. */
export class ShapeMismatch extends Schema.TaggedError<ShapeMismatch>()("ModelsShapeMismatch", {
  usage: Usage
}) {
  readonly code = "shape_mismatch" as const;
  readonly status = 422;
  readonly sent = true;
  get details() {
    return { sent: true };
  }
  override get message() {
    return "The model's answer didn't match the output's shape.";
  }
}

/** The model reached the call's `maxOutputTokens` before it finished; nothing was returned. */
export class OutputTruncated extends Schema.TaggedError<OutputTruncated>()(
  "ModelsOutputTruncated",
  { maxOutputTokens: Schema.Int, usage: Usage }
) {
  readonly code = "output_truncated" as const;
  readonly status = 422;
  readonly sent = true;
  get details() {
    return { sent: true, maxOutputTokens: this.maxOutputTokens };
  }
  override get message() {
    return `The model reached maxOutputTokens (${this.maxOutputTokens}) before it finished. Raise it, or ask for less.`;
  }
}

/** The model declined to answer, or the provider's filter stopped it. */
export class Refused extends Schema.TaggedError<Refused>()("ModelsRefused", { usage: Usage }) {
  readonly code = "model_refused" as const;
  readonly status = 422;
  readonly sent = true;
  get details() {
    return { sent: true };
  }
  override get message() {
    return "The model declined to answer this request.";
  }
}

/** Everything a provider call can refuse with once Patchy has prepared it. */
export type CallError =
  | Timeout
  | Busy
  | RateLimited
  | Unavailable
  | InvalidRequest
  | TooLarge
  | ShapeMismatch
  | OutputTruncated
  | Refused;
