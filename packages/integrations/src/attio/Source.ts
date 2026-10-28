import {
  type AttioAttribute,
  type AttioExclusion,
  type AttioList,
  type AttioObject,
  AttioSnapshot,
  attioAttributeTypes
} from "@patchy/api";
import { ContractLimits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * Attio, read through a workspace's read-only access token. The hosting server makes every call,
 * only to `https://api.attio.com`, and never follows a redirect. Bodies are collected under a byte
 * bound before they are decoded, and each workspace's calls and discoveries pass one gate per
 * process, inside a gate for all of Attio.
 */

export const BASE_URL = "https://api.attio.com";

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
  /** The key's scopes as its latest check found them, every one a read. */
  scopes: Schema.Array(Scope),
  /**
   * A check found the key can write, and the connection was disconnected for it: the write
   * scopes, the admin whose Test, Refresh or Reconnect ran the check, and when. Named on the page
   * until Replace key or a Reconnect's check finds a read-only key.
   */
  writable: Schema.optionalKey(
    Schema.Struct({
      scopes: Schema.Array(Scope),
      by: Schema.String,
      at: Schema.String,
      during: Schema.Literals(["test", "refresh", "reconnect"])
    })
  )
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
    const most = this.value.toLocaleString("en-US");
    const at = this.at ?? "One object or list";
    const what = {
      "attio.discovery.requests": `reading it takes more than ${most} requests`,
      "attio.discovery.response": `one of Attio's answers about ${at} is larger than ${this.value / 1024 ** 2} MiB`,
      "attio.discovery.bytes": `its shape is larger than the ${this.value / 1024 ** 2} MiB Patchy keeps`,
      "attio.discovery.objects": `it has more than ${most} objects`,
      "attio.discovery.lists": `it has more than ${most} lists`,
      "attio.discovery.attributes": `${at} has more than ${most} attributes`,
      "attio.discovery.options": `an attribute on ${at} has more than ${most} options`
    }[this.limitId];
    return `This workspace is larger than Patchy reads: ${what}. Nothing was saved.`;
  }
}

/**
 * An answer larger than its caller's byte bound, or than what remains of a call's budget across
 * its requests. Collection stopped there; nothing was decoded.
 */
