// @effect-diagnostics nodeBuiltinImport:off -- HTTP/1.1 over the pinned connection needs Node's client.
/**
 * Client metadata documents: how an MCP client names itself. Its client id is the https URL
 * of a JSON document on its own site, which Patchy fetches when the client asks to connect.
 * That URL is a stranger's, so the fetch reaches only global unicast addresses, resolves the
 * name once and connects only to the answer it checked, follows no redirect, accepts only a
 * 200, reads at most 5,000 bytes and gives up after 5 seconds.
 *
 * A document is accepted when its `client_id` is exactly the URL fetched, its required fields
 * are valid and it offers the `none` auth method. Accepted documents are kept as their response
 * headers say, for an hour at most; a refusal or failure is never kept. Fetches are limited
 * host-wide per minute, and one runs per URL at a time, shared by every load that asks while
 * it runs. There is no list of trusted clients and Patchy keeps no registrations.
 */
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isPublicAddress } from "@patchy/core";
import { DeploymentConfig, Limits } from "@patchy/limits";
import { clientName } from "./AgentConnections.js";
import * as ClientDocumentNetwork from "./ClientDocumentNetwork.js";

/** The CIMD draft's recommended read: 5 KB. */
const MAX_BYTES = 5_000;
const DEADLINE = Duration.seconds(5);
/** Longer client ids are refused before anything is fetched or kept. */
const MAX_CLIENT_ID_LENGTH = 2_048;
const USER_AGENT = "Patchy (+https://patchyhq.com)";
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The client id or its document breaks a rule, so the client can't connect. `reason` is for
 * the request's event: the client id isn't a URL Patchy fetches, the document isn't valid JSON
 * with the required fields, its `client_id` isn't the URL fetched, or it doesn't offer `none`.
 */
export class ClientDocumentRefused extends Schema.TaggedError<ClientDocumentRefused>()(
  "ClientDocumentRefused",
  {
    reason: Schema.Literals(["client_id_url", "document", "client_id", "auth_method"]),
    /** The client id's host, once it is a URL Patchy fetches. */
    site: Schema.optionalKey(Schema.String)
  }
) {
  override get message() {
    return this.site === undefined
      ? "The client id isn't an https URL Patchy fetches a metadata document from."
      : `The client metadata document at ${this.site} isn't one Patchy accepts (${this.reason}).`;
  }
}

/**
 * The document couldn't be fetched under the rules: its host didn't resolve, resolved to an
 * address Patchy never reaches, refused the connection or its certificate didn't verify,
 * answered anything but a 200, sent more than 5,000 bytes, broke off, or took over 5 seconds.
 */
