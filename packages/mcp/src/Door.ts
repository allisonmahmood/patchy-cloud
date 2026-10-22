/**
 * The door at `/mcp`: the one MCP server an instance offers, through which a worker agent uses
 * its company's patches as its person (docs/product.md › The door). It answers JSON over one
 * POST per message on every revision it serves, holding no session, so any replica answers
 * any request.
 *
 * Each request passes, in order: the `Host` gate (421, no challenge), the Origin rules (403),
 * its HTTP method (a production preflight, or 405), the bearer, which only an agent
 * connection's `work` token passes (401, or 429 past the failed checks a minute an address
 * spends), the body cap (413 before parsing), the revision's checks, and the person's
 * requests a minute. Authority comes only from the bearer: the door never reads cookies.
 *
 * A limit on `tools/call` is the tool's refusal over HTTP 200; on any other method it is 429
 * with `Retry-After`. Every tool call needs the company's agent access on, and is refused
 * naming its admins while it is off. `find_patches` and `open_patch` are the catalogue's, and
 * `read_patch` runs a patch's read tool through the host's invocation; until #855 lands,
 * `change_patch` refuses as not built.
 *
 * The request's wide event, opened by the server around every route, gains the connection, the
 * revision and method, the door's tool, the patch's tool a call named, the `Origin` and each
 * refusal's code. Arguments, results, tokens, change keys and instructions never reach it.
 */
import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as WideEvents from "@patchy/analytics/wide-events";
import { CURRENT_RELEASE, toolRefusal, type ToolCallResult } from "@patchy/api";
import { type AgentConnections, Authorization, Bearer, OAuthMetadata, Session } from "@patchy/auth";
import { Companies, Users } from "@patchy/companies";
import { DeploymentConfig, Limits, OperatingLimits, TokenBucket } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import type { Patches } from "@patchy/patches";
import { Invocation } from "@patchy/runtime";
import * as Calls from "./Calls.js";
import * as Catalogue from "./Catalogue.js";
import * as RequestTrust from "./RequestTrust.js";
import * as Revisions from "./Revisions.js";
import * as Tools from "./Tools.js";

/** Who answers, on every revision. */
const serverInfo = { name: "patchy", title: "Patchy", version: CURRENT_RELEASE };

/** The door's capabilities: tools only, and the list never changes under a client. */
const capabilities = { tools: { listChanged: false } };

/** Discovery names the person, so it is cached per token; the tool list is everyone's. */
const DISCOVER_TTL_MS = 60 * 60 * 1000;
const TOOLS_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_BODY_BYTES = registry["mcp.body.bytes"].default;
const decoder = new TextDecoder();

/** How much of what a client sends about itself an event keeps. */
const RECORDED_ORIGIN = 256;
const RECORDED_TEXT = 128;

const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

const recorded = (text: string, limit = RECORDED_TEXT) => [...text].slice(0, limit).join("");

/** What a message says of the revision and client that sent it, cut short for its event. */
const spoken = (classified: Revisions.Classified): WideEvents.EventFields => {
  const { era, method, version, clientInfo } = classified;
  return {
    ...(era === undefined ? {} : { protocolEra: era }),
    ...(method === undefined ? {} : { mcpMethod: recorded(method, 64) }),
    ...(version === undefined ? {} : { protocolVersion: recorded(version, 32) }),
    ...(clientInfo === undefined
      ? {}
      : {
          clientInfoName: recorded(clientInfo.name),
          clientInfoVersion: recorded(clientInfo.version)
        })
  };
};

