/**
 * Patchy's MCP door. A person connects their own agent (Claude Code, Codex,
 * anything that speaks MCP) once; it finds the company's patches, opens one
 * and calls the tools its builder put in the patch's agent area, acting as
 * that person. Four fixed tools disclose the rest progressively, so a new
 * patch needs no new connection and the agent's context stays small.
 *
 * Stateless JSON-RPC over one POST: no session id and no stream, so any
 * replica answers any request. Wiring only; who the bearer is belongs to Auth,
 * what a patch is to Patches, and running a tool to Runtime.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { WideEvents } from "@patchy/analytics";
import {
  CURRENT_RELEASE,
  handlerFieldsJsonSchema,
  handlerJsonSchema,
  readBody,
  type HandlerDescriptor,
  type JsonSchema
} from "@patchy/api";
import { AgentAuth } from "@patchy/auth";
import { Patches, PatchesConfig } from "@patchy/patches";
import { AgentCalls, Runtime } from "@patchy/runtime";

/** Newest first; an unknown requested version is answered with the newest stateful one. */
const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;
const DEFAULT_VERSION = "2025-11-25";
/** A tool's arguments are capped at 1 MiB by the runtime; this leaves room for the envelope. */
const MAX_BODY_BYTES = 1024 * 1024 + 64 * 1024;
/** find_patches answers at most this many patches; a search narrows the rest. */
const FIND_LIMIT = 50;

const JsonRpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
});
type JsonRpcRequest = typeof JsonRpcRequest.Type;
const decodeRequest = Schema.decodeUnknownOption(JsonRpcRequest);

const ToolCall = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
});
const decodeToolCall = Schema.decodeUnknownOption(ToolCall);
const FindArgs = Schema.Struct({ search: Schema.optionalKey(Schema.String) });
const decodeFind = Schema.decodeUnknownOption(FindArgs);
const OpenArgs = Schema.Struct({ patch: Schema.String });
const decodeOpen = Schema.decodeUnknownOption(OpenArgs);
const RunArgs = Schema.Struct({
  patch: Schema.String,
  tool: Schema.String,
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
});
const decodeRun = Schema.decodeUnknownOption(RunArgs);

const patchArg = {
  type: "string",
  description:
    "The patch's name (as find_patches lists it), its id, or its address. Names are unique within the company."
} as const satisfies JsonSchema;

/** The four tools every connection sees, whatever the company has built. */
const TOOLS = [
  {
    name: "find_patches",
    title: "Find patches",
    description:
      "List the company's patches (internal tools) the person can open, with what each is for and the agent tools it offers. Search with words from a name, description or owner; leave search empty to list everything. Only patches whose builders added agent tools can be used here.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Words to look for in names, descriptions and owners. Optional."
        }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "open_patch",
    title: "Open a patch",
    description:
      "Open one patch to see its purpose and every agent tool it offers: what each does, whether it reads or changes data, and the exact JSON arguments it takes. Call this before read_patch or change_patch, and again whenever a call says the patch changed.",
    inputSchema: {
      type: "object",
      properties: { patch: patchArg },
      required: ["patch"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "read_patch",
    title: "Read from a patch",
    description:
      'Run one of a patch\'s read tools (kind "read" in open_patch). Reads never change anything. Pass the tool name and its arguments exactly as open_patch describes them.',
    inputSchema: {
      type: "object",
      properties: {
        patch: patchArg,
        tool: { type: "string", description: "The tool's name from open_patch." },
        args: {
          type: "object",
          description: "The tool's arguments, matching its schema from open_patch."
        }
      },
      required: ["patch", "tool"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "change_patch",
    title: "Change a patch's data",
    description:
      "Run one of a patch's change tools (kind \"change\" in open_patch): it adds, updates or removes the patch's data as the person you act for, and colleagues see the result live. The patch's own rules decide what is allowed; a refusal says why and how to fix the call. If a change times out, read before trying it again.",
    inputSchema: {
      type: "object",
      properties: {
        patch: patchArg,
        tool: { type: "string", description: "The tool's name from open_patch." },
        args: {
          type: "object",
          description: "The tool's arguments, matching its schema from open_patch."
        }
      },
      required: ["patch", "tool"],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  }
] as const;

type ToolResult = {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: true;
};

const answer = (value: Readonly<Record<string, unknown>>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value
});
const refusal = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true
});

const noStore = { "cache-control": "no-store" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { ...noStore, ...headers } });
const rpcResult = (id: JsonRpcRequest["id"], result: unknown) =>
  json({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: JsonRpcRequest["id"] | null, code: number, message: string, status = 200) =>
  json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);

