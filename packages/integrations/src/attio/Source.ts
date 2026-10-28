import type { AttioSnapshot } from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * Attio, read through a workspace's read-only access token. The hosting server makes every call,
 * only to `https://api.attio.com`, and never follows a redirect. Bodies are collected under a byte
 * bound before they are decoded, and each workspace's calls and discoveries pass one gate per
 * process, inside a gate for all of Attio.
 */

const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });
const Scope = Schema.String.check(Schema.isMaxLength(128));

/** The scopes a key must read with: records, objects, list entries, lists and members. */
export const requiredScopes = [
  "record_permission:read",
  "object_configuration:read",
  "list_entry:read",
  "list_configuration:read",
  "user_management:read"
] as const;

/** Attio's names for its scopes, as an admin sees them when making a token. */
const scopeNames: Readonly<Record<string, string>> = {
  record_permission: "Records",
  object_configuration: "Object configuration",
  list_entry: "List entries",
  list_configuration: "List configuration",
  user_management: "User management",
  public_collection: "Public collections",
  private_collection: "Private collections",
  comment: "Comments",
  task: "Tasks",
  note: "Notes",
  meeting: "Meetings",
  call_recording: "Call recordings",
  webhook: "Webhooks",
  file: "Files",
  email: "Emails",
  activity_configuration: "Activity configuration",
  activity_record: "Activity records",
  sequence_unsubscribe: "Sequence unsubscribes"
};
/** A scope as Attio's token page names it, such as `Notes` for `note:read-write`. */
export const scopeName = (scope: string): string => scopeNames[scope.split(":")[0] ?? ""] ?? scope;
const named = (scopes: ReadonlyArray<string>) => {
  const names = scopes.map(scopeName);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

/** A token as pasted: visible ASCII, no spaces. Attio itself says whether it's one of its own. */
export const Key = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,512}$/));

/** What the ciphertext holds: the key and the workspace its check found, which binds it. */
export const Credentials = Schema.Struct({ key: Key, workspaceId: Schema.String });
export type Credentials = typeof Credentials.Type;

/** Safe to show: the workspace the key reads and the key's last characters. */
export const Display = Schema.Struct({
  workspace: Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.String }),
  keyHint: Schema.String,
  /**
   * The write scopes a check found, when it disconnected the connection for them: the page names
   * them until a Reconnect's check finds none.
   */
  writeScopes: Schema.optionalKey(Schema.Array(Scope))
});
export type Display = typeof Display.Type;

