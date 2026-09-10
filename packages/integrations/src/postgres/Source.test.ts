// @effect-diagnostics nodeBuiltinImport:off -- Real sockets exercise transport admission and interruption; inspect checks credential non-disclosure.
import { inspect } from "node:util";
import { Socket } from "node:net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { inject } from "vitest";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Testing from "@patchy/sql/testing";
import * as Source from "./Source.js";
import * as SourceClient from "./SourceClient.js";
import * as SourceNetwork from "./SourceNetwork.js";
import { Snapshot } from "./Snapshot.js";

it("refuses non-global addresses, including IPv6 aliases and transition ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "168.63.129.16",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::1",
    "2001:db8::1",
    "3fff::1",
    "not-an-ip"
  ])
    assert.isFalse(SourceClient.isPublicAddress(address), address);
  assert.isTrue(SourceClient.isPublicAddress("8.8.8.8"));
  assert.isTrue(SourceClient.isPublicAddress("2606:4700:4700::1111"));
});

it.effect("refuses a real non-TLS Postgres server, pins DNS and rechecks on the next attempt", () =>
  Effect.gen(function* () {
    const postgres = new URL(inject("postgres").adminUrl);
    let lookups = 0;
    let sockets = 0;
    let pinned: unknown;
    const source = yield* Source.make.pipe(
      Effect.provideService(SourceNetwork.SourceNetwork, {
        resolve: () => Effect.sync(() => [{ address: ++lookups === 1 ? "8.8.8.8" : "127.0.0.1" }]),
        socket: Effect.sync(() => {
          sockets++;
          const socket = new Socket();
          const connect = socket.connect.bind(socket);
          // Replace only the external transport destination, not Source's admission or TLS.
          socket.connect = ((port: number, host: string) => {
            pinned = { port, host };
            return connect(Number(postgres.port), postgres.hostname);
          }) as typeof socket.connect;
          return socket;
        })
      })
    );
    const credentials = Redacted.make("postgres://reader:secret@warehouse.example:6432/warehouse");
    const failure = yield* source.test(credentials).pipe(Effect.flip);
    assert.instanceOf(failure, SourceClient.TlsRequired);
    assert.deepStrictEqual(pinned, { port: 6432, host: "8.8.8.8" });
    const rebound = yield* source.test(credentials).pipe(Effect.flip);
    assert.instanceOf(rebound, SourceClient.PublicAddressRequired);
    assert.strictEqual(sockets, 1);
    assert.strictEqual(lookups, 2);
  })
);

it.effect("interrupts DNS at the service deadline without creating a socket afterward", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let sockets = 0;
    const source = yield* Source.make.pipe(
      Effect.provideService(SourceNetwork.SourceNetwork, {
        resolve: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        socket: Effect.sync(() => {
          sockets++;
          return new Socket();
        })
      })
    );
    const fiber = yield* source
      .test(Redacted.make("postgres://reader:secret@warehouse.example/warehouse"))
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("15 seconds");
    assert.instanceOf(yield* Fiber.join(fiber), Source.SourceTimeout);
    assert.strictEqual(sockets, 0);
  })
);

it.effect("destroys an in-progress connection when its calling fiber is interrupted", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const socket = new Socket();
    socket.connect = (() => socket) as typeof socket.connect;
    const source = yield* Source.make.pipe(
      Effect.provideService(SourceNetwork.SourceNetwork, {
        resolve: () => Effect.succeed([{ address: "8.8.8.8" }]),
        socket: Deferred.succeed(entered, undefined).pipe(Effect.as(socket))
      })
    );
    const fiber = yield* source
      .test(Redacted.make("postgres://reader:secret@warehouse.example/warehouse"))
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    assert.isTrue(socket.destroyed);
  })
);

it.effect("rejects a mixed public/private DNS answer before any socket allocation", () =>
  Effect.gen(function* () {
    let sockets = 0;
    const source = yield* Source.make.pipe(
      Effect.provideService(SourceNetwork.SourceNetwork, {
        resolve: () =>
          Effect.succeed([{ address: "8.8.8.8" }, { address: "::ffff:169.254.169.254" }]),
        socket: Effect.sync(() => {
          sockets++;
          return new Socket();
        })
      })
    );
    const failure = yield* source
      .test(Redacted.make("postgres://reader:secret@warehouse.example/warehouse"))
      .pipe(Effect.flip);
    assert.instanceOf(failure, SourceClient.PublicAddressRequired);
    assert.strictEqual(sockets, 0);
  })
);

