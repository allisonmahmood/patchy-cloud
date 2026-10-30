import {
  HandlerDescriptor,
  HandlerModuleName,
  HandlerName,
  serverAgentModuleFix
} from "@patchy/api/handlers";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { InvalidManifestError } from "./invalidManifestError.js";

const decodeDescriptor = Schema.decodeUnknownSync(HandlerDescriptor, {
  onExcessProperty: "error"
});
const isModuleName = Schema.is(HandlerModuleName);
const isHandlerName = Schema.is(HandlerName);

/** The refusal for `server/agent.ts`, whose handlers would clash with the agent area's names. */
export const serverAgentModule = `server/agent.ts: ${serverAgentModuleFix}`;

/** The refusal for one tool name exported by two `agent/` files, named by filename stem. */
export const duplicateAgentTool = (name: string, first: string, second: string) =>
  `${name} is exported by agent/${first}.ts and agent/${second}.ts; each tool needs its own name.`;

export function decodeHandlerDescriptor(value: unknown): HandlerDescriptor {
  try {
    return decodeDescriptor(value);
  } catch (error) {
    throw new InvalidManifestError(error instanceof Error ? error.message : String(error));
  }
}

const isExports = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Fold a patch's `agent/` files, keyed by filename stem, into the exports of the one module named
 * `agent`. A tool is named after its export, so files only organise tools; two files exporting one
 * name are refused, naming both.
 */
export function foldAgentArea(
  files: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  // No prototype, so an export named __proto__ is a key like any other.
  const folded: Record<string, unknown> = Object.create(null);
  const owners = new Map<string, string>();
  for (const [file, exports] of Object.entries(files)) {
    if (!isModuleName(file) || !isExports(exports))
      throw new InvalidManifestError(
        `Invalid agent file "${file}". Expected one level of named exports.`
      );
    for (const [name, value] of Object.entries(exports)) {
      const owner = owners.get(name);
      if (owner !== undefined)
        throw new InvalidManifestError(duplicateAgentTool(name, owner, file));
      owners.set(name, file);
      folded[name] = value;
    }
  }
  return folded;
}

/**
 * Inspect the structural handler contract across module copies without calling user code. The
 * folded agent area becomes the module `agent`, and each of its handlers is marked an agent tool;
 * a re-exported server handler keeps its server name unmarked beside its tool name. Agent tools
 * are for agents only, so a re-exported guest handler's tool drops the guest mark.
 */
export function extractHandlerDescriptors(
  modules: Readonly<Record<string, unknown>>,
  agentArea: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, HandlerDescriptor>> {
  // An older version's server/agent.ts stays a module of page handlers; only beside an agent area
  // would its names clash. The CLI refuses server/agent.ts outright.
  if (Object.hasOwn(modules, "agent") && Object.keys(agentArea).length > 0)
    throw new InvalidManifestError(serverAgentModule);
  const descriptors: Record<string, HandlerDescriptor> = {};
  const extract = (
    module: string,
    exports: Readonly<Record<string, unknown>>,
    agentTool: boolean
  ) => {
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
          agentTool
            ? `Agent tool "${name}" is not a query, mutation or action; every export of agent/ must be one.`
            : `Server export "${module}.${name}" is not a query, mutation or action.`
        );
      const descriptor = decodeHandlerDescriptor(handler.descriptor);
      if (handler.kind !== descriptor.kind)
        throw new InvalidManifestError(
          `Server export "${module}.${name}" does not match its descriptor kind.`
        );
      descriptors[`${module}.${name}`] = agentTool
        ? { ...Struct.omit(descriptor, ["guest"]), agentTool: true }
        : descriptor;
    }
  };
  for (const [module, exports] of Object.entries(modules)) {
    if (!isModuleName(module) || !isExports(exports))
      throw new InvalidManifestError(
        `Invalid server module "${module}". Expected one level of named exports.`
      );
    extract(module, exports, false);
  }
  extract("agent", agentArea, true);
  return descriptors;
}