/** What every connection is told once: the loop, the boundary and who it acts for. */
const instructions = (identity: AgentAuth.AgentPrincipal["identity"] | undefined) =>
  [
    "Patchy runs a company's internal tools, called patches.",
    identity === undefined
      ? undefined
      : `You act for ${identity.user.name} (${identity.user.email}) at ${identity.company.name}: everything you do is logged as them, via you.`,
    "1. find_patches to see what exists. 2. open_patch for a patch's tools and their exact arguments. 3. read_patch for read tools, change_patch for change tools.",
    "A patch offers only what its builder put in for agents. If what the person asks isn't a tool, say so and name the patch's owner, who can ask their builder agent to add it.",
    "Remember the patch and tool names you use. Share a patch's address when the person should see it themselves; changes show up there live."
  ]
    .filter((line) => line !== undefined)
    .join("\n");

const toRuntimeMe = (
  identity: AgentAuth.AgentPrincipal["identity"]
): Runtime.AdmittedIdentity["viewer"] => ({
  user: identity.user,
  company: identity.company,
  admin: identity.role === "admin"
});

const kindOf = (descriptor: HandlerDescriptor) => (descriptor.kind === "query" ? "read" : "change");

/**
 * A patch reference as people paste it: a name, an id, or an address. An address names its
 * company too; another company's address resolves to nothing rather than a namesake here.
 */
