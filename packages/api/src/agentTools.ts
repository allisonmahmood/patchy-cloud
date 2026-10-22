/**
 * What an agent is shown of a patch's agent area, shared so the door, `patchy dev agent`, the
 * card and the publish check all show the same thing: handler descriptors as JSON Schema
 * 2020-12, `open_patch`'s tools, the agent area check, and the shapes of a tool call's answer
 * (docs/product.md › Patchy MCP).
 */
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  agentToolName,
  handlerValues,
  serverAgentModuleFix,
  unknownRowRefusal,
  type HandlerDescriptor,
  type HandlerDescriptors,
  type HandlerSchema
} from "./handlers.js";
import type { HandlerFailure, RuntimeFailure, ServerCallReply } from "./runtime.js";
import type { ColumnDefinition, TableDefinition } from "./schemas.js";

/** The subset of JSON Schema 2020-12 that handler values map onto. `{}` is any value. */
export interface JsonSchema {
  readonly type?: "string" | "integer" | "number" | "boolean" | "object" | "array" | "null";
  readonly description?: string;
  readonly format?: "date-time";
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly items?: JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
}

type Tables = Readonly<Record<string, typeof TableDefinition.Type>>;

const int32 = { type: "integer", minimum: -2147483648, maximum: 2147483647 } as const;
const dateTime = { type: "string", format: "date-time" } as const;

const described = (schema: JsonSchema, description: string | undefined): JsonSchema =>
  description === undefined ? schema : { ...schema, description };

/** The value or null. The value's description moves to the wrapper, where an outer one wins. */
const nullable = ({ description, ...value }: JsonSchema): JsonSchema =>
  described({ anyOf: [value, { type: "null" }] }, description);

const column = (definition: typeof ColumnDefinition.Type): JsonSchema => {
  switch (definition.kind) {
    case "text":
    case "member":
    case "ref":
      return { type: "string" };
    case "integer":
      return int32;
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "timestamp":
      return dateTime;
    case "json":
      return {};
  }
};

/**
 * The rows one shaping has built, by table: each is built once and shared by every value naming
 * it, so a row many tools return costs its size once in memory and in `jsonBytes`.
 */
type Rows = Map<string, JsonSchema>;

/** The full stored row, all keys required and optional columns nullable. */
const row = (name: string, tables: Tables, rows: Rows): JsonSchema => {
  let shared = rows.get(name);
  if (shared === undefined) rows.set(name, (shared = tableRow(name, tables)));
  return shared;
};

const tableRow = (name: string, tables: Tables): JsonSchema => {
  const table = Object.hasOwn(tables, name) ? tables[name] : undefined;
  // The agent area check refuses an unknown table before anything is shaped.
  if (table === undefined) throw new TypeError(`Unknown row table "${name}".`);
  const columns = Object.entries(table.columns).map(
    ([field, definition]): readonly [string, JsonSchema] => [
      field,
      definition.optional === true ? nullable(column(definition)) : column(definition)
    ]
  );
  const properties = Object.fromEntries<JsonSchema>([
    ["id", { type: "string" }],
    ["createdAt", dateTime],
    ["updatedAt", dateTime],
    ...columns
  ]);
  return {
    type: "object",
    description: `A row of ${name}: ${table.description}`,
    properties,
    required: Object.keys(properties),
    additionalProperties: false
  };
};

/**
 * One handler value as JSON Schema, keeping its description. A row describes itself by its
 * table unless the value has its own description. Uploads and file handles never cross
 * Patchy MCP, so the agent area check refuses them before anything is shaped.
 */
export const handlerJsonSchema = (schema: HandlerSchema, tables: Tables): JsonSchema =>
  valueSchema(schema, tables, new Map());

/** A handler's arguments, or an object's fields, as one closed object. */
export const argsJsonSchema = (
  fields: Readonly<Record<string, HandlerSchema>>,
  tables: Tables
): JsonSchema => fieldsSchema(fields, tables, new Map());