export class Overflow extends Schema.TaggedError<Overflow>()("AttioOverflow", {}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  override get message() {
    return "Attio's answer is larger than Patchy reads.";
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
/** What one request can fail with before its caller reads the answer. */
export type SendError = Unavailable | RateLimited | Overflow;

/**
 * An answer as Attio sent it, once its transport, redirect, rate and server failures are taken
 * out: a 2xx, or a 4xx other than 401 and 429 for the caller to name. `body` is the decoded JSON,
 * or undefined when it wasn't JSON (an edge's HTML page).
 */
export interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}
/** Bytes a request may collect: its own bound, and what's left of its call's budget. */
export interface Bytes {
  readonly max: number;
  readonly budget?: { remaining: number };
}

/** One gate per workspace in this process, inside one for all of Attio. */
export class Source extends Context.Service<
  Source,
  {
    /** The key check: `/v2/self`, failing closed. Takes no slot: it's one small request. */
    readonly check: (key: Redacted.Redacted<string>) => Effect.Effect<Self, CheckError>;
    /**
     * The key check, then the workspace's shape, holding one of the workspace's slots. Nothing
     * partial is returned, and a bound refuses the moment it's passed.
     */
    readonly inspect: (
      key: Redacted.Redacted<string>
    ) => Effect.Effect<{ readonly self: Self; readonly snapshot: AttioSnapshot }, InspectError>;
    /**
     * Runs `effect` holding one of the workspace's slots and one of Attio's. Waiting keeps a
     * one-second reserve before `deadline` (epoch milliseconds), then refuses `busy` with nothing
     * sent. The slots are released however `effect` ends, including interruption.
     */
    readonly withSlot: (
      workspaceId: string,
      deadline: number
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Busy, R>;
    /**
     * One request to `https://api.attio.com` with the key. Redirects are refused; the body is
     * collected under `bytes` before it's decoded. 401 fails `source_unavailable` naming Replace
     * key, 429 `source_rate_limited`, 5xx `source_unavailable`; any other answer is returned.
     */
    readonly send: (
      key: Redacted.Redacted<string>,
      request: HttpClientRequest.HttpClientRequest,
      bytes: Bytes
    ) => Effect.Effect<Answer, SendError>;
  }
>()("@patchy/integrations/attio/Source") {}

/** The reserve a queued call keeps before its deadline, so a slot freed later isn't worth taking. */
const SLOT_RESERVE_MS = 1_000;
const ATTRIBUTES_PAGE = 500;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const SelfBody = Schema.Struct({
  active: Schema.Boolean,
  token_level: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  workspace_id: Schema.optionalKey(Schema.String),
  workspace_name: Schema.optionalKey(Schema.String),
  workspace_slug: Schema.optionalKey(Schema.String)
});
const Slug = Schema.optionalKey(Schema.NullOr(Schema.String));
const ObjectsBody = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.Struct({ object_id: Schema.String }),
      api_slug: Slug,
      singular_noun: Schema.optionalKey(Schema.NullOr(Schema.String)),
      plural_noun: Schema.optionalKey(Schema.NullOr(Schema.String))
    })
  )
});
const ListsBody = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.Struct({ list_id: Schema.String }),
      api_slug: Slug,
      name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      parent_object: Schema.Array(Schema.String)
    })
  )
});
const AttributesBody = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.Struct({ attribute_id: Schema.String }),
      api_slug: Slug,
      title: Schema.String,
      type: Schema.String,
      is_multiselect: Schema.Boolean,
      is_archived: Schema.Boolean,
      config: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            record_reference: Schema.optionalKey(
              Schema.NullOr(
                Schema.Struct({
                  allowed_object_ids: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)))
                })
              )
            )
          })
        )
      )
    })
  )
});
const OptionsBody = Schema.Struct({
  data: Schema.Array(Schema.Struct({ title: Schema.String, is_archived: Schema.Boolean }))
});
const ErrorBody = Schema.Struct({ code: Schema.optionalKey(Schema.String) });
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSelf = Schema.decodeUnknownEffect(SelfBody);
const decodeObjects = Schema.decodeUnknownEffect(ObjectsBody);
const decodeLists = Schema.decodeUnknownEffect(ListsBody);
const decodeAttributes = Schema.decodeUnknownEffect(AttributesBody);
const decodeOptions = Schema.decodeUnknownEffect(OptionsBody);
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);
const checkSnapshot = Schema.decodeUnknownEffect(AttioSnapshot);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(AttioSnapshot));
const isAttributeType = Schema.is(Schema.Literals(attioAttributeTypes));

/**
 * Reads the whole body, refusing it once it passes its bound or its call's budget. The budget is
 * spent chunk by chunk as it arrives, so requests collecting at once share it rather than each
 * seeing all of it.
 */
const collect = (response: HttpClientResponse.HttpClientResponse, bytes: Bytes) =>
  Effect.gen(function* () {
    const declared = Number(response.headers["content-length"]);
    if (
      Number.isFinite(declared) &&
      declared > Math.min(bytes.max, bytes.budget?.remaining ?? Number.POSITIVE_INFINITY)
    )
      return yield* new Overflow({});
    const chunks = yield* response.stream.pipe(
      Stream.mapError(
        (cause) => new Unavailable({ stage: "response", cause: Redacted.make(cause) })
      ),
      Stream.runFoldEffect(
        () => ({ bytes: 0, chunks: [] as Uint8Array[] }),
        (state, chunk) => {
          if (state.bytes + chunk.byteLength > bytes.max) return Effect.fail(new Overflow({}));
          if (bytes.budget !== undefined) {
            if (chunk.byteLength > bytes.budget.remaining) return Effect.fail(new Overflow({}));
            bytes.budget.remaining -= chunk.byteLength;
          }
          state.bytes += chunk.byteLength;
          state.chunks.push(chunk);
          return Effect.succeed(state);
        }
      )
    );
    const body = new Uint8Array(chunks.bytes);
    let offset = 0;
    for (const chunk of chunks.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return decoder.decode(body);
  });

/** Attio's Retry-After is an HTTP date, often already past; at least a second either way. */
const retryAfter = (value: string | undefined, now: number): number => {
  const trimmed = value?.trim() ?? "";
  if (/^\d{1,6}$/.test(trimmed)) return Math.max(1, Number(trimmed));
  const at = DateTime.make(trimmed);
  return Option.isNone(at)
    ? 1
    : Math.max(1, Math.ceil((DateTime.toEpochMillis(at.value) - now) / 1_000));
};

/** The scope each discovery request reads with, so a 403 names it. */
const scopeOf = (kind: "objects" | "lists") =>
  kind === "objects" ? "object_configuration:read" : "list_configuration:read";

/** The key check's verdict on `/v2/self`'s answer, failing closed on anything unexpected. */
const verdict = (body: typeof SelfBody.Type): Effect.Effect<Self, CheckError> => {
  if (!body.active) return Effect.fail(new KeyUnknown({}));
  if (body.token_level !== "workspace") return Effect.fail(new NotWorkspaceKey({}));
  if (
    body.scope === undefined ||
    body.workspace_id === undefined ||
    body.workspace_id === "" ||
    body.workspace_name === undefined ||
    body.workspace_slug === undefined
  )
    return Effect.fail(new Unavailable({ stage: "response", upstreamStatus: 200 }));
  const scopes = [...new Set(body.scope.split(" ").filter((scope) => scope !== ""))].sort();
  const writes = scopes.filter((scope) => scope.endsWith(":read-write"));
  if (writes.length > 0) return Effect.fail(new WriteScopes({ scopes: writes }));
  const missing = requiredScopes.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) return Effect.fail(new MissingScopes({ scopes: missing }));
  return Effect.succeed({
    workspace: { id: body.workspace_id, name: body.workspace_name, slug: body.workspace_slug },
    scopes
  });
};

