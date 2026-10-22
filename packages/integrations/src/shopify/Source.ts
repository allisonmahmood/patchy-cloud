/**
 * PROTOTYPE (#815): a Shopify store, read through the company's own Dev Dashboard app. Patchy
 * swaps the app's client ID and secret for a 24-hour token itself (the client credentials grant),
 * keeps it in memory, and uses the app only while its granted scopes are exactly the five it asks
 * for. Every call goes to the store's own `*.myshopify.com` host and never follows a redirect.
 */
import type { ShopifySnapshot } from "@patchy/api";
import { sha256 } from "@patchy/core";
import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
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
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Fake from "./Fake.js";

/** The Admin API version the whole integration pins; Patchy moves it, at least yearly. */
export const API_VERSION = "2026-10";
/** Exactly what the connect walkthrough asks the app for. */
export const SCOPES = [
  "read_orders",
  "read_products",
  "read_inventory",
  "read_locations",
  "read_reports"
] as const;

const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "ShopifyInvalidCredentials",
  { cause: Schema.optionalKey(SecretCause) }
) {
  readonly code = "invalid_credentials";
  readonly status = 422;
  override get message() {
    return "Enter the store's myshopify.com address, and the app's client ID and client secret from the Dev Dashboard.";
  }
}
/** The token endpoint refused the app: a wrong secret, an uninstalled app, or another org's store. */
export class CredentialsRejected extends Schema.TaggedError<CredentialsRejected>()(
  "ShopifyCredentialsRejected",
  { reason: Schema.NullOr(Schema.String) }
) {
  readonly code = "shopify_credentials_rejected";
  readonly status = 422;
  override get message() {
    return this.reason === "shop_not_permitted"
      ? "Shopify refused: this app and store aren't in the same Shopify organisation. Create the app in the store's own Dev Dashboard."
      : "Shopify refused this client ID and secret. Check they're the app's current ones, and that the app is still installed on the store.";
  }
}
export class WrongScopes extends Schema.TaggedError<WrongScopes>()("ShopifyWrongScopes", {
  missing: Schema.Array(Schema.String),
  extra: Schema.Array(Schema.String)
}) {
  readonly code = "shopify_wrong_scopes";
  readonly status = 422;
  override get message() {
    const parts = [
      ...(this.missing.length === 0 ? [] : [`add ${this.missing.join(", ")}`]),
      ...(this.extra.length === 0 ? [] : [`remove ${this.extra.join(", ")}`])
    ];
    return `Patchy uses an app only with exactly ${SCOPES.join(", ")}. In the Dev Dashboard, ${parts.join(" and ")}, release a new version and approve it on the store.`;
  }
}
/** Shopify answered ACCESS_DENIED: a scope or customer-data permission the call needs is missing. */
export class AccessDenied extends Schema.TaggedError<AccessDenied>()("ShopifyAccessDenied", {}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "Shopify refused this read for the connection's app. Ask a company administrator to check it at /company/connections.";
  }
}
export class RateLimited extends Schema.TaggedError<RateLimited>()("ShopifyRateLimited", {
  budget: Schema.Literals(["graphql", "shopifyql"]),
  retryAfterSeconds: Schema.optionalKey(Schema.Int)
}) {
  readonly code = "source_rate_limited" as const;
  readonly status = 429;
  override get message() {
    return `Shopify is limiting this store's ${this.budget === "graphql" ? "API" : "analytics"} calls for now.${this.retryAfterSeconds === undefined ? "" : ` Try again in ${this.retryAfterSeconds} seconds.`}`;
  }
}
export class Unavailable extends Schema.TaggedError<Unavailable>()("ShopifyUnavailable", {
  stage: Schema.Literals(["request", "redirect", "status", "response"]),
  upstreamStatus: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(SecretCause)
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "Shopify could not be reached or answered unexpectedly. Try again.";
  }
}
export class Timeout extends Schema.TaggedError<Timeout>()("ShopifyTimeout", {
  milliseconds: Schema.Int
}) {
  readonly code = "timeout" as const;
  readonly status = 504;
  override get message() {
    return `Shopify did not answer within ${this.milliseconds / 1_000} seconds.`;
  }
}
/** Shopify refused a query Patchy wrote, or ignored part of a search: a Patchy defect. */
export class InvalidQuery extends Schema.TaggedError<InvalidQuery>()("ShopifyInvalidQuery", {
  details: Schema.Struct({ message: Schema.String })
}) {
  readonly code = "invalid_query" as const;
  readonly status = 400;
  override get message() {
    return `Shopify refused Patchy's query: ${this.details.message}`;
  }
}
export class TooLarge extends Schema.TaggedError<TooLarge>()("ShopifyTooLarge", {
  maxBytes: Schema.Int
}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  readonly limitId = "runtime.result.bytes" as const;
  override get message() {
    return `Shopify's answer is larger than ${this.maxBytes} bytes. Ask for a smaller page or a shorter range.`;
  }
}
export class Busy extends Schema.TaggedError<Busy>()("ShopifyBusy", {}) {
  readonly code = "busy" as const;
  readonly status = 503;
  override get message() {
    return `This store already has ${SLOTS} calls running from Patchy. Try again shortly.`;
  }
}

