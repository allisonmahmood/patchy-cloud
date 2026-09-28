import * as GuestProtocol from "@patchy/api/guest";
import { canonicalArgs } from "@patchy/api/canonical-args";
import * as Schema from "effect/Schema";
import type { Json, Upload } from "./config.js";
import { decodeError, PatchyError } from "./clientError.js";
import { extractHandlerDescriptors } from "./handlerDescriptors.js";
import { decodeHandlerError, isHandlerError } from "./handlerError.js";
import type { Handler, HandlerKindName } from "./server.js";

const decodeRequest = Schema.decodeUnknownSync(GuestProtocol.GuestRequest, {
  onExcessProperty: "error"
});
const decodeCallback = Schema.decodeUnknownSync(GuestProtocol.Callback, {
  onExcessProperty: "error"
});
const decodeCallbackReply = Schema.decodeUnknownSync(GuestProtocol.CallbackReply, {
  onExcessProperty: "error"
});
const decodeReply = Schema.decodeUnknownSync(GuestProtocol.GuestReply, {
  onExcessProperty: "error"
});

type Failure = Extract<GuestProtocol.GuestReply, { readonly ok: false }>;
type FileBody = NonNullable<GuestProtocol.Callback["body"]>;
type Callback = (
  op: string,
  args: Readonly<Record<string, unknown>>,
  body?: FileBody
) => Promise<GuestProtocol.CallbackReply>;
type Call = (op: string, args: Readonly<Record<string, unknown>>) => Promise<Json>;
type Definition = Handler<HandlerKindName, Readonly<Record<string, Json>>, unknown>;

interface GuestContext {
  readonly props: {
    readonly invocationId?: string;
    readonly callbacks?: {
      call(operation: unknown): Promise<unknown>;
    };
  };
}

const failure = (code: "invalid_request" | "handler_failed", error: string): Failure => ({
  ok: false,
  source: "patchy",
  code,
  error
});
const handlerFailed = () => failure("handler_failed", "The handler failed.");
const json = (value: GuestProtocol.GuestReply | GuestProtocol.InspectionReply) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

/** Names come from the generated context types; the host checks declarations and authority. */
const names = <T>(make: (name: string) => T): Readonly<Record<string, T>> =>
  new Proxy(Object.create(null) as Record<string, T>, {
    get(target, name: string | symbol) {
      if (typeof name !== "string") return undefined;
      if (!Object.hasOwn(target, name)) target[name] = make(name);
      return target[name];
    }
  });

const table = (call: Call, name: string, writable: boolean) => {
  const read = {
    get: (id: string) => call("tables.get", { table: name, id }),
    getMany: (ids: readonly string[]) => call("tables.getMany", { table: name, ids }),
    list: (options: object = {}) => call("tables.list", { ...options, table: name })
  };
  return writable
    ? {
        ...read,
        insert: (row: Json) => call("tables.insert", { table: name, row }),
        insertMany: (rows: readonly Json[]) => call("tables.insertMany", { table: name, rows }),
        update: (id: string, patch: Json) => call("tables.update", { table: name, id, patch }),
        delete: (id: string) => call("tables.delete", { table: name, id })
      }
    : read;
};

const shared = (call: Call, alias: string) => ({
  get: (id: string) => call("shared.get", { alias, id }),
  getMany: (ids: readonly string[]) => call("shared.getMany", { alias, ids }),
  list: (options: object = {}) => call("shared.list", { ...options, alias })
});

