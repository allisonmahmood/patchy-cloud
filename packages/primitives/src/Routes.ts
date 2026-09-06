/**
 * PROTOTYPE (#176). The HTTP operations the SDK client speaks, under
 * `/_patchy/*`, over `Tables` and `Files`. Which patch and which viewer a
 * request binds to is the `Binding` service the host provides: `patchy dev`
 * binds every request to the one repo and the machine token's user; a
 * server behind the shell broker would resolve it per request. The routes
 * themselves never learn anything the binding did not say.
 *
 * Refusals are `{ ok: false, error }` with the status, the same shape as
 * the API's, so the client has one thing to read.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Manifest } from "@patchy/api";
import type { ContentStore } from "@patchy/content-store";
import * as Files from "./Files.js";
import * as Tables from "./Tables.js";

export interface Viewer {
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  readonly company: { readonly id: string; readonly handle: string; readonly name: string };
}

/** The patch and the viewer a request acts for. */
export class Binding extends Context.Service<
  Binding,
  {
    readonly namespace: string;
    readonly manifest: Manifest;
    readonly viewer: Viewer;
  }
>()("@patchy/primitives/Routes/Binding") {}

const refuse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ ok: false, error }).pipe(HttpServerResponse.setStatus(status));

const InsertBody = Schema.Struct({ row: Schema.Record(Schema.String, Schema.Unknown) });
const ListBody = Schema.Struct({ limit: Schema.optionalKey(Schema.Number) });
const decodeInsert = Schema.decodeUnknownEffect(InsertBody);
const decodeList = Schema.decodeUnknownEffect(ListBody);

const jsonBody = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => request.json);

/** The table a path names, as the pair `Tables` takes, or the 404 for an undeclared one. */
const tableOf = (binding: Binding["Service"], name: string | undefined) => {
  const shape = name === undefined ? undefined : binding.manifest.tables[name];
  return shape === undefined || name === undefined
    ? Option.none()
    : Option.some([name, shape] as const);
};

