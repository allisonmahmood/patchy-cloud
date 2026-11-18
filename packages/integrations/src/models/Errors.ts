import { registry } from "@patchy/limits/registry";
import * as Schema from "effect/Schema";

/**
 * How a model call refuses, in Patchy's codes. Every refusal reuses a runtime code except two:
 * `output_truncated` (the model reached the call's cap) and `model_refused` (the model declined
 * to generate). None carries the prompt, the answer or the provider's own words. PROTOTYPE.
 */

const Cause = Schema.optionalKey(Schema.Redacted(Schema.Defect(), { disallowJsonEncode: true }));
/** What the provider counted before the call failed, kept for the wide event, never shown. */
const Usage = Schema.optionalKey(
  Schema.Struct({
    inputTokens: Schema.NullOr(Schema.Int),
    outputTokens: Schema.NullOr(Schema.Int)
  })
);

/** The call reached its cut-off, its action's deadline less a second; the request was cancelled. */
export class Timeout extends Schema.TaggedError<Timeout>()("ModelsTimeout", {
  milliseconds: Schema.Int
}) {
  readonly code = "timeout" as const;
  readonly status = 504;
  readonly limitId = "tier2.action.deadline" as const;
  get scope() {
    return registry[this.limitId].scope;
  }
  get value() {
    return this.milliseconds;
  }
  get details() {
    return { cutoffMs: this.milliseconds };
  }
  override get message() {
    return `The model didn't answer within the ${this.milliseconds} ms left in this action, so Patchy cancelled the request.`;
  }
}

/** The provider refused for its rate or the account's quota. Never retried by Patchy. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("ModelsRateLimited", {
  limit: Schema.Literals(["requests", "quota"]),
  retryAfterSeconds: Schema.optionalKey(Schema.Int)
}) {
  readonly code = "source_rate_limited" as const;
  readonly status = 429;
  get details() {
    return { limit: this.limit };
  }
  override get message() {
    return this.limit === "quota"
      ? "The model provider refused: the company's account is out of quota. Ask an admin."
      : `The model provider is refusing requests for now: its rate limit was reached.${this.retryAfterSeconds === undefined ? "" : ` Try again in ${this.retryAfterSeconds} seconds.`}`;
  }
}

/** The provider couldn't be reached, refused the key, failed, or answered in a shape Patchy doesn't read. */
export class Unavailable extends Schema.TaggedError<Unavailable>()("ModelsUnavailable", {
  reason: Schema.Literals(["unreachable", "key", "provider", "answer"]),
  upstreamStatus: Schema.optionalKey(Schema.Int),
  cause: Cause
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  get details() {
    return {
      reason: this.reason,
      ...(this.upstreamStatus === undefined ? {} : { upstreamStatus: this.upstreamStatus })
    };
  }
  override get message() {
    return {
      unreachable: "The model provider couldn't be reached. Try again.",
      key: "The model provider no longer accepts the company's key. Ask an admin to replace it.",
      provider: "The model provider failed to answer. Try again.",
      answer: "The model provider answered in a shape Patchy doesn't read."
    }[this.reason];
  }
}

/** A call Patchy or the provider can't run as asked. Nothing was generated. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("ModelsInvalidRequest", {
  reason: Schema.Literals(["kind", "output", "input", "provider"]),
  /** Where in `output` the unsupported descriptor is, such as `items[]`. */
  path: Schema.optionalKey(Schema.String),
  /** The role's kind, when the call was for the other kind. */
  kind: Schema.optionalKey(Schema.Literals(["decision", "text"])),
  upstreamStatus: Schema.optionalKey(Schema.Int),
  cause: Cause
}) {
  readonly code = "invalid_request" as const;
  readonly status = 400;
  get details() {
    return {
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
      output: `A typed output takes objects whose fields are all required, of text, integer, number, boolean, enum and arrays of those. ${this.path ?? "The output"} isn't one.`,
      input: "The input is larger than a model call takes.",
      provider: "The model provider refused the request as invalid."
    }[this.reason];
  }
}

/** The model's answer didn't match the typed output; nothing was returned. */
export class ShapeMismatch extends Schema.TaggedError<ShapeMismatch>()("ModelsShapeMismatch", {
  usage: Usage
}) {
  readonly code = "shape_mismatch" as const;
  readonly status = 422;
  get details() {
    return { reason: "output" };
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
  get details() {
    return { maxOutputTokens: this.maxOutputTokens };
  }
  override get message() {
    return `The model reached maxOutputTokens (${this.maxOutputTokens}) before it finished. Raise it, or ask for less.`;
  }
}

/** The model declined to generate. */
export class Refused extends Schema.TaggedError<Refused>()("ModelsRefused", { usage: Usage }) {
  readonly code = "model_refused" as const;
  readonly status = 422;
  override get message() {
    return "The model declined to answer this request.";
  }
}

export type CallError =
  Timeout | RateLimited | Unavailable | InvalidRequest | ShapeMismatch | OutputTruncated | Refused;