const valueSchema = (schema: HandlerSchema, tables: Tables, rows: Rows): JsonSchema => {
  switch (schema.kind) {
    case "text":
      return described({ type: "string" }, schema.description);
    case "integer":
      return described(int32, schema.description);
    case "number":
      return described({ type: "number" }, schema.description);
    case "boolean":
      return described({ type: "boolean" }, schema.description);
    case "timestamp":
      return described(dateTime, schema.description);
    case "json":
      return described({}, schema.description);
    case "enum":
      return described({ type: "string", enum: schema.values }, schema.description);
    case "object":
      return described(fieldsSchema(schema.fields, tables, rows), schema.description);
    case "array":
      return described(
        { type: "array", items: valueSchema(schema.element, tables, rows) },
        schema.description
      );
    case "nullable":
      return described(nullable(valueSchema(schema.value, tables, rows)), schema.description);
    case "row":
      return described(row(schema.table, tables, rows), schema.description);
    case "fileHandle":
    case "upload":
      throw new TypeError(`An agent tool can't take or return t.${schema.kind}().`);
  }
};

const fieldsSchema = (
  fields: Readonly<Record<string, HandlerSchema>>,
  tables: Tables,
  rows: Rows
): JsonSchema => {
  const entries = Object.entries(fields);
  return {
    type: "object",
    properties: Object.fromEntries(
      entries.map(([name, field]) => [name, valueSchema(field, tables, rows)] as const)
    ),
    required: entries.filter(([, field]) => field.optional !== true).map(([name]) => name),
    additionalProperties: false
  };
};

/** A read never runs a Patchy write: a query or a read-only action. Everything else changes. */
export type AgentToolKind = "read" | "change";

export const agentToolKind = (
  descriptor: Pick<HandlerDescriptor, "kind" | "readOnly">
): AgentToolKind =>
  descriptor.kind === "query" || descriptor.readOnly === true ? "read" : "change";

/**
 * A manifest's agent tools by tool name, in the order every surface shows them: by name, by
 * code unit, so it holds however the manifest's keys were stored. It reads only the mark, so a
 * catalogue can pass descriptors without their schemas.
 */
export const agentToolEntries = <D extends Pick<HandlerDescriptor, "agentTool">>(
  handlers: Readonly<Record<string, D>> | undefined
): ReadonlyArray<readonly [tool: string, descriptor: D]> =>
  Object.entries(handlers ?? {})
    .filter(([, descriptor]) => descriptor.agentTool === true)
    .map(([handler, descriptor]) => [agentToolName(handler), descriptor] as const)
    .sort(([left], [right]) => byCodeUnit(left, right));

/** What a descriptor says of a tool without its schemas: its mark, kind and words. */
export type AgentToolMarks = Pick<
  HandlerDescriptor,
  "agentTool" | "kind" | "readOnly" | "description"
>;

/** A tool as `find_patches` lists it with `detail: "tools"`: `open_patch`'s, without schemas. */
export interface AgentToolSummary {
  readonly name: string;
  readonly kind: AgentToolKind;
  readonly description: string;
}

/** A manifest's agent tools in `open_patch`'s order, each without its schemas. */
export const agentToolSummaries = (
  handlers: Readonly<Record<string, AgentToolMarks>> | undefined
): readonly AgentToolSummary[] =>
  agentToolEntries(handlers).map(([name, descriptor]) => ({
    name,
    kind: agentToolKind(descriptor),
    // The check refuses a tool without one.
    description: descriptor.description ?? ""
  }));

const byCodeUnit = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** One tool as `open_patch` shows it. `refusals` lists the tool's declared error codes. */
export interface AgentTool {
  readonly name: string;
  readonly kind: AgentToolKind;
  readonly description: string;
  readonly args: JsonSchema;
  readonly returns: JsonSchema;
  readonly refusals?: readonly string[];
}

/** A checked manifest's agent tools, rows expanded. */
export const agentTools = (manifest: {
  readonly tables: Tables;
  readonly handlers?: HandlerDescriptors;
}): readonly AgentTool[] => {
  const rows: Rows = new Map();
  return agentToolEntries(manifest.handlers).map(([name, descriptor]) => ({
    name,
    kind: agentToolKind(descriptor),
    // The check refuses a tool without one.
    description: descriptor.description ?? "",
    args: fieldsSchema(descriptor.args, manifest.tables, rows),
    returns: valueSchema(descriptor.result, manifest.tables, rows),
    ...(descriptor.errors === undefined || descriptor.errors.length === 0
      ? {}
      : { refusals: descriptor.errors })
  }));
};

