// @effect-diagnostics nodeBuiltinImport:off -- Local WASM queries need a killable worker for hard deadlines.
import { Worker } from "node:worker_threads";
import { sha256 } from "@patchy/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Execution from "./Execution.js";
import { nativeType, quoteIdentifier, quoteLiteral, surface, typeMapping } from "./Mapping.js";
import type { Snapshot } from "./Snapshot.js";

export class FixtureMissing extends Schema.TaggedError<FixtureMissing>()("FixtureMissing", {
  path: Schema.String
}) {
  override get message() {
    return `Write the required Postgres fixture at ${this.path}.`;
  }
}
export class FixtureConfiguration extends Schema.TaggedError<FixtureConfiguration>()(
  "FixtureConfiguration",
  { field: Schema.Literals(["connectionId", "handle"]) }
) {
  override get message() {
    return `The fixture ${this.field} must be a safe filesystem name.`;
  }
}
export class FixtureInitialization extends Schema.TaggedError<FixtureInitialization>()(
  "FixtureInitialization",
  {
    path: Schema.String,
    cause: Schema.Defect()
  }
) {
  override get message() {
    return `The local Postgres fixture could not be initialized from ${this.path}.`;
  }
}
export class FixtureInvalid extends Schema.TaggedError<FixtureInvalid>()("FixtureInvalid", {
  path: Schema.String,
  details: Schema.Struct({ sqlstate: Schema.String, message: Schema.String }),
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return `Invalid Postgres fixture ${this.path}: ${this.details.message}`;
  }
}
export class FixtureRowInvalid extends Schema.TaggedError<FixtureRowInvalid>()(
  "FixtureRowInvalid",
  {
    path: Schema.String,
    relation: Schema.String,
    column: Schema.String
  }
) {
  override get message() {
    return `The fixture ${this.path} has an invalid value for ${this.relation}.${this.column}.`;
  }
}
export type DevError =
  | FixtureMissing
  | FixtureConfiguration
  | FixtureInitialization
  | FixtureInvalid
  | FixtureRowInvalid;
export interface Fixture {
  readonly connectionId: string;
  readonly handle: string;
  readonly root: string;
}

