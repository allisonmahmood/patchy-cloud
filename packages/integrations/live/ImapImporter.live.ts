// @effect-diagnostics nodeBuiltinImport:off -- The mailbox owner's client and digests compare real bytes.
import { createHash, randomBytes } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type Manifest } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import * as CompanyDatabases from "../../company-database/src/CompanyDatabases.js";
import { NodeCryptography } from "@patchy/core";
import { ContractLimits, OperatingLimits } from "@patchy/limits";
import {
  Binding,
  FileStaging,
  InvocationCapabilities,
  InvocationLog,
  LoadedVersions,
  Runtime,
  RuntimeLog
} from "@patchy/runtime";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ImapFlow } from "imapflow";
import { inject } from "vitest";
import * as CompanyTesting from "../../company-database/src/testing.js";
import * as FilesystemContentStore from "../../content-store/src/FilesystemContentStore.js";
import * as Files from "../../primitives/src/Files.js";
import * as MutationTransaction from "../../primitives/src/MutationTransaction.js";
import * as QuerySnapshot from "../../primitives/src/QuerySnapshot.js";
import * as TableOperations from "../../primitives/src/TableOperations.js";
import * as Tables from "../../primitives/src/Tables.js";
import * as TestMemberDirectory from "../../primitives/src/test/memberDirectory.js";
import * as TestWakes from "../../primitives/src/test/wakes.js";
import * as AttioSource from "../src/attio/Source.js";
import * as ConnectionStore from "../src/ConnectionStore.js";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as ImapNetwork from "../src/imap/Network.js";
import * as ImapOperations from "../src/imap/Operations.js";
import * as Sessions from "../src/imap/Sessions.js";
import * as Source from "../src/imap/Source.js";
import * as PidgeonSource from "../src/pidgeon/Source.js";
import * as PostgresSource from "../src/postgres/Source.js";
import * as PostHogSource from "../src/posthog/Source.js";
import * as SqlConnectionStore from "../src/SqlConnectionStore.js";
import * as ImapTest from "../src/test/imap.js";
import * as RuntimeTest from "../src/test/runtime.js";

/**
 * The `patchy-imap` skill's reference importer, taken from the skill, as a tier 2 action in real
 * workerd over real tables and files, reading Dovecot in Docker. It brings a date window of a
 * folder in and resumes after each way a run stops: a stage refused on quota, a message expunged
 * between its page and its read, an attachment past the staged-file bound, a named PDF sent
 * inline, which is a file like any other, and a row write that
 * fails after its file was adopted. The staged-file bound is lowered to 100,000 bytes, so a
 * 150,000-byte attachment stands in for one past 20 MiB.
 */

const mail = inject("imap");
const server = mail.dovecot;
const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const patchId = "imapimport01";
const versionId = "ver_importerimporterimport";
const BOUND = 100_000;
const limits = { "files.stage.bytes": BOUND } as const;

