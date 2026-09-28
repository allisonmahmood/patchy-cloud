import type {
  Config,
  Descriptor,
  DescriptorOf,
  Fields,
  FileHandle,
  Json,
  Row,
  SchemaInput,
  Upload,
  ValueDescriptor
} from "./config.js";
import type { FileListOptions, FileMetadata, OwnedTable } from "./client.js";
import type { Me } from "./clientTransport.js";
import type { QueryCallable } from "./queryRegistry.js";
import type { HandlerError } from "./handlerError.js";

export { t } from "./config.js";
export type { FileHandle, Upload } from "./config.js";
export { HandlerError, isHandlerError } from "./handlerError.js";
export type HandlerKindName = "query" | "mutation" | "action";
export type DeepReadonly<T> = T extends
  string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
type Empty = Record<never, never>;

type InferFields<F, C extends Config> = {
  readonly [K in keyof F as F[K] extends { readonly optional: true } ? never : K]: InferDescriptor<
    F[K],
    C
  >;
} & {
  readonly [K in keyof F as F[K] extends { readonly optional: true } ? K : never]?: InferDescriptor<
    F[K],
    C
  >;
};
export type InferDescriptor<D, C extends Config> = Descriptor extends D
  ? Json
  : D extends { readonly kind: "integer" | "number" }
    ? number
    : D extends { readonly kind: "boolean" }
      ? boolean
      : D extends { readonly kind: "text" | "timestamp" }
        ? string
        : D extends { readonly kind: "json" }
          ? Json
          : D extends { readonly kind: "fileHandle" }
            ? FileHandle
            : D extends { readonly kind: "upload" }
              ? Upload
              : D extends { readonly kind: "enum"; readonly values: readonly (infer V)[] }
                ? V
                : D extends { readonly kind: "array"; readonly element: infer V }
                  ? readonly InferDescriptor<V, C>[]
                  : D extends { readonly kind: "nullable"; readonly value: infer V }
                    ? InferDescriptor<V, C> | null
                    : D extends { readonly kind: "object"; readonly fields: infer F }
                      ? InferFields<F, C>
                      : D extends {
                            readonly kind: "row";
                            readonly table: infer N extends keyof C["tables"] & string;
                          }
                        ? DeepReadonly<Row<C, N>>
                        : never;
type ArgsOf<A extends Fields, C extends Config> = InferFields<
  {
    readonly [K in keyof A]: DescriptorOf<A[K]>;
  },
  C
>;

declare const handlerTypes: unique symbol;
/** The callback is stored, never invoked by the contract package. */
export interface Handler<
  Kind extends HandlerKindName,
  Args,
  Result,
  Errors extends string = never
> {
  readonly kind: Kind;
  readonly descriptor: HandlerDescriptor;
  readonly handler: (context: never, args: Args) => unknown;
  toJSON(): HandlerDescriptor;
  readonly [handlerTypes]?: {
    readonly args: Args;
    readonly result: Result;
    readonly errors: Errors;
  };
}
export type HandlerArgs<H> = H extends { readonly [handlerTypes]?: { readonly args: infer A } }
  ? A
  : never;
export type HandlerResult<H> = H extends { readonly [handlerTypes]?: { readonly result: infer R } }
  ? R
  : never;
export type HandlerKind<H> = H extends { readonly kind: infer K extends HandlerKindName }
  ? K
  : never;
export type HandlerErrors<H> = H extends {
  readonly [handlerTypes]?: { readonly errors: infer E extends string };
}
  ? E
  : never;