export type SourceError =
  | InvalidCredentials
  | CredentialsRejected
  | WrongScopes
  | AccessDenied
  | RateLimited
  | Unavailable
  | Timeout
  | InvalidQuery
  | TooLarge
  | Busy;
export type QueryError = Exclude<SourceError, InvalidCredentials | Busy>;

const Shop = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/));
export const Credentials = Schema.Struct({
  shop: Shop,
  clientId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
  clientSecret: Schema.String.check(Schema.isBetweenLength(1, 512))
});
export type Credentials = typeof Credentials.Type;
/** Safe to show: which store, and the app's client ID, which Shopify doesn't treat as a secret. */
export const Display = Schema.Struct({ shop: Shop, clientId: Schema.String });
export type Display = typeof Display.Type;

const credentialsJson = Schema.fromJsonString(Credentials);
const decodeCredentials = Schema.decodeUnknownEffect(credentialsJson, {
  onExcessProperty: "error"
});
const encodeCredentials = Schema.encodeSync(credentialsJson);
export const credentials = (value: Credentials): Redacted.Redacted<string> =>
  Redacted.make(encodeCredentials(value));
export const parseCredentials = Effect.fn("Shopify.parseCredentials")(function* (
  secret: Redacted.Redacted<string>
) {
  return yield* decodeCredentials(Redacted.value(secret)).pipe(
    Effect.mapError((cause) => new InvalidCredentials({ cause: Redacted.make(cause) }))
  );
});
export const display = (credentials: Credentials): Display => ({
  shop: credentials.shop,
  clientId: credentials.clientId
});

/** One fixed GraphQL document Patchy wrote, with its variables. */
export interface Request {
  readonly name: string;
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}
export interface Response {
  readonly data: unknown;
  /** Requested points, for recent calls and sizing pages. */
  readonly cost: number | null;
}

