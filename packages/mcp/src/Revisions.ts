/**
 * The MCP revisions the door serves on one endpoint, and which one a request speaks
 * (docs/product.md › The door › Revisions). 2026-07-28 is modern: it has no handshake, and
 * every request carries its version, capabilities and client in `params._meta`, mirrored into
 * headers. 2025-11-25 and 2025-06-18 are legacy: they open with `initialize`. Legacy is served
 * statelessly too, so any replica answers any request and `Mcp-Session-Id` means nothing.
 *
 * `classify` follows the official SDK's dual-era rules, body first: an envelope claim is
 * modern, and so is a request whose `MCP-Protocol-Version` header names a modern version
 * without one, which is refused for the missing envelope. Everything else is legacy, and an
 * `initialize` is always answered. Which methods exist is the door's to say.
 */
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { Base64 } from "effect/encoding";

/** The modern revision. */
export const MODERN = "2026-07-28";
/** The legacy revisions, newest first. */
export const LEGACY = ["2025-11-25", "2025-06-18"] as const;
/** Every revision the door serves, as an unsupported version's refusal lists them. */
export const SUPPORTED: readonly string[] = [MODERN, ...LEGACY];

export type Era = "modern" | "legacy";

/** A JSON-RPC request id. MCP has no `null` one. */
export type RequestId = string | number;

/** What a client says it is: self-reported, for the wide event and nothing else. */
export interface ClientInfo {
  readonly name: string;
  readonly version: string;
}

/** A JSON-RPC error object. */
export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** The headers a modern client mirrors from the body, as the request carried them. */
export interface MirroredHeaders {
  readonly protocolVersion?: string | undefined;
  readonly method?: string | undefined;
  readonly name?: string | undefined;
}

/** Why a request was refused before its method was looked at, as its wide event names it. */
export type RefusalReason =
  "invalid_request" | "invalid_envelope" | "header_mismatch" | "unsupported_version";

export type Classified =
  | {
      readonly kind: "request";
      readonly era: Era;
      readonly id: RequestId;
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
      /** Modern: the envelope's. Legacy: `initialize`'s offer, or the header when sent. */
      readonly version: string | undefined;
      readonly clientInfo: ClientInfo | undefined;
    }
  | {
      readonly kind: "notification";
      readonly era: Era;
      readonly method: string;
      readonly version: string | undefined;
      readonly clientInfo: ClientInfo | undefined;
    }
  | {
      readonly kind: "refused";
      readonly status: 400;
      readonly reason: RefusalReason;
      readonly error: RpcError;
      readonly id?: RequestId;
      readonly era?: Era;
      /** What a readable request said of itself, for its event. */
      readonly method?: string;
      readonly version?: string;
      readonly clientInfo?: ClientInfo;
    };

const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_KEY = "io.modelcontextprotocol/clientInfo";

/** The methods whose `Mcp-Name` header mirrors a body field, and that field. */
const NAMED_BY: Readonly<Record<string, string>> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri"
};

/** Modern revisions are dated on or after the first one, as the SDK reads them. */
const isModern = (version: string) => version >= MODERN;

const isRequestId = (value: unknown): value is RequestId =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

const asClientInfo = (value: unknown): ClientInfo | undefined =>
  Predicate.isReadonlyObject(value) &&
  typeof value["name"] === "string" &&
  typeof value["version"] === "string"
    ? { name: value["name"], version: value["version"] }
    : undefined;

/** The version a legacy `initialize` is answered with: its own when served, else the newest. */
export const negotiate = (requested: string | undefined): string =>
  LEGACY.find((version) => version === requested) ?? LEGACY[0];

const invalidRequest = (message: string, id?: RequestId): Classified => ({
  kind: "refused",
  status: 400,
  reason: "invalid_request",
  error: { code: -32600, message },
  ...(id === undefined ? {} : { id })
});

const headerMismatch = (message: string, id: RequestId): Classified => ({
  kind: "refused",
  status: 400,
  reason: "header_mismatch",
  error: { code: -32020, message },
  id,
  era: "modern"
});

const unsupported = (requested: string, id: RequestId, era: Era): Classified => ({
  kind: "refused",
  status: 400,
  reason: "unsupported_version",
  error: {
    code: -32022,
    message: `Patchy MCP serves ${MODERN} per request, and ${LEGACY.join(" and ")} through initialize; not ${requested}.`,
    data: { supported: SUPPORTED, requested }
  },
  id,
  era,
  version: requested
});