const fileStore = (call: Call, callback: Callback, store: string, writable: boolean) => {
  const read = {
    list: (options: object = {}) => call("files.list", { ...options, store }),
    stat: (name: string) => call("files.stat", { store, name })
  };
  return writable
    ? {
        ...read,
        async get(name: string) {
          const reply = await callback("files.get", { store, name });
          if (!reply.ok || !("body" in reply)) throw new Error("Invalid file callback reply.");
          return reply.body.bytes;
        },
        async put(
          name: string,
          input: Uint8Array | ArrayBuffer | Blob | Upload,
          options?: { readonly contentType: string }
        ) {
          if (typeof input === "string")
            return call("files.put", { ...options, store, name, upload: input });
          const bytes =
            input instanceof Uint8Array
              ? input
              : new Uint8Array(input instanceof ArrayBuffer ? input : await input.arrayBuffer());
          const contentType =
            options?.contentType ||
            (input instanceof Blob ? input.type : "") ||
            "application/octet-stream";
          const reply = await callback(
            "files.put",
            { store, name, contentType },
            {
              bytes,
              contentType
            }
          );
          if (!reply.ok || !("value" in reply)) throw new Error("Invalid file callback reply.");
          return reply.value;
        },
        delete: (name: string) => call("files.delete", { store, name })
      }
    : read;
};

// Match the generated Postgres client's public-relation and schema namespace conventions.
const postgres = (call: Call, connection: string) => {
  const rows = async (op: string, args: Readonly<Record<string, unknown>>) => {
    const value = await call(op, args);
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("ok" in value) ||
      value.ok !== true ||
      !("rows" in value) ||
      !Array.isArray(value.rows)
    )
      throw new Error("Invalid Postgres callback reply.");
    return value.rows;
  };
  const relation = (schema: string, name: string) => {
    const identity = { connection, relation: { schema, name } };
    return {
      list: (options: object = {}) => call("postgres.list", { ...options, ...identity }),
      get: async (key: Json) => (await rows("postgres.get", { ...identity, key }))[0] ?? null,
      getMany: (keys: readonly Json[]) => rows("postgres.getMany", { ...identity, keys })
    };
  };
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(target, name: string | symbol) {
      if (typeof name !== "string") return undefined;
      if (Object.hasOwn(target, name)) return target[name];
      if (name === "query") {
        return (target[name] = (
          sql: string,
          params: readonly Json[],
          shape: Readonly<
            Record<
              string,
              {
                readonly kind: string;
                readonly optional?: boolean;
                readonly isOptional?: boolean;
                readonly hasDefault?: boolean;
              }
            >
          >
        ) => {
          const wireShape = Object.fromEntries(
            Object.entries(shape).map(([column, value]) => {
              if (
                value.kind === "ref" ||
                value.hasDefault ||
                (!("isOptional" in value) &&
                  Object.keys(value).some((key) => key !== "kind" && key !== "optional"))
              )
                throw new PatchyError(
                  "invalid_request",
                  "Query shapes accept only kind and optional fields.",
                  {}
                );
              const optional = "isOptional" in value ? value.isOptional : value.optional;
              return [
                column,
                { kind: value.kind, ...(optional === undefined ? {} : { optional }) }
              ];
            })
          );
          return call("postgres.query", { connection, sql, params, shape: wireShape });
        });
      }
      // A name is either a public relation or a non-public schema. Its next property selects it.
      const publicRelation = relation("public", name);
      const schemas = names((table) => relation(name, table));
      return (target[name] = new Proxy(publicRelation, {
        get(operations, member: string | symbol) {
          if (typeof member !== "string") return undefined;
          if (!Object.hasOwn(operations, member)) return schemas[member];
          const operation = operations[member as keyof typeof operations];
          // A schema can itself contain a relation named get, getMany or list.
          if (!Object.hasOwn(operation, "list")) Object.assign(operation, schemas[member]);
          return operation;
        }
      }));
    }
  });
};

