// @effect-diagnostics nodeBuiltinImport:off -- Disposable Postgres, OpenSSL certificates and thread-local TLS trust exercise the real transport.
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { promisify } from "node:util";
import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type GuestProtocol } from "@patchy/api";
import { newInternalId, sha256 } from "@patchy/core";
import { OperatingLimits } from "@patchy/limits";
import {
  Binding,
  CallbackGateway,
  CallbackGatewayApi,
  Executor,
  Invocation,
  InvocationCapabilities,
  InvocationLog,
  RuntimeLog,
  ServerBundles
} from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import EmbeddedPostgres from "embedded-postgres";
import { build } from "esbuild";
import * as Testing from "../../../company-database/src/testing.js";
import * as Local from "../../../execution/src/local.js";
import * as MutationTransaction from "../../../primitives/src/MutationTransaction.js";
import * as QuerySnapshot from "../../../primitives/src/QuerySnapshot.js";
import * as TestWakes from "../../../primitives/src/test/wakes.js";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as Execution from "./Execution.js";
import * as Operations from "./Operations.js";
import * as Source from "./Source.js";
import * as SourceClient from "./SourceClient.js";
import * as SourceNetwork from "./SourceNetwork.js";

const openssl = promisify(execFile);
const host = "warehouse.example";
const password = "local-tls-reader";
const credentials = Redacted.make(
  `postgres://reader:${password}@${host}/postgres?sslmode=verify-full`
);

const tlsPostgres = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "patchy-handler-tls-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  );
  const ca = join(directory, "ca.pem");
  const key = join(directory, "server.key");
  const certificate = join(directory, "server.pem");
  yield* Effect.promise(async () => {
    await openssl("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=Patchy disposable test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-keyout",
      join(directory, "ca.key"),
      "-out",
      ca
    ]);
    await openssl("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${host}`,
      "-keyout",
      key,
      "-out",
      join(directory, "server.csr")
    ]);
    await writeFile(
      join(directory, "server.ext"),
      [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        `subjectAltName=DNS:${host}`
      ].join("\n")
    );
    await openssl("openssl", [
      "x509",
      "-req",
      "-in",
      join(directory, "server.csr"),
      "-CA",
      ca,
      "-CAkey",
      join(directory, "ca.key"),
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      join(directory, "server.ext"),
      "-out",
      certificate
    ]);
    await chmod(key, 0o600);
  });
  const port = yield* Effect.acquireUseRelease(
    Effect.sync(() => createServer()),
    (server) =>
      Effect.promise(async () => {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No Postgres test port");
        return address.port;
      }),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          })
      )
  );
  const postgres = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new EmbeddedPostgres({
          databaseDir: join(directory, "data"),
          port,
          user: "postgres",
          password: "local-tls-admin",
          persistent: false,
          postgresFlags: [
            "-c",
            "listen_addresses=127.0.0.1",
            "-c",
            "ssl=on",
            "-c",
            `ssl_cert_file=${certificate}`,
            "-c",
            `ssl_key_file=${key}`
          ],
          onLog() {},
          onError() {}
        })
    ),
    (postgres) => Effect.promise(() => postgres.stop())
  );
  yield* Effect.promise(async () => {
    await postgres.initialise();
    await postgres.start();
  });
  yield* Effect.acquireUseRelease(
    Effect.sync(() => postgres.getPgClient("postgres", "127.0.0.1")),
    (client) =>
      Effect.promise(async () => {
        await client.connect();
        await client.query(`
        CREATE ROLE reader LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
        CREATE TABLE public.leads (id integer PRIMARY KEY, name text NOT NULL);
        INSERT INTO public.leads VALUES (1, 'Ada'), (2, 'Grace');
        GRANT SELECT ON public.leads TO reader;
      `);
      }),
    (client) => Effect.promise(() => client.end())
  );
  const root = yield* Effect.promise(() => readFile(ca, "utf8"));
  // This is thread-local and restored before this isolated Vitest worker can run another file.
  const roots = yield* Effect.acquireRelease(
    Effect.sync(() => getCACertificates("default")),
    (roots) => Effect.sync(() => setDefaultCACertificates(roots))
  );
  const trust = (enabled: boolean) =>
    Effect.sync(() => setDefaultCACertificates(enabled ? [...roots, root] : roots));
  // Replace only the external destination. SourceClient still admits the public DNS answer,
  // negotiates PostgreSQL TLS and verifies the original credential hostname and CA.
  const network = SourceNetwork.SourceNetwork.of({
    resolve: () => Effect.succeed([{ address: "8.8.8.8" }]),
    socket: Effect.sync(() => {
      const socket = new Socket();
      const connect = socket.connect.bind(socket);
      socket.connect = (() => connect(port, "127.0.0.1")) as typeof socket.connect;
      return socket;
    })
  });
  return { trust, network };
});

