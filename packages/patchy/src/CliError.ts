/**
 * Every failure the CLI reports, and the one table that turns it into an exit
 * code. Each tag carries a `kind` naming who has to act — the caller (`local`),
 * the instance's policy (`rejected`), or the network and the operator
 * (`unreachable`) — and `exitCode` maps a kind to 1, 2 or 3. Nothing else
 * exits the process with a code of its own: interruption is 130 by Effect's
 * runtime, and a defect is 1. Decided as the CLI contract for agents
 * (docs/adr/ADR-0004).
 */
import * as Schema from "effect/Schema";

export type Kind = "local" | "rejected" | "unreachable";

/** The exit-code ladder, keyed by kind. */
export const exitCode = (kind: Kind): 1 | 2 | 3 =>
  kind === "local" ? 1 : kind === "rejected" ? 2 : 3;

const fields = {
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect())
};

/** Fixable without touching the network: arguments, files, local state, the HTML. */
export class LocalError extends Schema.TaggedError<LocalError>()("LocalError", fields) {
  readonly kind = "local";
}

/** The instance answered and said no: 4xx, with the sentence it used. */
export class RejectedError extends Schema.TaggedError<RejectedError>()("RejectedError", fields) {
  readonly kind = "rejected";
}

/** No usable answer from the instance: connect, timeout, 5xx, an unparseable body. */
export class UnreachableError extends Schema.TaggedError<UnreachableError>()("UnreachableError", {
  ...fields,
  instanceUrl: Schema.String
}) {
  readonly kind = "unreachable";
}

/** Exact-current tooling is required before starting a new publish or dev session. */
export class ReleaseMismatch extends Schema.TaggedError<ReleaseMismatch>()("ReleaseMismatch", {
  component: Schema.Literals(["pin", "cli", "runtime"]),
  loaded: Schema.String,
  current: Schema.String
}) {
  readonly kind = "local";
  readonly code = "release_mismatch";
  override get message() {
    const label =
      this.component === "cli" ? "CLI" : this.component === "pin" ? "Pinned" : "Runtime";
    return `${label} release ${this.loaded} does not match instance release ${this.current}. Run: patchy refresh`;
  }
}

/** Display the target without credentials, query parameters or fragments. */
const instanceLabel = (value: string): string => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "<invalid instance URL>";
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "<invalid instance URL>";
  }
};

/** A repo's stored instance cannot be overridden or replaced by a publish result. */
export class InstanceMismatch extends Schema.TaggedError<InstanceMismatch>()("InstanceMismatch", {
  stored: Schema.String,
  requested: Schema.String
}) {
  readonly kind = "local";
  readonly code = "instance_mismatch";
  static new(props: { readonly stored: string; readonly requested: string }) {
    return new InstanceMismatch({
      stored: instanceLabel(props.stored),
      requested: instanceLabel(props.requested)
    });
  }
  override get message() {
    return `patchy.json is bound to ${this.stored}, but this command targets ${this.requested}. Use the same instance; publishing does not change the repo's instance.`;
  }
}

export const CliError = Schema.Union([
  LocalError,
  RejectedError,
  UnreachableError,
  ReleaseMismatch,
  InstanceMismatch
]);
export type CliError = typeof CliError.Type;
export const isCliError = Schema.is(CliError);
