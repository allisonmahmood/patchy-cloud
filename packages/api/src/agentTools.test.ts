import { describe, expect, it } from "vitest";
import {
  agentAreaRefusal,
  agentTools,
  agentToolsBytes,
  argsJsonSchema,
  checkAgentArea,
  handlerJsonSchema,
  openPatchAnswer,
  patchRefusal,
  toolAnswer,
  toolRefusal,
  type HandlerDescriptor,
  type HandlerDescriptors,
  type HandlerSchema
} from "./index.js";

const tables = {
  leads: {
    description: "One sales lead, keyed by company.",
    columns: {
      company: { kind: "text" as const },
      score: { kind: "integer" as const, default: 1 },
      amount: { kind: "number" as const, optional: true },
      won: { kind: "boolean" as const },
      metAt: { kind: "timestamp" as const, optional: true },
      notes: { kind: "json" as const },
      owner: { kind: "member" as const, optional: true },
      parent: { kind: "ref" as const, table: "leads", optional: true }
    },
    indexes: {}
  }
};
const int32 = { type: "integer", minimum: -2147483648, maximum: 2147483647 };
const dateTime = { type: "string", format: "date-time" };
const nullable = (value: object) => ({ anyOf: [value, { type: "null" }] });
const leadRow = {
  type: "object",
  description: "A row of leads: One sales lead, keyed by company.",
  properties: {
    id: { type: "string" },
    createdAt: dateTime,
    updatedAt: dateTime,
    company: { type: "string" },
    score: int32,
    amount: nullable({ type: "number" }),
    won: { type: "boolean" },
    metAt: nullable(dateTime),
    notes: {},
    owner: nullable({ type: "string" }),
    parent: nullable({ type: "string" })
  },
  required: [
    "id",
    "createdAt",
    "updatedAt",
    "company",
    "score",
    "amount",
    "won",
    "metAt",
    "notes",
    "owner",
    "parent"
  ],
  additionalProperties: false
};

const tool = (descriptor: Partial<HandlerDescriptor> = {}): HandlerDescriptor => ({
  kind: "query",
  description: "Lists leads.",
  agentTool: true,
  args: {},
  result: { kind: "boolean" },
  ...descriptor
});
const area = (handlers: HandlerDescriptors) => checkAgentArea({ tables, handlers });

describe("agent tool schemas", () => {
  it("maps every value kind to JSON Schema 2020-12, keeping descriptions", () => {
    const cases: ReadonlyArray<readonly [HandlerSchema, object]> = [
      [{ kind: "text" }, { type: "string" }],
      [{ kind: "integer" }, int32],
      [{ kind: "number" }, { type: "number" }],
      [{ kind: "boolean" }, { type: "boolean" }],
      [{ kind: "timestamp" }, dateTime],
      [{ kind: "json" }, {}],
      [
        { kind: "enum", values: ["lead", "won"] },
        { type: "string", enum: ["lead", "won"] }
      ],
      [
        { kind: "array", element: { kind: "text" } },
        { type: "array", items: { type: "string" } }
      ],
      [{ kind: "nullable", value: { kind: "integer" } }, nullable(int32)],
      [{ kind: "row", table: "leads" }, leadRow],
      [
        { kind: "json", description: "Anything the caller sends." },
        { description: "Anything the caller sends." }
      ],
      [
        { kind: "timestamp", description: "When it closed." },
        { ...dateTime, description: "When it closed." }
      ]
    ];
    for (const [schema, json] of cases) expect(handlerJsonSchema(schema, tables)).toEqual(json);
  });

  it("closes objects, requires what isn't optional and lets an outer description win", () => {
    expect(
      argsJsonSchema(
        {
          company: { kind: "text", description: "The company's name." },
          stage: { kind: "enum", values: ["lead", "won"], optional: true },
          note: { kind: "nullable", value: { kind: "text", description: "Inner." } },
          reason: {
            kind: "nullable",
            value: { kind: "text", description: "Inner." },
            description: "Why it moved."
          },
          filter: {
            kind: "object",
            fields: { ids: { kind: "array", element: { kind: "text" } } },
            optional: true
          }
        },
        tables
      )
    ).toEqual({
      type: "object",
      properties: {
        company: { type: "string", description: "The company's name." },
        stage: { type: "string", enum: ["lead", "won"] },
        note: { ...nullable({ type: "string" }), description: "Inner." },
        reason: { ...nullable({ type: "string" }), description: "Why it moved." },
        filter: {
          type: "object",
          properties: { ids: { type: "array", items: { type: "string" } } },
          required: ["ids"],
          additionalProperties: false
        }
      },
      required: ["company", "note", "reason"],
      additionalProperties: false
    });
  });

  it("gives a described row its own description, and keeps a field named __proto__", () => {
    expect(
      handlerJsonSchema({ kind: "row", table: "leads", description: "The new lead." }, tables)
    ).toEqual({ ...leadRow, description: "The new lead." });
    const fields = JSON.parse('{"__proto__":{"kind":"text"}}') as Record<string, HandlerSchema>;
    expect(JSON.stringify(argsJsonSchema(fields, tables))).toBe(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"],"additionalProperties":false}'
    );
  });
});