/** The most UTF-8 bytes of `open_patch`'s compact JSON answer. */
export const openPatchBytes = 64 * 1024;
/**
 * The most a patch's tools may take of it. The other 4 KiB holds the patch's name, its
 * description (at most 500 characters), its owner (cut at 200) and its address, which change
 * without a publish, so no edit or reassignment pushes a published patch past the answer's cap.
 */
export const agentToolsBytes = 60 * 1024;
const ownerLimit = 200;

/**
 * `open_patch`'s answer: the patch, who owns it and its tools. `find_patches` lists each patch
 * in the same shape, with its tools' names, or their summaries.
 */
export const openPatchAnswer = <Tools extends readonly unknown[] = readonly AgentTool[]>(
  patch: {
    readonly name: string;
    readonly description: string;
    readonly owner: string;
    readonly address: string;
  },
  tools: Tools
) => ({
  name: patch.name,
  description: patch.description,
  owner: [...patch.owner].slice(0, ownerLimit).join(""),
  address: patch.address,
  tools
});

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).length;

/**
 * The UTF-8 bytes of `JSON.stringify(value)`, counted without building it. Each object is counted
 * once however often it appears, so a row every tool repeats costs its size once and the count
 * stays linear in the manifest, where the string could outgrow what a string may hold.
 */
const jsonBytes = (value: unknown, counted = new WeakMap<object, number>()): number => {
  if (value === null) return 4;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return utf8Bytes(JSON.stringify(value));
  if (typeof value !== "object") return 0;
  const known = counted.get(value);
  if (known !== undefined) return known;
  // Brackets, and a comma between each pair of entries.
  let bytes = 2;
  if (Array.isArray(value)) {
    for (const item of value) bytes += jsonBytes(item, counted);
    bytes += Math.max(value.length - 1, 0);
  } else {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    for (const [key, item] of entries)
      bytes += utf8Bytes(JSON.stringify(key)) + 1 + jsonBytes(item, counted);
    bytes += Math.max(entries.length - 1, 0);
  }
  counted.set(value, bytes);
  return bytes;
};

/**
 * The agent area check's refusal. Each names the tool, or the handler `server/agent.ts` built;
 * the CLI adds a tool's file, and the size belongs to the whole area.
 */
export const AgentAreaProblem = Schema.Union([
  Schema.TaggedStruct("Undescribed", { tool: Schema.String }),
  Schema.TaggedStruct("FileValue", {
    tool: Schema.String,
    value: Schema.String,
    uses: Schema.Literals(["upload", "fileHandle"])
  }),
  Schema.TaggedStruct("UnknownTable", {
    tool: Schema.String,
    value: Schema.String,
    table: Schema.String
  }),
  Schema.TaggedStruct("TooLarge", { bytes: Schema.Number }),
  /** An `agent.*` handler without the agent tool mark, which only `server/agent.ts` builds. */
  Schema.TaggedStruct("ServerAgentModule", { handler: Schema.String })
]);
export type AgentAreaProblem = typeof AgentAreaProblem.Type;

/** What a problem says: what's wrong, then how to fix it. */
export const agentAreaRefusal = (problem: AgentAreaProblem): string => {
  switch (problem._tag) {
    case "Undescribed":
      return `${problem.tool} needs a description: it is all an agent knows about the tool. Say what it does, what it changes and when it refuses.`;
    case "FileValue":
      return `${problem.tool} uses t.${problem.uses}() in ${problem.value}. Agent tools exchange JSON only; files stay on the page.`;
    case "UnknownTable":
      return unknownRowRefusal(problem.tool, problem.value, problem.table);
    case "ServerAgentModule":
      return `${problem.handler} comes from server/agent.ts. ${serverAgentModuleFix}`;
    case "TooLarge":
      return `An agent reads all of this patch's tools in one answer of at most ${openPatchBytes / 1024} KiB, and the tools get ${agentToolsBytes / 1024} KiB of it; yours come to ${Math.ceil(problem.bytes / 1024)} KiB. Shorten descriptions or drop tools.`;
  }
};