it.layer(Source.layer)("production Postgres admission", (it) => {
  it.effect("rejects private literal and DNS destinations before opening a database", () =>
    Effect.gen(function* () {
      const source = yield* Source.Source;
      for (const host of [
        "127.0.0.1",
        "[::1]",
        "[::ffff:7f00:1]",
        "169.254.169.254",
        "localhost"
      ]) {
        const failure = yield* source
          .inspect(Redacted.make(`postgres://reader:secret@${host}/warehouse`))
          .pipe(Effect.flip);
        assert.instanceOf(failure, SourceClient.PublicAddressRequired);
        assert.strictEqual(
          failure.message,
          "The database must be reachable from the internet over TLS."
        );
      }
    })
  );

  it.effect("refuses weaker TLS modes rather than inheriting driver defaults", () =>
    Effect.gen(function* () {
      const source = yield* Source.Source;
      for (const mode of ["disable", "allow", "prefer", "require", "verify-ca", "no-verify"]) {
        const failure = yield* source
          .test(Redacted.make(`postgres://reader:secret@example.com/warehouse?sslmode=${mode}`))
          .pipe(Effect.flip);
        assert.instanceOf(failure, SourceClient.TlsRequired);
      }
    })
  );

  it.effect("never serializes a rejected credential or its parser cause", () =>
    Effect.gen(function* () {
      const source = yield* Source.Source;
      const secret = "secret-credential-sentinel";
      const url = `postgres://reader:${secret}@example.com/warehouse?options=-c%20search_path%3Devil`;
      const failure = yield* source.inspect(Redacted.make(url)).pipe(Effect.flip);
      assert.instanceOf(failure, Source.InvalidCredentials);
      for (const representation of [JSON.stringify(failure), inspect(failure), String(failure)]) {
        assert.notInclude(representation, secret);
        assert.notInclude(representation, url);
      }
      const lower = new SourceClient.SourceUnavailable({
        stage: "connect",
        cause: Redacted.make(new Error(url))
      });
      assert.notInclude(JSON.stringify(lower), secret);
      assert.notInclude(inspect(lower), secret);
    })
  );
});

it.effect("parses only supported URL fields and keeps the decoded password redacted", () =>
  Effect.gen(function* () {
    const settings = yield* Source.parseCredentials(
      Redacted.make(
        "postgresql://reader:p%40ss%3Aword@example.com:6543/warehouse?sslmode=verify-full"
      )
    );
    assert.strictEqual(settings.host, "example.com");
    assert.strictEqual(settings.port, 6543);
    assert.strictEqual(settings.database, "warehouse");
    assert.strictEqual(settings.role, "reader");
    assert.strictEqual(Redacted.value(settings.password), "p@ss:word");
    assert.notInclude(JSON.stringify(settings), "p@ss:word");
    for (const url of [
      "postgres://reader:secret@example.com/warehouse?sslmode=verify-full&sslmode=disable",
      "postgres://reader:secret@example.com/warehouse?sslrootcert=/tmp/root.pem",
      "postgres://reader:secret@example.com/warehouse?host=/tmp",
      "postgres://reader:secret@example.com/warehouse?port=0",
      "postgres://reader:secret@example.com/warehouse?port=65536",
      "postgres://reader:secret@example.com/warehouse#ignored",
      "postgres://reader:%ZZ@example.com/warehouse"
    ])
      assert.instanceOf(
        yield* Source.parseCredentials(Redacted.make(url)).pipe(Effect.flip),
        Source.InvalidCredentials
      );
  })
);

const withSource = Effect.fn("test.withSource")(function* <A, E>(
  work: Effect.Effect<A, E, SourceClient.SourceClient>
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* work.pipe(
    Effect.provideService(
      SourceClient.SourceClient,
      SourceClient.SourceClient.of({
        query: (statement, parameters = []) =>
          sql.unsafe(statement, parameters).pipe(
            Effect.mapError(
              (cause) =>
                new SourceClient.SourceUnavailable({
                  stage: "query",
                  cause: Redacted.make(cause)
                })
            )
          )
      })
    )
  );
});