/** Discovery's bounds, read once per discovery; tests inject smaller ones. */
const discoveryBounds = Effect.all({
  deadline: ContractLimits.get("attio.discovery.deadline"),
  requests: ContractLimits.get("attio.discovery.requests"),
  concurrent: ContractLimits.get("attio.discovery.concurrent"),
  response: ContractLimits.get("attio.discovery.response"),
  bytes: ContractLimits.get("attio.discovery.bytes"),
  objects: ContractLimits.get("attio.discovery.objects"),
  lists: ContractLimits.get("attio.discovery.lists"),
  attributes: ContractLimits.get("attio.discovery.attributes"),
  options: ContractLimits.get("attio.discovery.options"),
  optionRequests: ContractLimits.get("attio.discovery.optionRequests"),
  optionDeadline: ContractLimits.get("attio.discovery.optionDeadline")
});
type Bounds = Effect.Success<typeof discoveryBounds>;

/** The workspace's objects and lists, kept or excluded, before their attributes are read. */
interface Container {
  readonly kind: "objects" | "lists";
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly parents: ReadonlyArray<{ readonly id: string; readonly slug: string }>;
}

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const perHost = yield* ContractLimits.get("attio.host.concurrent");
  const perWorkspace = yield* ContractLimits.get("attio.calls.concurrent");
  const host = Semaphore.makeUnsafe(perHost);
  const gates = new Map<string, Semaphore.Semaphore>();
  const gate = (workspaceId: string) => {
    let found = gates.get(workspaceId);
    if (found === undefined) {
      found = Semaphore.makeUnsafe(perWorkspace);
      gates.set(workspaceId, found);
    }
    return found;
  };

  const send = Effect.fn("Attio.send")(function* (
    key: Redacted.Redacted<string>,
    request: HttpClientRequest.HttpClientRequest,
    bytes: Bytes
  ) {
    const response = yield* client
      .execute(
        request.pipe(
          HttpClientRequest.prependUrl(BASE_URL),
          HttpClientRequest.bearerToken(Redacted.value(key)),
          HttpClientRequest.acceptJson
        )
      )
      .pipe(
        Effect.mapError(
          (cause) => new Unavailable({ stage: "request", cause: Redacted.make(cause) })
        ),
        // Never follow a redirect: fetch would otherwise leave api.attio.com with the key.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        // Trace context stays inside Patchy.
        Effect.provideService(Tracer.DisablePropagation, true)
      );
    if (response.status >= 300 && response.status < 400)
      return yield* new Unavailable({ stage: "redirect", upstreamStatus: response.status });
    if (response.status === 429)
      return yield* new RateLimited({
        retryAfterSeconds: retryAfter(
          response.headers["retry-after"],
          yield* Clock.currentTimeMillis
        )
      });
    if (response.status === 401 || response.status >= 500)
      return yield* new Unavailable({ stage: "status", upstreamStatus: response.status });
    const text = yield* collect(response, bytes);
    return {
      status: response.status,
      headers: response.headers,
      body: Option.getOrUndefined(decodeJson(text))
    } satisfies Answer;
  });

  const withSlot =
    (workspaceId: string, deadline: number) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Busy, R> => {
      const take = (semaphore: Semaphore.Semaphore, limitId: Busy["limitId"]) =>
        Effect.gen(function* () {
          if (yield* semaphore.takeIfAvailable(1)) return;
          const budget = deadline - SLOT_RESERVE_MS - (yield* Clock.currentTimeMillis);
          if (budget <= 0) return yield* new Busy({ limitId });
          const taken = yield* semaphore.take(1).pipe(Effect.timeoutOption(budget));
          if (Option.isNone(taken)) return yield* new Busy({ limitId });
        });
      const workspace = gate(workspaceId);
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* restore(take(workspace, "attio.calls.concurrent"));
          return yield* Effect.gen(function* () {
            yield* restore(take(host, "attio.host.concurrent"));
            return yield* restore(effect).pipe(Effect.ensuring(host.release(1)));
          }).pipe(Effect.ensuring(workspace.release(1)));
        })
      );
    };

  /** The key check's request; its refusals name what to change. */
  const self = Effect.fn("Attio.self")(function* (key: Redacted.Redacted<string>) {
    const answer = yield* send(key, HttpClientRequest.get("/v2/self"), {
      max: registry["attio.discovery.response"].default
    }).pipe(
      Effect.catchTags({
        AttioOverflow: () =>
          Effect.fail(new Unavailable({ stage: "response", upstreamStatus: 200 })),
        // `/v2/self` answers an unknown key 200 `{ active: false }`; a 401 is the same verdict.
        AttioUnavailable: (error) =>
          error.upstreamStatus === 401 ? Effect.fail(new KeyUnknown({})) : Effect.fail(error)
      })
    );
    if (answer.status === 400) {
      const code = Option.getOrUndefined(decodeErrorBody(answer.body))?.code;
      if (code === "missing_value") return yield* new NotAToken({});
    }
    if (answer.status !== 200 || answer.body === undefined)
      return yield* new Unavailable({ stage: "status", upstreamStatus: answer.status });
    const body = yield* decodeSelf(answer.body).pipe(
      Effect.mapError(
        (cause) =>
          new Unavailable({ stage: "response", upstreamStatus: 200, cause: Redacted.make(cause) })
      )
    );
    return yield* verdict(body);
  });

  const check = Effect.fn("Attio.check")(
    (key: Redacted.Redacted<string>) => self(key),
    Effect.timeoutOrElse({
      duration: registry["integration.deadline"].default,
      orElse: () =>
        Effect.fail(new Timeout({ milliseconds: registry["integration.deadline"].default }))
    })
  );

  /**
   * Reads every object, list and attribute, then options while it has budget. One request at a
   * time per fiber, at most eight fibers; every bound refuses the moment it's passed.
   */
  const discover = Effect.fn("Attio.discover")(function* (
    key: Redacted.Redacted<string>,
    self: Self,
    started: number,
    bounds: Bounds
  ) {
    let sent = 1; // The key check's.
    let size = encoder.encode(
      encodeSnapshot({
        version: 1,
        workspace: self.workspace,
        scopes: self.scopes,
        objects: [],
        lists: [],
        excluded: []
      })
    ).byteLength;
    /**
     * Adds what `value` encodes to toward the snapshot's bytes: an element, or with `property`, an
     * object's properties joining an attribute (its braces dropped, a comma added). It leaves out
     * the commas between elements, so it never counts more than the snapshot holds; the exact size
     * is checked once more at the end.
     */
    const grow = (value: unknown, at?: string, property = false) =>
      Effect.suspend(() => {
        size += encoder.encode(toJson(value)).byteLength - (property ? 1 : 0);
        return size > bounds.bytes
          ? Effect.fail(
              new DiscoveryTooLarge({
                limitId: "attio.discovery.bytes",
                ...(at === undefined ? {} : { at })
              })
            )
          : Effect.void;
      });
    /** One discovery request; `scope` names what a 403 lacks. */
    const read = <A>(
      path: string,
      decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>,
      scope: string,
      at?: string
    ): Effect.Effect<A, InspectError> =>
      Effect.gen(function* () {
        sent += 1;
        if (sent > bounds.requests)
          return yield* new DiscoveryTooLarge({ limitId: "attio.discovery.requests" });
        const answer = yield* send(key, HttpClientRequest.get(path), {
          max: bounds.response
        }).pipe(
          Effect.catchTags({
            AttioOverflow: () =>
              Effect.fail(
                new DiscoveryTooLarge({
                  limitId: "attio.discovery.response",
                  ...(at === undefined ? {} : { at })
                })
              )
          })
        );
        if (answer.status === 403) return yield* new AccessDenied({ scope });
        if (answer.status !== 200 || answer.body === undefined)
          return yield* new Unavailable({ stage: "status", upstreamStatus: answer.status });
        return yield* decode(answer.body).pipe(
          Effect.mapError(
            (cause) =>
              new Unavailable({
                stage: "response",
                upstreamStatus: 200,
                cause: Redacted.make(cause)
              })
          )
        );
      });

    const excluded: AttioExclusion[] = [];
    const [objectsBody, listsBody] = yield* Effect.all(
      [
        read("/v2/objects", decodeObjects, "object_configuration:read"),
        read("/v2/lists", decodeLists, "list_configuration:read")
      ],
      { concurrency: 2 }
    );
    const objects: Container[] = [];
    for (const object of objectsBody.data) {
      const name = object.plural_noun ?? object.singular_noun ?? object.id.object_id;
      if (object.api_slug === undefined || object.api_slug === null || object.api_slug === "")
        excluded.push({ kind: "object", name, reason: "no_slug" });
      else
        objects.push({
          kind: "objects",
          id: object.id.object_id,
          slug: object.api_slug,
          name,
          parents: []
        });
    }
    if (objects.length > bounds.objects)
      return yield* new DiscoveryTooLarge({ limitId: "attio.discovery.objects" });
    // Attio names a list's parents by slug, and legacy ones by id: either finds the object.
    const objectOf = (ref: string) => objects.find((item) => item.slug === ref || item.id === ref);
    const lists: Container[] = [];
    for (const list of listsBody.data) {
      const name = list.name ?? list.id.list_id;
      if (list.api_slug === undefined || list.api_slug === null || list.api_slug === "") {
        excluded.push({ kind: "list", name, reason: "no_slug" });
        continue;
      }
      const parents = list.parent_object.flatMap((ref) => {
        const found = objectOf(ref);
        return found === undefined ? [] : [{ id: found.id, slug: found.slug }];
      });
      if (parents.length === 0)
        excluded.push({ kind: "list", name: list.api_slug, reason: "no_parent" });
      else lists.push({ kind: "lists", id: list.id.list_id, slug: list.api_slug, name, parents });
    }
    if (lists.length > bounds.lists)
      return yield* new DiscoveryTooLarge({ limitId: "attio.discovery.lists" });
    // Every kept object and list, and what's left out already, counts toward the snapshot's bytes.
    for (const container of [...objects, ...lists])
      yield* grow(
        {
          id: container.id,
          slug: container.slug,
          name: container.name,
          ...(container.kind === "lists" ? { parents: container.parents } : {}),
          attributes: []
        },
        container.slug
      );
    for (const item of excluded) yield* grow(item);

    /** A container's attributes, archived ones named among the exclusions. */
    const attributesOf = (container: Container) =>
      Effect.gen(function* () {
        const kept: AttioAttribute[] = [];
        const left: AttioExclusion[] = [];
        for (let offset = 0; ; offset += ATTRIBUTES_PAGE) {
          const page = yield* read(
            `/v2/${container.kind}/${container.id}/attributes?show_archived=true&limit=${ATTRIBUTES_PAGE}&offset=${offset}`,
            decodeAttributes,
            scopeOf(container.kind),
            container.slug
          );
          for (const attribute of page.data) {
            const slug = attribute.api_slug ?? "";
            const leave = (reason: AttioExclusion["reason"]) => {
              const item: AttioExclusion = {
                kind: "attribute",
                in: {
                  kind: container.kind === "objects" ? "object" : "list",
                  slug: container.slug
                },
                name: slug === "" ? attribute.title : slug,
                reason
              };
              left.push(item);
              return grow(item, container.slug);
            };
            if (attribute.is_archived) yield* leave("archived");
            else if (slug === "") yield* leave("no_slug");
            else if (!isAttributeType(attribute.type)) yield* leave("unsupported_type");
            else {
              const targets =
                attribute.type === "record-reference"
                  ? (attribute.config?.record_reference?.allowed_object_ids ?? []).flatMap((id) => {
                      const found = objectOf(id);
                      return found === undefined ? [] : [{ id: found.id, slug: found.slug }];
                    })
                  : undefined;
              const item: AttioAttribute = {
                id: attribute.id.attribute_id,
                slug,
                title: attribute.title,
                type: attribute.type,
                multiselect: attribute.is_multiselect,
                ...(targets === undefined ? {} : { targets })
              };
              kept.push(item);
              if (kept.length > bounds.attributes)
                return yield* new DiscoveryTooLarge({
                  limitId: "attio.discovery.attributes",
                  at: container.slug
                });
              yield* grow(item, container.slug);
            }
          }
          if (page.data.length < ATTRIBUTES_PAGE) break;
        }
        return { container, kept, left };
      });
    const read1 = yield* Effect.forEach([...objects, ...lists], attributesOf, {
      concurrency: bounds.concurrent
    });

    // Options last, while there's budget: a skipped attribute is marked, never dropped.
    const choices = read1.flatMap(({ container, kept }) =>
      kept.flatMap((attribute, index) =>
        attribute.type === "select" || attribute.type === "status"
          ? [{ container, kept, index, attribute }]
          : []
      )
    );
    yield* Effect.forEach(
      choices,
      ({ container, kept, index, attribute }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (now - started >= bounds.optionDeadline || sent >= bounds.optionRequests) {
            kept[index] = { ...attribute, optionsSkipped: true };
            return yield* grow({ optionsSkipped: true }, container.slug, true);
          }
          const body = yield* read(
            `/v2/${container.kind}/${container.id}/attributes/${attribute.id}/${attribute.type === "select" ? "options" : "statuses"}`,
            decodeOptions,
            scopeOf(container.kind),
            container.slug
          );
          const options = body.data.filter((option) => !option.is_archived).map((o) => o.title);
          if (options.length > bounds.options)
            return yield* new DiscoveryTooLarge({
              limitId: "attio.discovery.options",
              at: container.slug
            });
          kept[index] = { ...attribute, options };
          yield* grow({ options }, container.slug, true);
        }),
      { concurrency: bounds.concurrent, discard: true }
    );

    const shaped = (container: Container, kept: ReadonlyArray<AttioAttribute>) => ({
      id: container.id,
      slug: container.slug,
      name: container.name,
      attributes: kept
    });
    const snapshot = {
      version: 1 as const,
      workspace: self.workspace,
      scopes: self.scopes,
      objects: read1
        .filter(({ container }) => container.kind === "objects")
        .map(({ container, kept }): AttioObject => shaped(container, kept)),
      lists: read1
        .filter(({ container }) => container.kind === "lists")
        .map(({ container, kept }): AttioList => ({
          ...shaped(container, kept),
          parents: container.parents
        })),
      excluded: [...excluded, ...read1.flatMap(({ left }) => left)]
    } satisfies AttioSnapshot;
    // What Attio named must fit the snapshot's own bounds, and the whole of it, the byte bound.
    const checked = yield* checkSnapshot(snapshot).pipe(
      Effect.mapError(
        (cause) =>
          new Unavailable({ stage: "response", upstreamStatus: 200, cause: Redacted.make(cause) })
      )
    );
    if (encoder.encode(encodeSnapshot(checked)).byteLength > bounds.bytes)
      return yield* new DiscoveryTooLarge({ limitId: "attio.discovery.bytes" });
    return checked;
  });

  const inspect = Effect.fn("Attio.inspect")(function* (key: Redacted.Redacted<string>) {
    const bounds = yield* discoveryBounds;
    const started = yield* Clock.currentTimeMillis;
    return yield* Effect.gen(function* () {
      const found = yield* self(key);
      const snapshot = yield* withSlot(
        found.workspace.id,
        started + bounds.deadline
      )(discover(key, found, started, bounds));
      return { self: found, snapshot };
    }).pipe(
      Effect.timeoutOrElse({
        duration: bounds.deadline,
        orElse: () => Effect.fail(new Timeout({ milliseconds: bounds.deadline }))
      })
    );
  });

  return Source.of({ check, inspect, withSlot, send });
});

export const layer = Layer.effect(Source, make).pipe(Layer.provide(FetchHttpClient.layer));

/** A pasted key's last characters, safe to show. */
export const keyHint = (key: Redacted.Redacted<string>) => `…${Redacted.value(key).slice(-4)}`;

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
