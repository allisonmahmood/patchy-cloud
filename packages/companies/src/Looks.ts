/**
 * A company's look: its numbered revisions and a pointer to the current one, like a patch's
 * versions and its served version. Publishing runs the look checks whoever calls it, so no
 * stored revision fails them. A restore that moves the pointer records who made it, when and
 * why, and the next publish clears that record. Callers authorize the admin; generation reads
 * `read(...).current` and `restored`, and `patchyLook` when the current revision is null; patch
 * publish reads `current` alone.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { LookFiles, PatchyLookFiles } from "@patchy/api";
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
export interface Revision {
  readonly revision: number;
  readonly author: { readonly id: string; readonly name: string };
  readonly createdAt: Date;
  readonly note: string;
}

/** The current revision, with the files a patch takes its look from. */
export interface Current extends Revision {
  readonly files: typeof LookFiles.Type;
}

/** The company's latest restore: who moved the pointer, when, and the note they gave. */
export interface Restore {
  readonly by: { readonly id: string; readonly name: string };
  readonly at: Date;
  readonly note: string | null;
}

export interface Look {
  /** Null when the company has no look, the starting state. */
  readonly current: Current | null;
  /** Every revision, newest first, including the current one. */
  readonly revisions: ReadonlyArray<Revision>;
  /** The latest restore, or null when a publish set the current revision or none came yet. */
  readonly restored: Restore | null;
}

export interface PublishInput {
  readonly companyId: string;
  readonly authorId: string;
  readonly note: string;
  readonly files: typeof LookFiles.Type;
}

export interface RestoreInput {
  readonly companyId: string;
  /** The revision to make current, or null for no look. */
  readonly revision: number | null;
  /** The admin restoring it. */
  readonly restoredBy: string;
  readonly note: string | null;
}

/** A change to the pointer, with the revision it moved from, null for no look. */
export interface Moved {
  readonly current: Revision | null;
  readonly from: number | null;
}

const RestoreRow = Schema.Struct({
  restoredById: Schema.NullOr(Schema.String),
  restoredByName: Schema.NullOr(Schema.String),
  restoredAt: Schema.NullOr(Schema.Date),
  restoreNote: Schema.NullOr(Schema.String)
});
const restoreOf = (row: typeof RestoreRow.Type | undefined): Restore | null =>
  row === undefined ||
  row.restoredById === null ||
  row.restoredByName === null ||
  row.restoredAt === null
    ? null
    : {
        by: { id: row.restoredById, name: row.restoredByName },
        at: row.restoredAt,
        note: row.restoreNote
      };

const RevisionRow = Schema.Struct({
  revision: Schema.Int,
  authorId: Schema.String,
  authorName: Schema.String,
  createdAt: Schema.Date,
  note: Schema.String
});
const Row = Schema.Struct({
  ...RevisionRow.fields,
  current: Schema.Boolean,
  css: Schema.NullOr(Schema.String),
  brief: Schema.NullOr(Schema.String),
  logo: Schema.NullOr(Schema.String),
  ...RestoreRow.fields
});
const revision = (row: typeof RevisionRow.Type): Revision => ({
  revision: row.revision,
  author: { id: row.authorId, name: row.authorName },
  createdAt: row.createdAt,
  note: row.note
});
/** Revisions are Postgres integers; a larger number names none. */
const MAX_REVISION = 2_147_483_647;

export class Looks extends Context.Service<
  Looks,
  {
    readonly read: (companyId: string) => Effect.Effect<Look, SqlError>;
    /**
     * The current revision without its files, or null when the company has no look: one plain
     * read, no history or lock. Publish uses it to warn a repo behind the company's look.
     */
    readonly current: (companyId: string) => Effect.Effect<Revision | null, SqlError>;
    /**
     * The Patchy look, Patchy's own, which stands in while a company has none: `look.css` and
     * `LOOK.md` from `looks/patchy/`, shipped with the release. It is no company's revision and
     * never carries Patchy's logo.
     */
    readonly patchyLook: typeof PatchyLookFiles.Type;
    /**
     * Checks the files, stores them as the next revision and makes it current. Clears the
     * restore record: the new revision's own author, time and note describe the look.
     */
    readonly publish: (
      input: PublishInput
    ) => Effect.Effect<
      Moved & { readonly current: Revision },
      InvalidLook | CompanyNotFound | SqlError
    >;
    /**
     * Points the company at one of its revisions, or at none, and records who restored it, when
     * and why. Copies nothing. Restoring what is already current changes nothing, the record
     * included. Returns the record as it stands afterwards.
     */
    readonly restore: (
      input: RestoreInput
    ) => Effect.Effect<
      Moved & { readonly restored: Restore | null },
      RevisionUnavailable | CompanyNotFound | SqlError
    >;
  }
