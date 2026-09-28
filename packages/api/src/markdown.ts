/**
 * Renders `docs/API.md` from the OpenAPI document `OpenApi.fromApi(PatchyApi)`
 * produces. Deliberately small: one heading per route, its description, the
 * request body, and every response with its shape spelled out inline. Named
 * shapes get one section each at the end.
 */
import * as Schema from "effect/Schema";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import { PatchyApi } from "./api.js";
import { RuntimeStreamFrame } from "./runtime.js";
import * as GuestProtocol from "./guest.js";

/** The subset of JSON Schema `fromApi` emits, as far as this renderer reads it. */
interface JsonSchema {
  $ref?: string;
  type?: string;
  title?: string;
  enum?: ReadonlyArray<unknown>;
  anyOf?: ReadonlyArray<JsonSchema>;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
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
const streamFrameDocument = Schema.toJsonSchemaDocument(RuntimeStreamFrame);

export function renderApiMarkdown(): string {
  const spec = OpenApi.fromApi(PatchyApi);
  const components = {
    ...spec.components.schemas,
    ...streamFrameDocument.definitions
  } as Record<string, JsonSchema>;
  const shapeName = (ref: string) =>
    ref.replace(/^#\/(?:components\/schemas|\$defs)\//, "").replace(/Encoded$/, "");

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
        else if (operation.requestBody?.content?.["application/octet-stream"])
          lines.push("Request body: raw bytes (`application/octet-stream`)", "");

        lines.push("Responses:", "");
        for (const [status, response] of Object.entries(operation.responses)) {
          const schema = response.content?.["application/json"]?.schema;
          const body = schema
            ? renderType(schema)
            : response.content?.["application/octet-stream"]
              ? "raw bytes (`application/octet-stream`)"
              : response.content?.["text/event-stream"]
                ? `SSE (\`text/event-stream\`), JSON data: ${renderType(streamFrameDocument.schema as JsonSchema)}`
                : "no body";
          lines.push(`- \`${status}\` ${body}`);
        }
        lines.push("");
      }
    }
  }

  lines.push(
    "## Private guest protocol",
    "",
    `Wire ${GuestProtocol.wireVersion} is pinned to workerd \`${GuestProtocol.workerdVersion}\`, compatibility date \`${GuestProtocol.compatibilityDate}\`.`,
    "The authoritative schemas are in [`packages/api/src/guest.ts`](../packages/api/src/guest.ts).",
    "These are engine/inspection contracts, not public `HttpApi` routes or CLI operations.",
    "",
    "- `BundleBinding`: company, patch and version ids plus lowercase SHA-256. `Bundle` adds the closed ESM source.",
    "- `BindRequest`: wire and bundle. `BindReply` acknowledges the binding with `ok: true` or returns a typed binding refusal.",
    "- `Invoke`: wire, binding, invocation id, attempt id, process generation, absolute deadline, handler, JSON arguments, initiating viewer and issuing-host callback address/capability.",
    "- `InvokeReply`: the ordinary runtime or declared-handler reply plus guest elapsed milliseconds. The capability stays in the loader; the guest receives only an invocation-named RPC stub.",
    "- `GuestRequest`: describe or invoke. Description yields handler descriptors; invocation yields the existing `RuntimeReply` envelope without wrapping successful business data.",
    "- `Callback`: runtime operation, arguments and optional raw file body. `CallbackReply` preserves runtime refusals or returns JSON/file bytes. File bodies carry `Uint8Array` bytes and a content type over RPC, not JSON byte arrays.",
    "- Host callback transport uses JSON except binary requests (`application/octet-stream`, URI-encoded operation metadata in `X-Patchy-Callback`) and binary replies (`X-Patchy-File-Body: 1`). Authorization is the private per-attempt bearer, never a guest field.",
    "- `InspectRequest`: wire and source only. `InspectionReply` contains descriptors or a runtime refusal. Inspection has no company binding, capability or callback path and runs in a reaped, deadline-bounded process.",
    "",
    "See [ADR-0012](./adr/ADR-0012-credential-free-execution-service.md) for authority, lifetime and hosting contracts. Tier 2 publishing remains refused.",
    ""
  );

  lines.push("## Shapes", "");
  for (const [ref, schema] of Object.entries(components)) {
    lines.push(`### ${shapeName(ref)}`, "", "```", renderShape(schema, 0, false), "```", "");
  }

  return lines.join("\n");

  /**
   * A schema on one line. A named shape is a link in prose and a bare name
   * inside a code block; anything else is spelled out.
   */
  function renderType(schema: JsonSchema, linked = true, arrayElement = false): string {
    if (schema.$ref) {
      const name = shapeName(schema.$ref);
      return linked ? `[${name}](#${name.toLowerCase()})` : name;
    }
    if (schema.anyOf) {
      // The enum-of-non-finite-numbers arm Schema.Number adds is noise on a
      // reference and is dropped.
      const arms = [
        ...new Set(
          schema.anyOf
            .filter((arm) => !isNonFiniteNumberArm(arm))
            .map((arm) => renderType(arm, linked, arrayElement))
        )
      ];
      const rendered = arms.join(" | ");
      return arrayElement && arms.length > 1 ? `(${rendered})` : rendered;
    }
    if (schema.enum) {
      const rendered = schema.enum.map((value) => JSON.stringify(value)).join(" | ");
      return arrayElement && schema.enum.length > 1 ? `(${rendered})` : rendered;
    }
    if (schema.type === "array") {
      return `${renderType(schema.items ?? {}, linked, true)}[]`;
    }
    if (schema.type === "object") return renderShape(schema, 0, linked).replace(/\s+/g, " ");
    if (schema.title === "Timestamp") return "string (ISO-8601)";
    return schema.type ?? "unknown";
  }

  /** An object shape over several lines, optional keys marked `?`. */
  function renderShape(schema: JsonSchema, depth: number, linked: boolean): string {
    if (!schema.properties) {
      if (schema.type !== "object") return renderType(schema, linked);
      if (schema.additionalProperties === false) return "{}";
      const value =
        typeof schema.additionalProperties === "object"
          ? renderType(schema.additionalProperties, linked)
          : "unknown";
      return `{ [key: string]: ${value} }`;
    }
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