const toolProblem = (
  tool: string,
  descriptor: HandlerDescriptor,
  tables: Tables
): AgentAreaProblem | undefined => {
  if (descriptor.description === undefined) return { _tag: "Undescribed", tool };
  for (const { path, schema } of handlerValues(descriptor)) {
    if (schema.kind === "upload" || schema.kind === "fileHandle")
      return { _tag: "FileValue", tool, value: path, uses: schema.kind };
    if (schema.kind === "row" && !Object.hasOwn(tables, schema.table))
      return { _tag: "UnknownTable", tool, value: path, table: schema.table };
  }
  return undefined;
};

/**
 * The agent area check, run by the CLI in watched dev builds and before sending a publish, and
 * by the instance on the descriptors it inspects from the stored bundle. Description length is
 * `descriptionProblem`'s, for every handler. An unmarked `agent.*` handler is refused first, then
 * tools are checked in name order, so both report the same first problem. `warnings` name
 * undescribed top-level arguments, at publish only.
 */
export const checkAgentArea = (manifest: {
  readonly tables: Tables;
  readonly handlers?: HandlerDescriptors;
}): { readonly problem?: AgentAreaProblem; readonly warnings: readonly string[] } => {
  // Only server/agent.ts builds an agent.* handler without the mark. Read from an older version
  // it stays a page handler; a new version is refused.
  const [unmarked] = Object.entries(manifest.handlers ?? {})
    .filter(([name, descriptor]) => name.startsWith("agent.") && descriptor.agentTool !== true)
    .map(([name]) => name)
    .sort(byCodeUnit);
  if (unmarked !== undefined)
    return { problem: { _tag: "ServerAgentModule", handler: unmarked }, warnings: [] };
  const entries = agentToolEntries(manifest.handlers);
  for (const [tool, descriptor] of entries) {
    const problem = toolProblem(tool, descriptor, manifest.tables);
    if (problem !== undefined) return { problem, warnings: [] };
  }
  const tools = agentTools(manifest);
  const bytes = jsonBytes(tools);
  if (bytes > agentToolsBytes) return { problem: { _tag: "TooLarge", bytes }, warnings: [] };
  const warnings = tools.flatMap((tool) => {
    const undescribed = Object.entries(tool.args.properties ?? {})
      .filter(([, schema]) => schema.description === undefined)
      .map(([name]) => name);
    if (undescribed.length === 0) return [];
    const names =
      undescribed.length === 1
        ? `argument ${undescribed[0]} has`
        : `arguments ${undescribed.slice(0, -1).join(", ")} and ${undescribed.at(-1)} have`;
    return [
      `${tool.name}'s ${names} no description, so an agent knows only the name and type. Add .describe() where the name doesn't say enough.`
    ];
  });
  return { warnings };
};

/**
 * A refusal's structured part: who refused, the code, and the message that says what
 * happened and then what to do. A patch's own refusal keeps its code and details unchanged.
 */
export const ToolRefusal = Schema.Struct({
  code: Schema.String,
  from: Schema.Literals(["patch", "patchy"]),
  message: Schema.String,
  details: Schema.optionalKey(Schema.Json),
  retryAfterSeconds: Schema.optionalKey(Schema.Int)
});
export type ToolRefusal = typeof ToolRefusal.Type;

/**
 * A `read_patch` or `change_patch` success: the result and the version the call ran on.
 * `replayed` marks a change key's retry of a committed change, which wrote nothing. A change
 * whose result is too large for an agent to read leaves it out, saying so in `resultLeftOut`.
 */
export const CallSuccess = Schema.Struct({
  result: Schema.optionalKey(Schema.Json),
  version: Schema.Int,
  replayed: Schema.optionalKey(Schema.Literal(true)),
  resultLeftOut: Schema.optionalKey(Schema.String)
});
export type CallSuccess = typeof CallSuccess.Type;

/**
 * A tool call's answer. A success carries its document twice, as compact JSON text and as
 * `structuredContent`; a refusal's text is its message, followed by any details a patch gave.
 */
export interface ToolCallResult {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: Readonly<Record<string, unknown>>;
  readonly isError?: true;
}

/** A catalogue answer, or a read or change's `CallSuccess`. */
export const toolAnswer = (document: Readonly<Record<string, unknown>>): ToolCallResult => ({
  content: [{ type: "text", text: JSON.stringify(document) }],
  structuredContent: document
});

