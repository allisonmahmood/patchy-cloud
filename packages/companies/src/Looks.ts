/**
 * A company's look: its numbered revisions and a pointer to the current one, like a patch's
 * versions and its served version. Publishing runs the look checks whoever calls it, so no
 * stored revision fails them. Callers authorize the admin; generation reads `read(...).current`.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { LookFiles } from "@patchy/api";
import { checkLook } from "@patchy/core/look";
import { CompanyNotFound } from "./Companies.js";

export class InvalidLook extends Schema.TaggedError<InvalidLook>()("InvalidLook", {
  errors: Schema.Array(Schema.String)
}) {
  override get message() {
    return "The look failed its checks; nothing was published.";
  }
}

export class RevisionUnavailable extends Schema.TaggedError<RevisionUnavailable>()(
  "LookRevisionUnavailable",
  { companyId: Schema.String, revision: Schema.Int }
) {
  override get message() {
    return `There is no look revision ${this.revision}.`;
  }
}

/** One revision without its files: number, author, time and note. */
export class Revision extends Schema.Class<Revision>("LookRevision")({
  revision: Schema.Int,
  author: Schema.Struct({ id: Schema.String, name: Schema.String }),
  createdAt: Schema.Date,
  note: Schema.String
}) {}

/** The current revision, with the files a patch takes its look from. */
export class Current extends Revision.extend<Current>("CurrentLook")({ files: LookFiles }) {}

export interface Look {
  /** Null when the company has no look, the starting state. */
  readonly current: Current | null;
  /** Every revision, newest first, including the current one. */
  readonly revisions: ReadonlyArray<Revision>;
}

export interface PublishInput {
  readonly companyId: string;
  readonly authorId: string;
  readonly note: string;
  readonly files: typeof LookFiles.Type;
}

/** A change to the pointer, with the revision it moved from, null for no look. */
export interface Moved {
  readonly current: Revision | null;
  readonly from: number | null;
}

const Row = Schema.Struct({
  revision: Schema.Int,
  authorId: Schema.String,
  authorName: Schema.String,
  createdAt: Schema.Date,
  note: Schema.String,
  current: Schema.Boolean,
  css: Schema.NullOr(Schema.String),
  brief: Schema.NullOr(Schema.String),
  logo: Schema.NullOr(Schema.String)
});
const revision = (row: typeof Row.Type) =>
  new Revision({
    revision: row.revision,
    author: { id: row.authorId, name: row.authorName },
    createdAt: row.createdAt,
    note: row.note
  });

export class Looks extends Context.Service<
  Looks,
  {
    readonly read: (companyId: string) => Effect.Effect<Look, SqlError>;
    /** Checks the files, stores them as the next revision and makes it current. */
    readonly publish: (
      input: PublishInput
    ) => Effect.Effect<
      Moved & { readonly current: Revision },
      InvalidLook | CompanyNotFound | SqlError
    >;
    /** Points the company at one of its revisions, or at none. Copies nothing. */
    readonly restore: (input: {
      readonly companyId: string;
      readonly revision: number | null;
    }) => Effect.Effect<Moved, RevisionUnavailable | CompanyNotFound | SqlError>;
  }