it.layer(Testing.emptyLayer({}))("real Postgres discovery", (it) => {
  it.effect(
    "discovers compound keys, enum labels, domains, foreign tables and nullable views",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("CREATE SCHEMA sales");
        yield* sql.unsafe("CREATE TYPE sales.status AS ENUM ('new', 'in progress', 'done')");
        yield* sql.unsafe("CREATE DOMAIN sales.required_name AS text NOT NULL");
        yield* sql.unsafe("CREATE DOMAIN sales.nested_name AS sales.required_name");
        yield* sql.unsafe(
          "CREATE TABLE sales.accounts (tenant int, id int, name sales.nested_name, PRIMARY KEY (tenant, id))"
        );
        yield* sql.unsafe(
          "CREATE TABLE sales.orders (id bigint PRIMARY KEY, tenant int, account int, status sales.status NOT NULL, states sales.status[], exotic point, CONSTRAINT owner FOREIGN KEY (tenant, account) REFERENCES sales.accounts (tenant, id))"
        );
        yield* sql.unsafe("CREATE VIEW sales.order_view AS SELECT id, status FROM sales.orders");
        // No handler exists: discovery must inspect the catalog, never query foreign rows.
        yield* sql.unsafe("CREATE FOREIGN DATA WRAPPER metadata_only");
        yield* sql.unsafe("CREATE SERVER metadata_server FOREIGN DATA WRAPPER metadata_only");
        yield* sql.unsafe(
          "CREATE FOREIGN TABLE sales.remote_accounts (id bigint) SERVER metadata_server"
        );
        const snapshot = yield* sql.withTransaction(withSource(Source.discover));
        const accounts = snapshot.relations.find(
          (relation) => relation.schema === "sales" && relation.name === "accounts"
        )!;
        assert.deepStrictEqual(accounts.primaryKey?.columns, ["tenant", "id"]);
        const domain = accounts.columns.find((column) => column.name === "name")!;
        assert.strictEqual(domain.type.baseName, "text");
        assert.isFalse(domain.nullable);
        const remote = snapshot.relations.find((relation) => relation.name === "remote_accounts");
        assert.strictEqual(remote?.kind, "table");
        assert.deepStrictEqual(
          remote?.columns.map((column) => column.name),
          ["id"]
        );
        const orders = snapshot.relations.find((relation) => relation.name === "orders")!;
        assert.deepStrictEqual(orders.foreignKeys, [
          {
            name: "owner",
            columns: ["tenant", "account"],
            target: { schema: "sales", relation: "accounts", columns: ["tenant", "id"] }
          }
        ]);
        assert.deepStrictEqual(snapshot.enums, [
          { schema: "sales", name: "status", labels: ["new", "in progress", "done"] }
        ]);
        assert.deepStrictEqual(snapshot.exclusions, [
          { schema: "sales", relation: "orders", column: "exotic", reason: "unsupported_type" }
        ]);
        assert.isTrue(
          snapshot.relations
            .find((relation) => relation.name === "order_view")!
            .columns.every((column) => column.nullable)
        );
        assert.isTrue(Schema.is(Snapshot)(snapshot));
      })
  );

  it.effect("keeps foreign keys valid when their target column is not selectable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const databases = yield* sql<{ name: string }>`SELECT current_database() AS name`;
      const role = `"${databases[0]!.name.replaceAll('"', '""')}_columns"`;
      yield* sql.unsafe(`CREATE ROLE ${role}`);
      yield* Effect.gen(function* () {
        yield* sql.unsafe("CREATE SCHEMA partial_columns");
        yield* sql.unsafe("CREATE TABLE partial_columns.parents (id int PRIMARY KEY, label text)");
        yield* sql.unsafe(
          "CREATE TABLE partial_columns.children (parent_id int REFERENCES partial_columns.parents(id))"
        );
        yield* sql.unsafe(`GRANT USAGE ON SCHEMA partial_columns TO ${role}`);
        yield* sql.unsafe(`GRANT SELECT(label) ON partial_columns.parents TO ${role}`);
        yield* sql.unsafe(`GRANT SELECT ON partial_columns.children TO ${role}`);
        const snapshot = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe(`SET LOCAL ROLE ${role}`);
            return yield* withSource(Source.discover);
          })
        );
        assert.deepStrictEqual(
          snapshot.relations
            .find((relation) => relation.name === "parents")
            ?.columns.map((column) => column.name),
          ["label"]
        );
        assert.deepStrictEqual(
          snapshot.relations.find((relation) => relation.name === "children")?.foreignKeys[0]
            ?.target,
          { schema: "partial_columns", relation: "parents", columns: ["id"] }
        );
        assert.includeDeepMembers(snapshot.exclusions, [
          { schema: "partial_columns", relation: "parents", column: "id", reason: "access_denied" }
        ]);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* sql.unsafe(`DROP OWNED BY ${role}`);
            yield* sql.unsafe(`DROP ROLE ${role}`);
          }).pipe(Effect.orDie)
        )
      );
    })
  );

  it.effect(
    "names relation and column bound exclusions instead of silently truncating a schema",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("CREATE SCHEMA bounds");
        yield* sql.unsafe(
          `CREATE TABLE bounds.a_wide (${Array.from({ length: 201 }, (_, index) => `c${index} int`).join(", ")})`
        );
        yield* sql.unsafe(`DO $body$ BEGIN FOR i IN 1..501 LOOP
        EXECUTE format('CREATE TABLE bounds.%I (id int PRIMARY KEY)', 'r' || lpad(i::text, 3, '0'));
      END LOOP; END $body$`);
        const snapshot = yield* sql.withTransaction(withSource(Source.discover));
        assert.includeDeepMembers(snapshot.exclusions, [
          { schema: "bounds", relation: "a_wide", reason: "column_limit" },
          { schema: "bounds", relation: "r501", reason: "relation_limit" }
        ]);
        assert.isAtMost(snapshot.relations.length, 500);
        assert.isFalse(snapshot.relations.some((relation) => relation.name === "a_wide"));
      })
  );

  it.effect("names generated surface collisions without changing discovered names", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("CREATE SCHEMA collisions");
      yield* sql.unsafe("CREATE TABLE collisions.query (id int)");
      yield* sql.unsafe("CREATE TABLE public.collisions (id int)");
      const snapshot = yield* sql.withTransaction(withSource(Source.discover));
      assert.includeDeepMembers(snapshot.exclusions, [
        { schema: "collisions", relation: "query", reason: "reserved_name" },
        { schema: "public", relation: "collisions", reason: "reserved_name" }
      ]);
    })
  );

  it.effect("refuses actual dangerous database roles with each role's sentence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.instanceOf(
        yield* withSource(Source.checkRole).pipe(Effect.flip),
        Source.SuperuserRefused
      );
      // Roles are cluster-wide; use this isolated database's random name for identity.
      const databases = yield* sql<{ name: string }>`SELECT current_database() AS name`;
      const role = `${databases[0]!.name}_reader`;
      const quoted = `"${role.replaceAll('"', '""')}"`;
      yield* sql.unsafe(`CREATE ROLE ${quoted} CREATEDB`);
      yield* Effect.gen(function* () {
        const checked = Effect.gen(function* () {
          yield* sql.unsafe(`SET LOCAL ROLE ${quoted}`);
          return yield* withSource(Source.checkRole).pipe(Effect.flip);
        });
        const createDatabase = yield* sql.withTransaction(checked);
        assert.instanceOf(createDatabase, Source.CreateDatabaseRefused);
        assert.strictEqual(
          createDatabase.message,
          "This role can create databases. Connect a role without CREATEDB."
        );
        yield* sql.unsafe(`ALTER ROLE ${quoted} NOCREATEDB CREATEROLE`);
        const createRole = yield* sql.withTransaction(checked);
        assert.instanceOf(createRole, Source.CreateRoleRefused);
        assert.strictEqual(
          createRole.message,
          "This role can create roles. Connect a role without CREATEROLE."
        );
        yield* sql.unsafe(`ALTER ROLE ${quoted} NOCREATEROLE`);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe(`SET LOCAL ROLE ${quoted}`);
            yield* withSource(Source.checkRole);
          })
        );
      }).pipe(Effect.ensuring(sql.unsafe(`DROP ROLE ${quoted}`).pipe(Effect.orDie)));
    })
  );
});
