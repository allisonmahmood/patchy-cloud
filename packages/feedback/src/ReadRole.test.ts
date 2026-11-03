/**
 * The read role, made from `read-role.sql`, audited by `read-role-audit.sql` and dropped by
 * `read-role-drop.sql`, the files `docs/OPERATIONS.md` runs with psql. Signed in as it, the
 * feedback schema's rows answer and no other platform table's do, and the audit catches a
 * column PUBLIC was granted.
 */
import { readFileSync } from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { inject } from "vitest";
import { layerFromUrl } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";

/**
 * A psql file's statements, each ending with a semicolon at the end of a line, with `:"name"`
 * and `:'name'` filled in and quoted as psql would.
 */
const psql = (file: string, variables: Readonly<Record<string, string>>) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .split(/;[ \t]*(?:\n|$)/)
    .map((statement) =>
      statement
        .trim()
        .replace(/:"(\w+)"/g, (_, name: string) => `"${variables[name]!.replaceAll('"', '""')}"`)
        .replace(/:'(\w+)'/g, (_, name: string) => `'${variables[name]!.replaceAll("'", "''")}'`)
    )
    .filter((statement) => statement !== "");

/** Each statement's rows, in order. */
const run = (statements: ReadonlyArray<string>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(statements, (statement) => sql.unsafe<Record<string, unknown>>(statement))
  );

it.layer(Testing.layer())("the feedback read role", (it) => {
  it.effect(
    "reads the feedback schema's rows, later tables included, and no other table's; the audit catches a PUBLIC column",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_reader', 'reader', 'Reader')`;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES ('usr_reader', 'clerk_reader', 'cmp_reader', 'reader@example.com', 'Reader', 'admin')`;
        yield* sql`INSERT INTO feedback.submissions (id, kind, text, company_id, user_id, surface, agent)
        VALUES ('req_reader', 'request', 'Gmail integration', 'cmp_reader', 'usr_reader', 'cli', 'codex')`;
        yield* sql`INSERT INTO feedback.general_requests (title) VALUES ('Email integrations')`;

        const [settings] = yield* sql<{ owner: string; database: string }>`
        SELECT current_user AS owner, current_database() AS database`;
        const { owner, database } = settings!;
        const role = `feedback_reader_${(yield* Random.nextInt).toString(36)}`;
        const password = `pw'${(yield* Random.nextInt).toString(36)}"`;
        // Roles belong to the whole cluster, which other suites share: drop it whatever happens.
        yield* Effect.acquireRelease(run(psql("read-role.sql", { role, password, owner })), () =>
          run(psql("read-role-drop.sql", { role, owner })).pipe(Effect.orDie)
        );
        // Granted by the default privileges, not the GRANT the file ran before it existed.
        yield* sql`CREATE TABLE feedback.later (id INT)`;
        yield* sql`INSERT INTO feedback.later VALUES (1)`;

        const url = new URL(inject("postgres").adminUrl);
        url.pathname = `/${database}`;
        url.username = role;
        url.password = password;
        const asReader = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
          Effect.provide(work, layerFromUrl(Redacted.make(url.toString())), { local: true });
        const count = (table: string) =>
          asReader(
            Effect.flatMap(SqlClient.SqlClient, (reader) =>
              reader.unsafe<{ rows: string }>(`SELECT count(*)::text AS rows FROM ${table}`)
            )
          );

        for (const table of [
          "feedback.submissions",
          "feedback.general_requests",
          "feedback.later"
        ]) {
          const [counted] = yield* count(table);
          assert.notStrictEqual(counted?.rows ?? "0", "0", table);
        }
        for (const table of ["users", "connections", "machine_tokens", "patches"]) {
          // SQLSTATE 42501, insufficient privilege.
          const refused = yield* count(table).pipe(Effect.flip);
          assert.strictEqual(
            refused._tag === "SqlError" ? refused.reason._tag : refused._tag,
            "AuthorizationError",
            table
          );
        }

        // The audit, query by query as the file numbers them.
        const audit = Effect.map(run(psql("read-role-audit.sql", { role })), (answers) => ({
          attributes: answers[0],
          memberships: answers[1],
          readable: answers[2]?.map((row) => `${String(row.schema)}.${String(row.name)}`),
          publicTables: answers[3],
          publicColumns: answers[4]?.map(
            (row) =>
              `${String(row.table_schema)}.${String(row.table_name)}.${String(row.column_name)}`
          )
        }));
        const feedbackOnly = [
          "feedback.general_requests",
          "feedback.later",
          "feedback.submissions"
        ];
        const clean = yield* audit;
        assert.deepStrictEqual(clean.attributes, [
          {
            rolname: role,
            rolsuper: false,
            rolinherit: false,
            rolcreaterole: false,
            rolcreatedb: false,
            rolcanlogin: true,
            rolreplication: false,
            rolbypassrls: false
          }
        ]);
        assert.deepStrictEqual(
          [clean.memberships, clean.readable, clean.publicTables, clean.publicColumns],
          [[], feedbackOnly, [], []]
        );

        // One column granted to PUBLIC opens it to the role, and the audit names it twice.
        yield* sql`GRANT SELECT (email) ON users TO PUBLIC`;
        const emails = yield* asReader(
          Effect.flatMap(SqlClient.SqlClient, (reader) =>
            reader.unsafe<{ email: string }>("SELECT email FROM users")
          )
        );
        assert.include(
          emails.map(({ email }) => email),
          "reader@example.com"
        );
        const opened = yield* audit;
        assert.deepStrictEqual(opened.readable, [
          "feedback.general_requests",
          "feedback.later",
          "feedback.submissions",
          "public.users"
        ]);
        assert.deepStrictEqual(opened.publicColumns, ["public.users.email"]);
        yield* sql`REVOKE SELECT (email) ON users FROM PUBLIC`;
        assert.deepStrictEqual((yield* audit).readable, feedbackOnly);
      })
  );
});