>()("@patchy/companies/Looks") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Read once: the files belong to the release, and a release without them is broken.
  const shipped = (name: string) =>
    path
      .fromFileUrl(new URL(`../looks/patchy/${name}`, import.meta.url))
      .pipe(Effect.flatMap((file) => fs.readFileString(file)));
  const patchyLook = yield* Effect.all({
    "look.css": shipped("look.css"),
    "LOOK.md": shipped("LOOK.md")
  }).pipe(Effect.orDie);
  const dieOnSchemaError = { SchemaError: Effect.die } as const;
  // One statement, so the history, the current files and the restore record come from the same
  // moment. Every row repeats the record; a company with no revisions has never restored.
  const rows = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, only: Schema.NullOr(Schema.Int) }),
    Result: Row,
    execute: ({ companyId, only }) => sql`
      SELECT r.revision, u.id AS "authorId", u.name AS "authorName", r.created_at AS "createdAt",
        r.note, COALESCE(r.revision = c.current_look_revision, false) AS current,
        CASE WHEN r.revision = c.current_look_revision THEN r.look_css END AS css,
        CASE WHEN r.revision = c.current_look_revision THEN r.look_md END AS brief,
        CASE WHEN r.revision = c.current_look_revision THEN r.logo_svg END AS logo,
        ru.id AS "restoredById", ru.name AS "restoredByName",
        c.look_restored_at AS "restoredAt", c.look_restore_note AS "restoreNote"
      FROM companies c
      JOIN look_revisions r ON r.company_id = c.id
      JOIN users u ON u.id = r.author_id
      LEFT JOIN users ru ON ru.id = c.look_restored_by
      WHERE c.id = ${companyId} AND (${only}::integer IS NULL OR r.revision = ${only})
      ORDER BY r.revision DESC`
  });
  const currentRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RevisionRow,
    execute: (companyId) => sql`
      SELECT r.revision, u.id AS "authorId", u.name AS "authorName", r.created_at AS "createdAt",
        r.note
      FROM companies c
      JOIN look_revisions r ON r.company_id = c.id AND r.revision = c.current_look_revision
      JOIN users u ON u.id = r.author_id
      WHERE c.id = ${companyId}`
  });
  const lastRestore = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RestoreRow,
    execute: (companyId) => sql`
      SELECT u.id AS "restoredById", u.name AS "restoredByName",
        c.look_restored_at AS "restoredAt", c.look_restore_note AS "restoreNote"
      FROM companies c JOIN users u ON u.id = c.look_restored_by
      WHERE c.id = ${companyId}`
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
    if (number > MAX_REVISION) return null;
    const [row] = yield* rows({ companyId, only: number }).pipe(Effect.catchTags(dieOnSchemaError));
    return row === undefined ? null : revision(row);
  });
  const setPublished = (companyId: string, number: number) =>
    sql`UPDATE companies SET current_look_revision = ${number}, look_restored_by = NULL,
      look_restored_at = NULL, look_restore_note = NULL WHERE id = ${companyId}`;
  const setRestored = (input: RestoreInput, now: number) =>
    sql`UPDATE companies SET current_look_revision = ${input.revision},
      look_restored_by = ${input.restoredBy}, look_restored_at = to_timestamp(${now / 1_000}),
      look_restore_note = ${input.note} WHERE id = ${input.companyId}`;

  const read = Effect.fn("Looks.read")(function* (companyId: string) {
    const found = yield* rows({ companyId, only: null }).pipe(Effect.catchTags(dieOnSchemaError));
    const current = found.find((row) => row.current);
    return {
      current:
        current === undefined || current.css === null || current.brief === null
          ? null
          : {
              ...revision(current),
              files: {
                "look.css": current.css,
                "LOOK.md": current.brief,
                ...(current.logo === null ? {} : { "logo.svg": current.logo })
              }
            },
      revisions: found.map(revision),
      restored: restoreOf(found[0])
    } satisfies Look;
  });

  const current = Effect.fn("Looks.current")(function* (companyId: string) {
    const row = yield* currentRow(companyId).pipe(Effect.catchTags(dieOnSchemaError));
    return Option.isNone(row) ? null : revision(row.value);
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
        yield* setPublished(input.companyId, number);
        const current = yield* one(input.companyId, number);
        if (current === null) return yield* Effect.die("The published look revision vanished.");
        return { current, from };
      })
    );
  });

  const restore = Effect.fn("Looks.restore")(function* (input: RestoreInput) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const from = yield* locked(input.companyId);
        const current =
          input.revision === null ? null : yield* one(input.companyId, input.revision);
        if (input.revision !== null && current === null)
          return yield* new RevisionUnavailable({
            companyId: input.companyId,
            revision: input.revision
          });
        if (input.revision !== from) yield* setRestored(input, yield* Clock.currentTimeMillis);
        const restored = yield* lastRestore(input.companyId).pipe(
          Effect.catchTags(dieOnSchemaError)
        );
        return { current, from, restored: restoreOf(Option.getOrUndefined(restored)) };
      })
    );
  });

  return Looks.of({ read, current, patchyLook, publish, restore });
});

export const layer = Layer.effect(Looks, make);
