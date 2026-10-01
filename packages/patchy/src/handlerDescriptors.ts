import { HandlerDescriptor, HandlerModuleName, HandlerName } from "@patchy/api/handlers";
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