/** What the key check found: the workspace the key reads and its scopes, all of them reads. */
export interface Self {
  readonly workspace: Display["workspace"];
  readonly scopes: ReadonlyArray<string>;
}

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "AttioInvalidCredentials",
  { cause: Schema.optionalKey(SecretCause) }
) {
  readonly code = "invalid_credentials";
  readonly status = 422;
  override get message() {
    return "Paste an Attio access token, from Workspace settings › Developers.";
  }
}
/** `/v2/self` answered `{ active: false }`: a deleted, revoked or unknown key. */
export class KeyUnknown extends Schema.TaggedError<KeyUnknown>()("AttioKeyUnknown", {}) {
  readonly code = "attio_key_unknown";
  readonly status = 422;
  override get message() {
    return "Attio doesn't know this key. It may have been deleted: make a new one under Workspace settings › Developers.";
  }
}
/** `/v2/self` answered 400 `missing_value`: not a token at all. */
export class NotAToken extends Schema.TaggedError<NotAToken>()("AttioNotAToken", {}) {
  readonly code = "attio_not_a_token";
  readonly status = 422;
  override get message() {
    return "That isn't an Attio access token. Copy the token Attio shows once, when you make it under Workspace settings › Developers.";
  }
}
export class NotWorkspaceKey extends Schema.TaggedError<NotWorkspaceKey>()(
  "AttioNotWorkspaceKey",
  {}
) {
  readonly code = "attio_not_workspace_key";
  readonly status = 422;
  override get message() {
    return "This token belongs to an app or a person, not the workspace. Make an access token under Workspace settings › Developers.";
  }
}
export class MissingScopes extends Schema.TaggedError<MissingScopes>()("AttioMissingScopes", {
  scopes: Schema.Array(Scope)
}) {
  readonly code = "attio_missing_scopes";
  readonly status = 422;
  override get message() {
    return `This key can't read everything Patchy needs. In Attio, set ${named(this.scopes)} to Read, then try again.`;
  }
}
/** The key can change something in Attio. Patchy never keeps a key it knows can write. */
export class WriteScopes extends Schema.TaggedError<WriteScopes>()("AttioWriteScopes", {
  scopes: Schema.Array(Scope)
}) {
  readonly code = "attio_write_scopes";
  readonly status = 422;
  override get message() {
    return `This key can change your workspace: ${named(this.scopes)} ${this.scopes.length === 1 ? "is" : "are"} Read-write. In Attio, set every scope to Read or off, then try again.`;
  }
}
/** Replace key was given a key for another workspace; a connection keeps its workspace. */
export class OtherWorkspace extends Schema.TaggedError<OtherWorkspace>()("AttioOtherWorkspace", {
  expected: Schema.String,
  found: Schema.String
}) {
  readonly code = "attio_other_workspace";
  readonly status = 409;
  override get message() {
    return `This key reads the workspace ${this.found}, not ${this.expected}. A connection keeps its workspace: connect ${this.found} as a new connection instead.`;
  }
}
/** Attio refused a request for a scope the key lacks; named from Patchy's own table. */
export class AccessDenied extends Schema.TaggedError<AccessDenied>()("AttioAccessDenied", {
  scope: Scope
}) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return `Attio refused: the key needs Read on ${scopeName(this.scope)}.`;
  }
}
/** Attio refused for its rate or query complexity. Never retried. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("AttioRateLimited", {
  retryAfterSeconds: Schema.Int
}) {
  readonly code = "source_rate_limited" as const;
  readonly status = 429;
  override get message() {
    return `Attio is refusing requests for now: its rate limit was reached. Try again in ${this.retryAfterSeconds} seconds.`;
  }
}
export class Unavailable extends Schema.TaggedError<Unavailable>()("AttioUnavailable", {
  stage: Schema.Literals(["request", "redirect", "status", "response"]),
  upstreamStatus: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(SecretCause)
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return this.upstreamStatus === 401
      ? "Attio no longer accepts this connection's key. Replace the key."
      : "Attio could not be reached or answered unexpectedly. Try again.";
  }
}
export class Timeout extends Schema.TaggedError<Timeout>()("AttioTimeout", {
  milliseconds: Schema.Int
}) {
  readonly code = "timeout" as const;
  readonly status = 504;
  override get message() {
    return `Attio did not answer within ${this.milliseconds / 1_000} seconds.`;
  }
}
/** Patchy's gates for the workspace, or for Attio, stayed full until the deadline; nothing was sent. */
export class Busy extends Schema.TaggedError<Busy>()("AttioBusy", {
  limitId: Schema.Literals(["attio.calls.concurrent", "attio.host.concurrent"])
}) {
  readonly code = "busy" as const;
  readonly status = 503;
  get scope() {
    return registry[this.limitId].scope;
  }
  get value() {
    return registry[this.limitId].default;
  }
  override get message() {
    return this.limitId === "attio.calls.concurrent"
      ? `This Attio workspace already has ${this.value} calls running from Patchy. Try again shortly.`
      : "Patchy is already reading Attio as much as it allows at once. Try again shortly.";
  }
}
export class DiscoveryTooLarge extends Schema.TaggedError<DiscoveryTooLarge>()(
  "AttioDiscoveryTooLarge",
  {
    limitId: Schema.Literals([
      "attio.discovery.requests",
      "attio.discovery.response",
      "attio.discovery.bytes",
      "attio.discovery.objects",
      "attio.discovery.lists",
      "attio.discovery.attributes",
      "attio.discovery.options"
    ]),
    /** The object or list it was reading, by slug, when one bound refused. */
    at: Schema.optionalKey(Schema.String)
  }
) {
  readonly code = "attio_discovery_too_large";
  readonly status = 422;
  get value() {
    return registry[this.limitId].default;
  }
  override get message() {
    const limit = registry[this.limitId];
    return `This workspace is larger than Patchy reads: ${limit.measure.toLowerCase()} is at most ${limit.default} ${limit.unit}${this.at === undefined ? "" : `, and ${this.at} has more`}. Nothing was saved.`;
  }
}

/** What the key check refuses. */
export type CheckError =
  | InvalidCredentials
  | KeyUnknown
  | NotAToken
  | NotWorkspaceKey
  | MissingScopes
  | WriteScopes
  | RateLimited
  | Unavailable
  | Timeout;
/** What connecting, Replace key and Refresh refuse: the check's refusals and discovery's. */
export type InspectError = CheckError | AccessDenied | Busy | DiscoveryTooLarge;

/** One gate per workspace in this process, inside one for all of Attio. */
export class Source extends Context.Service<
  Source,
  {
    /** The key check: `/v2/self`, failing closed. */
    readonly check: (key: Redacted.Redacted<string>) => Effect.Effect<Self, CheckError>;
    /** The key check, then the workspace's shape. Nothing partial is returned. */
    readonly inspect: (
      key: Redacted.Redacted<string>
    ) => Effect.Effect<{ readonly self: Self; readonly snapshot: AttioSnapshot }, InspectError>;
  }
>()("@patchy/integrations/attio/Source") {}

const credentialsJson = Schema.fromJsonString(Credentials);
const decodeCredentials = Schema.decodeUnknownEffect(credentialsJson, {
  onExcessProperty: "error"
});
const encodeCredentials = Schema.encodeSync(credentialsJson);

export const credentials = (value: Credentials): Redacted.Redacted<string> =>
  Redacted.make(encodeCredentials(value));

export const parseCredentials = Effect.fn("Attio.parseCredentials")(function* (
  secret: Redacted.Redacted<string>
) {
  return yield* decodeCredentials(Redacted.value(secret)).pipe(
    Effect.mapError((cause) => new InvalidCredentials({ cause: Redacted.make(cause) }))
  );
});