describe("open_patch's tools", () => {
  it("shapes only agent tools, by name, as reads or changes with their refusals", () => {
    const handlers: HandlerDescriptors = {
      "agent.listDeals": tool({
        result: { kind: "array", element: { kind: "row", table: "leads" } }
      }),
      "agent.addLead": tool({
        kind: "mutation",
        description: "Adds a lead.",
        args: { company: { kind: "text", description: "Its name." } },
        result: { kind: "row", table: "leads" },
        errors: ["missing_fields"]
      }),
      "agent.peek": tool({ kind: "action", readOnly: true, description: "Reads a connection." }),
      "agent.sync": tool({ kind: "action", description: "Syncs." }),
      "leads.list": { kind: "query", args: {}, result: { kind: "boolean" } },
      "agent.page": { kind: "query", args: {}, result: { kind: "boolean" } }
    };
    expect(agentTools({ tables, handlers })).toEqual([
      {
        name: "addLead",
        kind: "change",
        description: "Adds a lead.",
        args: {
          type: "object",
          properties: { company: { type: "string", description: "Its name." } },
          required: ["company"],
          additionalProperties: false
        },
        returns: leadRow,
        refusals: ["missing_fields"]
      },
      {
        name: "listDeals",
        kind: "read",
        description: "Lists leads.",
        args: { type: "object", properties: {}, required: [], additionalProperties: false },
        returns: { type: "array", items: leadRow }
      },
      expect.objectContaining({ name: "peek", kind: "read" }),
      expect.objectContaining({ name: "sync", kind: "change" })
    ]);
  });

  it("answers the patch with its owner cut at 200 characters", () => {
    const answer = openPatchAnswer(
      {
        name: "new-business",
        description: "Leads.",
        owner: "é".repeat(250),
        address: "https://patchy.example/acme/new-business"
      },
      []
    );
    expect(answer).toEqual({
      name: "new-business",
      description: "Leads.",
      owner: "é".repeat(200),
      address: "https://patchy.example/acme/new-business",
      tools: []
    });
  });
});