const services = Layer.mergeAll(
  RuntimeLog.layer,
  InvocationLog.layer,
  OperatingLimits.layer,
  QuerySnapshot.layer,
  MutationTransaction.layer
).pipe(
  Layer.provideMerge(InvocationCapabilities.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(TestWakes.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(
    CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 71).toString("base64")}`))
  )
);

it.live(
  "ctx.connections verifies TLS and returns real Postgres rows as a non-superuser through workerd",
  () =>
    Effect.gen(function* () {
      const fixture = yield* tlsPostgres;
      yield* fixture.trust(true);
      const source = yield* Source.make.pipe(
        Effect.provideService(SourceNetwork.SourceNetwork, fixture.network)
      );
      const wrongHostname = yield* source
        .test(
          Redacted.make(`postgres://reader:${password}@wrong.example/postgres?sslmode=verify-full`)
        )
        .pipe(Effect.flip);
      assert.instanceOf(wrongHostname, SourceClient.TlsRequired);
      const connections = yield* SqlConnectionStore.make.pipe(
        Effect.provideService(Source.Source, source)
      );
      const connection = yield* connections.connect({
        companyId: "cmp_dev",
        userId: "usr_dev",
        handle: "tls-warehouse",
        description: "TLS handler acceptance",
        credentials
      });
      const viewer = {
        user: { id: "usr_dev", name: "Dev", email: "dev@patchy.local" },
        company: { id: "cmp_dev", name: "Patchy Dev", handle: "patchy-dev" },
        admin: false
      };
      const binding = Binding.Binding.of({
        companyId: "cmp_dev",
        patchId: "handlertls01",
        versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
        wireVersion: WIRE_VERSION,
        scope: "company",
        correlationId: "tls-handler",
        principal: { userId: viewer.user.id },
        identity: viewer,
        manifest: {
          manifestVersion: 1,
          release: CURRENT_RELEASE,
          tier: 2,
          tables: {},
          files: {},
          uses: {
            warehouse: {
              kind: "postgres",
              id: connection.id,
              handle: connection.handle,
              revision: connection.metadataRevision
            }
          },
          handlers: { "leads.read": { kind: "action", args: {}, result: { kind: "json" } } }
        }
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
      VALUES (${binding.patchId}, 'cmp_dev', 'usr_dev', 'TLS acceptance', 'tls-acceptance')`;
      const execution = yield* Execution.make().pipe(
        Effect.provideService(ConnectionStore.ConnectionStore, connections),
        Effect.provideService(SourceNetwork.SourceNetwork, fixture.network)
      );
      const handlers = yield* Operations.makeHandlers.pipe(
        Effect.provideService(ConnectionStore.ConnectionStore, connections),
        Effect.provideService(Execution.Execution, execution)
      );
      const gateway = yield* CallbackGateway.make(handlers);
      const listener = yield* CallbackGatewayApi.listen().pipe(
        Effect.provideService(CallbackGateway.CallbackGateway, gateway)
      );
      const built = yield* Effect.promise(() =>
        build({
          stdin: {
            contents: `import { action, createGuest, t } from "patchy/server";
          const read = action({args:{},result:t.json(),handler:async ctx => {
            const leads = await ctx.connections.warehouse.leads.list();
            const session = await ctx.connections.warehouse.query(
              'SELECT current_user::text AS role, r.rolsuper AS superuser, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole, s.ssl FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_stat_ssl s ON s.pid = pg_backend_pid() WHERE r.rolname = current_user',
              [], {role:t.text(),superuser:t.boolean(),createdb:t.boolean(),createrole:t.boolean(),ssl:t.boolean()}
            );
            return {leads,session};
          }});
          export default createGuest({leads:{read}});`,
            resolveDir: new URL("../../../patchy", import.meta.url).pathname,
            sourcefile: "tls-handler.ts"
          },
          bundle: true,
          write: false,
          platform: "browser",
          format: "esm",
          target: "es2022",
          conditions: ["development"]
        })
      );
      const text = built.outputFiles[0]!.text;
      const bundle: GuestProtocol.Bundle = {
        companyId: binding.companyId,
        patchId: binding.patchId,
        versionId: binding.versionId,
        bundle: text,
        sha256: sha256(text)
      };
      const executor = yield* Local.make({
        companyId: binding.companyId,
        callbackUrls: [listener.url],
        environment: "test"
      });
      const invocations = yield* Invocation.make({ callbackUrl: listener.url }).pipe(
        Effect.provideService(Executor.Executor, executor),
        Effect.provideService(ServerBundles.ServerBundles, { load: () => Effect.succeed(bundle) })
      );
      const call = Effect.suspend(() =>
        invocations.call(
          { handler: "leads.read", args: {} },
          { ...binding, correlationId: newInternalId("call") },
          Effect.succeed(viewer)
        )
      );
      // No cached runtime connection exists: the callback must refuse the untrusted CA.
      yield* fixture.trust(false);
      assert.strictEqual((yield* call.pipe(Effect.flip)).code, "source_unavailable");
      yield* fixture.trust(true);
      assert.deepStrictEqual(yield* call, {
        ok: true,
        value: {
          leads: {
            ok: true,
            rows: [
              { id: 1, name: "Ada" },
              { id: 2, name: "Grace" }
            ],
            cursor: null
          },
          session: {
            ok: true,
            rows: [
              { role: "reader", superuser: false, createdb: false, createrole: false, ssl: true }
            ]
          }
        }
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  { timeout: 60_000 }
);
