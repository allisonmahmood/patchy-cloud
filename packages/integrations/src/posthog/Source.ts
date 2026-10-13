import { PostHogSnapshot, type PostHogValues } from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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
 * PostHog Cloud, read through a personal API key. The credentialed server makes every call, only
 * to the two Cloud hosts, and never follows a redirect. Bodies are collected under a byte cap
 * before they are decoded, and a project's queries pass one gate per process.
 */

const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "PostHogInvalidCredentials",
  { cause: Schema.optionalKey(SecretCause) }
) {
  readonly code = "invalid_credentials";
  readonly status = 422;
  override get message() {
    return "Choose US or EU Cloud, enter the project's numeric ID and paste a personal API key (phx_…).";
  }
}
export class KeyRejected extends Schema.TaggedError<KeyRejected>()("PostHogKeyRejected", {}) {
  readonly code = "posthog_key_rejected";
  readonly status = 422;
  override get message() {
    return "PostHog rejected this key. Paste a personal API key that hasn't been revoked.";
  }
}
export class AccessDenied extends Schema.TaggedError<AccessDenied>()("PostHogAccessDenied", {}) {
  readonly code = "posthog_access_denied";
  readonly status = 422;
  override get message() {
    return "This key can't read that project. Limit it to the project, with Read on Query, Event definitions and Property definitions.";
  }
}
export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()(
  "PostHogProjectNotFound",
  {}
) {
  readonly code = "posthog_project_not_found";
  readonly status = 422;
  override get message() {
    return "PostHog has no project with this ID in that region for this key.";
  }
}
/** PostHog refused for its rate, query budget or concurrency limit. Never replayed. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("PostHogRateLimited", {
  /** PostHog's `code` when it sent one, such as `api_queries_budget_exceeded`; diagnostics only. */
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
  /** Present only when PostHog sent Retry-After. */
  retryAfterSeconds: Schema.optionalKey(Schema.Int)
}) {
  readonly code = "source_rate_limited" as const;
  readonly status = 429;
  override get message() {
    return `PostHog is refusing queries for now: its rate, query budget or concurrency limit was reached.${this.retryAfterSeconds === undefined ? "" : ` Try again in ${this.retryAfterSeconds} seconds.`}`;
  }
}
export class Unavailable extends Schema.TaggedError<Unavailable>()("PostHogUnavailable", {
  stage: Schema.Literals(["request", "redirect", "status", "response", "pagination"]),
  upstreamStatus: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(SecretCause)
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "PostHog could not be reached or answered unexpectedly. Try again.";
  }
}
export class Timeout extends Schema.TaggedError<Timeout>()("PostHogTimeout", {
  milliseconds: Schema.Int
}) {
  readonly code = "timeout" as const;
  readonly status = 504;
  override get message() {
    return `PostHog did not answer within ${this.milliseconds / 1_000} seconds.`;
  }
}
export class InvalidQuery extends Schema.TaggedError<InvalidQuery>()("PostHogInvalidQuery", {
  /** PostHog's own explanation, bounded; it describes the patch's query, never credentials. */
  details: Schema.Struct({ message: Schema.String })
}) {
  readonly code = "invalid_query" as const;
  readonly status = 400;
  override get message() {
    return "PostHog rejected the query.";
  }
}
export class TooLarge extends Schema.TaggedError<TooLarge>()("PostHogTooLarge", {
  maxBytes: Schema.Int
}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  readonly limitId = "runtime.result.bytes" as const;
  override get message() {
    return `PostHog's answer is larger than ${this.maxBytes} bytes.`;
  }
  get details() {
    return { maxBytes: this.maxBytes };
  }
}
/** Patchy's own gate for the project stayed full until the call's deadline; nothing was sent. */
export class Busy extends Schema.TaggedError<Busy>()("PostHogBusy", {}) {
  readonly code = "busy" as const;
  readonly status = 503;
  readonly limitId = "posthog.queries.concurrent" as const;
  readonly scope = registry["posthog.queries.concurrent"].scope;
  readonly value = registry["posthog.queries.concurrent"].default;
  override get message() {
    return `This PostHog project already has ${this.value} queries running from Patchy. Try again shortly.`;
  }
}
export class DiscoveryTooLarge extends Schema.TaggedError<DiscoveryTooLarge>()(
  "PostHogDiscoveryTooLarge",
  {
    limitId: Schema.Literals([
      "posthog.discovery.pages",
      "posthog.discovery.entries",
      "posthog.discovery.bytes"
    ])
  }
) {
  readonly code = "posthog_discovery_too_large";
  readonly status = 422;
  get value() {
    return registry[this.limitId].default;
  }
  override get message() {
    const limit = registry[this.limitId];
    return `This project has more definitions than Patchy keeps (at most ${limit.default} ${limit.unit}). Nothing was saved.`;
  }
}