/** An `Mcp-Name` value, decoded from the base64 sentinel a name outside a header's characters takes. */
const decodeName = (header: string): string | undefined => {
  const sentinel = /^=\?base64\?(.*)\?=$/.exec(header);
  if (sentinel === null) return header;
  const decoded = Base64.decodeString(sentinel[1]!);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

/** What's wrong with a modern envelope, or `undefined` when it holds what the revision requires. */
const envelopeProblem = (meta: Readonly<Record<string, unknown>>): string | undefined => {
  if (typeof meta[VERSION_KEY] !== "string") return `${VERSION_KEY} must be a version string`;
  if (!Predicate.isReadonlyObject(meta[CAPABILITIES_KEY]))
    return `${CAPABILITIES_KEY} must be an object`;
  if (meta[CLIENT_KEY] !== undefined && asClientInfo(meta[CLIENT_KEY]) === undefined)
    return `${CLIENT_KEY} must name the client and its version`;
  return undefined;
};

/**
 * The era and checks of one parsed request body and the headers it came with. A refusal keeps
 * whatever the request said of its method, version and client.
 */
export const classify = (request: {
  readonly body: unknown;
  readonly headers: MirroredHeaders;
}): Classified => {
  const classified = ladder(request);
  if (classified.kind !== "refused" || !Predicate.isReadonlyObject(request.body)) return classified;
  const { body, headers } = request;
  const params = body["params"];
  const meta =
    Predicate.isReadonlyObject(params) && Predicate.isReadonlyObject(params["_meta"])
      ? params["_meta"]
      : undefined;
  const said = meta?.[VERSION_KEY];
  const version = classified.version ?? (typeof said === "string" ? said : headers.protocolVersion);
  const clientInfo = asClientInfo(meta?.[CLIENT_KEY]);
  return {
    ...classified,
    ...(typeof body["method"] === "string" ? { method: body["method"] } : {}),
    ...(version === undefined ? {} : { version }),
    ...(clientInfo === undefined ? {} : { clientInfo })
  };
};

const ladder = (request: {
  readonly body: unknown;
  readonly headers: MirroredHeaders;
}): Classified => {
  const { body, headers } = request;
  if (Array.isArray(body))
    return invalidRequest("Patchy MCP takes one message per request; batches aren't served.");
  if (
    !Predicate.isReadonlyObject(body) ||
    body["jsonrpc"] !== "2.0" ||
    typeof body["method"] !== "string"
  )
    return invalidRequest("The body must be one JSON-RPC 2.0 request.");
  const method = body["method"];
  const params = body["params"] ?? {};
  const hasId = Object.hasOwn(body, "id");
  const id = isRequestId(body["id"]) ? body["id"] : undefined;
  if (!Predicate.isReadonlyObject(params))
    return invalidRequest("A request's params must be an object.", id);
  const meta = Predicate.isReadonlyObject(params["_meta"]) ? params["_meta"] : undefined;
  // No client notification means anything to a stateless door; each is acknowledged, and its
  // event still says what spoke it.
  if (!hasId) {
    const said = meta?.[VERSION_KEY];
    const version = typeof said === "string" ? said : headers.protocolVersion;
    return {
      kind: "notification",
      era: version !== undefined && isModern(version) ? "modern" : "legacy",
      method,
      version,
      clientInfo: asClientInfo(meta?.[CLIENT_KEY])
    };
  }
  if (id === undefined) return invalidRequest("A request's id must be a string or a number.");

  const claim = meta !== undefined && Object.hasOwn(meta, VERSION_KEY);
  const valid = claim && envelopeProblem(meta) === undefined;
  const claimed = valid && typeof meta[VERSION_KEY] === "string" ? meta[VERSION_KEY] : undefined;

  // The legacy handshake by definition, unless a valid modern envelope says otherwise; it is
  // never refused, because a 4xx sends some clients back to the old SSE transport.
  if (method === "initialize" && (claimed === undefined || !isModern(claimed)))
    return {
      kind: "request",
      era: "legacy",
      id,
      method,
      params,
      version:
        typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : undefined,
      clientInfo: asClientInfo(params["clientInfo"])
    };

  if (claim) {
    const problem = envelopeProblem(meta);
    if (problem !== undefined || claimed === undefined)
      return {
        kind: "refused",
        status: 400,
        reason: "invalid_envelope",
        error: { code: -32602, message: `Invalid _meta for ${MODERN}: ${problem}.` },
        id,
        era: "modern"
      };
    if (headers.protocolVersion !== undefined && headers.protocolVersion !== claimed)
      return headerMismatch(
        `MCP-Protocol-Version says ${headers.protocolVersion} but the body's _meta says ${claimed}.`,
        id
      );
    if (headers.method !== undefined && headers.method !== method)
      return headerMismatch(`Mcp-Method says ${headers.method} but the body is ${method}.`, id);
    if (claimed !== MODERN) return unsupported(claimed, id, "modern");
    if (headers.protocolVersion === undefined)
      return headerMismatch("A request needs its MCP-Protocol-Version header.", id);
    if (headers.method === undefined)
      return headerMismatch("A request needs its Mcp-Method header.", id);
    const mirrored = Object.hasOwn(NAMED_BY, method) ? params[NAMED_BY[method]!] : undefined;
    if (typeof mirrored === "string") {
      if (headers.name === undefined)
        return headerMismatch(`A ${method} request needs its Mcp-Name header.`, id);
      const name = decodeName(headers.name);
      if (name !== mirrored)
        return headerMismatch(
          name === undefined
            ? "Mcp-Name holds an invalid base64 value."
            : `Mcp-Name says ${name} but the body names ${mirrored}.`,
          id
        );
    }
    return {
      kind: "request",
      era: "modern",
      id,
      method,
      params,
      version: claimed,
      clientInfo: asClientInfo(meta[CLIENT_KEY])
    };
  }

  const version = headers.protocolVersion;
  if (version !== undefined && isModern(version))
    return {
      kind: "refused",
      status: 400,
      reason: "invalid_envelope",
      error: {
        code: -32602,
        message: `MCP-Protocol-Version says ${version}, which carries ${VERSION_KEY} and ${CAPABILITIES_KEY} in params._meta; this request has no _meta.`
      },
      id,
      era: "modern",
      version
    };
  if (version !== undefined && !LEGACY.some((served) => served === version))
    return unsupported(version, id, "legacy");
  return { kind: "request", era: "legacy", id, method, params, version, clientInfo: undefined };
};
