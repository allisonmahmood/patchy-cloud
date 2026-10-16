import { describe, expect, it } from "vitest";
import { handlerFieldsJsonSchema, handlerJsonSchema } from "./index.js";

const tables = {
  leads: {
    description: "One sales lead, keyed by company.",
    columns: {
      company: { kind: "text" as const },
      owner: { kind: "member" as const, optional: true },
      parent: { kind: "ref" as const, table: "leads", optional: true },
      score: { kind: "integer" as const, default: 1 }
    },
    indexes: {}
  }
};

describe("handler JSON Schema", () => {
  it("keeps descriptions, closes objects and requires every field that isn't optional", () => {
    expect(
      handlerFieldsJsonSchema(
        {
          company: { kind: "text", description: "The company's name." },
          stage: { kind: "enum", values: ["lead", "won"], optional: true },
          note: { kind: "nullable", value: { kind: "text" }, description: "Why." }
        },
        tables
      )
    ).toEqual({
      type: "object",
      properties: {
        company: { type: "string", description: "The company's name." },
        stage: { type: "string", enum: ["lead", "won"] },
        note: { anyOf: [{ type: "string" }, { type: "null" }], description: "Why." }
      },
      required: ["company", "note"],
      additionalProperties: false
    });
  });

  it("projects a row from its table: system columns, then optional columns as nullable", () => {
    const row = handlerJsonSchema(
      { kind: "array", element: { kind: "row", table: "leads" } },
      tables
    );
    expect(row).toMatchObject({
      type: "array",
      items: {
        type: "object",
        description: "A row of leads: One sales lead, keyed by company.",
        required: ["id", "createdAt", "updatedAt", "company", "owner", "parent", "score"],
        properties: {
          createdAt: { type: "string", format: "date-time" },
          owner: { anyOf: [{ type: "string" }, { type: "null" }] },
          score: { type: "integer" }
        }
      }
    });
  });
});