export class Source extends Context.Service<
  Source,
  {
    /** Gets a token, checks its scopes and reads the shop's name; returns what pages show. */
    readonly test: (secret: Redacted.Redacted<string>) => Effect.Effect<Display, SourceError>;
    /** Tests, then reads the shop facts and whether analytics run. */
    readonly inspect: (
      secret: Redacted.Redacted<string>
    ) => Effect.Effect<
      { readonly display: Display; readonly snapshot: ShopifySnapshot },
      SourceError
    >;
    readonly withSlot: (
      credentials: Credentials,
      deadline: number
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Busy, R>;
    readonly graphql: (
      credentials: Credentials,
      request: Request
    ) => Effect.Effect<Response, QueryError>;
  }
>()("@patchy/integrations/shopify/Source") {}

const ADMIN_DEADLINE_MS = registry["integration.deadline"].default;
const SLOT_RESERVE_MS = 1_000;
const SLOTS = 2;
const MAX_BYTES = registry["runtime.result.bytes"].default;
/** Renew this long before Shopify's own expiry. */
const RENEW_MS = 5 * 60_000;

const TokenBody = Schema.Struct({
  access_token: Schema.String,
  scope: Schema.String,
  expires_in: Schema.Int
});
const GraphqlError = Schema.Struct({
  message: Schema.String,
  extensions: Schema.optionalKey(Schema.Struct({ code: Schema.optionalKey(Schema.String) }))
});
const GraphqlBody = Schema.Struct({
  data: Schema.optionalKey(Schema.Unknown),
  errors: Schema.optionalKey(Schema.Array(GraphqlError)),
  extensions: Schema.optionalKey(
    Schema.Struct({
      cost: Schema.optionalKey(
        Schema.Struct({
          requestedQueryCost: Schema.optionalKey(Schema.Number),
          throttleStatus: Schema.optionalKey(
            Schema.Struct({
              currentlyAvailable: Schema.Number,
              restoreRate: Schema.Number
            })
          )
        })
      ),
      shopifyqlCost: Schema.optionalKey(
        Schema.Struct({ windowResetAt: Schema.optionalKey(Schema.String) })
      ),
      search: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            warnings: Schema.optionalKey(
              Schema.Array(
                Schema.Struct({ field: Schema.optionalKey(Schema.String), message: Schema.String })
              )
            )
          })
        )
      )
    })
  )
});
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeToken = Schema.decodeUnknownEffect(TokenBody);
const decodeGraphql = Schema.decodeUnknownEffect(GraphqlBody);
const decodeTokenError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.optionalKey(Schema.String) }))
);
const decoder = new TextDecoder();

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