/** What reading a project's events can refuse, as connect, test and refresh show it. */
export type SourceError =
  | InvalidCredentials
  | KeyRejected
  | AccessDenied
  | ProjectNotFound
  | RateLimited
  | Unavailable
  | Timeout
  | InvalidQuery
  | TooLarge
  | Busy
  | DiscoveryTooLarge;
/** What one query can refuse once it has a slot. */
export type QueryError = Exclude<SourceError, InvalidCredentials | Busy | DiscoveryTooLarge>;

export const Region = Schema.Literals(["us", "eu"]);
export type Region = typeof Region.Type;
export const hosts: { readonly [R in Region]: string } = {
  us: "https://us.posthog.com",
  eu: "https://eu.posthog.com"
};
export const regionLabels: { readonly [R in Region]: string } = { us: "US", eu: "EU" };

const ProjectId = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(2 ** 53));
/** What the ciphertext holds: everything a call needs. */
export const Credentials = Schema.Struct({
  region: Region,
  projectId: ProjectId,
  apiKey: Schema.String.check(Schema.isPattern(/^phx_[A-Za-z0-9_-]{8,256}$/))
});
export type Credentials = typeof Credentials.Type;
/** Safe to show: where the connection reads, and the key's last characters. */
export const Display = Schema.Struct({
  region: Region,
  projectId: ProjectId,
  keyHint: Schema.String
});
export type Display = typeof Display.Type;

const credentialsJson = Schema.fromJsonString(Credentials);
const decodeCredentials = Schema.decodeUnknownEffect(credentialsJson, {
  onExcessProperty: "error"
});
const encodeCredentials = Schema.encodeSync(credentialsJson);

/** The connect and change-project forms keep the three fields as one secret. */
export const credentials = (value: Credentials): Redacted.Redacted<string> =>
  Redacted.make(encodeCredentials(value));

export const parseCredentials = Effect.fn("PostHog.parseCredentials")(function* (
  secret: Redacted.Redacted<string>
) {
  return yield* decodeCredentials(Redacted.value(secret)).pipe(
    Effect.mapError((cause) => new InvalidCredentials({ cause: Redacted.make(cause) }))
  );
});

export const display = (credentials: Credentials): Display => ({
  region: credentials.region,
  projectId: credentials.projectId,
  keyHint: `phx_…${credentials.apiKey.slice(-4)}`
});

/** A HogQL query as PostHog receives it. */
export interface QueryRequest {
  readonly name: string;
  readonly query: string;
  readonly values?: typeof PostHogValues.Type;
}
/** PostHog's answer, before Patchy maps it through a shape. */
export interface QueryResponse {
  readonly columns: ReadonlyArray<string>;
  readonly types: ReadonlyArray<readonly [string, string]>;
  readonly results: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly hasMore: boolean;
}