const Reply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    fields: Schema.Array(Schema.Struct({ name: Schema.String, dataTypeID: Schema.Int })),
    rows: Schema.Array(Schema.Array(Schema.Unknown))
  }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    code: Schema.String,
    message: Schema.String,
    position: Schema.optionalKey(Schema.String),
    bound: Schema.optionalKey(Schema.Literals(["rows", "bytes"])),
    limit: Schema.optionalKey(Schema.Int)
  })
]);
const decodeReply = Schema.decodeUnknownSync(Reply);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// A worker is the cancellation boundary: a synchronous WASM loop cannot starve the host's deadline.
// The worker owns no platform connection, credential, network source, or runtime log.
const workerSource = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const report = (error) => parentPort.postMessage({ kind: "error", code: typeof error.code === "string" ? error.code : "PGLITE", message: typeof error.message === "string" ? error.message : "PGlite could not execute this SQL.", ...(typeof error.position === "string" ? { position: error.position } : {}), ...(error.bound ? { bound: error.bound, limit: error.limit } : {}) });
(async () => {
  const { PGlite, protocol, types } = await import(workerData.module);
  // The worker receives resolved module URLs; a static import cannot cross this CommonJS worker boundary.
  const { citext } = await import(workerData.citextModule);
  const raw = (value) => value;
  const pg = await PGlite.create({ dataDir: workerData.dataDir, fsync: false, extensions: { citext }, parsers: { 20: raw, 1700: raw, 1082: raw, 1083: raw, 1114: raw, 1184: raw, 1266: raw } });
  const serialize = protocol.serialize;
  const batch = (...messages) => Buffer.concat(messages);
  if (workerData.initialize) {
    for (const sql of workerData.ddl) await pg.query(sql);
    await pg.exec(workerData.fixture);
  }
  parentPort.on("message", async (input) => {
    try {
      await pg.query("BEGIN READ ONLY");
      await pg.query("SET LOCAL statement_timeout = '10000ms'");
      await pg.query("SET LOCAL TIME ZONE 'UTC'");
      await pg.query("SET LOCAL DateStyle = 'ISO, YMD'");
      try {
        const description = await pg.describeQuery(input.text);
        const values = input.parameters.map((value, index) => value === null ? null : description.queryParams[index]?.serializer?.(value) ?? String(value));
        let messages = (await pg.execProtocol(batch(serialize.parse({ text: input.text }), serialize.bind({ values }), serialize.describe({ type: "P" }), serialize.execute({ rows: 1 }), serialize.flush()))).messages;
        let fields = [];
        const rows = [];
        let bytes = 32;
        while (true) {
          let suspended = false;
          for (const message of messages) {
            if (message.name === "rowDescription") {
              fields = message.fields.map(({ name, dataTypeID }) => ({ name, dataTypeID }));
            } else if (message.name === "dataRow") {
              const row = message.fields.map((value, index) => value === null ? null : types.parseType(value, fields[index].dataTypeID, pg.parsers));
              bytes += Buffer.byteLength(JSON.stringify(row)) + fields.reduce((size, field) => size + Buffer.byteLength(JSON.stringify(field.name)) + 1, 0) + 1;
              if (!input.validation && rows.length >= 1000) throw { code: "TOO_LARGE", message: "A database call is limited to 1000 rows.", bound: "rows", limit: 1000 };
              if (!input.validation && bytes > 8 * 1024 * 1024) throw { code: "TOO_LARGE", message: "A database call is limited to 8388608 bytes.", bound: "bytes", limit: 8 * 1024 * 1024 };
              rows.push(row);
            } else if (message.name === "portalSuspended") suspended = true;
          }
          if (!suspended) break;
          messages = (await pg.execProtocol(batch(serialize.execute({ rows: 1 }), serialize.flush()))).messages;
        }
        await pg.execProtocol(serialize.sync());
        await pg.query("ROLLBACK");
        await pg.query("DISCARD ALL");
        parentPort.postMessage({ kind: "result", fields, rows });
      } catch (error) {
        try {
          await pg.execProtocol(serialize.sync());
          await pg.query("ROLLBACK");
          await pg.query("DISCARD ALL");
        } catch (resetError) {
          report(resetError);
          parentPort.close();
          await pg.close();
          return;
        }
        throw error;
      }
    } catch (error) { report(error); }
  });
  parentPort.postMessage({ kind: "ready" });
})().catch(report);
`;

export const dev = (input: typeof Snapshot.Type, fixture: Fixture) =>
  Layer.effect(
    Execution.Execution,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const field of ["connectionId", "handle"] as const) {
        if (!/^[A-Za-z0-9_-]+$/.test(fixture[field]))
          return yield* new FixtureConfiguration({ field });
      }
      const fixturePath = path.resolve(fixture.root, "fixtures", `postgres-${fixture.handle}.sql`);
      if (!(yield* fs.exists(fixturePath))) return yield* new FixtureMissing({ path: fixturePath });
      const sql = yield* fs
        .readFileString(fixturePath)
        .pipe(Effect.mapError((cause) => new FixtureInitialization({ path: fixturePath, cause })));
      const snapshot = surface(input);
      const dataDir = path.resolve(
        fixture.root,
        ".patchy",
        "dev",
        `postgres-${fixture.connectionId}`
      );
      const stampPath = `${dataDir}.json`;
      const stamp = sha256(encodeJson({ version: 1, snapshot: input, fixture: sql }));
      const old = yield* fs.readFileString(stampPath).pipe(Effect.catch(() => Effect.succeed("")));
      const initialize = old !== stamp || !(yield* fs.exists(dataDir));
      if (initialize) {
        yield* fs
          .remove(dataDir, { recursive: true, force: true })
          .pipe(
            Effect.mapError((cause) => new FixtureInitialization({ path: fixturePath, cause }))
          );
        yield* fs
          .remove(stampPath, { force: true })
          .pipe(
            Effect.mapError((cause) => new FixtureInitialization({ path: fixturePath, cause }))
          );
      }
      yield* fs
        .makeDirectory(path.dirname(dataDir), { recursive: true })
        .pipe(Effect.mapError((cause) => new FixtureInitialization({ path: fixturePath, cause })));
      const ddl: string[] = [];
      const schemas = new Set(snapshot.relations.map((relation) => relation.schema));
      const usedEnums = snapshot.enums.filter((enumeration) =>
        snapshot.relations.some((relation) =>
          relation.columns.some((column) =>
            column.type.kind === "enum"
              ? column.type.baseSchema === enumeration.schema &&
                column.type.baseName === enumeration.name
              : column.type.element?.kind === "enum" &&
                column.type.element.baseSchema === enumeration.schema &&
                column.type.element.baseName === enumeration.name
          )
        )
      );
      for (const enumeration of usedEnums) schemas.add(enumeration.schema);
      const citextSchemas = new Set(
        snapshot.relations.flatMap((relation) =>
          relation.columns.flatMap((column) =>
            column.type.baseName === "citext"
              ? [column.type.baseSchema]
              : column.type.element?.baseName === "citext"
                ? [column.type.element.baseSchema]
                : []
          )
        )
      );
      for (const schema of citextSchemas) schemas.add(schema);
      for (const schema of schemas)
        ddl.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
      for (const schema of citextSchemas)
        ddl.push(`CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA ${quoteIdentifier(schema)}`);
      for (const enumeration of usedEnums)
        ddl.push(
          `CREATE TYPE ${quoteIdentifier(enumeration.schema)}.${quoteIdentifier(enumeration.name)} AS ENUM (${enumeration.labels.map(quoteLiteral).join(", ")})`
        );
      for (const relation of snapshot.relations) {
        const columns = relation.columns.map(
          (column) =>
            `${quoteIdentifier(column.name)} ${nativeType(column.type, snapshot)!}${column.nullable ? "" : " NOT NULL"}`
        );
        if (relation.primaryKey)
          columns.push(
            `PRIMARY KEY (${relation.primaryKey.columns.map(quoteIdentifier).join(", ")})`
          );
        ddl.push(
          `CREATE TABLE ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)} (${columns.join(", ")})`
        );
      }
      const worker = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            new Worker(workerSource, {
              eval: true,
              workerData: {
                module: import.meta.resolve("@electric-sql/pglite"),
                citextModule: import.meta.resolve("@electric-sql/pglite/contrib/citext"),
                dataDir,
                initialize,
                ddl,
                fixture: sql
              }
            }),
          catch: (cause) => new FixtureInitialization({ path: fixturePath, cause })
        }),
        (worker) => Effect.promise(() => worker.terminate()).pipe(Effect.asVoid)
      );
      let alive = true;
      worker.on("error", () => {
        alive = false;
      });
      worker.on("exit", () => {
        alive = false;
      });
      const receive = (message?: {
        readonly text: string;
        readonly parameters: Execution.QueryInput["parameters"];
        readonly validation?: boolean;
      }) =>
        Effect.callback<typeof Reply.Type, Execution.ExecutionError>((resume) => {
          if (!alive) {
            resume(Effect.fail(new Execution.SourceUnavailable({ stage: "query" })));
            return;
          }
          let settled = false;
          const cleanup = () => {
            worker.off("message", onMessage);
            worker.off("error", onError);
            worker.off("exit", onExit);
          };
          const onMessage = (value: unknown) => {
            settled = true;
            cleanup();
            try {
              resume(Effect.succeed(decodeReply(value)));
            } catch (cause) {
              resume(
                Effect.fail(
                  new Execution.SourceUnavailable({ stage: "query", cause: Redacted.make(cause) })
                )
              );
            }
          };
          const onError = (cause: unknown) => {
            settled = true;
            alive = false;
            cleanup();
            resume(
              Effect.fail(
                new Execution.SourceUnavailable({ stage: "query", cause: Redacted.make(cause) })
              )
            );
          };
          const onExit = () => onError(new Error("The local PGlite worker exited."));
          worker.once("message", onMessage);
          worker.once("error", onError);
          worker.once("exit", onExit);
          if (message) worker.postMessage(message);
          return Effect.suspend(() => {
            cleanup();
            if (settled) return Effect.void;
            alive = false;
            return Effect.promise(() => worker.terminate()).pipe(Effect.asVoid);
          });
        });
      const ready = yield* receive().pipe(
        Effect.timeoutOrElse({
          duration: 30_000,
          orElse: () => Effect.fail(new Execution.Timeout({ milliseconds: 30_000 }))
        }),
        Effect.mapError((cause) => new FixtureInitialization({ path: fixturePath, cause }))
      );
      if (ready.kind === "error")
        return yield* new FixtureInvalid({
          path: fixturePath,
          details: { sqlstate: ready.code, message: ready.message },
          cause: ready
        });
      if (ready.kind !== "ready")
        return yield* new FixtureInitialization({ path: fixturePath, cause: ready });
      const semaphore = yield* Semaphore.make(1);
      const query = Effect.fn("Postgres.Dev.query")(
        function* (query: Execution.QueryInput) {
          if (
            query.declaration.id !== fixture.connectionId ||
            query.declaration.handle !== fixture.handle
          )
            return yield* new Execution.AccessDenied({});
          const reply = yield* receive({ text: query.text, parameters: query.parameters }).pipe(
            Effect.timeoutOrElse({
              duration: 10_000,
              orElse: () => Effect.fail(new Execution.Timeout({ milliseconds: 10_000 }))
            })
          );
          if (reply.kind === "result") return { fields: reply.fields, rows: reply.rows };
          if (reply.kind === "error") {
            if (reply.bound && reply.limit)
              return yield* new Execution.TooLarge({ bound: reply.bound, limit: reply.limit });
            if (reply.code === "57014") {
              alive = false;
              yield* Effect.promise(() => worker.terminate());
            }
            if (reply.code === "PGLITE")
              return yield* new Execution.InvalidQuery({
                details: {
                  sqlstate: "0A000",
                  message: `Local PGlite cannot execute this query: ${reply.message}`
                },
                cause: Redacted.make(reply)
              });
            return yield* Execution.queryError(reply);
          }
          return yield* new Execution.SourceUnavailable({ stage: "query" });
        },
        semaphore.withPermits(1),
        Effect.timeoutOrElse({
          duration: 15_000,
          orElse: () => Effect.fail(new Execution.Timeout({ milliseconds: 15_000 }))
        })
      );
      for (const relation of snapshot.relations) {
        const projections = relation.columns.map(
          (column) =>
            `${typeMapping(column.type)!.project(quoteIdentifier(column.name))} AS ${quoteIdentifier(column.name)}`
        );
        const reply = yield* receive({
          text: `SELECT ${projections.join(", ")} FROM ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`,
          parameters: [],
          validation: true
        }).pipe(
          Effect.timeoutOrElse({
            duration: 15_000,
            orElse: () => Effect.fail(new Execution.Timeout({ milliseconds: 15_000 }))
          }),
          Effect.mapError((cause) => new FixtureInitialization({ path: fixturePath, cause }))
        );
        if (reply.kind === "error")
          return yield* new FixtureInvalid({
            path: fixturePath,
            details: { sqlstate: reply.code, message: reply.message },
            cause: reply
          });
        if (reply.kind !== "result")
          return yield* new FixtureInitialization({ path: fixturePath, cause: reply });
        for (const row of reply.rows)
          for (const [index, column] of relation.columns.entries()) {
            if (
              !(row[index] === null && column.nullable) &&
              !typeMapping(column.type)!.is(row[index])
            )
              return yield* new FixtureRowInvalid({
                path: fixturePath,
                relation: `${relation.schema}.${relation.name}`,
                column: column.name
              });
          }
      }
      if (initialize)
        yield* fs
          .writeFileString(stampPath, stamp)
          .pipe(
            Effect.mapError((cause) => new FixtureInitialization({ path: fixturePath, cause }))
          );
      return Execution.Execution.of({ query });
    })
  );