/** A refusal. Patchy's messages say what happened and then what to do on their own. */
export const toolRefusal = (error: ToolRefusal, text = error.message): ToolCallResult => ({
  content: [{ type: "text", text }],
  structuredContent: { error },
  isError: true
});

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * What a refusal repeats of a tool's name, as the agent sent it or a builder chose it, or of a
 * schema's words about the arguments, cut short so the refusal's own words always reach the
 * agent within the read cap.
 */
const repeated = (text: string, limit: number) =>
  [...text].length > limit ? `${[...text].slice(0, limit - 1).join("")}…` : text;
const repeatedName = 128;
const repeatedProblem = 2_000;

/**
 * A patch's own refusal of a tool, such as "New Business refused addLead (missing_fields):
 * give every field." A string `message` in its details says what to do; the rest of the
 * details follow in the text, and all of them stay in `structuredContent` unchanged.
 */
export const patchRefusal = (
  patch: string,
  tool: string,
  failure: Pick<HandlerFailure, "code" | "details">
): ToolCallResult => {
  const { details } = failure;
  const record = Predicate.isObject(details) ? details : undefined;
  const said = Predicate.isString(record?.["message"]) ? record["message"] : undefined;
  const rest =
    record === undefined
      ? details
      : Object.fromEntries(Object.entries(record).filter(([key]) => key !== "message"));
  // Without its own words, the tool's description is where the agent learns what to do.
  const message = `${patch} refused ${repeated(tool, repeatedName)} (${failure.code})${said === undefined ? ". Its description in open_patch says when it refuses and what to do." : `: ${sentence(said)}`}`;
  const extra =
    rest === undefined || (Predicate.isObject(rest) && Object.keys(rest).length === 0)
      ? ""
      : ` Details: ${JSON.stringify(rest)}`;
  return toolRefusal(
    {
      code: failure.code,
      from: "patch",
      message,
      ...(details === undefined ? {} : { details })
    },
    `${message}${extra}`
  );
};

/** The tools a patch has now, read from the version a call would run on, and where to look. */
const toolsNow = (tools: readonly string[]) =>
  `${tools.length === 0 ? "It has no agent tools now." : `Its tools now: ${tools.join(", ")}.`} Call open_patch to see what each does and takes.`;

/** A call naming a tool the patch doesn't have: it names the tools it has now. */
export const unknownToolRefusal = (
  patch: string,
  tool: string,
  tools: readonly string[]
): ToolCallResult =>
  toolRefusal({
    code: "unknown_tool",
    from: "patchy",
    message: `${patch} has no tool ${repeated(tool, repeatedName)}. ${toolsNow(tools)}`
  });

/**
 * Arguments the tool's schema refuses, in the schema's own words for what and where. A publish
 * may have changed the schema since the agent read it, so it names the tools the patch has now.
 */
export const invalidArgsRefusal = (
  tool: string,
  problem: string,
  tools: readonly string[]
): ToolCallResult =>
  toolRefusal({
    code: "invalid_args",
    from: "patchy",
    message: `${repeated(tool, repeatedName)}'s arguments don't fit its schema: ${repeated(problem, repeatedProblem)}. ${toolsNow(tools)}`
  });

/**
 * A tool named on the door's tool for the other kind: a change through `read_patch`, or a read
 * through `change_patch`. A publish may have flipped its kind since the agent read it, so it
 * names the tools the patch has now.
 */
export const wrongKindRefusal = (
  patch: string,
  tool: string,
  kind: AgentToolKind,
  tools: readonly string[]
): ToolCallResult =>
  toolRefusal({
    code: "wrong_kind",
    from: "patchy",
    message: `${repeated(tool, repeatedName)} is one of ${patch}'s ${kind} tools, so call it with ${kind === "read" ? "read_patch" : "change_patch"}. ${toolsNow(tools)}`
  });

/** The refusals of an action that ran out of time, at any depth, or whose outcome is unknown. */
const unfinished = new Set<string>(["handler_timeout", "timeout", "unknown_outcome"]);

/**
 * Patchy's own refusal of a call, from Runtime's failure: its code and message, any correlation
 * id the message points to, its details, and the wait before a retry when one is safe. An
 * action that can write and didn't finish may have written some of it, so it says so.
 */