const storeOf = (binding: Binding["Service"], name: string | undefined) =>
  name !== undefined && name in binding.manifest.files ? Option.some(name) : Option.none();

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const tables = yield* Tables.Tables;
    const files = yield* Files.Files;
    const binding = yield* Binding;
    const ns = binding.namespace;

    yield* router.add("GET", "/_patchy/me", HttpServerResponse.jsonUnsafe(binding.viewer));

    yield* router.add(
      "POST",
      "/_patchy/tables/:table/insert",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const table = tableOf(binding, params.table);
        if (Option.isNone(table))
          return refuse(404, `Table ${params.table} is not defined in patchy.config.ts.`);
        const body = yield* jsonBody.pipe(Effect.flatMap(decodeInsert), Effect.option);
        if (Option.isNone(body)) return refuse(400, "Body must be { row: { ... } }.");
        return yield* tables.insert(ns, table.value, body.value.row).pipe(
          Effect.map((row) => HttpServerResponse.jsonUnsafe({ row })),
          Effect.catchTags({
            InvalidRow: (error) => Effect.succeed(refuse(422, error.message)),
            SqlError: Effect.die
          })
        );
      })
    );

    yield* router.add(
      "POST",
      "/_patchy/tables/:table/list",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const table = tableOf(binding, params.table);
        if (Option.isNone(table))
          return refuse(404, `Table ${params.table} is not defined in patchy.config.ts.`);
        const body = yield* jsonBody.pipe(Effect.flatMap(decodeList), Effect.option);
        const rows = yield* tables
          .list(ns, table.value, Option.getOrUndefined(body)?.limit ?? 100)
          .pipe(Effect.catchTags({ SqlError: Effect.die }));
        return HttpServerResponse.jsonUnsafe({ rows });
      })
    );

    yield* router.add(
      "GET",
      "/_patchy/tables/:table/:id",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const table = tableOf(binding, params.table);
        if (Option.isNone(table))
          return refuse(404, `Table ${params.table} is not defined in patchy.config.ts.`);
        const row = yield* tables
          .get(ns, table.value, params.id ?? "")
          .pipe(Effect.catchTags({ SqlError: Effect.die }));
        return Option.isNone(row)
          ? refuse(404, "Row not found.")
          : HttpServerResponse.jsonUnsafe({ row: row.value });
      })
    );

    yield* router.add(
      "DELETE",
      "/_patchy/tables/:table/:id",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const table = tableOf(binding, params.table);
        if (Option.isNone(table))
          return refuse(404, `Table ${params.table} is not defined in patchy.config.ts.`);
        yield* tables
          .delete(ns, table.value, params.id ?? "")
          .pipe(Effect.catchTags({ SqlError: Effect.die }));
        return HttpServerResponse.jsonUnsafe({ ok: true });
      })
    );

    yield* router.add(
      "GET",
      "/_patchy/files/:store",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const store = storeOf(binding, params.store);
        if (Option.isNone(store))
          return refuse(404, `File store ${params.store} is not defined in patchy.config.ts.`);
        const list = yield* files
          .list(ns, store.value)
          .pipe(Effect.catchTags({ SqlError: Effect.die }));
        return HttpServerResponse.jsonUnsafe({ files: list });
      })
    );

    yield* router.add(
      "PUT",
      "/_patchy/files/:store/:name",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const store = storeOf(binding, params.store);
        if (Option.isNone(store))
          return refuse(404, `File store ${params.store} is not defined in patchy.config.ts.`);
        const buffer = yield* request.arrayBuffer.pipe(Effect.option);
        if (Option.isNone(buffer)) return refuse(400, "Could not read the file body.");
        const name = decodeURIComponent(params.name ?? "");
        return yield* files
          .put(
            ns,
            store.value,
            name,
            new Uint8Array(buffer.value),
            request.headers["content-type"] ?? "application/octet-stream"
          )
          .pipe(
            Effect.map((file) => HttpServerResponse.jsonUnsafe({ file })),
            Effect.catchTags({
              InvalidFileName: (error) => Effect.succeed(refuse(400, error.message)),
              InvalidObjectKey: Effect.die,
              StoreUnavailable: Effect.die,
              SqlError: Effect.die
            })
          );
      })
    );

    yield* router.add(
      "GET",
      "/_patchy/files/:store/:name",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const store = storeOf(binding, params.store);
        if (Option.isNone(store))
          return refuse(404, `File store ${params.store} is not defined in patchy.config.ts.`);
        return yield* files.get(ns, store.value, decodeURIComponent(params.name ?? "")).pipe(
          Effect.map(({ bytes, file }) =>
            HttpServerResponse.uint8Array(bytes, { contentType: file.contentType }).pipe(
              HttpServerResponse.setHeader(
                "content-disposition",
                `inline; filename="${encodeURIComponent(file.name)}"`
              )
            )
          ),
          Effect.catchTags({
            FileNotFound: (error) => Effect.succeed(refuse(404, error.message)),
            InvalidObjectKey: Effect.die,
            StoreUnavailable: Effect.die,
            SqlError: Effect.die
          })
        );
      })
    );

    yield* router.add(
      "DELETE",
      "/_patchy/files/:store/:name",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const store = storeOf(binding, params.store);
        if (Option.isNone(store))
          return refuse(404, `File store ${params.store} is not defined in patchy.config.ts.`);
        yield* files
          .delete(ns, store.value, decodeURIComponent(params.name ?? ""))
          .pipe(
            Effect.catchTags({
              InvalidObjectKey: Effect.die,
              StoreUnavailable: Effect.die,
              SqlError: Effect.die
            })
          );
        return HttpServerResponse.jsonUnsafe({ ok: true });
      })
    );

    yield* router.add("*", "/_patchy/*", refuse(404, "Not a Patchy operation."));
  })
);

/** The routes with their services, over a `SqlClient`, a `ContentStore` and a `Binding`. */
export const layerWithServices: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | Binding | SqlClient.SqlClient | ContentStore.ContentStore
> = layer.pipe(Layer.provide([Tables.layer, Files.layer]));
