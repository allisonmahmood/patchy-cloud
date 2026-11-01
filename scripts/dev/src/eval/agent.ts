/**
 * Checks that act as a person's own agent: an agent connection minted for
 * them straight into the side's database, as `pnpm dev mcp-token` mints one,
 * then the target's tools through Patchy MCP at `/mcp`, as any worker agent
 * reaches them: `open_patch` to list them, `read_patch` and `change_patch` to
 * call one. The door holds no session, so each call is one POST.
 *
 * Builders name and shape their tools themselves, so a check finds a tool by
 * its kind and words (`findTool`) and fills its arguments from its schema
 * (`argsFor`), as an agent reading `open_patch` would.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { APIRequestContext } from "@playwright/test";
import { AgentConnections } from "@patchy/auth";
import { mintDevAgentConnection } from "@patchy/auth/seed";
import type { Agent, AgentCall, AgentTool, JsonSchema, RunPerson } from "./task.js";

/** The grader couldn't give a person's agent a connection: its trouble, not the builder's. */
export class NoAgentConnection extends Schema.TaggedError<NoAgentConnection>()(
  "NoAgentConnection",
  { person: Schema.String, cause: Schema.Defect() }
) {
  override get message() {
    return `The grader couldn't connect ${this.person}'s agent.`;
  }
}

/** Mints an agent connection for each person, by key, with a year-long token. */
export const mintAgents = Effect.fn("Eval.mintAgents")(function* (
  apiUrl: string,
  people: ReadonlyArray<RunPerson>
) {
  const tokens = new Map<string, string>();
  for (const person of people) {
    const minted = yield* mintDevAgentConnection({
      email: person.email,
      clientName: "Eval grader",
      // No document names a minted client, so its id is the instance's own address for it.
      clientId: `${apiUrl}/dev/mcp-token`
    }).pipe(Effect.mapError((cause) => new NoAgentConnection({ person: person.name, cause })));
    tokens.set(person.key, minted.token);
  }
  return tokens;
}, Effect.provide(AgentConnections.layer));

/** The parts of a tool's argument schema checks read; the rest is ignored. */
const JsonSchemaValue: Schema.Codec<JsonSchema> = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  enum: Schema.optionalKey(Schema.Array(Schema.String)),
  properties: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchemaValue)
    )
  ),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  items: Schema.optionalKey(Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchemaValue)),
  anyOf: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchemaValue))
  ),
  minimum: Schema.optionalKey(Schema.Number),
  maximum: Schema.optionalKey(Schema.Number)
});

const ToolCallAnswer = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      result: Schema.optionalKey(Schema.Unknown),
      tools: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            kind: Schema.Literals(["read", "change"]),
            description: Schema.String,
            args: JsonSchemaValue
          })
        )
      ),
      error: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String }))
    })
  })
});
const decodeAnswer = Schema.decodeUnknownSync(Schema.fromJsonString(ToolCallAnswer));

/**
 * A person's agent on one patch, over `request`. A refusal comes back as the
 * call's answer; only the door itself answering anything but 200 throws.
 * Each change gets a key of its own under `keys`, which must be new to the
 * person's agent.
 */
export const doorAgent = (input: {
  readonly request: APIRequestContext;
  readonly apiUrl: string;
  readonly token: string;
  readonly patch: string;
  readonly keys: string;
}): Agent => {
  const { request, apiUrl, token, patch } = input;
  let changes = 0;
  const call = async (name: string, args: Readonly<Record<string, unknown>>) => {
    const response = await request.post(`${apiUrl}/mcp`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18"
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { patch, ...args } }
      }
    });
    if (response.status() !== 200)
      throw new Error(`Patchy MCP answered ${name} with HTTP ${response.status()}.`);
    return decodeAnswer(await response.text()).result.structuredContent;
  };
  return {
    tools: async () => {
      const opened = await call("open_patch", {});
      if (opened.error !== undefined)
        throw new Error(`open_patch refused (${opened.error.code}): ${opened.error.message}`);
      return opened.tools ?? [];
    },
    call: async (tool, args): Promise<AgentCall> => {
      const answer = await call(
        tool.kind === "read" ? "read_patch" : "change_patch",
        tool.kind === "read"
          ? { tool: tool.name, args }
          : { tool: tool.name, args, key: `${input.keys}-${++changes}` }
      );
      return answer.error === undefined
        ? { ok: true, result: answer.result }
        : { ok: false, code: answer.error.code, message: answer.error.message };
    }
  };
};

/**
 * The tool of `kind` that `words` pick, most telling first: for each, a tool
 * whose name matches it, then one whose description does. Failing all, the
 * only tool of that kind.
 */