/** One gate per region and project in this process, shared by its connections and callers. */
export class Source extends Context.Service<
  Source,
  {
    /** Proves the key can query the project; returns what the pages show. */
    readonly test: (secret: Redacted.Redacted<string>) => Effect.Effect<Display, SourceError>;
    /** Tests, then reads every event and property definition. Nothing partial is returned. */
    readonly inspect: (
      secret: Redacted.Redacted<string>
    ) => Effect.Effect<
      { readonly display: Display; readonly snapshot: PostHogSnapshot },
      SourceError
    >;
    /**
     * Runs `effect` holding one of the project's slots. Waiting keeps a one-second reserve before
     * `deadline` (epoch milliseconds), then refuses `busy` with nothing sent. The slot is released
     * however `effect` ends, including interruption.
     */
    readonly withSlot: (
      credentials: Credentials,
      deadline: number
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Busy, R>;
    /** Sends one query; callers hold a slot. The request is bounded by the caller's deadline. */
    readonly query: (
      credentials: Credentials,
      request: QueryRequest
    ) => Effect.Effect<QueryResponse, QueryError>;
  }
>()("@patchy/integrations/posthog/Source") {}

const ADMIN_DEADLINE_MS = registry["integration.deadline"].default;
/** The reserve a queued call keeps before its deadline, so a slot freed later isn't worth taking. */
const SLOT_RESERVE_MS = 1_000;
const MAX_BYTES = registry["runtime.result.bytes"].default;
const MAX_ERROR_MESSAGE = 1_000;
const DEFINITIONS_PAGE_SIZE = 500;

const QueryBody = Schema.Struct({
  columns: Schema.Array(Schema.String),
  types: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  results: Schema.Array(Schema.Array(Schema.Unknown)),
  hasMore: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  error: Schema.optionalKey(Schema.NullOr(Schema.String))
});
const ErrorBody = Schema.Struct({
  type: Schema.optionalKey(Schema.NullOr(Schema.String)),
  code: Schema.optionalKey(Schema.NullOr(Schema.String)),
  detail: Schema.optionalKey(Schema.NullOr(Schema.String))
});
const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  property_type: Schema.optionalKey(Schema.NullOr(Schema.String))
});
const DefinitionsPage = Schema.Struct({
  next: Schema.optionalKey(Schema.NullOr(Schema.String)),
  results: Schema.Array(Definition)
});
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeQueryBody = Schema.decodeUnknownEffect(QueryBody);
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));
const decodeDefinitionsPage = Schema.decodeUnknownEffect(DefinitionsPage);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(PostHogSnapshot));
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Reads the whole body, refusing it once it passes `maxBytes`. */
const collect = (response: HttpClientResponse.HttpClientResponse, maxBytes: number) =>
  Effect.gen(function* () {
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) return yield* new TooLarge({ maxBytes });
    const chunks = yield* response.stream.pipe(
      Stream.mapError(
        (cause) => new Unavailable({ stage: "response", cause: Redacted.make(cause) })
      ),
      Stream.runFoldEffect(
        () => ({ bytes: 0, chunks: [] as Uint8Array[] }),
        (state, chunk) => {
          if (state.bytes + chunk.byteLength > maxBytes)
            return Effect.fail(new TooLarge({ maxBytes }));
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

const retryAfter = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim());
};

/** A refusal as PostHog sends it, mapped by status; the body was read under the cap first. */
const refusal = (
  status: number,
  headers: Readonly<Record<string, string>>,
  text: string
): QueryError => {
  const body = Option.getOrUndefined(decodeErrorBody(text));
  const detail = body?.detail ?? undefined;
  const code = body?.code ?? null;
  if (status === 400)
    return new InvalidQuery({
      details: { message: (detail ?? "The query is not valid HogQL.").slice(0, MAX_ERROR_MESSAGE) }
    });
  if (status === 401) return new KeyRejected({});
  if (status === 403) return new AccessDenied({});
  if (status === 404) return new ProjectNotFound({});
  if (status === 429) {
    const seconds = retryAfter(headers["retry-after"]);
    return new RateLimited({
      reason: code === null ? null : code.slice(0, 64),
      ...(seconds === undefined ? {} : { retryAfterSeconds: seconds })
    });
  }
  return new Unavailable({ stage: "status", upstreamStatus: status });
};

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const gates = new Map<string, Semaphore.Semaphore>();
  const gate = (credentials: Credentials) => {
    const key = `${credentials.region}:${credentials.projectId}`;
    let found = gates.get(key);
    if (found === undefined) {
      found = Semaphore.makeUnsafe(registry["posthog.queries.concurrent"].default);
      gates.set(key, found);
    }
    return found;
  };

  /** One call to the project's host; any redirect is refused rather than followed. */
  const send = Effect.fn("PostHog.send")(function* (
    credentials: Credentials,
    request: HttpClientRequest.HttpClientRequest
  ) {
    const response = yield* client
      .execute(
        request.pipe(
          HttpClientRequest.bearerToken(credentials.apiKey),
          HttpClientRequest.acceptJson
        )
      )
      .pipe(
        Effect.mapError(
          (cause) => new Unavailable({ stage: "request", cause: Redacted.make(cause) })
        ),
        // Never follow a redirect: fetch would otherwise leave the Cloud host with the key.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        // Trace context stays inside Patchy.
        Effect.provideService(Tracer.DisablePropagation, true)
      );
    if (response.status >= 300 && response.status < 400)
      return yield* new Unavailable({ stage: "redirect", upstreamStatus: response.status });
    const text = yield* collect(response, MAX_BYTES);
    if (response.status < 200 || response.status >= 300)
      return yield* refusal(response.status, response.headers, text);
    return yield* decodeJson(text).pipe(
      Effect.mapError(
        (cause) => new Unavailable({ stage: "response", cause: Redacted.make(cause) })
      )
    );
  });

  const post = (credentials: Credentials, request: QueryRequest) =>
    send(
      credentials,
      HttpClientRequest.post(
        `${hosts[credentials.region]}/api/projects/${credentials.projectId}/query/`
      ).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          query: {
            kind: "HogQLQuery",
            query: request.query,
            ...(request.values === undefined ? {} : { values: request.values }),
            name: request.name
          }
        })
      )
    ).pipe(
      Effect.flatMap((body) =>
        decodeQueryBody(body).pipe(
          Effect.mapError(
            (cause) => new Unavailable({ stage: "response", cause: Redacted.make(cause) })
          )
        )
      ),
      Effect.flatMap((body) =>
        body.error === undefined || body.error === null
          ? Effect.succeed<QueryResponse>({
              columns: body.columns,
              types: body.types,
              results: body.results,
              hasMore: body.hasMore === true
            })
          : Effect.fail(new Unavailable({ stage: "response" }))
      )
    );

  const withSlot =
    (credentials: Credentials, deadline: number) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Busy, R> => {
      const semaphore = gate(credentials);
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!(yield* semaphore.takeIfAvailable(1))) {
            const budget = deadline - SLOT_RESERVE_MS - (yield* Clock.currentTimeMillis);
            if (budget <= 0) return yield* new Busy({});
            const taken = yield* restore(semaphore.take(1)).pipe(Effect.timeoutOption(budget));
            if (Option.isNone(taken)) return yield* new Busy({});
          }
          return yield* restore(effect).pipe(Effect.ensuring(semaphore.release(1)));
        })
      );
    };

  const query = Effect.fn("PostHog.query")((credentials: Credentials, request: QueryRequest) =>
    post(credentials, request)
  );
  const testQuery = Effect.fn("PostHog.testQuery")(function* (credentials: Credentials) {
    const now = yield* Clock.currentTimeMillis;
    yield* withSlot(
      credentials,
      now + ADMIN_DEADLINE_MS
    )(post(credentials, { name: "patchy-connection-test", query: "SELECT 1" }));
  });

  /** Every page of one definitions list, never leaving the project's own list. */
  const definitions = Effect.fn("PostHog.definitions")(function* (
    credentials: Credentials,
    path: "event_definitions" | "property_definitions",
    type: "event" | "person" | undefined,
    budget: { pages: number }
  ) {
    const first = new URL(
      `${hosts[credentials.region]}/api/projects/${credentials.projectId}/${path}/`
    );
    first.searchParams.set("limit", String(DEFINITIONS_PAGE_SIZE));
    if (type !== undefined) first.searchParams.set("type", type);
    const found: Array<typeof Definition.Type> = [];
    let next: URL | undefined = first;
    while (next !== undefined) {
      if (budget.pages <= 0)
        return yield* new DiscoveryTooLarge({ limitId: "posthog.discovery.pages" });
      budget.pages--;
      const body: unknown = yield* send(credentials, HttpClientRequest.get(next.href));
      const page: typeof DefinitionsPage.Type = yield* decodeDefinitionsPage(body).pipe(
        Effect.mapError(
          (cause) => new Unavailable({ stage: "response", cause: Redacted.make(cause) })
        )
      );
      found.push(...page.results);
      if (found.length > registry["posthog.discovery.entries"].default)
        return yield* new DiscoveryTooLarge({ limitId: "posthog.discovery.entries" });
      // An empty page with a next link is followed too: only the page bound ends a list early.
      if (page.next === undefined || page.next === null) {
        next = undefined;
        continue;
      }
      const following: URL | undefined = URL.canParse(page.next) ? new URL(page.next) : undefined;
      // Pagination stays on this host, this project's list and the same kind of property.
      if (
        following === undefined ||
        following.origin !== first.origin ||
        following.pathname !== first.pathname ||
        following.username !== "" ||
        following.password !== "" ||
        following.searchParams.get("type") !== first.searchParams.get("type")
      )
        return yield* new Unavailable({ stage: "pagination" });
      next = following;
    }
    return found;
  });

  /**
   * A missing description is left out. One past the bound is cut, as other text agents read is,
   * at a code-unit boundary that keeps surrogate pairs whole, and marked ` [truncated]`.
   */
  const description = (value: string | null | undefined) => {
    if (value === undefined || value === null || value.trim() === "") return {};
    const limit = registry["posthog.discovery.description"].default;
    if (value.length <= limit) return { description: value };
    const marker = " [truncated]";
    const last = value.charCodeAt(limit - marker.length - 1);
    const end = limit - marker.length - (last >= 0xd800 && last <= 0xdbff ? 1 : 0);
    return { description: `${value.slice(0, end)}${marker}` };
  };
  const byName = <A extends { readonly name: string }>(items: ReadonlyArray<A>) =>
    [...new Map(items.map((item) => [item.name, item])).values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );

  const test = Effect.fn("PostHog.test")(
    function* (secret: Redacted.Redacted<string>) {
      const credentials = yield* parseCredentials(secret);
      yield* testQuery(credentials);
      return display(credentials);
    },
    Effect.timeoutOrElse({
      duration: ADMIN_DEADLINE_MS,
      orElse: () => Effect.fail(new Timeout({ milliseconds: ADMIN_DEADLINE_MS }))
    })
  );

  const inspect = Effect.fn("PostHog.inspect")(
    function* (secret: Redacted.Redacted<string>) {
      const credentials = yield* parseCredentials(secret);
      yield* testQuery(credentials);
      const budget = { pages: registry["posthog.discovery.pages"].default };
      const events = yield* definitions(credentials, "event_definitions", undefined, budget);
      const eventProperties = yield* definitions(
        credentials,
        "property_definitions",
        "event",
        budget
      );
      const personProperties = yield* definitions(
        credentials,
        "property_definitions",
        "person",
        budget
      );
      if (
        events.length + eventProperties.length + personProperties.length >
        registry["posthog.discovery.entries"].default
      )
        return yield* new DiscoveryTooLarge({ limitId: "posthog.discovery.entries" });
      const property = (item: typeof Definition.Type) => ({
        name: item.name,
        type: item.property_type?.slice(0, 64) ?? null,
        ...description(item.description)
      });
      const snapshot: PostHogSnapshot = {
        version: 1,
        events: byName(events).map((item) => ({
          name: item.name,
          ...description(item.description)
        })),
        eventProperties: byName(eventProperties).map(property),
        personProperties: byName(personProperties).map(property)
      };
      if (
        encoder.encode(encodeSnapshot(snapshot)).byteLength >
        registry["posthog.discovery.bytes"].default
      )
        return yield* new DiscoveryTooLarge({ limitId: "posthog.discovery.bytes" });
      return { display: display(credentials), snapshot };
    },
    Effect.timeoutOrElse({
      duration: ADMIN_DEADLINE_MS,
      orElse: () => Effect.fail(new Timeout({ milliseconds: ADMIN_DEADLINE_MS }))
    })
  );

  return Source.of({ test, inspect, withSlot, query });
});

export const layer = Layer.effect(Source, make).pipe(Layer.provide(FetchHttpClient.layer));
