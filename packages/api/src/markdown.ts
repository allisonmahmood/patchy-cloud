/**
 * Renders `docs/API.md` from the OpenAPI document `OpenApi.fromApi(PatchyApi)`
 * produces. Deliberately small: one heading per route, its description, the
 * request body, and every response with its shape spelled out inline. Named
 * shapes get one section each at the end.
 */
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import { PatchyApi } from "./api.js";

/** The subset of JSON Schema `fromApi` emits, as far as this renderer reads it. */
interface JsonSchema {
  $ref?: string;
  type?: string;
  title?: string;
  enum?: ReadonlyArray<unknown>;
  anyOf?: ReadonlyArray<JsonSchema>;
  properties?: Record<string, JsonSchema>;
  required?: ReadonlyArray<string>;
  items?: JsonSchema;
}

interface Operation {
  operationId?: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  parameters?: ReadonlyArray<{ name: string; in: string; schema?: JsonSchema }>;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
}

const METHOD_ORDER = ["get", "post", "delete", "put", "patch"] as const;

export function renderApiMarkdown(): string {
  const spec = OpenApi.fromApi(PatchyApi);
  const components = spec.components.schemas as Record<string, JsonSchema>;
  const shapeName = (ref: string) =>
    ref.replace("#/components/schemas/", "").replace(/Encoded$/, "");

  const lines: string[] = [
    `# ${spec.info.title}`,
    "",
    "Rendered from `PatchyApi` in `packages/api` by `pnpm --filter @patchy/api render-docs`. Do not",
    "edit by hand: a test fails when this file and the schemas disagree.",
    "",
    spec.info.description ?? "",
    ""
  ];

  for (const tag of spec.tags) {
    lines.push(`## ${tag.name}`, "");
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of METHOD_ORDER) {
        const operation = (methods as Record<string, Operation | undefined>)[method];
        if (!operation || !operation.tags?.includes(tag.name)) continue;
        lines.push(`### \`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}\``, "");
        if (operation.description) lines.push(operation.description, "");

        const body = operation.requestBody?.content?.["application/json"]?.schema;
        if (body) lines.push(`Request body: ${renderType(body)}`, "");

        lines.push("Responses:", "");
        for (const [status, response] of Object.entries(operation.responses)) {
          const schema = response.content?.["application/json"]?.schema;
          lines.push(`- \`${status}\` ${schema ? renderType(schema) : "no body"}`);
        }
        lines.push("");
      }
    }
  }

  lines.push("## Shapes", "");
  for (const [ref, schema] of Object.entries(components)) {
    lines.push(`### ${shapeName(ref)}`, "", "```", renderShape(schema, 0, false), "```", "");
  }

  return lines.join("\n");

  /**
   * A schema on one line. A named shape is a link in prose and a bare name
   * inside a code block; anything else is spelled out.
   */
  function renderType(schema: JsonSchema, linked = true): string {
    if (schema.$ref) {
      const name = shapeName(schema.$ref);
      return linked ? `[${name}](#${name.toLowerCase()})` : name;
    }
    if (schema.anyOf) {
      // The enum-of-non-finite-numbers arm Schema.Number adds is noise on a
      // reference and is dropped.
      const arms = schema.anyOf
        .filter((arm) => !isNonFiniteNumberArm(arm))
        .map((arm) => renderType(arm, linked));
      return [...new Set(arms)].join(" | ");
    }
    if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
    if (schema.type === "array") return `${renderType(schema.items ?? {}, linked)}[]`;
    if (schema.type === "object") return renderShape(schema, 0, linked).replace(/\s+/g, " ");
    if (schema.title === "Timestamp") return "string (ISO-8601)";
    return schema.type ?? "unknown";
  }

  /** An object shape over several lines, optional keys marked `?`. */
  function renderShape(schema: JsonSchema, depth: number, linked: boolean): string {
    if (!schema.properties) return renderType(schema, linked);
    const indent = "  ".repeat(depth + 1);
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties).map(([name, field]) => {
      const rendered = field.properties
        ? renderShape(field, depth + 1, linked)
        : renderType(field, linked);
      return `${indent}${name}${required.has(name) ? "" : "?"}: ${rendered}`;
    });
    return `{\n${fields.join(",\n")}\n${"  ".repeat(depth)}}`;
  }
}

function isNonFiniteNumberArm(schema: JsonSchema): boolean {
  return schema.type === "string" && (schema.enum?.includes("NaN") ?? false);
}