const patchRef = (raw: string, companyHandle: string): string | undefined => {
  const path = raw
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  const segments = (/^[a-z]+:\/\//i.test(path) ? new URL(path).pathname : path)
    .split("/")
    .filter((segment) => segment.length > 0);
  const [company, name] = segments.length >= 2 ? segments.slice(-2) : [undefined, segments[0]];
  return company === undefined || company === companyHandle ? name : undefined;
};

/** A patch's own refusal: its message first, then whatever else it said, for the agent to act on. */
const handlerRefusal = (
  patch: string,
  tool: string,
  failure: { readonly code: string; readonly details?: unknown }
) => {
  const { details } = failure;
  const record = Predicate.isObject(details) ? details : undefined;
  const message = typeof record?.["message"] === "string" ? record["message"] : undefined;
  const rest =
    record === undefined
      ? details
      : Object.fromEntries(Object.entries(record).filter(([key]) => key !== "message"));
  const extra =
    rest === undefined ||
    (typeof rest === "object" && rest !== null && Object.keys(rest).length === 0)
      ? ""
      : `\nDetails: ${JSON.stringify(rest)}`;
  return `${patch} refused ${tool} (${failure.code})${message === undefined ? "." : `: ${message}`}${extra}`;
};

/** Plain words for a refusal the agent can act on or relay. */
const runtimeRefusal = (patch: string, failure: ReturnType<typeof Runtime.toFailure>): string => {
  switch (failure.code) {
    case "unknown_outcome":
      return `The change to ${patch} may or may not have happened: it did not finish in time. Read the data before trying again.`;
    case "write_conflict":
      return `${patch} was busy with other changes to the same data. Try the change again.`;
    case "rate_limited":
    case "limit_exceeded":
    case "busy":
      return `${patch} is busy${failure.retryAfter === undefined ? "" : `; try again in ${failure.retryAfter} seconds`}. (${failure.error})`;
    case "handler_failed":
      return `The tool crashed inside ${patch}${failure.correlationId === undefined ? "" : ` (reference ${failure.correlationId})`}. Tell the person; the patch's owner can see what happened in its log.`;
    case "invalid_request":
      return `${patch} refused the arguments: ${failure.error} Call open_patch to check the tool's schema.`;
    default:
      return `${patch} refused: ${failure.error}`;
  }
};

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const agentAuth = yield* AgentAuth.AgentAuth;
    const patches = yield* Patches.Patches;
    const agentCalls = yield* AgentCalls.AgentCalls;
    const canOpen = yield* Patches.Openability;
    const publicBaseUrl = (yield* PatchesConfig.publicBaseUrl).replace(/\/+$/, "");
    const ownOrigin = new URL(publicBaseUrl).origin;

    /** The person's live patches, each with the agent tools its served version offers. */
    const catalogue = Effect.fn("Mcp.catalogue")(function* (
      identity: AgentAuth.AgentPrincipal["identity"],
      ref?: string
    ) {
      const rows = yield* patches.read({
        companyId: identity.company.id,
        userId: identity.user.id,
        state: "live",
        canOpen: (patch) => canOpen(patch, identity.user.id),
        ...(ref === undefined ? {} : { patchRef: ref })
      });
      return yield* Effect.forEach(rows, (row) =>
        Effect.map(row.tier === 2 ? patches.find(row.patch.id) : Effect.succeedNone, (served) => ({
          row,
          manifest: Option.map(served, ({ version }) => version.manifest),
          tools: Option.match(served, {
            onNone: () => [],
            onSome: ({ version }) => AgentCalls.agentTools(version.manifest)
          })
        }))
      );
    });

    const address = (identity: AgentAuth.AgentPrincipal["identity"], name: string) =>
      Patches.address(publicBaseUrl, identity.company.handle, name);

    const findPatches = Effect.fn("Mcp.findPatches")(function* (
      identity: AgentAuth.AgentPrincipal["identity"],
      search: string | undefined
    ) {
      const needle = search?.trim().toLowerCase() ?? "";
      const all = (yield* catalogue(identity)).filter(
        ({ row }) =>
          needle === "" ||
          [row.patch.name, row.patch.title, row.patch.description, row.owner.name].some((field) =>
            field.toLowerCase().includes(needle)
          )
      );
      // Usable patches first; the rest show the agent what exists and whom to ask.
      const ordered = [...all].sort(
        (a, b) =>
          Number(b.tools.length > 0) - Number(a.tools.length > 0) ||
          a.row.patch.name.localeCompare(b.row.patch.name)
      );
      return answer({
        patches: ordered.slice(0, FIND_LIMIT).map(({ row, tools }) => ({
          name: row.patch.name,
          description: row.patch.description === "" ? null : row.patch.description,
          owner: row.owner.name,
          address: address(identity, row.patch.name),
          agentTools: tools.map((tool) => tool.name)
        })),
        ...(ordered.length > FIND_LIMIT
          ? { more: `${ordered.length - FIND_LIMIT} more; search to narrow.` }
          : {}),
        ...(ordered.some(({ tools }) => tools.length === 0)
          ? {
              note: "Patches with no agentTools can't be used by agents yet. Their owners can ask their builder agent to add tools."
            }
          : {})
      });
    });

    /** One patch the person can open, or a refusal naming why not. */
    const resolve = Effect.fn("Mcp.resolve")(function* (
      identity: AgentAuth.AgentPrincipal["identity"],
      raw: string
    ) {
      const ref = patchRef(raw, identity.company.handle);
      if (ref === undefined)
        return refusal(
          `"${raw}" isn't one of ${identity.company.name}'s patches. Use find_patches to see what exists.`
        );
      const found = yield* catalogue(identity, ref).pipe(
        Effect.map((entries) => Option.fromNullishOr(entries[0])),
        Effect.catchTags({
          PatchUnavailable: () => Effect.succeedNone,
          WrongState: () => Effect.succeedNone
        })
      );
      if (Option.isSome(found))
        yield* WideEvents.enrich(Patches.eventFields(found.value.row.patch));
      return Option.match(found, {
        onNone: () =>
          refusal(
            `No live patch called "${ref}" that ${identity.user.name} can open. Use find_patches to see what exists.`
          ),
        onSome: (entry) => entry
      });
    });

    const openPatch = Effect.fn("Mcp.openPatch")(function* (
      identity: AgentAuth.AgentPrincipal["identity"],
      raw: string
    ) {
      const entry = yield* resolve(identity, raw);
      if ("content" in entry) return entry;
      const { row, tools, manifest } = entry;
      const tables = Option.match(manifest, { onNone: () => ({}), onSome: (m) => m.tables });
      return answer({
        name: row.patch.name,
        description: row.patch.description === "" ? null : row.patch.description,
        owner: row.owner.name,
        address: address(identity, row.patch.name),
        version: row.currentVersion,
        tools: tools.map(({ name, descriptor }) => ({
          name,
          kind: kindOf(descriptor),
          description: descriptor.description,
          args: handlerFieldsJsonSchema(descriptor.args, tables),
          returns: handlerJsonSchema(descriptor.result, tables),
          ...(descriptor.errors === undefined ? {} : { refusals: descriptor.errors })
        })),
        ...(tools.length === 0
          ? {
              note:
                row.tier < 2
                  ? `${row.patch.name} has no agent tools: it runs only in the browser. ${row.owner.name}, its owner, can ask their builder agent to move it to tier 2 and add an agent area.`
                  : `${row.patch.name} has no agent tools yet. ${row.owner.name}, its owner, can ask their builder agent to add them.`
            }
          : {})
      });
    });

    const runTool = Effect.fn("Mcp.runTool")(function* (
      principal: AgentAuth.AgentPrincipal,
      authorization: string | undefined,
      call: typeof RunArgs.Type,
      expected: "read" | "change"
    ) {
      const { identity } = principal;
      const entry = yield* resolve(identity, call.patch);
      if ("content" in entry) return entry;
      const { row, tools } = entry;
      const tool = tools.find((candidate) => candidate.name === call.tool);
      if (tool === undefined)
        return refusal(
          tools.length === 0
            ? `${row.patch.name} has no agent tools. Call open_patch for why.`
            : `${row.patch.name} has no agent tool called "${call.tool}" (it may have changed since you opened it). Its tools: ${tools.map((t) => t.name).join(", ")}. Call open_patch for their arguments.`
        );
      const kind = kindOf(tool.descriptor);
      if (kind !== expected)
        return refusal(
          `${call.tool} is a ${kind} tool; call it with ${kind === "read" ? "read_patch" : "change_patch"}.`
        );
      yield* WideEvents.enrich({ handler: tool.handler, kind: tool.descriptor.kind });
      const reply = yield* agentCalls
        .call({
          identity: toRuntimeMe(identity),
          agent: { name: identity.machine.name },
          patchId: row.patch.id,
          handler: tool.handler,
          args: call.args ?? {},
          reauthorize: agentAuth.authenticate(authorization).pipe(
            Effect.map(({ identity }) => toRuntimeMe(identity)),
            Effect.mapError(() => new Runtime.AccessDenied({}))
          )
        })
        .pipe(
          Effect.map((value) => {
            if (value.ok) return answer({ result: value.value });
            return refusal(handlerRefusal(row.patch.name, call.tool, value));
          }),
          Effect.catchTags({
            UnknownTool: () =>
              Effect.succeed(
                refusal(
                  `${row.patch.name} no longer offers ${call.tool}: it changed since you opened it. Call open_patch again.`
                )
              ),
            TierTwoRequired: (error) => Effect.succeed(refusal(error.message))
          }),
          Effect.catch((error) =>
            Effect.succeed(refusal(runtimeRefusal(row.patch.name, Runtime.toFailure(error))))
          )
        );
      return reply;
    });

    const callTool = Effect.fn("Mcp.callTool")(function* (
      access: Exclude<Access, { readonly _tag: "Unauthorized" }>,
      authorization: string | undefined,
      params: Readonly<Record<string, unknown>> | undefined
    ) {
      const call = decodeToolCall(params);
      if (Option.isNone(call)) return Option.none<ToolResult>();
      if (access._tag === "Disabled")
        return Option.some(
          refusal(
            `Agent access is off at ${access.companyName}, so no patch can be used through Patchy's MCP. ${
              access.admins.length === 0
                ? "A company admin"
                : access.admins.map((admin) => `${admin.name} (${admin.email})`).join(" or ")
            } can turn it on at ${publicBaseUrl}/company.`
          )
        );
      const args = call.value.arguments ?? {};
      const invalid = (tool: string) =>
        Option.some(refusal(`Invalid arguments for ${tool}; see its input schema.`));
      switch (call.value.name) {
        case "find_patches": {
          const find = decodeFind(args);
          return Option.isNone(find)
            ? invalid("find_patches")
            : Option.some(yield* findPatches(access.principal.identity, find.value.search));
        }
        case "open_patch": {
          const open = decodeOpen(args);
          return Option.isNone(open)
            ? invalid("open_patch")
            : Option.some(yield* openPatch(access.principal.identity, open.value.patch));
        }
        case "read_patch":
        case "change_patch": {
          const run = decodeRun(args);
          return Option.isNone(run)
            ? invalid(call.value.name)
            : Option.some(
                yield* runTool(
                  access.principal,
                  authorization,
                  run.value,
                  call.value.name === "read_patch" ? "read" : "change"
                )
              );
        }
        default:
          return Option.none<ToolResult>();
      }
    });

    const serverInfo = { name: "patchy", title: "Patchy", version: CURRENT_RELEASE };
    const capabilities = { tools: { listChanged: false } };

    const handle = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const origin = request.headers.origin;
      // A browser page elsewhere never drives this door; agents send no Origin.
      if (origin !== undefined && origin !== ownOrigin)
        return json({ error: "Cross-origin requests are not accepted." }, 403);
      const authorization = request.headers.authorization;
      const access = yield* agentAuth.authenticate(authorization).pipe(
        Effect.map((principal): Access => ({ _tag: "Allowed", principal })),
        Effect.catchTags({
          AgentsDisabled: (disabled) =>
            Effect.succeed<Access>({
              _tag: "Disabled",
              companyName: disabled.companyName,
              admins: disabled.admins
            }),
          AgentUnauthorized: () => Effect.succeed<Access>({ _tag: "Unauthorized" })
        })
      );
      // Unauthenticated, the answer points the client at OAuth discovery.
      if (access._tag === "Unauthorized")
        return json({ error: "unauthorized", error_description: "Connect to Patchy first." }, 401, {
          "www-authenticate": AgentAuth.wwwAuthenticate(publicBaseUrl)
        });
      const body = yield* readBody(MAX_BODY_BYTES).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          MalformedBody: () => Effect.succeedNone,
          BodyTooLarge: () => Effect.succeedNone
        })
      );
      if (Option.isNone(body)) return rpcError(null, -32700, "Parse error.", 400);
      if (Array.isArray(body.value))
        return rpcError(null, -32600, "Batches are not supported.", 400);
      const message = decodeRequest(body.value);
      if (Option.isNone(message)) return rpcError(null, -32600, "Invalid request.", 400);
      const { id, method, params } = message.value;
      // Notifications and responses carry no id and get no answer.
      if (id === undefined) return HttpServerResponse.empty({ status: 202 });
      const identity = access._tag === "Allowed" ? access.principal.identity : undefined;
      switch (method) {
        case "initialize": {
          const requested = params?.["protocolVersion"];
          const protocolVersion =
            typeof requested === "string" &&
            (SUPPORTED_VERSIONS as ReadonlyArray<string>).includes(requested)
              ? requested
              : DEFAULT_VERSION;
          return rpcResult(id, {
            protocolVersion,
            capabilities,
            serverInfo,
            instructions: instructions(identity)
          });
        }
        case "server/discover":
          return rpcResult(id, {
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities,
            serverInfo,
            instructions: instructions(identity),
            ttlMs: 0,
            cacheScope: "private"
          });
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          return rpcResult(id, { tools: TOOLS, ttlMs: 0, cacheScope: "private" });
        case "tools/call": {
          const result = yield* callTool(access, authorization, params);
          return Option.match(result, {
            onNone: () => rpcError(id, -32602, "Unknown tool or invalid tool call."),
            onSome: (value) => rpcResult(id, value)
          });
        }
        default:
          return rpcError(id, -32601, `Method not found: ${method}.`);
      }
    });

    yield* router.add("POST", "/mcp", handle);
    // No server-initiated stream: GET is answered as the spec allows a stateless server to.
    yield* router.add(
      "GET",
      "/mcp",
      Effect.succeed(json({ error: "Use POST." }, 405, { allow: "POST" }))
    );
  })
);

type Access =
  | { readonly _tag: "Allowed"; readonly principal: AgentAuth.AgentPrincipal }
  | {
      readonly _tag: "Disabled";
      readonly companyName: string;
      readonly admins: ReadonlyArray<{ readonly name: string; readonly email: string }>;
    }
  | { readonly _tag: "Unauthorized" };