type HandlerCall<H> = (args: HandlerArgs<H>) => Promise<HandlerResult<H>>;
export type ServerClient<Modules> = {
  readonly [M in keyof Modules]: {
    readonly [N in keyof Modules[M]]: HandlerKind<Modules[M][N]> extends "query"
      ? QueryCallable<HandlerArgs<Modules[M][N]>, HandlerResult<Modules[M][N]>>
      : HandlerCall<Modules[M][N]>;
  };
};
export type RunClient<Modules> = {
  readonly [M in keyof Modules]: {
    // Resolve only the selected sibling; filtering keys would inspect the action being inferred.
    readonly [N in keyof Modules[M]]: HandlerKind<Modules[M][N]> extends "query" | "mutation"
      ? HandlerCall<Modules[M][N]>
      : never;
  };
};
export type DeclaredHandlerCodes<Modules> = {
  [M in keyof Modules]: { [N in keyof Modules[M]]: HandlerErrors<Modules[M][N]> }[keyof Modules[M]];
}[keyof Modules];
export type HandlerErrorGuard<Modules> = <Code extends DeclaredHandlerCodes<Modules>>(
  error: unknown,
  code: Code
) => error is HandlerError<Code>;
export interface MutationUnknownOutcome<Result> extends Error {
  readonly code: "unknown_outcome";
  retry(): Promise<Result>;
}

export interface HandlerDescriptor {
  readonly kind: HandlerKindName;
  readonly args: Readonly<Record<string, ValueDescriptor>>;
  readonly result: ValueDescriptor;
  readonly errors?: readonly string[];
}
export interface ServerFileMetadata extends FileMetadata {
  readonly handle: FileHandle;
}
export interface QueryFileStore {
  list(
    options?: FileListOptions
  ): Promise<{ readonly files: readonly ServerFileMetadata[]; readonly cursor: string | null }>;
  stat(name: string): Promise<ServerFileMetadata | null>;
}
export interface ActionFileStore extends QueryFileStore {
  put(
    name: string,
    bytes: Uint8Array | ArrayBuffer | Blob | Upload,
    options?: { readonly contentType: string }
  ): Promise<null>;
  get(name: string): Promise<Uint8Array>;
  delete(name: string): Promise<null>;
}
type ReadonlyOperations<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<DeepReadonly<R>>
    : T[K];
};
type QueryShared<Shared> = {
  readonly [K in keyof Shared]: Shared[K] extends QueryFileStore
    ? QueryFileStore
    : ReadonlyOperations<Shared[K]>;
};
export interface ContextBase {
  readonly viewer: Me;
  log(message: string, details?: Json): void;
}
export interface QueryContext<C extends Config, Shared = Empty> extends ContextBase {
  readonly tables: {
    readonly [N in keyof C["tables"] & string]: ReadonlyOperations<
      Pick<OwnedTable<C, N>, "get" | "getMany" | "list">
    >;
  };
  readonly shared: QueryShared<Shared>;
  readonly files: { readonly [N in keyof C["files"]]: QueryFileStore };
}
export interface MutationContext<C extends Config> extends ContextBase {
  readonly tables: {
    readonly [N in keyof C["tables"] & string]: ReadonlyOperations<OwnedTable<C, N>>;
  };
}
export interface ActionContext<
  C extends Config,
  Modules = Empty,
  Shared = Empty,
  Connections = Empty
> extends MutationContext<C> {
  readonly shared: Shared;
  readonly files: { readonly [N in keyof C["files"]]: ActionFileStore };
  readonly connections: Connections;
  readonly run: RunClient<Modules>;
}

type Position = "args" | "result";
type SchemaProblem<
  D,
  K extends HandlerKindName,
  P extends Position,
  C extends Config,
  Field extends boolean
> = Descriptor extends D
  ? never
  : "default" extends keyof D
    ? "Defaults are table-only"
    : D extends { readonly kind: "ref" }
      ? "References are table-only"
      : D extends { readonly optional: true }
        ? Field extends false
          ? "Only fields may be optional"
          : SchemaKindProblem<D, K, P, C>
        : SchemaKindProblem<D, K, P, C>;
type SchemaKindProblem<
  D,
  K extends HandlerKindName,
  P extends Position,
  C extends Config