/** The generated bundle exports this Worker object, without importing privileged Workers APIs. */
export function createGuest(modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>) {
  const descriptors = extractHandlerDescriptors(modules);
  const handlers = new Map(
    Object.entries(descriptors).map(([name, descriptor]) => {
      const dot = name.indexOf(".");
      const definition = modules[name.slice(0, dot)]![name.slice(dot + 1)] as Definition;
      return [name, { descriptor, handler: definition.handler }] as const;
    })
  );

  return {
    async fetch(request: Request, _env: unknown, ctx: GuestContext): Promise<Response> {
      let input: GuestProtocol.GuestRequest;
      try {
        input = decodeRequest(await request.json());
      } catch {
        return json(failure("invalid_request", "Invalid guest request."));
      }
      if (input.type === "describe")
        return json({
          ok: true,
          handlers: Object.fromEntries(
            [...handlers].map(([name, entry]) => [name, entry.descriptor])
          )
        });
      const entry = handlers.get(input.handler);
      if (entry === undefined) return json(failure("invalid_request", "Unknown handler."));
      const callbacks = ctx.props.callbacks;
      if (callbacks === undefined || !ctx.props.invocationId)
        return json(failure("invalid_request", "Missing invocation callbacks."));

      const refusals = new WeakMap<Error, Failure>();
      const errorReply = (error: unknown): Failure => {
        if (error instanceof Error) {
          const refused = refusals.get(error);
          if (refused !== undefined) return refused;
          if (
            "code" in error &&
            typeof error.code === "string" &&
            isHandlerError(error, error.code)
          ) {
            try {
              const reply = decodeReply({
                ok: false,
                source: "handler",
                code: error.code,
                ...(error.details === undefined ? {} : { details: error.details })
              });
              if (!reply.ok) return reply;
            } catch {
              return handlerFailed();
            }
          }
        }
        return handlerFailed();
      };
      let active = true;
      const callback: Callback = async (op, args, body) => {
        if (!active) throw new Error("The invocation has ended.");
        const operation = decodeCallback({
          op,
          args: JSON.parse(canonicalArgs(args)),
          ...(body === undefined ? {} : { body })
        });
        const received = await callbacks.call(operation);
        if (received === null || typeof received !== "object")
          throw new Error("Invalid callback reply.");
        // RPC adds disposal metadata to the envelope; it is not part of the wire data.
        const { [Symbol.dispose]: dispose, ...wire } = received as Record<PropertyKey, unknown>;
        let reply: GuestProtocol.CallbackReply;
        try {
          reply = decodeCallbackReply(wire);
        } finally {
          if (typeof dispose === "function") dispose.call(received);
        }
        if (!reply.ok) {
          const error =
            decodeHandlerError(reply) ?? decodeError(reply) ?? new Error("Callback refused.");
          refusals.set(error, reply);
          throw error;
        }
        return reply;
      };
      const call: Call = async (op, args) => {
        const reply = await callback(op, args);
        if (!reply.ok || !("value" in reply)) throw new Error("Invalid JSON callback reply.");
        return reply.value;
      };
      const pendingLogs: Promise<Failure | undefined>[] = [];
      const kind = entry.descriptor.kind;
      const context = {
        viewer: input.viewer,
        tables: names((name) => table(call, name, kind !== "query")),
        log(message: string, details?: Json): void {
          pendingLogs.push(
            call("log", { message, ...(details === undefined ? {} : { details }) }).then(
              () => undefined,
              errorReply
            )
          );
        },
        ...(kind === "mutation"
          ? {}
          : {
              shared: names((alias) => shared(call, alias)),
              files: names((store) => fileStore(call, callback, store, kind === "action"))
            }),
        ...(kind !== "action"
          ? {}
          : {
              connections: names((connection) => postgres(call, connection)),
              run: names((module) =>
                names(
                  (name) =>
                    (args: Readonly<Record<string, Json>> = {}) =>
                      call("server.call", { handler: `${module}.${name}`, args })
                )
              )
            })
      };
      let reply: GuestProtocol.GuestReply;
      try {
        reply = decodeReply({ ok: true, value: await entry.handler(context as never, input.args) });
      } catch (error) {
        reply = errorReply(error);
      }
      let logFailure: Failure | undefined;
      // log() is synchronous to handlers, but its callbacks belong to this invocation's reply.
      for (let index = 0; index < pendingLogs.length; index++) {
        const refused = await pendingLogs[index];
        logFailure ??= refused;
      }
      active = false;
      try {
        return json(logFailure ?? reply);
      } catch {
        return json(handlerFailed());
      }
    }
  };
}