export class ClientDocumentUnavailable extends Schema.TaggedError<ClientDocumentUnavailable>()(
  "ClientDocumentUnavailable",
  {
    site: Schema.String,
    stage: Schema.Literals(["dns", "address", "connect", "status", "size", "body", "timeout"]),
    status: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {
  override get message() {
    const status = this.status === undefined ? "" : ` ${this.status}`;
    return `The client metadata document at ${this.site} could not be loaded (${this.stage}${status}).`;
  }
}

/** The host has started its minute's fetches; a document already kept still loads. */
export class ClientDocumentsBusy extends Schema.TaggedError<ClientDocumentsBusy>()(
  "ClientDocumentsBusy",
  { retryAfterSeconds: Schema.Int }
) {
  override get message() {
    return `Patchy is loading too many client metadata documents; try again in ${this.retryAfterSeconds} seconds.`;
  }
}

type LoadFailure = ClientDocumentRefused | ClientDocumentUnavailable | ClientDocumentsBusy;

/** An accepted document: what consent shows and where its answer may go. */
export interface ClientDocument {
  /** The document's URL, which is the client's id. */
  readonly clientId: string;
  /** The document's `client_name`, cleaned as `AgentConnections.clientName` cleans it. */
  readonly name: string;
  /** The client id's host, shown beside the name. */
  readonly site: string;
  readonly redirectUris: ReadonlyArray<string>;
}

export class ClientDocuments extends Context.Service<
  ClientDocuments,
  {
    /** The accepted document `clientId` names, kept or fetched under the rules above. */
    readonly load: (clientId: string) => Effect.Effect<ClientDocument, LoadFailure>;
  }
>()("@patchy/auth/ClientDocuments") {}

/**
 * The client id as a URL Patchy fetches: https on a host name, with a path, and written as the
 * URL parser writes it, so it has no dot segments, userinfo, fragment, default port or numeric
 * host form that could name something other than what it says.
 */
const fetchable = (clientId: string): URL | undefined => {
  if (clientId.length > MAX_CLIENT_ID_LENGTH || clientId.includes("#")) return undefined;
  const url = URL.parse(clientId);
  if (url === null || url.href !== clientId || url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "" || url.pathname === "/") return undefined;
  // A literal address has no name to verify a certificate against.
  if (isIP(url.hostname) !== 0 || url.hostname.startsWith("[")) return undefined;
  return url;
};

/**
 * Plain http back to this computer, without its port, when written as the URL parser writes it;
 * otherwise undefined. Only the port may vary, so a host or path the parser would rewrite, such
 * as `LOCALHOST` or `/a/../callback`, matches nothing.
 */
const loopback = (uri: string): string | undefined => {
  const url = URL.parse(uri);
  if (
    url === null ||
    url.href !== uri ||
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname)
  )
    return undefined;
  url.port = "";
  return url.href;
};

/**
 * Whether an answer may go to `redirectUri` for this client: one the document lists, exactly,
 * over https; or, for plain http back to this computer, one it lists on any port, with the host
 * and path exact (`localhost` and `127.0.0.1` are different hosts). Never a fragment, userinfo
 * or plain http to another computer, even when listed.
 */
export const redirectAllowed = (document: ClientDocument, redirectUri: string): boolean => {
  const url = URL.parse(redirectUri);
  if (url === null || redirectUri.includes("#") || url.username !== "" || url.password !== "")
    return false;
  if (url.protocol === "https:") return document.redirectUris.includes(redirectUri);
  const requested = loopback(redirectUri);
  return (
    requested !== undefined &&
    document.redirectUris.some((listed) => loopback(listed) === requested)
  );
};

/** A redirect URI a document may list: absolute, without a fragment. */
const RedirectUri = Schema.String.check(
  Schema.makeFilter((uri) => URL.canParse(uri) && !uri.includes("#"), {
    expected: "an absolute URI without a fragment"
  })
);

const Metadata = Schema.Struct({
  client_id: Schema.String,
  client_name: Schema.String,
  redirect_uris: Schema.NonEmptyArray(RedirectUri),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
  token_endpoint_auth_methods_supported: Schema.optionalKey(Schema.Array(Schema.String))
});
const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(Metadata));
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The document `body` as accepted for `url`, or why it isn't. */
const accept = Effect.fnUntraced(function* (url: URL, body: Uint8Array) {
  const site = url.host;
  const text = yield* Effect.try({
    try: () => utf8.decode(body),
    catch: () => new ClientDocumentRefused({ reason: "document", site })
  });
  const metadata = decodeMetadata(text);
  if (Option.isNone(metadata))
    return yield* new ClientDocumentRefused({ reason: "document", site });
  const document = metadata.value;
  if (document.client_id !== url.href)
    return yield* new ClientDocumentRefused({ reason: "client_id", site });
  // The list when there is one, the single field otherwise.
  const methods = document.token_endpoint_auth_methods_supported ?? [
    document.token_endpoint_auth_method
  ];
  if (!methods.includes("none"))
    return yield* new ClientDocumentRefused({ reason: "auth_method", site });
  return {
    clientId: url.href,
    name: clientName(document.client_name, url.href),
    site,
    redirectUris: document.redirect_uris
  } satisfies ClientDocument;
});

