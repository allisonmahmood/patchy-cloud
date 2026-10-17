import {
  HandlerDescriptor,
  HandlerModuleName,
  HandlerName,
  type HandlerSchema
} from "@patchy/api/handlers";
import * as Schema from "effect/Schema";
import { InvalidManifestError } from "./invalidManifestError.js";

const decodeDescriptor = Schema.decodeUnknownSync(HandlerDescriptor, {
  onExcessProperty: "error"
});
const isModuleName = Schema.is(HandlerModuleName);
const isHandlerName = Schema.is(HandlerName);

export function decodeHandlerDescriptor(value: unknown): HandlerDescriptor {
  try {
    return decodeDescriptor(value);
  } catch (error) {
    throw new InvalidManifestError(error instanceof Error ? error.message : String(error));
  }
}

/** Inspect the structural handler contract across module copies without calling user code. */
export function extractHandlerDescriptors(
  modules: Readonly<Record<string, unknown>>
): Readonly<Record<string, HandlerDescriptor>> {
  const descriptors: Record<string, HandlerDescriptor> = {};
  for (const [module, exports] of Object.entries(modules)) {
    if (
      !isModuleName(module) ||
      typeof exports !== "object" ||
      exports === null ||
      Array.isArray(exports)
    )
      throw new InvalidManifestError(
        `Invalid server module "${module}". Expected one level of named exports.`
      );
    for (const [name, handler] of Object.entries(exports)) {
      if (
        !isHandlerName(`${module}.${name}`) ||
        typeof handler !== "object" ||
        handler === null ||
        Array.isArray(handler) ||
        !("handler" in handler) ||
        typeof handler.handler !== "function" ||
        !("toJSON" in handler) ||
        typeof handler.toJSON !== "function" ||
        !("descriptor" in handler) ||
        !("kind" in handler)
      )
        throw new InvalidManifestError(
          `Server export "${module}.${name}" is not a query, mutation or action.`
        );
      const descriptor = decodeHandlerDescriptor(handler.descriptor);
      if (handler.kind !== descriptor.kind)
        throw new InvalidManifestError(
          `Server export "${module}.${name}" does not match its descriptor kind.`
        );
      descriptors[`${module}.${name}`] = descriptor;
    }
  }
  return descriptors;
}

const exchangesFiles = (schema: HandlerSchema): boolean => {
  switch (schema.kind) {
    case "upload":
    case "fileHandle":
      return true;
    case "object":
      return Object.values(schema.fields).some(exchangesFiles);
    case "array":
      return exchangesFiles(schema.element);
    case "nullable":
      return exchangesFiles(schema.value);
    default:
      return false;
  }
};

/**
 * The agent area is server/agent.ts: its exports, and nothing else, are tools people's agents
 * call through Patchy's MCP. Publish and watched dev builds refuse a tool an agent cannot use;
 * publish also warns about undescribed arguments.
 */
export function checkAgentArea(handlers: Readonly<Record<string, HandlerDescriptor>>): {
  readonly refusal: string | undefined;
  readonly warnings: readonly string[];
} {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const [name, handler] of Object.entries(handlers)) {
    if (!name.startsWith("agent.")) continue;
    if (handler.description === undefined)
      problems.push(
        `${name} needs a description: it is all an agent knows about the tool. Say what it does, what it changes and when it refuses.`
      );
    if ([...Object.values(handler.args), handler.result].some(exchangesFiles))
      problems.push(
        `${name} uses t.upload() or t.fileHandle(). Agent tools exchange JSON only; uploads and file handles stay on the page.`
      );
    const undescribed = Object.entries(handler.args)
      .filter(([, field]) => field.description === undefined)
      .map(([field]) => field);
    if (undescribed.length)
      warnings.push(
        `Agent tool ${name} has undescribed arguments: ${undescribed.join(", ")}. Add .describe() to each so agents know what to send.`
      );
  }
  return {
    refusal: problems.length
      ? `server/agent.ts holds tools for people's agents, and they cannot use these:\n- ${problems.join("\n- ")}`
      : undefined,
    warnings
  };
}