export const runtimeRefusal = (
  failure: RuntimeFailure,
  tool: Pick<HandlerDescriptor, "kind" | "readOnly">
): ToolCallResult => {
  const partly =
    tool.kind === "action" && agentToolKind(tool) === "change" && unfinished.has(failure.code)
      ? " It may have partly happened: read what it changes before trying again, with a new change key."
      : "";
  const correlation =
    failure.correlationId === undefined ? "" : ` Correlation id: ${failure.correlationId}.`;
  return toolRefusal({
    code: failure.code,
    from: "patchy",
    message: `${failure.error}${partly}${correlation}`,
    ...(failure.details === undefined ? {} : { details: failure.details }),
    ...(failure.retryAfter === undefined
      ? {}
      : { retryAfterSeconds: Math.ceil(failure.retryAfter) })
  });
};

/**
 * A started call's answer: its result and the version it ran on, or the patch's own refusal.
 * Patchy's refusals of the call are `runtimeRefusal`'s.
 */
export const callAnswer = (
  patch: string,
  tool: string,
  version: number,
  reply: ServerCallReply
): ToolCallResult =>
  reply.ok
    ? toolAnswer({ result: reply.value, version } satisfies CallSuccess)
    : patchRefusal(patch, tool, reply);

/** The most characters of a read's compact JSON answer, which an agent reads whole. */
export const readAnswerChars = 100_000;

/** The most characters of a refusal's words kept when its details are left out. */
const keptWords = 2_000;

const counted = (count: number) => count.toLocaleString("en-US");
const decodeRefusal = Schema.decodeUnknownOption(ToolRefusal);

/**
 * A refusal within the read cap, measured once on the compact JSON text the agent reads: past
 * `readAnswerChars` it keeps its code, its words (cut at 2,000 characters) and any retry wait,
 * leaving its details out. A long tool name or a schema's words about long arguments can make
 * even Patchy's own refusal that long.
 */
export const fitRefusal = (answer: ToolCallResult): ToolCallResult => {
  const chars = answer.content[0].text.length;
  if (answer.isError !== true || chars <= readAnswerChars) return answer;
  const { code, from, message, retryAfterSeconds } = Option.getOrElse(
    decodeRefusal(answer.structuredContent["error"]),
    (): ToolRefusal => ({
      code: "too_large",
      from: "patchy",
      message: "The refusal was too long to send."
    })
  );

  const words = repeated(message, keptWords);
  return toolRefusal({
    code,
    from,
    message: `${words} Its details were left out: the refusal came to ${counted(chars)} characters, more than the ${counted(readAnswerChars)} an agent reads in one answer.`,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  });
};

/**
 * A read's answer as the agent gets it, measured once on the compact JSON text it reads: a
 * result past `readAnswerChars` is refused `too_large` without it, and a refusal is `fitRefusal`'s.
 */
export const readAnswer = (
  patch: { readonly name: string; readonly owner: string },
  tool: string,
  answer: ToolCallResult
): ToolCallResult => {
  const chars = answer.content[0].text.length;
  if (answer.isError === true) return fitRefusal(answer);
  if (chars <= readAnswerChars) return answer;
  return toolRefusal({
    code: "too_large",
    from: "patchy",
    message: `${patch.name}'s ${tool} answered with ${counted(chars)} characters, more than the ${counted(readAnswerChars)} an agent reads in one answer, so nothing was sent. Narrow the call; the patch's owner, ${[...patch.owner].slice(0, ownerLimit).join("")}, can add paging.`
  });
};

/**
 * A change's answer as the agent gets it, measured as a read's is. A change has happened by the
 * time it answers, so a result past `readAnswerChars` is still a success, on `version`, with
 * the result left out and `resultLeftOut` saying so, still `replayed` if it was; a refusal is
 * `fitRefusal`'s.
 */
export const changeAnswer = (
  tool: string,
  version: number,
  answer: ToolCallResult
): ToolCallResult => {
  const chars = answer.content[0].text.length;
  if (answer.isError === true) return fitRefusal(answer);
  if (chars <= readAnswerChars) return answer;
  return toolAnswer({
    version,
    ...(answer.structuredContent["replayed"] === true ? { replayed: true as const } : {}),
    resultLeftOut: `${tool} succeeded, but its result came to ${counted(chars)} characters, more than the ${counted(readAnswerChars)} an agent reads in one answer, so it was left out. Read what you need of the change through the patch's read tools.`
  } satisfies CallSuccess);
};