const network = ImapNetwork.loopback(() => [
  { host: server.host, ports: { 993: server.tls, 143: server.plain }, ca: mail.ca }
]);
const storage = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-imap-importer-" });
    return FilesystemContentStore.layer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: root })))
    );
  })
);
const services = Layer.mergeAll(
  RuntimeLog.layer,
  InvocationLog.layer,
  OperatingLimits.layer,
  QuerySnapshot.layer,
  MutationTransaction.layer,
  Tables.layer,
  storage,
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 7).toString("base64")}`)),
  // Never called: these connections reach no database, PostHog project, Pidgeon address or Attio.
  Layer.succeed(
    PostgresSource.Source,
    PostgresSource.Source.of({
      test: () => Effect.die("no Postgres here"),
      inspect: () => Effect.die("no Postgres here")
    })
  ),
  PostHogSource.layer,
  PidgeonSource.layer,
  AttioSource.layer,
  Sessions.layer.pipe(Layer.provideMerge(Source.layer.pipe(Layer.provide(network)))),
  // The patch reads only its own tables and store: no other version to find.
  Layer.succeed(LoadedVersions.LoadedVersions, { find: () => Effect.succeed(Option.none()) })
).pipe(
  Layer.provideMerge(InvocationCapabilities.layer),
  Layer.provideMerge(CompanyTesting.layer()),
  Layer.provideMerge(TestWakes.layer),
  Layer.provideMerge(TestMemberDirectory.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCryptography.layer)
);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const owned = <A>(use: (owner: ImapFlow) => Promise<A>) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(async () => {
        const opened = new ImapFlow({
          host: "127.0.0.1",
          port: server.tls,
          secure: true,
          servername: server.host,
          tls: { ca: [mail.ca], minVersion: "TLSv1.2" },
          auth: { user: server.username, pass: server.password },
          logger: false
        });
        await opened.connect();
        return opened;
      }),
      (opened) => Effect.promise(() => opened.logout().catch(() => undefined))
    ).pipe(Effect.flatMap((owner) => Effect.promise(() => use(owner))))
  );
/** One invoice with `pdf` attached, received on `day` of 2026. */
const invoice = (
  subject: string,
  day: string,
  pdf: Uint8Array,
  disposition: "attachment" | "inline" = "attachment"
) => ({
  day,
  raw: [
    "From: Billing <billing@example.com>",
    "To: invoices@imap-live.test",
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="importer-boundary"',
    "",
    "--importer-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `${subject}, attached.`,
    "--importer-boundary",
    `Content-Type: application/pdf; name="${subject}.pdf"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${disposition}; filename="${subject}.pdf"`,
    "",
    (
      Buffer.from(pdf)
        .toString("base64")
        .match(/.{1,76}/g) ?? []
    ).join("\r\n"),
    "--importer-boundary--",
    ""
  ].join("\r\n")
});
const append = (folder: string, message: ReturnType<typeof invoice>) =>
  owned((owner) => owner.append(folder, message.raw, [], new Date(`${message.day}T10:00:00Z`)));
const expunge = (folder: string, uid: number) =>
  owned(async (owner) => {
    const lock = await owner.getMailboxLock(folder);
    try {
      await owner.messageDelete(String(uid), { uid: true });
    } finally {
      lock.release();
    }
  });

/** The patch the skill's importer runs in: the scenario's tables and store, and the mailbox. */
const manifest = (connection: {
  readonly id: string;
  readonly handle: string;
  readonly revision: number;
}) =>
  ({
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    // As `scenarios/imap/patches/invoice-inbox/patchy.config.ts` declares them.
    tables: {
      messages: {
        description: "One imported message per mailbox ref.",
        columns: {
          key: { kind: "text" },
          folder: { kind: "text" },
          uid: { kind: "integer" },
          subject: { kind: "text", optional: true },
          sender: { kind: "text", optional: true },
          received: { kind: "timestamp", optional: true }
        },
        indexes: { byKey: { columns: ["key"], unique: true } }
      },
      attachments: {
        description: "One attachment per imported message key and part.",
        columns: {
          message: { kind: "text" },
          part: { kind: "text" },
          filename: { kind: "text", optional: true },
          size: { kind: "integer" },
          sha256: { kind: "text", optional: true },
          file: { kind: "text", optional: true }
        },
        indexes: { byMessagePart: { columns: ["message", "part"], unique: true } }
      },
      imports: {
        description: "One per imported folder.",
        columns: { folder: { kind: "text" }, checkpoint: { kind: "text" } },
        indexes: { byFolder: { columns: ["folder"], unique: true } }
      }
    },
    files: { documents: { description: "Imported attachments keyed by ref and part." } },
    uses: { mail: { kind: "imap", ...connection } },
    handlers: {
      "importer.importFolder": {
        kind: "action",
        args: { folder: { kind: "text" }, since: { kind: "text" } },
        result: {
          kind: "object",
          fields: {
            imported: { kind: "integer" },
            done: { kind: "boolean" },
            stopped: { kind: "nullable", value: { kind: "text" } }
          }
        }
      }
    }
  }) satisfies typeof Manifest.Type;

/** The skill's importer as the guest bundles it, its generated imports the package's own. */
const source = () =>
  `${ImapTest.skillBlock("`server/importer.ts`:").replace(
    '"../patchy/_generated/server.js"',
    '"patchy/server"'
  )}