interface Token {
  readonly value: string;
  readonly expiresAt: number;
}

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const gates = new Map<string, Semaphore.Semaphore>();
  const tokens = new Map<string, Token>();
  const renewals = new Map<string, Semaphore.Semaphore>();
  const keyOf = (credentials: Credentials) =>
    `${credentials.shop}:${credentials.clientId}:${sha256(credentials.clientSecret)}`;
  const gate = (credentials: Credentials) => {
    let found = gates.get(credentials.shop);
    if (found === undefined) {
      found = Semaphore.makeUnsafe(SLOTS);
      gates.set(credentials.shop, found);
    }
    return found;
  };

  const send = Effect.fn("Shopify.send")(function* (request: HttpClientRequest.HttpClientRequest) {
    const response = yield* client.execute(request.pipe(HttpClientRequest.acceptJson)).pipe(
      Effect.mapError(
        (cause) => new Unavailable({ stage: "request", cause: Redacted.make(cause) })
      ),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(Tracer.DisablePropagation, true)
    );
    if (response.status >= 300 && response.status < 400)
      return yield* new Unavailable({ stage: "redirect", upstreamStatus: response.status });
    return {
      status: response.status,
      headers: response.headers,
      text: yield* collect(response, MAX_BYTES)
    };
  });

  /** A fresh token, its granted scopes checked against exactly the five Patchy asks for. */
  const mint = Effect.fn("Shopify.mint")(function* (credentials: Credentials) {
    const answer = yield* send(
      HttpClientRequest.post(`https://${credentials.shop}/admin/oauth/access_token`).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "client_credentials",
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret
        })
      )
    );
    if (
      answer.status === 400 ||
      answer.status === 401 ||
      answer.status === 403 ||
      answer.status === 404
    )
      return yield* new CredentialsRejected({
        reason: Option.getOrUndefined(decodeTokenError(answer.text))?.error ?? null
      });
    if (answer.status === 429) return yield* new RateLimited({ budget: "graphql" });
    if (answer.status !== 200)
      return yield* new Unavailable({ stage: "status", upstreamStatus: answer.status });
    const body = yield* decodeJson(answer.text).pipe(
      Effect.flatMap(decodeToken),
      Effect.mapError(
        (cause) => new Unavailable({ stage: "response", cause: Redacted.make(cause) })
      )
    );
    const granted = body.scope
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope !== "");
    const missing = SCOPES.filter((scope) => !granted.includes(scope));
    const extra = granted.filter((scope) => !(SCOPES as ReadonlyArray<string>).includes(scope));
    if (missing.length > 0 || extra.length > 0) return yield* new WrongScopes({ missing, extra });
    const now = yield* Clock.currentTimeMillis;
    return { value: body.access_token, expiresAt: now + body.expires_in * 1_000, granted };
  });

  /** The cached token, renewed once per app and store at a time. */
  const token = Effect.fn("Shopify.token")(function* (credentials: Credentials, fresh: boolean) {
    const key = keyOf(credentials);
    let lock = renewals.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      renewals.set(key, lock);
    }
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = tokens.get(key);
        if (!fresh && cached !== undefined && cached.expiresAt - RENEW_MS > now)
          return cached.value;
        tokens.delete(key);
        const minted = yield* mint(credentials);
        tokens.set(key, { value: minted.value, expiresAt: minted.expiresAt });
        return minted.value;
      })
    );
  });

  const post = Effect.fn("Shopify.post")(function* (
    credentials: Credentials,
    request: Request,
    access: string
  ) {
    return yield* send(
      HttpClientRequest.post(
        `https://${credentials.shop}/admin/api/${API_VERSION}/graphql.json`
      ).pipe(
        HttpClientRequest.setHeader("x-shopify-access-token", access),
        HttpClientRequest.bodyJsonUnsafe({
          query: request.query,
          operationName: request.name,
          variables: request.variables ?? {}
        })
      )
    );
  });

  const graphql = Effect.fn("Shopify.graphql")(function* (
    credentials: Credentials,
    request: Request
  ) {
    let answer = yield* post(credentials, request, yield* token(credentials, false));
    // Shopify rejected the token without running anything: renew once and send again.
    if (answer.status === 401)
      answer = yield* post(credentials, request, yield* token(credentials, true));
    if (answer.status === 401) {
      tokens.delete(keyOf(credentials));
      return yield* new CredentialsRejected({ reason: null });
    }
    if (answer.status === 402 || answer.status === 403 || answer.status === 423)
      return yield* new AccessDenied({});
    if (answer.status === 429)
      return yield* new RateLimited({
        budget: request.name === "PatchyAnalytics" ? "shopifyql" : "graphql"
      });
    if (answer.status !== 200)
      return yield* new Unavailable({ stage: "status", upstreamStatus: answer.status });
    const body = yield* decodeJson(answer.text).pipe(
      Effect.flatMap(decodeGraphql),
      Effect.mapError(
        (cause) => new Unavailable({ stage: "response", cause: Redacted.make(cause) })
      )
    );
    const cost = body.extensions?.cost;
    for (const error of body.errors ?? []) {
      const code = error.extensions?.code;
      if (code === "THROTTLED") {
        const throttle = cost?.throttleStatus;
        const requested = cost?.requestedQueryCost;
        const seconds =
          throttle !== undefined && requested !== undefined && throttle.restoreRate > 0
            ? Math.max(
                1,
                Math.ceil((requested - throttle.currentlyAvailable) / throttle.restoreRate)
              )
            : undefined;
        return yield* new RateLimited({
          budget: "graphql",
          ...(seconds === undefined ? {} : { retryAfterSeconds: seconds })
        });
      }
      if (code === "ACCESS_DENIED" || code === "SHOP_INACTIVE") return yield* new AccessDenied({});
      if (code === "INTERNAL_SERVER_ERROR") return yield* new Unavailable({ stage: "response" });
      return yield* new InvalidQuery({ details: { message: error.message.slice(0, 500) } });
    }
    // A search Shopify partly ignored would return the wrong rows, so it fails instead.
    const warning = (body.extensions?.search ?? []).flatMap((search) => search.warnings ?? [])[0];
    if (warning !== undefined)
      return yield* new InvalidQuery({
        details: {
          message: `Shopify ignored part of a search${warning.field === undefined ? "" : ` (${warning.field})`}.`
        }
      });
    if (body.data === undefined || body.data === null)
      return yield* new Unavailable({ stage: "response" });
    return { data: body.data, cost: cost?.requestedQueryCost ?? null };
  });

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

  const ShopFacts = Schema.Struct({
    shop: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      myshopifyDomain: Schema.String,
      currencyCode: Schema.String,
      ianaTimezone: Schema.String,
      plan: Schema.Struct({ publicDisplayName: Schema.String })
    })
  });
  const decodeShop = Schema.decodeUnknownEffect(ShopFacts);
  const shopFacts = Effect.fn("Shopify.shopFacts")(function* (credentials: Credentials) {
    const response = yield* graphql(credentials, {
      name: "PatchyShop",
      query: `query PatchyShop { shop { id name myshopifyDomain currencyCode ianaTimezone plan { publicDisplayName } } }`
    });
    return yield* decodeShop(response.data).pipe(
      Effect.mapError(
        (cause) => new Unavailable({ stage: "response", cause: Redacted.make(cause) })
      )
    );
  });

  /** One tiny report says whether analytics run; a timeout or throttle says only "unknown". */
  const analyticsAvailability = (credentials: Credentials, plan: string) =>
    graphql(credentials, {
      name: "PatchyAnalytics",
      query: `query PatchyAnalytics($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name dataType } rows } parseErrors } }`,
      variables: { q: "FROM sales SHOW orders SINCE -1d" }
    }).pipe(
      Effect.as("available" as const),
      Effect.catchTags({
        ShopifyAccessDenied: () =>
          Effect.succeed(
            /^(basic|starter)/i.test(plan) ? ("needs_plan" as const) : ("missing_access" as const)
          ),
        ShopifyInvalidQuery: () => Effect.succeed("missing_access" as const)
      }),
      Effect.catch(() => Effect.succeed("unknown" as const))
    );

  const test = Effect.fn("Shopify.test")(
    function* (secret: Redacted.Redacted<string>) {
      const credentials = yield* parseCredentials(secret);
      yield* token(credentials, true);
      yield* shopFacts(credentials);
      return display(credentials);
    },
    Effect.timeoutOrElse({
      duration: ADMIN_DEADLINE_MS,
      orElse: () => Effect.fail(new Timeout({ milliseconds: ADMIN_DEADLINE_MS }))
    })
  );

  const inspect = Effect.fn("Shopify.inspect")(
    function* (secret: Redacted.Redacted<string>) {
      const credentials = yield* parseCredentials(secret);
      yield* token(credentials, true);
      const { shop } = yield* shopFacts(credentials);
      const snapshot: ShopifySnapshot = {
        version: 1,
        shop: {
          id: shop.id,
          name: shop.name,
          domain: shop.myshopifyDomain,
          plan: shop.plan.publicDisplayName,
          currency: shop.currencyCode,
          timezone: shop.ianaTimezone
        },
        scopes: [...SCOPES],
        analytics: yield* analyticsAvailability(credentials, shop.plan.publicDisplayName)
      };
      return { display: display(credentials), snapshot };
    },
    Effect.timeoutOrElse({
      duration: ADMIN_DEADLINE_MS,
      orElse: () => Effect.fail(new Timeout({ milliseconds: ADMIN_DEADLINE_MS }))
    })
  );

  return Source.of({ test, inspect, withSlot, graphql });
});

/**
 * Real Shopify, except that `pnpm dev` (PATCHY_SHOPIFY_FAKE) answers the demo store's host from
 * the in-memory fake, so the prototype runs before a real dev store exists.
 */
const http = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const real = yield* HttpClient.HttpClient;
    const fake = yield* Config.Boolean("PATCHY_SHOPIFY_FAKE").pipe(
      Config.withDefault(false),
      Effect.orElseSucceed(() => false)
    );
    if (!fake) return real;
    const store = Fake.make();
    return HttpClient.make((request, url) =>
      url.host === Fake.SHOP
        ? Effect.sync(() => HttpClientResponse.fromWeb(request, store.respond(request, url)))
        : real.execute(request)
    );
  })
).pipe(Layer.provide(FetchHttpClient.layer));

export const layer = Layer.effect(Source, make).pipe(Layer.provide(http));
