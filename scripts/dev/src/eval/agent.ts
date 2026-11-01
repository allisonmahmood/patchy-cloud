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

/** The client name the grader's agent connections carry, which a patch's log shows as "via". */
export const GRADER_AGENT = "Eval grader";

/**
 * Mints an agent connection for each person, by key, with a year-long token.
 * Each token goes to `keep` as soon as it exists, so the sanitizer redacts it
 * even when a later mint fails.
 */
export const mintAgents = Effect.fn("Eval.mintAgents")(function* (
  apiUrl: string,
  people: ReadonlyArray<RunPerson>,
  keep: (token: string) => Effect.Effect<void>
) {
  const tokens = new Map<string, string>();
  for (const person of people) {
    const minted = yield* mintDevAgentConnection({
      email: person.email,
      clientName: GRADER_AGENT,
      // No document names a minted client, so its id is the instance's own address for it.
      clientId: `${apiUrl}/dev/mcp-token`
    }).pipe(Effect.mapError((cause) => new NoAgentConnection({ person: person.name, cause })));
    yield* keep(minted.token);
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
 * call's answer; the door not answering, or answering anything but 200, throws.
 * Each change gets a key of its own under `keys`, which must be new to the
 * person's agent. A thrown error's message never carries the request, whose
 * bearer is the person's token: Playwright's own message, kept only as its
 * `cause`, can.
 */
export const doorAgent = (input: {
  readonly request: Pick<APIRequestContext, "post">;
  readonly apiUrl: string;
  readonly token: string;
  readonly patch: string;
  readonly keys: string;
}): Agent => {
  const { request, apiUrl, token, patch } = input;
  let changes = 0;
  const call = async (name: string, args: Readonly<Record<string, unknown>>) => {
    const response = await request
      .post(`${apiUrl}/mcp`, {
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
      })
      .catch((cause: unknown) => {
        throw new Error(`Patchy MCP didn't answer ${name}.`, { cause });
      });
    if (response.status() !== 200)
      throw new Error(`Patchy MCP answered ${name} with HTTP ${response.status()}.`);
    const text = await response.text().catch((cause: unknown) => {
      throw new Error(`Patchy MCP's answer to ${name} didn't arrive whole.`, { cause });
    });
    try {
      return decodeAnswer(text).result.structuredContent;
    } catch (cause) {
      throw new Error(`Patchy MCP's answer to ${name} isn't one the grader reads.`, { cause });
    }
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

/** What a check looks for in a tool: what it is about, what it does, and names that rule it out. */
export interface ToolWords {
  readonly about: RegExp;
  readonly does: RegExp;
  readonly not?: RegExp;
}

/**
 * The tool of `kind` that best means what `words` say. What it is about
 * counts most, in its name and then its description, before what it does, so
 * a tool named for kudos outranks one named only for listing; a name `not`
 * matches ranks below any that doesn't. Ties keep `open_patch`'s order.
 * Failing any tool that means it, the only tool of that kind.
 */
export const findTool = (
  tools: ReadonlyArray<AgentTool>,
  kind: AgentTool["kind"],
  words: ToolWords
): AgentTool | undefined => {
  const ofKind = tools.filter((tool) => tool.kind === kind);
  const score = (tool: AgentTool) =>
    (words.about.test(tool.name) ? 4 : 0) +
    (words.about.test(tool.description) ? 2 : 0) +
    (words.does.test(tool.name) ? 2 : 0) +
    (words.does.test(tool.description) ? 1 : 0) -
    (words.not?.test(tool.name) === true ? 5 : 0);
  const [best] = ofKind
    .map((tool) => ({ tool, score: score(tool) }))
    .filter((each) => each.score > 0)
    .sort((a, b) => b.score - a.score);
  return best?.tool ?? (ofKind.length === 1 ? ofKind[0] : undefined);
};

/** What a check means to say in a call: who it is about, and its words. */
export interface Meaning {
  readonly person?: RunPerson;
  readonly text?: string;
}

const PERSON_NAME =
  /recipient|colleague|person|people|member|user|teammate|employee|assignee|who|^to$|^to[A-Z_]|^for$/i;
const PERSON_SAID =
  /recipient|colleague|teammate|employee|assignee|\bperson\b|\bmember\b|\buser\b/i;
const TEXT = /message|note|reason|text|body|comment|why|description|thanks|content|shout/i;
const MANY = /limit|count|max|size|take|first|last|per.?page|^n$/i;

const nullable = (schema: JsonSchema) =>
  schema.anyOf?.some((option) => option.type === "null") === true;
const valueOf = (schema: JsonSchema): JsonSchema =>
  schema.anyOf?.find((option) => option.type !== "null") ?? schema;

type Role = "person" | "text" | "plain";

/**
 * What a field is for: inside an object about a person, the person; else
 * what its name says, words before a person, then what its description says
 * when its name says neither.
 */
const roleOf = (field: string, schema: JsonSchema, inPerson: boolean): Role => {
  const said = schema.description ?? "";
  return inPerson
    ? "person"
    : TEXT.test(field)
      ? "text"
      : PERSON_NAME.test(field)
        ? "person"
        : PERSON_SAID.test(said)
          ? "person"
          : TEXT.test(said)
            ? "text"
            : "plain";
};

/**
 * The ways a field about a person can name them, the one its words ask for
 * first: an email, a name, or otherwise the member id the directory knows.
 * Inside an object about a person, a field named for one of them takes only it.
 */
const namings = (field: string, schema: JsonSchema, person: RunPerson, inPerson: boolean) => {
  if (inPerson && /e-?mail/i.test(field)) return [person.email];
  if (inPerson && /name/i.test(field)) return [person.name];
  if (inPerson && /id$/i.test(field)) return [person.id];
  const words = `${field} ${schema.description ?? ""}`;
  return /e-?mail/i.test(words)
    ? [person.email, person.name, person.id]
    : /name/i.test(field) || /\bname\b/i.test(schema.description ?? "")
      ? [person.name, person.email, person.id]
      : [person.id, person.email, person.name];
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
      return {};
    case "string":
      return meaning.text ?? "";
    default:
      return null;
  }
};

/** The values a field can take, and whether the check means anything by it. */
const fillField = (
  field: string,
  schema: JsonSchema,
  meaning: Meaning,
  inPerson: boolean
): { readonly values: ReadonlyArray<unknown>; readonly meant: boolean } => {
  const value = valueOf(schema);
  const role = roleOf(field, schema, inPerson);
  if (value.type === "object" && value.properties !== undefined)
    return fillObject(value, meaning, role === "person");
  if (value.type === "string" && value.enum === undefined) {
    if (role === "person" && meaning.person !== undefined)
      return { values: namings(field, schema, meaning.person, inPerson), meant: true };
    if (role === "text" && meaning.text !== undefined)
      return { values: [meaning.text], meant: true };
  }
  return { values: [plain(field, schema, meaning)], meant: false };
};

const fillObject = (
  schema: JsonSchema,
  meaning: Meaning,
  inPerson: boolean
): { readonly values: ReadonlyArray<Record<string, unknown>>; readonly meant: boolean } => {
  const required = new Set(schema.required ?? []);
  let values: ReadonlyArray<Record<string, unknown>> = [{}];
  let meant = false;
  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    const filled = fillField(field, property, meaning, inPerson);
    if (!filled.meant && !required.has(field)) continue;
    meant ||= filled.meant;
    values = filled.values.flatMap((each) => values.map((args) => ({ ...args, [field]: each })));
  }
  return { values, meant };
};

/**
 * Arguments for a tool, from its schema and what the check means: a field
 * about a person names `meaning.person`, by its name or, when that says
 * nothing, its description, and so does every field of an object about a
 * person; a field of words says `meaning.text`; any other required field gets
 * a plain value. Optional fields are left out unless the check means
 * something for them. A person can be named three ways, so this answers each,
 * the field's own words first; a check tries them in order until one isn't
 * refused.
 */
export const argsFor = (schema: JsonSchema, meaning: Meaning) =>
  fillObject(schema, meaning, false).values;

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