import { createGuest } from "patchy/server";
export default createGuest({ importer: { importFolder } }, [], {}, [], [], ["mail"]);
`;

/** A handler that runs `before` ahead of each JSON call, for a fault a test injects. */
const before = (
  handler: Runtime.Handler,
  first: (args: unknown) => Effect.Effect<void, Runtime.RuntimeError>
): Runtime.Handler =>
  handler.transport === undefined
    ? { ...handler, run: (args) => Effect.andThen(first(args), handler.run(args)) }
    : handler;

const run = `${process.pid}`;

it.layer(services, { timeout: "300 seconds", excludeTestServices: true })(
  "The reference importer, live",
  (it) => {
    it.effect(
      "Dovecot: imports a date window into tables and files, and resumes after each stop",
      () =>
        Effect.gen(function* () {
          const folder = `Importer ${run}`;
          const pdfs = [
            randomBytes(2_000),
            randomBytes(3_000),
            randomBytes(150_000),
            randomBytes(4_000),
            randomBytes(5_000),
            randomBytes(6_000),
            randomBytes(7_000)
          ] as const;
          yield* owned((owner) => owner.mailboxCreate(folder));
          // UID 1 is before the window; 2 to 6 are in it, 6 a named PDF sent inline; 7 arrives
          // after the first full import.
          yield* append(folder, invoice("Old", "2026-09-20", pdfs[0]));
          yield* append(folder, invoice("Small", "2026-10-02", pdfs[1]));
          yield* append(folder, invoice("Large", "2026-10-03", pdfs[2]));
          yield* append(folder, invoice("Expunged", "2026-10-04", pdfs[3]));
          yield* append(folder, invoice("Failed", "2026-10-05", pdfs[4]));
          yield* append(folder, invoice("Inline", "2026-10-05", pdfs[5], "inline"));
          const uidValidity = yield* owned(async (owner) => {
            const status = await owner.status(folder, { uidValidity: true });
            return status === false ? 0 : Number(status.uidValidity);
          });

          const store = yield* SqlConnectionStore.make;
          const connection = yield* store.connect({
            integration: "imap",
            ...who,
            handle: "invoices",
            description: "Live mailbox",
            credentials: Source.credentials({
              host: server.host,
              port: 993,
              security: "tls",
              username: server.username,
              password: server.password
            })
          });
          const declared = manifest({
            id: connection.id,
            handle: connection.handle,
            revision: connection.metadataRevision
          });
          const databases = yield* CompanyDatabases.CompanyDatabases;
          const tables = yield* Tables.Tables;
          yield* databases.ensureReady(who.companyId);
          yield* databases.withCompany(who.companyId)(
            databases.withPatchLock(patchId)(tables.provision(patchId, declared))
          );
          const viewer = {
            user: { id: who.userId, name: "Dev", email: "dev@example.test" },
            company: { id: who.companyId, handle: "patchy-dev", name: "Patchy Dev" },
            admin: false
          };
          const binding = Binding.Binding.of({
            companyId: who.companyId,
            patchId,
            versionId,
            wireVersion: WIRE_VERSION,
            scope: "company",
            correlationId: "imap-importer",
            principal: { userId: who.userId },
            identity: viewer,
            reauthorize: Effect.succeed(viewer),
            manifest: declared
          });

          const staging = yield* Files.makeStaging.pipe(
            Effect.provideService(ContractLimits.overrides, limits)
          );
          const files = yield* Files.make;
          const rows = yield* TableOperations.make;
          const imap = yield* ImapOperations.makeHandlers.pipe(
            Effect.provideService(FileStaging.FileStaging, staging),
            Effect.provideService(ConnectionStore.ConnectionStore, store)
          );
          // Faults the test sets before a run: a message expunged as its page is read, and an
          // attachment row write that fails once, after its file was adopted.
          let expungeOnRead: number | undefined;
          let failRowOf: string | undefined;
          const handlers = {
            ...rows,
            ...files,
            ...imap,
            "imap.getMessages": before(imap["imap.getMessages"], () =>
              Effect.suspend(() => {
                const uid = expungeOnRead;
                expungeOnRead = undefined;
                return uid === undefined ? Effect.void : expunge(folder, uid);
              })
            ),
            "tables.insert": before(rows["tables.insert"], (args) =>
              Effect.suspend(() => {
                const row = args as {
                  readonly table: string;
                  readonly row: { readonly message?: string };
                };
                if (
                  failRowOf === undefined ||
                  row.table !== "attachments" ||
                  row.row.message !== failRowOf
                )
                  return Effect.void;
                failRowOf = undefined;
                return Effect.fail(
                  new Runtime.SourceUnavailable({
                    cause: new Error("The row write fails, as the test asked.")
                  })
                );
              })
            )
          };
          // The bound the IMAP side downloads to is the staged-file bound, lowered alike.
          const bounded = Object.fromEntries(
            Object.entries(handlers).map(([op, handler]) => [
              op,
              handler.transport === undefined
                ? {
                    ...handler,
                    run: (args: unknown) =>
                      handler
                        .run(args)
                        .pipe(Effect.provideService(ContractLimits.overrides, limits))
                  }
                : handler
            ])
          );
          const invoke = yield* RuntimeTest.invoker(bounded, binding, source());
          // Each run a fresh invocation, with its own correlation id.
          const importWindow = () =>
            invoke("importer.importFolder", { folder, since: "2026-10-01" });
          const as = <A, E>(effect: Effect.Effect<A, E, Binding.Binding>) =>
            effect.pipe(Effect.provideService(Binding.Binding, binding));
          const list = (table: string) =>
            as(rows["tables.list"].run({ table, limit: 100 })).pipe(
              Effect.map(
                (page) => (page as { readonly rows: ReadonlyArray<Record<string, unknown>> }).rows
              )
            );
          const key = (uid: number) => `${folder}/${uidValidity}/${uid}`;
          const file = (uid: number) => `${encodeURIComponent(folder)}.${uidValidity}/${uid}/2`;

          // 1. The viewer's staged uploads are full: the run stops before anything is kept.
          const full = [];
          for (let index = 0; index < 16; index++)
            full.push((yield* as(staging.stage(new Uint8Array([index]), "text/plain"))).upload);
          assert.deepStrictEqual(yield* importWindow(), {
            ok: true,
            value: { imported: 0, done: false, stopped: "limit_exceeded" }
          });
          assert.lengthOf(yield* list("imports"), 0);
          for (const upload of full) yield* as(files["files.discard"].run({ upload }));

          // 2. UID 4 is expunged as the page is read, and UID 5's row write fails after its file
          //    was adopted: the run fails before the checkpoint, with UID 5's file stored.
          expungeOnRead = 4;
          failRowOf = key(5);
          // The action relays the refused write as it failed: the run ends with it.
          const failed = yield* Effect.flip(importWindow());
          assert.propertyVal(failed, "_tag", "CallbackRefusal");
          assert.lengthOf(yield* list("imports"), 0);
          assert.deepStrictEqual((yield* list("attachments")).map((row) => row["message"]).sort(), [
            key(2),
            key(3)
          ]);
          assert.strictEqual(
            sha256(
              (yield* as(files["files.get"].run({ store: "documents", name: file(5) }))).bytes
            ),
            sha256(pdfs[4])
          );

          // 3. Run again: the page is read again, rows and files written over, nothing doubled.
          assert.deepStrictEqual(yield* importWindow(), {
            ok: true,
            value: { imported: 4, done: true, stopped: null }
          });
          const kept = new Map(
            (yield* list("attachments")).map((row) => [row["message"] as string, row])
          );
          assert.sameMembers([...kept.keys()], [key(2), key(3), key(5), key(6)]);
          assert.deepInclude(kept.get(key(3))!, {
            file: null,
            sha256: null,
            filename: "Large.pdf"
          });
          assert.isAbove(kept.get(key(3))!["size"] as number, BOUND);
          for (const [uid, pdf] of [
            [2, pdfs[1]],
            [5, pdfs[4]],
            [6, pdfs[5]]
          ] as const) {
            assert.deepInclude(kept.get(key(uid))!, {
              file: file(uid),
              sha256: sha256(pdf),
              size: pdf.byteLength
            });
            assert.strictEqual(
              sha256(
                (yield* as(files["files.get"].run({ store: "documents", name: file(uid) }))).bytes
              ),
              sha256(pdf)
            );
          }
          assert.sameMembers(
            (yield* list("messages")).map((row) => row["key"]),
            [key(2), key(3), key(5), key(6)]
          );
          assert.lengthOf(yield* list("imports"), 1);

          // 4. New mail since: the next run starts from the checkpoint and imports only it.
          yield* append(folder, invoice("Later", "2026-10-06", pdfs[6]));
          assert.deepStrictEqual(yield* importWindow(), {
            ok: true,
            value: { imported: 1, done: true, stopped: null }
          });
          assert.strictEqual(
            sha256(
              (yield* as(files["files.get"].run({ store: "documents", name: file(7) }))).bytes
            ),
            sha256(pdfs[6])
          );
          assert.lengthOf(yield* list("messages"), 5);
        })
    );
  }
);
