import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { CompanyNotFound } from "./Companies.js";

export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("DirectoryInvalidCursor", {
  companyId: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return "Invalid directory cursor; use a cursor from the same company and search.";
  }
}

export class Member extends Schema.Class<Member>("DirectoryMember")({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  admin: Schema.Boolean,
  active: Schema.Boolean
}) {}

export interface Page {
  readonly rows: readonly Member[];
  readonly cursor: string | null;
}

class CandidateRow extends Member.extend<CandidateRow>("DirectoryCandidateRow")({
  sortName: Schema.String,
  sortEmail: Schema.String
}) {}

const CursorData = Schema.Struct({
  version: Schema.Literal(1),
  companyId: Schema.String,
  text: Schema.NullOr(Schema.String),
  name: Schema.String,
  email: Schema.String,
  id: Schema.String
});
const Cursor = Schema.fromJsonString(CursorData);
const decodeCursor = Schema.decodeUnknownEffect(Cursor);
const encodeCursor = Schema.encodeSync(Cursor);
const isCursorEncoding = Schema.is(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)));

/** Platform-domain reads. Callers authorize access and supply their page bound. */
export class Directory extends Context.Service<
  Directory,
  {
    readonly list: (
      companyId: string,
      limit: number,
      cursor?: string
    ) => Effect.Effect<Page, InvalidCursor | SqlError>;
    readonly search: (
      companyId: string,
      text: string,
      limit: number,
      cursor?: string
    ) => Effect.Effect<Page, InvalidCursor | SqlError>;
    readonly get: (companyId: string, id: string) => Effect.Effect<Member | null, SqlError>;
    readonly getMany: (
      companyId: string,
      ids: readonly string[]
    ) => Effect.Effect<readonly (Member | null)[], SqlError>;
    readonly candidates: (
      companyId: string,
      ids: readonly string[]
    ) => Effect.Effect<readonly string[], SqlError>;
    readonly revision: (companyId: string) => Effect.Effect<string, CompanyNotFound | SqlError>;
  }
