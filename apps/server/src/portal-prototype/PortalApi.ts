/**
 * THROWAWAY (prototype #241): the `portalPrototype` API group behind
 * `patchy list`, over the same queries the portal pages read. Tables and file
 * stores come from the cumulative inventory when the caller may read it (the
 * owner, live patch) and from the current version's manifest otherwise.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  CurrentIdentity,
  NotFound,
  PatchDetail,
  PatchList,
  PortalPrototypeApi,
  PrimitiveDetail,
  refuse,
  type Manifest,
  type TableDefinition
} from "@patchy/api";
import { isPatchId } from "@patchy/core";
import { Patches } from "@patchy/patches";
import { Session } from "@patchy/auth";
import * as PortalQueries from "./PortalQueries.js";

const encodeList = Schema.encodeSync(PatchList);
const encodeDetail = Schema.encodeSync(PatchDetail);
const encodePrimitive = Schema.encodeSync(PrimitiveDetail);
const noStore = { headers: { "cache-control": "private, no-store" } };
const notFound = () => refuse(NotFound, { ok: false, error: "Patch not found." }, noStore.headers);

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

const summary = (
  row: PortalQueries.PatchRow,
  viewerUserId: string,
  publicBaseUrl: string
): (typeof PatchList.Type)["patches"][number] => ({
  id: row.id,
  name: row.name,
  address: `${publicBaseUrl.replace(/\/+$/, "")}/${row.companyHandle}/${row.name}`,
  owner: { id: row.ownerId, name: row.ownerName, deactivated: row.ownerDeactivatedAt !== null },
  mine: row.ownerId === viewerUserId,
  tier: row.tier ?? 0,
  scope: row.scope,
  description: row.description,
  state: PortalQueries.stateOf(row),
  retiredAt: iso(row.retiredAt),
  deletedAt: iso(row.deletedAt),
  currentVersion: row.currentVersionNumber,
  publishedAt: iso(row.publishedAt)
});

type Definitions = Pick<typeof Manifest.Type, "tables" | "files"> & {
  readonly schemaRevision: number;
};

const columnsOf = (table: typeof TableDefinition.Type) =>
  Object.entries(table.columns).map(([name, column]) => ({
    name,
    kind: column.kind,
    optional: column.optional === true,
    ...("default" in column && column.default !== undefined ? { default: column.default } : {}),
    ...(column.kind === "ref" ? { ref: column.table } : {})
  }));

export const layer = HttpApiBuilder.group(PortalPrototypeApi, "portalPrototype", (handlers) =>
  Effect.gen(function* () {
    const queries = yield* PortalQueries.PortalQueries;
    const patches = yield* Patches.Patches;
    const session = yield* Session.Session;
    const publicBaseUrl = session.publicBaseUrl;

    /** By id in any state; by name only while the name resolves to a non-deleted patch. */
    const resolve = Effect.fn("PortalApi.resolve")(function* (companyId: string, ref: string) {
      if (isPatchId(ref)) return yield* queries.byId(companyId, ref);
      const found = yield* queries.byName(companyId, ref);
      return Option.filter(found, (row) => PortalQueries.stateOf(row) !== "deleted");
    });

    /** Cumulative inventory for the owner of a live patch; the current manifest for everyone else. */
    const definitions = Effect.fn("PortalApi.definitions")(function* (
      row: PortalQueries.PatchRow,
      viewerUserId: string
    ): Effect.fn.Return<Definitions | null, never, never> {
      const inventory = yield* patches.inventory(row.id, viewerUserId).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          PatchUnavailable: () => Effect.succeed(Option.none()),
          Busy: () => Effect.succeed(Option.none()),
          CompanyDatabaseError: () => Effect.succeed(Option.none()),
          CompanyDatabaseNotReady: () => Effect.succeed(Option.none()),
          CompanyIdentityMismatch: Effect.die,
          SqlError: Effect.die
        })
      );
      if (Option.isSome(inventory)) return inventory.value;
      const manifest = yield* queries
        .currentManifest(row.id)
        .pipe(Effect.catchTags({ SqlError: Effect.die }));
      return Option.match(manifest, {
        onNone: () => null,
        onSome: (value) => ({
          tables: value.tables,
          files: value.files,
          schemaRevision: row.schemaRevision ?? 0
        })
      });
    });

    return handlers
      .handle("listPatches", ({ query }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const rows = yield* queries
            .list(identity.company.id)
            .pipe(Effect.catchTags({ SqlError: Effect.die }));
          const state = query.state ?? "live";
          const mine = query.mine ?? false;
          const shown = rows
            .map((row) => summary(row, identity.user.id, publicBaseUrl))
            .filter((row) => (state === "all" ? true : row.state === state))
            .filter((row) => !mine || row.mine)
            .sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name));
          return HttpServerResponse.jsonUnsafe(
            encodeList({ patches: shown, connections: [] }),
            noStore
          );
        })
      )
      .handle("showPatch", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const found = yield* resolve(identity.company.id, params.patchRef).pipe(
            Effect.catchTags({ SqlError: Effect.die })
          );
          if (Option.isNone(found)) return notFound();
          const row = found.value;
          const defs = yield* definitions(row, identity.user.id);
          const live = PortalQueries.stateOf(row) === "live";
          const tables = Object.entries(defs?.tables ?? {}).map(([name, table]) => {
            const shared = table.shared === true;
            return {
              name,
              description: "",
              shared,
              declarable: shared && live,
              ...(shared && live
                ? { hint: `patchy add shared-table ${row.id}/${name}` }
                : shared
                  ? { reason: `not declarable while the patch is ${PortalQueries.stateOf(row)}` }
                  : { reason: `not shared; ask ${row.ownerName}` })
            };
          });
          const stores = Object.keys(defs?.files ?? {}).map((name) => ({
            name,
            description: "",
            declarable: false as const,
            reason: "not shareable yet"
          }));
          return HttpServerResponse.jsonUnsafe(
            encodeDetail({ ...summary(row, identity.user.id, publicBaseUrl), tables, stores }),
            noStore
          );
        })
      )
      .handle("showPrimitive", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const found = yield* resolve(identity.company.id, params.patchRef).pipe(
            Effect.catchTags({ SqlError: Effect.die })
          );
          if (Option.isNone(found)) return notFound();
          const row = found.value;
          const defs = yield* definitions(row, identity.user.id);
          const table = defs?.tables[params.name];
          if (table !== undefined) {
            return HttpServerResponse.jsonUnsafe(
              encodePrimitive({
                kind: "table",
                name: params.name,
                description: "",
                shared: table.shared === true,
                schemaRevision: defs!.schemaRevision,
                columns: columnsOf(table),
                indexes: Object.entries(table.indexes).map(([name, index]) => ({
                  name,
                  columns: index.columns,
                  unique: index.unique === true
                }))
              }),
              noStore
            );
          }
          if (defs !== null && Object.hasOwn(defs.files, params.name)) {
            return HttpServerResponse.jsonUnsafe(
              encodePrimitive({
                kind: "store",
                name: params.name,
                description: "",
                shared: false,
                schemaRevision: defs.schemaRevision,
                columns: [],
                indexes: []
              }),
              noStore
            );
          }
          return refuse(
            NotFound,
            { ok: false, error: `No table or file store named ${params.name}.` },
            noStore.headers
          );
        })
      );
  })
);