export const findTool = (
  tools: ReadonlyArray<AgentTool>,
  kind: AgentTool["kind"],
  words: ReadonlyArray<RegExp>
): AgentTool | undefined => {
  const ofKind = tools.filter((tool) => tool.kind === kind);
  for (const said of words) {
    const found =
      ofKind.find((tool) => said.test(tool.name)) ??
      ofKind.find((tool) => said.test(tool.description));
    if (found !== undefined) return found;
  }
  return ofKind.length === 1 ? ofKind[0] : undefined;
};

/** What a check means to say in a call: who it is about, and its words. */
export interface Meaning {
  readonly person?: RunPerson;
  readonly text?: string;
}

const PERSON =
  /recipient|colleague|person|people|member|user|teammate|employee|assignee|who|^to$|^to[A-Z_]|^for$/i;
const TEXT = /message|note|reason|text|body|comment|why|description|thanks|content|shout/i;
const MANY = /limit|count|max|size|take|first|last|per.?page|^n$/i;

const nullable = (schema: JsonSchema) =>
  schema.anyOf?.some((option) => option.type === "null") === true;
const valueOf = (schema: JsonSchema): JsonSchema =>
  schema.anyOf?.find((option) => option.type !== "null") ?? schema;

/**
 * The ways a field about a person can name them, the one its words ask for
 * first: an email, a name, or otherwise the member id the directory knows.
 */
const namings = (field: string, schema: JsonSchema, person: RunPerson) => {
  const words = `${field} ${schema.description ?? ""}`;
  const order = /e-?mail/i.test(words)
    ? [person.email, person.name, person.id]
    : /name/i.test(field) || /\bname\b/i.test(schema.description ?? "")
      ? [person.name, person.email, person.id]
      : [person.id, person.email, person.name];
  return order;
};

/**
 * One value for a field an agent has no reason to vary: an enum's first
 * value, `null` where allowed, false, a generous count, nothing in a list,
 * and the check's words for any other text.
 */
const plain = (field: string, schema: JsonSchema, meaning: Meaning): unknown => {
  if (nullable(schema)) return null;
  const value = valueOf(schema);
  if (value.enum !== undefined && value.enum.length > 0) return value.enum[0];
  switch (value.type) {
    case "boolean":
      return false;
    case "integer":
    case "number":
      return Math.min(
        Math.max(MANY.test(field) ? 50 : 1, value.minimum ?? -Infinity),
        value.maximum ?? Infinity
      );
    case "array":
      return [];
    case "object":
      return value.properties === undefined ? {} : (argsFor(value, meaning)[0] ?? {});
    case "string":
      return meaning.text ?? "";
    default:
      return null;
  }
};

/**
 * Arguments for a tool, from its schema and what the check means: a field
 * about a person names `meaning.person`, a field of words says
 * `meaning.text`, and any other required field gets a plain value. Optional
 * fields are left out unless the check means something for them. A person
 * can be named three ways, so this answers each, the field's own words first;
 * a check tries them in order until one isn't refused.
 */
export const argsFor = (
  schema: JsonSchema,
  meaning: Meaning
): ReadonlyArray<Record<string, unknown>> => {
  const required = new Set(schema.required ?? []);
  let candidates: Array<Record<string, unknown>> = [{}];
  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    const value = valueOf(property);
    const words = `${field} ${property.description ?? ""}`;
    const text = value.type === "string" && value.enum === undefined;
    if (meaning.person !== undefined && text && PERSON.test(field)) {
      const person = meaning.person;
      candidates = namings(field, property, person).flatMap((name) =>
        candidates.map((args) => ({ ...args, [field]: name }))
      );
    } else if (meaning.text !== undefined && text && TEXT.test(words)) {
      candidates = candidates.map((args) => ({ ...args, [field]: meaning.text }));
    } else if (required.has(field)) {
      const filled = plain(field, property, meaning);
      candidates = candidates.map((args) => ({ ...args, [field]: filled }));
    }
  }
  return candidates;
};

/**
 * The innermost object in a tool's result holding `text` in one of its own
 * strings: a listed entry, however the list around it is shaped.
 */
export const entryWith = (result: unknown, text: string): object | undefined => {
  if (Array.isArray(result)) {
    for (const item of result) {
      const found = entryWith(item, text);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof result !== "object" || result === null) return undefined;
  const values = Object.values(result);
  for (const value of values) {
    const found = typeof value === "object" ? entryWith(value, text) : undefined;
    if (found !== undefined) return found;
  }
  return values.some((value) => typeof value === "string" && value.includes(text))
    ? result
    : undefined;
};

/** Whether an entry names the person: their member id, email or name, anywhere in it. */
export const mentions = (entry: object, person: RunPerson) => {
  const json = JSON.stringify(entry);
  return [person.id, person.email, person.name].some((name) => json.includes(name));
};