> = D extends { readonly kind: "fileHandle" }
  ? P extends "result"
    ? never
    : "File handles are results-only"
  : D extends { readonly kind: "upload" }
    ? K extends "action"
      ? P extends "args"
        ? never
        : "Uploads are action arguments only"
      : "Uploads are action arguments only"
    : D extends { readonly kind: "row"; readonly table: infer N }
      ? N extends keyof C["tables"]
        ? never
        : "Unknown row table"
      : D extends { readonly kind: "object"; readonly fields: infer F }
        ? { [N in keyof F]: SchemaProblem<F[N], K, P, C, true> }[keyof F]
        : D extends { readonly kind: "array"; readonly element: infer V }
          ? SchemaProblem<V, K, P, C, false>
          : D extends { readonly kind: "nullable"; readonly value: infer V }
            ? SchemaProblem<V, K, P, C, false>
            : never;
type CheckSchema<
  S extends SchemaInput,
  K extends HandlerKindName,
  P extends Position,
  C extends Config,
  Field extends boolean
> = [SchemaProblem<DescriptorOf<S>, K, P, C, Field>] extends [never]
  ? unknown
  : {
      readonly schemaError: SchemaProblem<DescriptorOf<S>, K, P, C, Field>;
    };
type CheckFields<A extends Fields, K extends HandlerKindName, C extends Config> = {
  readonly [N in keyof A]: CheckSchema<A[N], K, "args", C, true>;
};
export interface HandlerBuilder<K extends HandlerKindName, C extends Config, Context> {
  <
    const A extends Fields,
    const R extends SchemaInput,
    const E extends readonly string[] = readonly []
  >(definition: {
    readonly args: A & CheckFields<A, K, C>;
    readonly result: R & CheckSchema<R, K, "result", C, false>;
    readonly errors?: E;
    readonly handler: (
      ctx: Context,
      args: NoInfer<ArgsOf<A, C>>
    ) =>
      | NoInfer<InferDescriptor<DescriptorOf<R>, C>>
      | Promise<NoInfer<InferDescriptor<DescriptorOf<R>, C>>>;
  }): Handler<K, ArgsOf<A, C>, InferDescriptor<DescriptorOf<R>, C>, E[number]>;
}
export type QueryBuilder<C extends Config, Shared = Empty> = HandlerBuilder<
  "query",
  C,
  QueryContext<C, Shared>
>;
export type MutationBuilder<C extends Config> = HandlerBuilder<"mutation", C, MutationContext<C>>;
export type ActionBuilder<
  C extends Config,
  Modules = Empty,
  Shared = Empty,
  Connections = Empty
> = HandlerBuilder<"action", C, ActionContext<C, Modules, Shared, Connections>>;
export interface ServerBuilders<
  C extends Config,
  Modules = Empty,
  Shared = Empty,
  Connections = Empty
> {
  readonly query: QueryBuilder<C, Shared>;
  readonly mutation: MutationBuilder<C>;
  readonly action: ActionBuilder<C, Modules, Shared, Connections>;
}

export class InvalidManifestError extends Error {
  readonly code = "invalid_manifest";
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = "InvalidManifestError";
  }
}

