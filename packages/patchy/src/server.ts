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
import type {
  DeclaredMembers,
  FileListOptions,
  FileMetadata,
  Member,
  MemberListOptions,
  MemberSearchOptions,
  OwnedTable,
  Page,
  ReadFileStore
} from "./client.js";
import type { Me } from "./clientTransport.js";
import type { QueryCallable } from "./queryRegistry.js";
import type { HandlerError } from "./handlerError.js";
import { decodeHandlerDescriptor } from "./handlerDescriptors.js";
import { InvalidManifestError } from "./invalidManifestError.js";

export { t } from "./config.js";
export type { FileHandle, Upload } from "./config.js";
export { HandlerError, isHandlerError } from "./handlerError.js";
export { createGuest } from "./guest.js";
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
export interface HandlerFileMetadata extends FileMetadata {
  readonly handle: FileHandle;
}
export interface QueryFileStore {
  list(
    options?: FileListOptions
  ): Promise<{ readonly files: readonly HandlerFileMetadata[]; readonly cursor: string | null }>;
  stat(name: string): Promise<HandlerFileMetadata | null>;
}
export interface ActionSharedFileStore extends QueryFileStore {
  get(name: string): Promise<Uint8Array>;
}
export interface ActionFileStore extends ActionSharedFileStore {
  put(
    name: string,
    bytes: Uint8Array | ArrayBuffer | Blob | Upload,
    options?: { readonly contentType: string }
  ): Promise<null>;
  delete(name: string): Promise<null>;
}
type ReadonlyOperations<T> = {
  readonly [K in keyof T]: T[K] extends QueryCallable<infer A, infer R>
    ? (...args: undefined extends A ? [args?: A] : [args: A]) => Promise<DeepReadonly<R>>
    : T[K] extends (...args: infer A) => Promise<infer R>
      ? (...args: A) => Promise<DeepReadonly<R>>
      : T[K];
};
type QueryShared<Shared> = {
  readonly [K in keyof Shared]: Shared[K] extends ReadFileStore
    ? QueryFileStore
    : ReadonlyOperations<Shared[K]>;
};
type ActionShared<Shared> = {
  readonly [K in keyof Shared]: Shared[K] extends ReadFileStore
    ? ActionSharedFileStore
    : ReadonlyOperations<Shared[K]>;
};
export interface Members {
  list(options?: MemberListOptions): Promise<Page<Member>>;
  search(text: string | MemberSearchOptions, options?: MemberListOptions): Promise<Page<Member>>;
  get(id: string): Promise<Member | null>;
  getMany(ids: readonly string[]): Promise<readonly (Member | null)[]>;
}
export interface ContextBase {
  readonly viewer: Me;
  log(message: string, details?: Json): void;
}
export type QueryContext<C extends Config, Shared = Empty> = ContextBase &
  DeclaredMembers<C, Members> & {
    readonly tables: {
      readonly [N in keyof C["tables"] & string]: ReadonlyOperations<
        Pick<OwnedTable<C, N>, "get" | "getMany" | "list">
      >;
    };
    readonly shared: QueryShared<Shared>;
    readonly files: { readonly [N in keyof C["files"]]: QueryFileStore };
  };
export type MutationContext<C extends Config> = ContextBase &
  DeclaredMembers<C, Members> & {
    readonly tables: {
      readonly [N in keyof C["tables"] & string]: ReadonlyOperations<OwnedTable<C, N>>;
    };
  };
export type ActionContext<
  C extends Config,
  Modules = Empty,
  Shared = Empty,
  Connections = Empty
> = MutationContext<C> & {
  readonly shared: ActionShared<Shared>;
  readonly files: { readonly [N in keyof C["files"]]: ActionFileStore };
  readonly connections: Connections;
  readonly run: RunClient<Modules>;
};

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
    : D extends { readonly kind: "ref" | "member" }
      ? "References and members are table-only"
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
    const args: Record<string, Descriptor> = {};
    for (const [name, schema] of Object.entries(definition.args)) {
      Object.defineProperty(args, name, {
        value: schema.toJSON(),
        enumerable: true
      });
    }
    const descriptor = decodeHandlerDescriptor({
      kind,
      args,
      result: definition.result.toJSON(),
      ...(definition.errors === undefined ? {} : { errors: definition.errors })
    });
    return Object.freeze({
      kind,
      descriptor,
      handler: definition.handler,
      toJSON: () => descriptor
    });
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