export const layer: Layer.Layer<
  never,
  Config.ConfigError | DeploymentConfig.InvalidLimit,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      | AgentConnections.AgentConnections
      | Limits.Limits
      | OperatingLimits.OperatingLimits
      | Patches.Patches
      | Companies.Companies
      | Users.Users
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const publicUrl = yield* Session.publicUrlConfig;
    const dev = Session.isLoopback(publicUrl);
    const failuresPerMinute = (yield* DeploymentConfig.load).get("mcp.bearer.failures.perMinute");
    const people = yield* TokenBucket.make;
    // The host's invocation runs patch code; a host without one answers that it runs none.
    const invocation = yield* Effect.serviceOption(Invocation.Invocation);
    const cors: Record<string, string> = dev ? {} : OAuthMetadata.cors;
    const challengeBase = `Bearer resource_metadata="${publicUrl.origin}/.well-known/oauth-protected-resource/mcp", scope="${OAuthMetadata.SCOPE}"`;

    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      HttpServerResponse.jsonUnsafe(body, { status, headers: { ...cors, ...headers } });

    /** A refusal before there is a message to answer, in an OAuth resource server's words. */
    const refuse = (
      status: number,
      error: string,
      description: string,
      headers: Record<string, string> = {}
    ) =>
      WideEvents.enrich({ code: error }).pipe(
        Effect.as(json(status, { error, error_description: description }, headers))
      );

    const result = (era: Revisions.Era, id: Revisions.RequestId, body: object) =>
      json(200, {
        jsonrpc: "2.0",
        id,
        result:
          era === "modern"
            ? {
                resultType: "complete",
                ...body,
                _meta: { "io.modelcontextprotocol/serverInfo": serverInfo }
              }
            : body
      });

    const rpcError = (
      status: number,
      id: Revisions.RequestId | undefined,
      error: Revisions.RpcError,
      code: string,
      headers: Record<string, string> = {}
    ) =>
      WideEvents.enrich({ code, ...(status === 200 ? { outcome: "refused" as const } : {}) }).pipe(
        Effect.as(
          json(status, { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), error }, headers)
        )
      );

    const toolAnswer = (era: Revisions.Era, id: Revisions.RequestId, answer: ToolCallResult) => {
      const refusal = answer.isError === true ? answer.structuredContent["error"] : undefined;
      const code = Predicate.hasProperty(refusal, "code") ? String(refusal.code) : undefined;
      return WideEvents.enrich(code === undefined ? {} : { outcome: "refused", code }).pipe(
        Effect.as(result(era, id, answer))
      );
    };

    /** The 401 a missing, unknown, ended or `build` token gets, or 429 past the address's minute. */
    const unauthorized = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const sent = Bearer.parse(request.headers.authorization).kind !== "missing";
      const counted = yield* (yield* Limits.Limits).consume({
        key: `mcp-bearer-failures:${Option.getOrElse(request.remoteAddress, () => "")}`,
        limit: failuresPerMinute,
        window: "1 minute"
      });
      if (!counted.allowed) {
        yield* WideEvents.enrich({ limitId: "mcp.bearer.failures.perMinute" });
        return yield* refuse(
          429,
          "rate_limited",
          `Too many requests without a working token from this address; try again in ${counted.retryAfterSeconds} seconds.`,
          { "retry-after": String(counted.retryAfterSeconds) }
        );
      }
      return yield* refuse(
        401,
        sent ? "invalid_token" : "missing_token",
        sent
          ? "This token is unknown or its agent connection has ended. Connect the agent to Patchy again."
          : "Patchy's MCP needs an agent connection: connect the agent to Patchy and sign in.",
        { "www-authenticate": sent ? `${challengeBase}, error="invalid_token"` : challengeBase }
      );
    });

    /**
     * The body as text, `too_large` past the cap, or `unreadable` when the client went away. A
     * declared length past the cap is refused unread. A chunked body is read to its end,
     * keeping only the cap, so its 413 still reaches the client: stopping early would end the
     * connection first. Node's request timeout bounds how long that read can take.
     */
    const body = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) return "too_large" as const;
      const read = yield* request.stream.pipe(
        Stream.scan(
          () => ({ bytes: 0, kept: [] as ReadonlyArray<Uint8Array> }),
          (read, chunk) => {
            const bytes = read.bytes + chunk.length;
            return { bytes, kept: bytes <= MAX_BODY_BYTES ? [...read.kept, chunk] : read.kept };
          }
        ),
        Stream.runLast,
        Effect.result
      );
      if (Result.isFailure(read)) return "unreadable" as const;
      const { bytes, kept } = Option.getOrElse(read.success, () => ({ bytes: 0, kept: [] }));
      if (bytes > MAX_BODY_BYTES) return "too_large" as const;
      const joined = new Uint8Array(bytes);
      let at = 0;
      for (const chunk of kept) {
        joined.set(chunk, at);
        at += chunk.length;
      }
      return { text: decoder.decode(joined) };
    });

    /** The person's requests a minute: undefined while they have some left, else the wait. */
    const spend = (identity: AgentConnections.AgentIdentity) =>
      Effect.gen(function* () {
        const limit = yield* (yield* OperatingLimits.OperatingLimits)
          .get({ companyId: identity.company.id, limitId: "mcp.requests.perMinute" })
          .pipe(
            Effect.catchTags({
              InvalidLimit: Effect.die,
              CompanyNotFound: Effect.die,
              SqlError: Effect.die
            })
          );
        const attempt = yield* people.consume({
          key: `mcp-requests:${identity.user.id}`,
          rate: limit.value / 60,
          burst: limit.value
        });
        yield* WideEvents.enrich({
          limits: [
            {
              limitId: limit.limitId,
              value: limit.value,
              peak: limit.value - attempt.remaining,
              configRevision: limit.configRevision
            }
          ]
        });
        if (attempt.allowed) return undefined;
        yield* WideEvents.enrich({
          limitId: attempt.reason === "capacity" ? "rate.trackedKeys" : limit.limitId
        });
        return { retryAfterSeconds: attempt.retryAfterSeconds, value: limit.value };
      });

    /** While the company's agent access is off, the refusal every tool call gets. */
    const accessOff = Effect.fn("Door.accessOff")(function* (
      identity: AgentConnections.AgentIdentity
    ) {
      const access = yield* (yield* Companies.Companies)
        .agentAccess(identity.company.id)
        .pipe(Effect.catchTags({ CompanyNotFound: Effect.die, SqlError: Effect.die }));
      if (access.on) return undefined;
      const admins = (yield* (yield* Users.Users)
        .list(identity.company.id)
        .pipe(Effect.catchTags({ SqlError: Effect.die })))
        .filter((user) => user.role === "admin" && user.deactivatedAt === null)
        .map((user) => user.name)
        .sort((a, b) => a.localeCompare(b));
      return Tools.agentAccessOff({
        company: identity.company.name,
        admins,
        turnOnAt: `${publicUrl.href.replace(/\/+$/u, "")}/company`
      });
    });

    const callTool = (
      request: Extract<Revisions.Classified, { kind: "request" }>,
      identity: AgentConnections.AgentIdentity
    ) => {
      const name = request.params["name"];
      if (typeof name !== "string")
        return rpcError(
          200,
          request.id,
          { code: -32602, message: "tools/call needs params.name, the tool to call." },
          "invalid_params"
        );
      if (!Tools.isName(name))
        return rpcError(
          200,
          request.id,
          {
            code: -32602,
            message: `Patchy MCP has no tool ${name}; its tools are ${Tools.NAMES.join(", ")}.`
          },
          "unknown_tool"
        );
      return Effect.gen(function* () {
        yield* WideEvents.enrich({ mcpTool: name });
        const args = request.params["arguments"];
        const answered =
          (yield* accessOff(identity)) ??
          (name === "find_patches"
            ? yield* Catalogue.find(identity, args, publicUrl)
            : name === "open_patch"
              ? yield* Catalogue.open(identity, args, publicUrl)
              : name === "read_patch"
                ? yield* Calls.read(identity, args, publicUrl, invocation)
                : Tools.notBuilt(name));
        return yield* toolAnswer(request.era, request.id, answered);
      });
    };

    const answer = (
      request: Extract<Revisions.Classified, { kind: "request" }>,
      identity: AgentConnections.AgentIdentity
    ) => {
      const { era, id, method } = request;
      switch (`${era} ${method}`) {
        case "legacy initialize":
          return Effect.succeed(
            result(era, id, {
              protocolVersion: Revisions.negotiate(request.version),
              capabilities,
              serverInfo,
              instructions: Tools.instructions(identity)
            })
          );
        case "legacy ping":
          return Effect.succeed(result(era, id, {}));
        case "modern server/discover":
          return Effect.succeed(
            result(era, id, {
              supportedVersions: Revisions.SUPPORTED,
              capabilities,
              instructions: Tools.instructions(identity),
              ttlMs: DISCOVER_TTL_MS,
              cacheScope: "private"
            })
          );
        case "legacy tools/list":
          return Effect.succeed(result(era, id, { tools: Tools.tools }));
        case "modern tools/list":
          return Effect.succeed(
            result(era, id, { tools: Tools.tools, ttlMs: TOOLS_TTL_MS, cacheScope: "public" })
          );
        case "legacy tools/call":
        case "modern tools/call":
          return callTool(request, identity);
        default:
          // A legacy 404 means the session ended, so a legacy client hears this over 200.
          return rpcError(
            era === "modern" ? 404 : 200,
            id,
            { code: -32601, message: `Patchy MCP has no method ${method}.` },
            "method_not_found"
          );
      }
    };

    const door = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const origin = request.headers.origin;
      if (origin !== undefined)
        yield* WideEvents.enrich({ origin: recorded(origin, RECORDED_ORIGIN) });
      if (!RequestTrust.isOwnHost(RequestTrust.requestAuthority(request), publicUrl))
        return yield* refuse(
          421,
          "invalid_host",
          `Patchy's MCP answers only at ${publicUrl.origin}/mcp.`
        );
      if (RequestTrust.checkOrigin(origin, publicUrl) !== "allowed")
        return yield* refuse(
          403,
          "invalid_origin",
          dev
            ? `A dev instance's MCP answers only its own origin, ${publicUrl.origin}, or none.`
            : "The Origin header must be one well-formed origin, or left out."
        );
      if (request.method === "OPTIONS" && !dev) return OAuthMetadata.preflight;
      if (request.method !== "POST")
        return yield* refuse(
          405,
          "method_not_allowed",
          "Patchy's MCP takes one JSON-RPC message per POST; there is no stream to open or session to end.",
          { allow: dev ? "POST" : "POST, OPTIONS" }
        );

      const found = yield* Authorization.identify("work");
      if (Option.isNone(found)) return yield* unauthorized;
      const identity = found.value;
      yield* WideEvents.enrich({
        agentConnectionId: identity.agentConnection.id,
        clientName: identity.agentConnection.clientName,
        clientSite: identity.agentConnection.clientSite
      });

      // Every request the person sends spends their minute, an oversized one included.
      const limited = yield* spend(identity);
      const read = yield* body;
      if (read === "too_large")
        return yield* refuse(
          413,
          "too_large",
          `A request body is at most ${MAX_BODY_BYTES} bytes: the ${registry["tier2.args.bytes"].default}-byte argument cap and its envelope.`,
          // Whatever the client still sends is never read.
          { connection: "close" }
        );
      if (read === "unreadable")
        return yield* refuse(400, "unreadable_body", "The request body couldn't be read.");
      const parsed = parseJson(read.text);
      const classified = Result.isSuccess(parsed)
        ? Revisions.classify({
            body: parsed.success,
            headers: {
              protocolVersion: request.headers["mcp-protocol-version"],
              method: request.headers["mcp-method"],
              name: request.headers["mcp-name"]
            }
          })
        : undefined;
      if (classified !== undefined) yield* WideEvents.enrich(spoken(classified));

      if (limited !== undefined) {
        const message = `You sent Patchy's MCP more than ${limited.value} requests in a minute; try again in ${limited.retryAfterSeconds} seconds.`;
        if (classified?.kind === "request" && classified.method === "tools/call") {
          const name = classified.params["name"];
          if (typeof name === "string" && Tools.isName(name))
            yield* WideEvents.enrich({ mcpTool: name });
          return yield* toolAnswer(
            classified.era,
            classified.id,
            toolRefusal({
              code: "rate_limited",
              from: "patchy",
              message,
              retryAfterSeconds: limited.retryAfterSeconds
            })
          );
        }
        return yield* rpcError(
          429,
          classified?.kind === "request" || classified?.kind === "refused"
            ? classified.id
            : undefined,
          {
            code: -32000,
            message,
            data: { code: "rate_limited", retryAfterSeconds: limited.retryAfterSeconds }
          },
          "rate_limited",
          { "retry-after": String(limited.retryAfterSeconds) }
        );
      }

      if (classified === undefined)
        return yield* rpcError(
          400,
          undefined,
          { code: -32700, message: "The body isn't JSON." },
          "parse_error"
        );
      switch (classified.kind) {
        case "notification":
          return HttpServerResponse.empty({ status: 202, headers: cors });
        case "refused":
          return yield* rpcError(
            classified.status,
            classified.id,
            classified.error,
            classified.reason
          );
        case "request":
          return yield* answer(classified, identity);
      }
    });

    yield* router.add("*", "/mcp", door);
  })
);