describe("the agent area check", () => {
  it("passes a patch without agent tools and an undescribed page handler", () => {
    expect(
      area({ "leads.list": { kind: "query", args: {}, result: { kind: "boolean" } } })
    ).toEqual({ warnings: [] });
  });

  it("refuses each problem with its fix, in tool name order", () => {
    const cases: ReadonlyArray<readonly [HandlerDescriptors, string]> = [
      [
        {
          "agent.zeta": tool({ description: undefined }),
          "agent.addLead": tool({ description: undefined })
        },
        "addLead needs a description: it is all an agent knows about the tool. Say what it does, what it changes and when it refuses."
      ],
      [
        {
          "agent.attach": tool({
            kind: "action",
            args: { file: { kind: "upload" } }
          })
        },
        "attach uses t.upload() in args.file. Agent tools exchange JSON only; files stay on the page."
      ],
      [
        {
          "agent.files": tool({
            result: {
              kind: "array",
              element: { kind: "object", fields: { handle: { kind: "fileHandle" } } }
            }
          })
        },
        "files uses t.fileHandle() in result[].handle. Agent tools exchange JSON only; files stay on the page."
      ],
      [
        // A page query couldn't take an upload at all; an agent tool gets the agent area's fix.
        { "agent.find": tool({ args: { file: { kind: "upload" } } }) },
        "find uses t.upload() in args.file. Agent tools exchange JSON only; files stay on the page."
      ],
      [
        { "agent.listDeals": tool({ result: { kind: "row", table: "deals" } }) },
        'listDeals\'s result is t.row("deals"), but this patch defines no table deals. Define the table in patchy.config.ts, or name one it defines.'
      ]
    ];
    for (const [handlers, refusal] of cases) {
      const { problem } = area(handlers);
      expect(problem === undefined ? undefined : agentAreaRefusal(problem)).toBe(refusal);
    }
  });

  it("measures the tools as open_patch renders them, rows expanded, against 60 KiB", () => {
    const description = "d".repeat(2_000);
    const handlers = (count: number): HandlerDescriptors =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `agent.tool${index}`,
          tool({ description, result: { kind: "row", table: "leads" } })
        ])
      );
    const bytes = (count: number) =>
      new TextEncoder().encode(JSON.stringify(agentTools({ tables, handlers: handlers(count) })))
        .length;
    const fits = Math.floor(agentToolsBytes / bytes(1));
    expect(bytes(fits)).toBeLessThanOrEqual(agentToolsBytes);
    expect(area(handlers(fits)).problem).toBeUndefined();
    const over = area(handlers(fits + 1)).problem;
    expect(over).toEqual({ _tag: "TooLarge", bytes: bytes(fits + 1) });
    expect(agentAreaRefusal(over!)).toBe(
      `An agent reads all of this patch's tools in one answer of at most 64 KiB, and the tools get 60 KiB of it; yours come to ${Math.ceil(bytes(fits + 1) / 1024)} KiB. Shorten descriptions or drop tools.`
    );
  });

  it("counts a manifest too large to render as one string, refusing it without building it", () => {
    // Every argument returns the same wide row: expanded, it is far past what a string can hold.
    const wide = {
      description: "w".repeat(100_000),
      columns: Object.fromEntries(
        Array.from({ length: 1_597 }, (_, index) => [`column${index}`, { kind: "text" as const }])
      ),
      indexes: {}
    };
    const handlers = Object.fromEntries(
      Array.from({ length: 540 }, (_, index) => [
        `agent.tool${index}`,
        tool({
          args: Object.fromEntries(
            Array.from({ length: 20 }, (_, field) => [
              `field${field}`,
              { kind: "row" as const, table: "wide" }
            ])
          )
        })
      ])
    );
    const tools = agentTools({ tables: { wide }, handlers });
    // One field's share, counted the way JSON.stringify writes it.
    const rowBytes = new TextEncoder().encode(
      JSON.stringify(tools[0]!.args.properties!["field0"])
    ).length;
    const { problem } = checkAgentArea({ tables: { wide }, handlers });
    expect(problem?._tag).toBe("TooLarge");
    expect(problem?._tag === "TooLarge" && problem.bytes).toBeGreaterThan(540 * 20 * rowBytes);
  });

  it("warns about undescribed top-level arguments only", () => {
    expect(
      area({
        "agent.addLead": tool({
          kind: "mutation",
          args: {
            email: { kind: "text" },
            note: { kind: "text", optional: true },
            company: { kind: "text", description: "Its name." },
            stage: { kind: "nullable", value: { kind: "text", description: "Where it is." } },
            lead: { kind: "row", table: "leads" },
            filter: { kind: "object", fields: { ids: { kind: "text" } }, description: "Which." }
          }
        }),
        "agent.find": tool({ args: { query: { kind: "text" } } })
      }).warnings
    ).toEqual([
      "addLead's arguments email and note have no description, so an agent knows only the name and type. Add .describe() where the name doesn't say enough.",
      "find's argument query has no description, so an agent knows only the name and type. Add .describe() where the name doesn't say enough."
    ]);
  });
});

describe("tool call answers", () => {
  it("carries a success twice, as compact JSON text and as structured content", () => {
    const success = { result: { id: "lead_1" }, version: 3, replayed: true as const };
    expect(toolAnswer(success)).toEqual({
      content: [{ type: "text", text: '{"result":{"id":"lead_1"},"version":3,"replayed":true}' }],
      structuredContent: success
    });
  });

  it("says a patch's own refusal in words and passes its code and details through", () => {
    const details = { message: "give every field", missing: ["email"] };
    expect(patchRefusal("New Business", "addLead", { code: "missing_fields", details })).toEqual({
      content: [
        {
          type: "text",
          text: 'New Business refused addLead (missing_fields): give every field. Details: {"missing":["email"]}'
        }
      ],
      structuredContent: {
        error: {
          code: "missing_fields",
          from: "patch",
          message: "New Business refused addLead (missing_fields): give every field.",
          details
        }
      },
      isError: true
    });
    expect(patchRefusal("New Business", "addLead", { code: "closed" }).content[0].text).toBe(
      "New Business refused addLead (closed). Its description in open_patch says when it refuses and what to do."
    );
  });

  it("gives Patchy's refusal its message as text, with retryAfterSeconds structured", () => {
    const error = {
      code: "busy",
      from: "patchy" as const,
      message: "Acme's server is starting; try again in 15 seconds.",
      retryAfterSeconds: 15
    };
    expect(toolRefusal(error)).toEqual({
      content: [{ type: "text", text: error.message }],
      structuredContent: { error },
      isError: true
    });
  });
});
