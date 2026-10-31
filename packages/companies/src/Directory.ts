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

/**
 * A person as a company's directory shows them: one of its members, or one of its guests, who
 * alone carry `guest`.
 */
export class Member extends Schema.Class<Member>("DirectoryMember")({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  admin: Schema.Boolean,
  active: Schema.Boolean,
  guest: Schema.optionalKey(Schema.Literal(true))
}) {}

export interface Page {
  readonly rows: readonly Member[];
  readonly cursor: string | null;
}

/**
 * Whose people a read covers: the company's members, and guests of its patches by user id,
 * `true` while their grant is active. Patches holds the grants; the host reads them and passes
 * them in.
 */
export interface Scope {
  readonly companyId: string;
  readonly guests: ReadonlyMap<string, boolean>;
}

/** A user as stored, before a scope says what they are to its company. */
class PersonRow extends Schema.Class<PersonRow>("DirectoryPersonRow")({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  companyId: Schema.String,
  admin: Schema.Boolean,
  accountActive: Schema.Boolean
}) {}

class CandidateRow extends PersonRow.extend<CandidateRow>("DirectoryCandidateRow")({
  sortName: Schema.String,
  sortEmail: Schema.String
}) {}

/**
 * What a person is to the scope's company: a member, or a guest, who is never its admin and is
 * active while both their account and a grant are.
 */
const memberOf = ({ companyId, guests }: Scope, row: PersonRow) => {
  const { id, name, email } = row;
  return row.companyId === companyId
    ? new Member({ id, name, email, admin: row.admin, active: row.accountActive })
    : new Member({
        id,
        name,
        email,
        admin: false,
        active: row.accountActive && guests.get(id) === true,
        guest: true
      });
};

/** The guests a scope lets pickers offer and assignments name: those whose grant is active. */
const activeGuests = (scope: Scope) =>
  [...scope.guests].flatMap(([id, active]) => (active ? [id] : []));

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

/**
 * Platform-domain reads. Callers authorize access and supply their page bound and scope. Lists,
 * searches and candidates hold active people; `get` and `getMany` resolve anyone in scope.
 */
export class Directory extends Context.Service<
  Directory,
  {
    readonly list: (
      scope: Scope,
      limit: number,
      cursor?: string
    ) => Effect.Effect<Page, InvalidCursor | SqlError>;
    readonly search: (
      scope: Scope,
      text: string,
      limit: number,
      cursor?: string
    ) => Effect.Effect<Page, InvalidCursor | SqlError>;
    readonly get: (scope: Scope, id: string) => Effect.Effect<Member | null, SqlError>;
    readonly getMany: (
      scope: Scope,
      ids: readonly string[]
    ) => Effect.Effect<readonly (Member | null)[], SqlError>;
    readonly candidates: (
      scope: Scope,
      ids: readonly string[]
    ) => Effect.Effect<readonly string[], SqlError>;
    readonly revision: (companyId: string) => Effect.Effect<string, CompanyNotFound | SqlError>;
  }
>()("@patchy/companies/Directory") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const dieOnSchemaError = { SchemaError: Effect.die } as const;
  const columns = sql`id, name, email, company_id AS "companyId", role = 'admin' AS admin,
    deactivated_at IS NULL AS "accountActive"`;
  const people = Schema.Struct({
    companyId: Schema.String,
    guests: Schema.Array(Schema.String),
    ids: Schema.Array(Schema.String)
  });
  const byIds = SqlSchema.findAll({
    Request: people,
    Result: PersonRow,
    execute: ({ companyId, guests, ids }) => sql`SELECT ${columns} FROM users
      WHERE ${sql.in("id", ids)} AND (company_id = ${companyId} OR ${sql.in("id", guests)})`
  });
  const candidatesByIds = SqlSchema.findAll({
    Request: people,
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ companyId, guests, ids }) =>
      sql.unsafe(
        `SELECT id FROM users WHERE id = ANY($1::text[]) AND deactivated_at IS NULL
          AND (company_id = $2 OR id = ANY($3::text[]))`,
        [ids, companyId, guests]
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
      guests: Schema.Array(Schema.String),
      text: Schema.NullOr(Schema.String),
      limit: Schema.Int,
      after: Schema.NullOr(CursorData)
    }),
    Result: CandidateRow,
    execute: ({ companyId, guests, text, limit, after }) => {
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
        FROM users WHERE (company_id = ${companyId} OR ${sql.in("id", guests)})
          AND deactivated_at IS NULL AND ${match} AND ${position}
        ORDER BY lower(name) COLLATE "C", lower(email) COLLATE "C", id COLLATE "C"
        LIMIT ${limit + 1}`;
    }
  });

  const page = Effect.fn("Directory.page")(function* (
    scope: Scope,
    text: string | null,
    limit: number,
    cursor?: string
  ) {
    const { companyId } = scope;
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
    const found = yield* candidatePage({
      companyId,
      guests: activeGuests(scope),
      text,
      limit,
      after
    }).pipe(Effect.catchTags(dieOnSchemaError));
    const rows = found.slice(0, limit).map((row) => memberOf(scope, row));
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
  const getMany = Effect.fn("Directory.getMany")(function* (scope: Scope, ids: readonly string[]) {
    if (ids.length === 0) return [];
    const found = yield* byIds({
      companyId: scope.companyId,
      guests: [...scope.guests.keys()],
      ids: [...new Set(ids)]
    }).pipe(Effect.catchTags(dieOnSchemaError));
    const members = new Map(found.map((row) => [row.id, memberOf(scope, row)]));
    return ids.map((id) => members.get(id) ?? null);
  });
  const candidates = Effect.fn("Directory.candidates")(function* (
    scope: Scope,
    ids: readonly string[]
  ) {
    if (ids.length === 0) return [];
    const found = yield* candidatesByIds({
      companyId: scope.companyId,
      guests: activeGuests(scope),
      ids
    }).pipe(Effect.catchTags(dieOnSchemaError));
    return found.map(({ id }) => id);
  });
  const revision = Effect.fn("Directory.revision")(function* (companyId: string) {
    const found = yield* directoryRevision(companyId).pipe(Effect.catchTags(dieOnSchemaError));
    if (Option.isNone(found)) return yield* new CompanyNotFound({ companyId });
    return found.value.revision;
  });
  return Directory.of({
    list: (scope, limit, cursor) => page(scope, null, limit, cursor),
    search: (scope, text, limit, cursor) => page(scope, text, limit, cursor),
    get: (scope, id) => getMany(scope, [id]).pipe(Effect.map(([member]) => member ?? null)),
    getMany,
    candidates,
    revision
  });
});

export const layer = Layer.effect(Directory, make);