>()("@patchy/companies/Directory") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const dieOnSchemaError = { SchemaError: Effect.die } as const;
  const columns = sql`id, name, email, role = 'admin' AS admin, deactivated_at IS NULL AS active`;
  const ref = Schema.Struct({ companyId: Schema.String, id: Schema.String });
  const byId = SqlSchema.findOneOption({
    Request: ref,
    Result: Member,
    execute: ({ companyId, id }) =>
      sql`SELECT ${columns} FROM users WHERE company_id = ${companyId} AND id = ${id}`
  });
  const byIds = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, ids: Schema.Array(Schema.String) }),
    Result: Member,
    execute: ({ companyId, ids }) =>
      sql`SELECT ${columns} FROM users WHERE company_id = ${companyId} AND ${sql.in("id", ids)}`
  });
  const candidatesByIds = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, ids: Schema.Array(Schema.String) }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ companyId, ids }) =>
      sql.unsafe(
        `SELECT id FROM users WHERE company_id = $1
          AND id = ANY($2::text[]) AND deactivated_at IS NULL`,
        [companyId, ids]
      )
  });
  const directoryRevision = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ revision: Schema.String }),
    execute: (companyId) => sql`
      SELECT COALESCE(d.revision, 0)::text AS revision
      FROM companies c LEFT JOIN companies_directory d ON d.company_id = c.id
      WHERE c.id = ${companyId}`
  });
  const candidatePage = SqlSchema.findAll({
    Request: Schema.Struct({
      companyId: Schema.String,
      text: Schema.NullOr(Schema.String),
      limit: Schema.Int,
      after: Schema.NullOr(CursorData)
    }),
    Result: CandidateRow,
    execute: ({ companyId, text, limit, after }) => {
      // Escape the escape character before SQL's two pattern metacharacters.
      const prefix = text === null ? "" : `${text.replaceAll(/[%_\\]/g, "\\$&")}%`;
      const match =
        text === null
          ? sql`TRUE`
          : sql`(lower(name) LIKE lower(${prefix}) ESCAPE '\\'
            OR lower(email) LIKE lower(${prefix}) ESCAPE '\\')`;
      const position =
        after === null
          ? sql`TRUE`
          : sql`(lower(name) COLLATE "C", lower(email) COLLATE "C", id COLLATE "C")
            > (${after.name}, ${after.email}, ${after.id})`;
      return sql`
        SELECT ${columns}, lower(name) AS "sortName", lower(email) AS "sortEmail"
        FROM users WHERE company_id = ${companyId} AND deactivated_at IS NULL
          AND ${match} AND ${position}
        ORDER BY lower(name) COLLATE "C", lower(email) COLLATE "C", id COLLATE "C"
        LIMIT ${limit + 1}`;
    }
  });

  const page = Effect.fn("Directory.page")(function* (
    companyId: string,
    text: string | null,
    limit: number,
    cursor?: string
  ) {
    let after: typeof Cursor.Type | null = null;
    if (cursor !== undefined) {
      if (!isCursorEncoding(cursor)) return yield* new InvalidCursor({ companyId });
      const json = yield* Effect.fromResult(Base64Url.decodeString(cursor)).pipe(
        Effect.mapError((cause) => new InvalidCursor({ companyId, cause }))
      );
      after = yield* decodeCursor(json).pipe(
        Effect.mapError((cause) => new InvalidCursor({ companyId, cause }))
      );
      if (after.companyId !== companyId || after.text !== text)
        return yield* new InvalidCursor({ companyId });
    }
    const found = yield* candidatePage({ companyId, text, limit, after }).pipe(
      Effect.catchTags(dieOnSchemaError)
    );
    const rows = found
      .slice(0, limit)
      .map(({ id, name, email, admin, active }) => new Member({ id, name, email, admin, active }));
    const last = found[limit - 1];
    return {
      rows,
      cursor:
        found.length > limit && last !== undefined
          ? Base64Url.encode(
              encodeCursor({
                version: 1,
                companyId,
                text,
                name: last.sortName,
                email: last.sortEmail,
                id: last.id
              })
            )
          : null
    } satisfies Page;
  });
  const get = Effect.fn("Directory.get")((companyId: string, id: string) =>
    byId({ companyId, id }).pipe(Effect.catchTags(dieOnSchemaError), Effect.map(Option.getOrNull))
  );
  const getMany = Effect.fn("Directory.getMany")(function* (
    companyId: string,
    ids: readonly string[]
  ) {
    if (ids.length === 0) return [];
    const found = yield* byIds({ companyId, ids: [...new Set(ids)] }).pipe(
      Effect.catchTags(dieOnSchemaError)
    );
    const members = new Map(found.map((member) => [member.id, member]));
    return ids.map((id) => members.get(id) ?? null);
  });
  const candidates = Effect.fn("Directory.candidates")(function* (
    companyId: string,
    ids: readonly string[]
  ) {
    if (ids.length === 0) return [];
    const found = yield* candidatesByIds({ companyId, ids }).pipe(
      Effect.catchTags(dieOnSchemaError)
    );
    return found.map(({ id }) => id);
  });
  const revision = Effect.fn("Directory.revision")(function* (companyId: string) {
    const found = yield* directoryRevision(companyId).pipe(Effect.catchTags(dieOnSchemaError));
    if (Option.isNone(found)) return yield* new CompanyNotFound({ companyId });
    return found.value.revision;
  });
  return Directory.of({
    list: (companyId, limit, cursor) => page(companyId, null, limit, cursor),
    search: (companyId, text, limit, cursor) => page(companyId, text, limit, cursor),
    get,
    getMany,
    candidates,
    revision
  });
});

export const layer = Layer.effect(Directory, make);