const header = (headers: IncomingHttpHeaders, name: string) => {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
};

/**
 * How long a response may be kept, in milliseconds, at most `lifetime`: `no-store` and
 * `no-cache` keep nothing, a `max-age` sets it, `Expires` less `Date` sets it otherwise, and
 * `lifetime` does when neither is sent; `Age` counts against all three. A malformed or repeated
 * `max-age` keeps nothing.
 */
const freshness = (headers: IncomingHttpHeaders, now: number, lifetime: number): number => {
  const directives = (header(headers, "cache-control") ?? "")
    .split(",")
    .map((directive) => directive.trim().toLowerCase())
    .filter((directive) => directive !== "");
  if (directives.some((directive) => directive === "no-store" || directive === "no-cache"))
    return 0;
  const maxAges = directives.filter((directive) => directive.startsWith("max-age"));
  let fresh: number;
  if (maxAges.length > 0) {
    const seconds = maxAges.length === 1 ? /^max-age=(\d+)$/.exec(maxAges[0]!)?.[1] : undefined;
    if (seconds === undefined) return 0;
    fresh = Number(seconds) * 1_000;
  } else {
    const expires = header(headers, "expires");
    const date = Date.parse(header(headers, "date") ?? "");
    fresh =
      expires === undefined ? lifetime : Date.parse(expires) - (Number.isNaN(date) ? now : date);
    if (Number.isNaN(fresh)) return 0;
  }
  const age = /^\d+$/.test(header(headers, "age") ?? "") ? Number(headers.age) * 1_000 : 0;
  return Math.min(lifetime, Math.max(0, fresh - age));
};

interface Fetched {
  readonly headers: IncomingHttpHeaders;
  readonly body: Uint8Array;
}

/** GET `url` over `socket`: only a 200, and at most MAX_BYTES of body. */
const get = (url: URL, socket: Duplex) =>
  Effect.callback<Fetched, ClientDocumentUnavailable>((resume) => {
    const site = url.host;
    let settled = false;
    let responded = false;
    const request = httpRequest({
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: {
        host: url.host,
        accept: "application/json",
        "accept-encoding": "identity",
        "user-agent": USER_AGENT
      },
      createConnection: () => socket
    });
    const settle = (exit: Exit.Exit<Fetched, ClientDocumentUnavailable>) => {
      if (settled) return;
      settled = true;
      if (Exit.isFailure(exit)) request.destroy();
      resume(exit);
    };
    const fail = (fields: {
      readonly stage: ClientDocumentUnavailable["stage"];
      readonly status?: number;
      readonly cause?: unknown;
    }) => settle(Exit.fail(new ClientDocumentUnavailable({ site, ...fields })));
    request.on("error", (cause) => fail({ stage: responded ? "body" : "connect", cause }));
    request.on("response", (response) => {
      responded = true;
      if (response.statusCode !== 200)
        return fail({ stage: "status", status: response.statusCode });
      if (Number(response.headers["content-length"]) > MAX_BYTES) return fail({ stage: "size" });
      const chunks: Array<Buffer> = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) fail({ stage: "size" });
        else chunks.push(chunk);
      });
      response.on("end", () =>
        settle(Exit.succeed({ headers: response.headers, body: Buffer.concat(chunks) }))
      );
      response.on("close", () => {
        if (!response.complete) fail({ stage: "body" });
      });
    });
    request.end();
    return Effect.sync(() => request.destroy());
  });

