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
import {
  HasDependants,
  NotOwner,
  PatchDeleted,
  PatchState,
  SourcesOff,
  WrongState
} from "@patchy/api";

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

/** Structured details at the CLI output boundary, including installed CLI failures. */
export const refusalFields = {
  owner: Schema.optionalKey(NotOwner.fields.owner),
  dependants: Schema.optionalKey(HasDependants.fields.dependants),
  sources: Schema.optionalKey(SourcesOff.fields.sources),
  state: Schema.optionalKey(PatchState),
  purgeAt: Schema.optionalKey(PatchDeleted.fields.purgeAt)
};

/** Generic refusals unrelated to patch ownership or lifecycle. */
export class RejectedError extends Schema.TaggedError<RejectedError>()("RejectedError", fields) {
  readonly kind = "rejected";
}

export class NotOwnerError extends Schema.TaggedError<NotOwnerError>()("NotOwnerError", {
  owner: NotOwner.fields.owner,
  cause: Schema.Defect()
}) {
  readonly kind = "rejected";
  override get message() {
    return `This patch belongs to ${this.owner.name}. Ask them, or an admin, to reassign it.`;
  }
}

export class PatchRetiredError extends Schema.TaggedError<PatchRetiredError>()(
  "PatchRetiredError",
  {
    cause: Schema.Defect()
  }
) {
  readonly kind = "rejected";
  override get message() {
    return "This patch is retired. Restore it (patchy restore) or ask an admin.";
  }
}

export class PatchDeletedError extends Schema.TaggedError<PatchDeletedError>()(
  "PatchDeletedError",
  {
    purgeAt: PatchDeleted.fields.purgeAt,
    cause: Schema.Defect()
  }
) {
  readonly kind = "rejected";
  override get message() {
    return `This patch is deleted. Reclaim date: ${this.purgeAt}. Restore it before that date (patchy restore) or ask an admin.`;
  }
}

export class HasDependantsError extends Schema.TaggedError<HasDependantsError>()(
  "HasDependantsError",
  {
    dependants: HasDependants.fields.dependants,
    cause: Schema.Defect()
  }
) {
  readonly kind = "rejected";
  override get message() {
    return `Other live patches read these tables.\n${this.dependants.map((patch) => `- ${patch.patchId} ${patch.name} (${patch.owner.name})`).join("\n")}\nAsk the person you are working for before forcing.`;
  }
}

export class SourcesOffError extends Schema.TaggedError<SourcesOffError>()("SourcesOffError", {
  sources: SourcesOff.fields.sources,
  cause: Schema.Defect()
}) {
  readonly kind = "rejected";
  override get message() {
    return `This patch reads sources that are off.\n${this.sources.map((source) => `- ${source.patchId}${source.name === undefined ? "" : ` ${source.name}`} / ${source.table}: ${source.state}`).join("\n")}\nAsk the person you are working for before forcing.`;
  }
}

export class WrongStateError extends Schema.TaggedError<WrongStateError>()("WrongStateError", {
  state: WrongState.fields.state,
  cause: Schema.Defect()
}) {
  readonly kind = "rejected";
  override get message() {
    return `This patch is ${this.state}; this action is not available in that state.`;
  }
}

/** Discovery resolved a patch outside the requested lifecycle filter. */
export class WrongPatchState extends Schema.TaggedError<WrongPatchState>()("WrongPatchState", {
  state: PatchState,
  cause: Schema.Defect()
}) {
  readonly kind = "rejected";
  override get message() {
    return `Patch is ${this.state}; pass --state ${this.state === "deleted" ? "all" : this.state}.`;
  }
}

export const Rejected = Schema.Union([
  RejectedError,
  NotOwnerError,
  PatchRetiredError,
  PatchDeletedError,
  HasDependantsError,
  SourcesOffError,
  WrongStateError,
  WrongPatchState
]);
export type Rejected = typeof Rejected.Type;

/** Wire codes belong to output, not to the tagged domain errors. */
export const refusalDetails = (error: Rejected) => {
  switch (error._tag) {
    case "RejectedError":
      return error.code === undefined ? {} : { code: error.code };
    case "NotOwnerError":
      return { code: "not_owner", owner: error.owner };
    case "PatchRetiredError":
      return { code: "patch_retired" };
    case "PatchDeletedError":
      return { code: "patch_deleted", purgeAt: error.purgeAt };
    case "HasDependantsError":
      return { code: "has_dependants", dependants: error.dependants };
    case "SourcesOffError":
      return { code: "sources_off", sources: error.sources };
    case "WrongStateError":
    case "WrongPatchState":
      return { code: "wrong_state", state: error.state };
  }
};

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
  Rejected,
  UnreachableError,
  ReleaseMismatch,
  InstanceMismatch
]);
export type CliError = typeof CliError.Type;
export const isCliError = Schema.is(CliError);