>()("@patchy/companies/Looks") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const dieOnSchemaError = { SchemaError: Effect.die } as const;
  // One statement, so the history and the current files come from the same moment.
  const rows = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, only: Schema.NullOr(Schema.Int) }),
    Result: Row,
    execute: ({ companyId, only }) => sql`
      SELECT r.revision, u.id AS "authorId", u.name AS "authorName", r.created_at AS "createdAt",
        r.note, COALESCE(r.revision = c.current_look_revision, false) AS current,
        CASE WHEN r.revision = c.current_look_revision THEN r.look_css END AS css,
        CASE WHEN r.revision = c.current_look_revision THEN r.look_md END AS brief,
        CASE WHEN r.revision = c.current_look_revision THEN r.logo_svg END AS logo
      FROM companies c
      JOIN look_revisions r ON r.company_id = c.id
      JOIN users u ON u.id = r.author_id
      WHERE c.id = ${companyId} AND (${only}::integer IS NULL OR r.revision = ${only})
      ORDER BY r.revision DESC`
  });
  // Serializes publishes and restores per company. NO KEY UPDATE leaves joins and invites,
  // which only take KEY SHARE on the company row, unblocked.
  const lockCompany = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ current: Schema.NullOr(Schema.Int) }),
    execute: (companyId) => sql`
      SELECT current_look_revision AS current FROM companies
      WHERE id = ${companyId} FOR NO KEY UPDATE`
  });
  const insert = SqlSchema.findOne({
    Request: Schema.Struct({
      companyId: Schema.String,
      authorId: Schema.String,
      note: Schema.String,
      css: Schema.String,
      brief: Schema.String,
      logo: Schema.NullOr(Schema.String),
      now: Schema.Number
    }),
    Result: Schema.Struct({ revision: Schema.Int }),
    execute: ({ companyId, authorId, note, css, brief, logo, now }) => sql`
      INSERT INTO look_revisions
        (company_id, revision, author_id, note, look_css, look_md, logo_svg, created_at)
      SELECT ${companyId}, COALESCE(MAX(revision), 0) + 1, ${authorId}, ${note}, ${css},
        ${brief}, ${logo}, to_timestamp(${now / 1_000})
      FROM look_revisions WHERE company_id = ${companyId}
      RETURNING revision`
  });

  const locked = Effect.fn("Looks.locked")(function* (companyId: string) {
    const company = yield* lockCompany(companyId).pipe(Effect.catchTags(dieOnSchemaError));
    if (Option.isNone(company)) return yield* new CompanyNotFound({ companyId });
    return company.value.current;
  });
  const one = Effect.fn("Looks.one")(function* (companyId: string, number: number) {
    const [row] = yield* rows({ companyId, only: number }).pipe(Effect.catchTags(dieOnSchemaError));
    return row === undefined ? null : revision(row);
  });
  const setCurrent = (companyId: string, number: number | null) =>
    sql`UPDATE companies SET current_look_revision = ${number} WHERE id = ${companyId}`;

  const read = Effect.fn("Looks.read")(function* (companyId: string) {
    const found = yield* rows({ companyId, only: null }).pipe(Effect.catchTags(dieOnSchemaError));
    const current = found.find((row) => row.current);
    return {
      current:
        current === undefined || current.css === null || current.brief === null
          ? null
          : new Current({
              ...revision(current),
              files: {
                "look.css": current.css,
                "LOOK.md": current.brief,
                ...(current.logo === null ? {} : { "logo.svg": current.logo })
              }
            }),
      revisions: found.map(revision)
    } satisfies Look;
  });

  const publish = Effect.fn("Looks.publish")(function* (input: PublishInput) {
    const errors = checkLook(input.files);
    if (errors.length > 0) return yield* new InvalidLook({ errors });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const from = yield* locked(input.companyId);
        const now = yield* Clock.currentTimeMillis;
        const { revision: number } = yield* insert({
          companyId: input.companyId,
          authorId: input.authorId,
          note: input.note,
          css: input.files["look.css"],
          brief: input.files["LOOK.md"],
          logo: input.files["logo.svg"] ?? null,
          now
        }).pipe(Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die }));
        yield* setCurrent(input.companyId, number);
        const current = yield* one(input.companyId, number);
        if (current === null) return yield* Effect.die("The published look revision vanished.");
        return { current, from };
      })
    );
  });

  const restore = Effect.fn("Looks.restore")(function* (input: {
    readonly companyId: string;
    readonly revision: number | null;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const from = yield* locked(input.companyId);
        if (input.revision === null) {
          yield* setCurrent(input.companyId, null);
          return { current: null, from };
        }
        const current = yield* one(input.companyId, input.revision);
        if (current === null)
          return yield* new RevisionUnavailable({
            companyId: input.companyId,
            revision: input.revision
          });
        yield* setCurrent(input.companyId, input.revision);
        return { current, from };
      })
    );
  });

  return Looks.of({ read, publish, restore });
});

export const layer = Layer.effect(Looks, make);