const validateDescriptor = (
  descriptor: Descriptor,
  kind: HandlerKindName,
  position: Position,
  field: boolean
): ValueDescriptor => {
  if (Object.hasOwn(descriptor, "default") || descriptor.kind === "ref")
    throw new InvalidManifestError("Defaults and references are table-only.");
  if (descriptor.optional === true && !field)
    throw new InvalidManifestError("Only object and argument fields may be optional.");
  switch (descriptor.kind) {
    case "fileHandle":
      if (position !== "result") throw new InvalidManifestError("File handles are results-only.");
      break;
    case "upload":
      if (kind !== "action" || position !== "args")
        throw new InvalidManifestError("Uploads are allowed only in action arguments.");
      break;
    case "object":
      for (const [name, child] of Object.entries(descriptor.fields)) {
        if (name.length === 0) throw new InvalidManifestError("Field names cannot be empty.");
        validateDescriptor(child, kind, position, true);
      }
      break;
    case "array":
      validateDescriptor(descriptor.element, kind, position, false);
      break;
    case "nullable":
      validateDescriptor(descriptor.value, kind, position, false);
      break;
    case "row":
      if (!/^[a-z][a-zA-Z0-9]{0,62}$/.test(descriptor.table))
        throw new InvalidManifestError("Invalid row table name.");
      break;
  }
  return descriptor as ValueDescriptor;
};
const handlers = new WeakMap<object, HandlerDescriptor>();
const makeBuilder =
  <K extends HandlerKindName>(kind: K) =>
  (definition: {
    readonly args: Fields;
    readonly result: SchemaInput;
    readonly errors?: readonly string[];
    readonly handler: (context: never, args: never) => unknown;
  }) => {
    if (typeof definition.handler !== "function")
      throw new InvalidManifestError("A handler needs a callback.");
    const args: Record<string, ValueDescriptor> = {};
    for (const [name, schema] of Object.entries(definition.args)) {
      if (name.length === 0) throw new InvalidManifestError("Argument names cannot be empty.");
      Object.defineProperty(args, name, {
        value: validateDescriptor(schema.toJSON(), kind, "args", true),
        enumerable: true
      });
    }
    const result = validateDescriptor(definition.result.toJSON(), kind, "result", false);
    if (definition.errors?.some((code) => typeof code !== "string" || code.length === 0))
      throw new InvalidManifestError("Handler error codes must be nonempty strings.");
    const descriptor: HandlerDescriptor = {
      kind,
      args,
      result,
      ...(definition.errors === undefined ? {} : { errors: [...definition.errors] })
    };
    const handler = Object.freeze({
      kind,
      descriptor,
      handler: definition.handler,
      toJSON: () => descriptor
    });
    handlers.set(handler, descriptor);
    return handler;
  };

/** Binds only types. No config, modules, viewer or execution capability is loaded. */
export function bindServer<
  C extends Config,
  Modules = Empty,
  Shared = Empty,
  Connections = Empty
>(): ServerBuilders<C, Modules, Shared, Connections> {
  // Context and argument types exist only at authoring time; callbacks stay opaque here.
  return {
    query: makeBuilder("query"),
    mutation: makeBuilder("mutation"),
    action: makeBuilder("action")
  } as unknown as ServerBuilders<C, Modules, Shared, Connections>;
}
export const query: QueryBuilder<Config> = makeBuilder("query") as unknown as QueryBuilder<Config>;
export const mutation: MutationBuilder<Config> = makeBuilder(
  "mutation"
) as unknown as MutationBuilder<Config>;
export const action: ActionBuilder<Config> = makeBuilder(
  "action"
) as unknown as ActionBuilder<Config>;

/** Inspect one-level module exports without ever running their callbacks. */
export function extractHandlerDescriptors(
  modules: Readonly<Record<string, unknown>>
): Readonly<Record<string, HandlerDescriptor>> {
  const descriptors: Record<string, HandlerDescriptor> = {};
  for (const [module, exports] of Object.entries(modules)) {
    if (
      !/^[a-zA-Z_$][a-zA-Z0-9_$-]*$/.test(module) ||
      typeof exports !== "object" ||
      exports === null
    )
      throw new InvalidManifestError(
        `Invalid server module "${module}". Expected one level of named exports.`
      );
    for (const [name, handler] of Object.entries(exports)) {
      const descriptor =
        typeof handler === "object" && handler !== null ? handlers.get(handler) : undefined;
      if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) || descriptor === undefined)
        throw new InvalidManifestError(
          `Server export "${module}.${name}" is not a query, mutation or action.`
        );
      descriptors[`${module}.${name}`] = descriptor;
    }
  }
  return descriptors;
}