export const make = Effect.gen(function* () {
  const network = yield* ClientDocumentNetwork.ClientDocumentNetwork;
  const limits = yield* Limits.Limits;
  const deployment = yield* DeploymentConfig.load;
  const perMinute = deployment.get("oauth.clientDocuments.perMinute");
  const lifetime = deployment.get("oauth.clientDocuments.lifetime");
  const entries = deployment.get("oauth.clientDocuments.entries");

  const fetchDocument = (url: URL) =>
    Effect.gen(function* () {
      const site = url.host;
      const addresses = yield* network.resolve(url.hostname).pipe(
        Effect.catchTags({
          LookupFailed: (cause) =>
            Effect.fail(new ClientDocumentUnavailable({ site, stage: "dns", cause }))
        })
      );
      if (addresses.length === 0)
        return yield* new ClientDocumentUnavailable({ site, stage: "dns" });
      if (!addresses.every(({ address }) => isPublicAddress(address)))
        return yield* new ClientDocumentUnavailable({ site, stage: "address" });
      const socket = yield* Effect.acquireRelease(
        network.connect({ hostname: url.hostname, port: Number(url.port || 443), addresses }),
        (socket) => Effect.sync(() => socket.destroy())
      );
      return yield* get(url, socket);
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: DEADLINE,
        orElse: () =>
          Effect.fail(new ClientDocumentUnavailable({ site: url.host, stage: "timeout" }))
      })
    );

  const scope = yield* Effect.scope;

  // Accepted documents, least recently used first, and the one fetch running for each URL. A
  // running fetch isn't an entry, so keeping documents never evicts it.
  const kept = new Map<string, { readonly document: ClientDocument; readonly expiresAt: number }>();
  const running = new Map<string, Deferred.Deferred<ClientDocument, LoadFailure>>();

  /** Starts a fetch if the minute allows one, and keeps what it accepts as its headers say. */
  const fetchAndKeep = Effect.fn("ClientDocuments.fetch")(function* (url: URL) {
    const admitted = yield* limits.consume({
      key: "oauth.clientDocuments",
      limit: perMinute,
      window: Duration.minutes(1)
    });
    if (!admitted.allowed)
      return yield* new ClientDocumentsBusy({ retryAfterSeconds: admitted.retryAfterSeconds });
    // Freshness counts from the request, so time spent fetching counts against it.
    const started = yield* Clock.currentTimeMillis;
    const fetched = yield* fetchDocument(url);
    const document = yield* accept(url, fetched.body);
    const fresh = freshness(fetched.headers, started, lifetime);
    if (fresh > 0) {
      kept.set(url.href, { document, expiresAt: started + fresh });
      for (const oldest of kept.keys()) {
        if (kept.size <= entries) break;
        kept.delete(oldest);
      }
    }
    return document;
  });

  const load = Effect.fn("ClientDocuments.load")(function* (clientId: string) {
    const url = fetchable(clientId);
    if (url === undefined) return yield* new ClientDocumentRefused({ reason: "client_id_url" });
    const now = yield* Clock.currentTimeMillis;
    // One synchronous step, so no other load acts on this URL between the look and the claim.
    const found = yield* Effect.sync(() => {
      const hit = kept.get(clientId);
      kept.delete(clientId);
      if (hit !== undefined && now < hit.expiresAt) {
        kept.set(clientId, hit);
        return { kind: "kept", document: hit.document } as const;
      }
      const fetching = running.get(clientId);
      if (fetching !== undefined) return { kind: "running", fetching } as const;
      const started = Deferred.makeUnsafe<ClientDocument, LoadFailure>();
      running.set(clientId, started);
      return { kind: "starts", fetching: started } as const;
    });
    if (found.kind === "kept") return found.document;
    // The fetch belongs to the service, not this load, so it finishes for everyone waiting.
    if (found.kind === "starts")
      yield* fetchAndKeep(url).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            running.delete(clientId);
            Deferred.doneUnsafe(found.fetching, exit);
          })
        ),
        Effect.forkIn(scope)
      );
    return yield* Deferred.await(found.fetching);
  });

  return ClientDocuments.of({ load });
});

export const layer = Layer.effect(ClientDocuments, make);
