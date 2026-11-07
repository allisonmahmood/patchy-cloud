// @effect-diagnostics nodeBuiltinImport:off -- The mailbox owner's client and digests compare real bytes.
import { createHash, randomBytes } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type Manifest } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import * as CompanyDatabases from "../../company-database/src/CompanyDatabases.js";
import { NodeCryptography } from "@patchy/core";
import { ContractLimits, OperatingLimits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
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
 * between its page and its read, an attachment past the staged-file bound and a row write that
 * fails after its file was adopted. It saves only what a person calls attachments: a named PDF
 * sent inline, a PDF with no name, a forwarded message's PDF and a signed message's PDF, never
 * the forward's own text and HTML, a logo the HTML body embeds or the signature. A second folder
 * of 130 messages runs past a scan page of 100 and `getMessages`' 25 refs, and resumes across
 * pages, every message kept once. A third holds long plain-text exports, 25 of which answer past
 * the 8 MiB result bound, so the importer reads that batch again in halves. The staged-file bound
 * is lowered to 100,000 bytes, so a 150,000-byte attachment stands in for one past 20 MiB.
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
const base64 = (bytes: Uint8Array) =>
  (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
const headers = (subject: string, type: string) => [
  "From: Billing <billing@example.com>",
  "To: invoices@imap-live.test",
  `Subject: ${subject}`,
  "MIME-Version: 1.0",
  `Content-Type: ${type}`,
  ""
];
/** A PDF part named for `subject`, attached. */
const pdfPart = (subject: string, pdf: Uint8Array) => [
  `Content-Type: application/pdf; name="${subject}.pdf"`,
  "Content-Transfer-Encoding: base64",
  `Content-Disposition: attachment; filename="${subject}.pdf"`,
  "",
  base64(pdf)
];
/**
 * A note forwarding a supplier's mail as a message of its own, `message/rfc822`, named as a mail
 * client names it: the forward has its own text and HTML, and `pdf` attached as its part 2.2.
 */
const forward = (subject: string, day: string, pdf: Uint8Array) => ({
  day,
  raw: [
    ...headers(`Fwd: ${subject}`, 'multipart/mixed; boundary="outer"'),
    "--outer",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Forwarding this one.",
    "--outer",
    "Content-Type: message/rfc822",
    'Content-Disposition: attachment; filename="Original message.eml"',
    "",
    "From: Accounts <accounts@supplier.example.com>",
    "To: billing@example.com",
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="inner"',
    "",
    "--inner",
    'Content-Type: multipart/alternative; boundary="alternative"',
    "",
    "--alternative",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The invoice is attached.",
    "--alternative",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>The invoice is attached.</p>",
    "--alternative--",
    "--inner",
    ...pdfPart(subject, pdf),
    "--inner--",
    "--outer--",
    ""
  ].join("\r\n")
});
/**
 * An HTML body showing a logo as a desktop mail client sends it, named image001.png with a
 * Content-ID inside `multipart/related`, and `pdf` attached as part 2.
 */
const withLogo = (subject: string, day: string, pdf: Uint8Array, logo: Uint8Array) => ({
  day,
  raw: [
    ...headers(subject, 'multipart/mixed; boundary="mixed"'),
    "--mixed",
    'Content-Type: multipart/related; boundary="related"',
    "",
    "--related",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Invoice attached.</p><img src="cid:image001.png@example.com">',
    "--related",
    'Content-Type: image/png; name="image001.png"',
    "Content-Transfer-Encoding: base64",
    "Content-ID: <image001.png@example.com>",
    'Content-Disposition: inline; filename="image001.png"',
    "",
    base64(logo),
    "--related--",
    "--mixed",
    ...pdfPart(subject, pdf),
    "--mixed--",
    ""
  ].join("\r\n")
});
/**
 * An S/MIME signed message: its text and `pdf` as part 1.2, then the detached signature as part 2,
 * `smime.p7s` attached as mail programs send it.
 */
const signed = (subject: string, day: string, pdf: Uint8Array, signature: Uint8Array) => ({
  day,
  raw: [
    ...headers(
      subject,
      'multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="signed"'
    ),
    "--signed",
    'Content-Type: multipart/mixed; boundary="content"',
    "",
    "--content",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `${subject}, signed.`,
    "--content",
    ...pdfPart(subject, pdf),
    "--content--",
    "--signed",
    'Content-Type: application/pkcs7-signature; name="smime.p7s"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="smime.p7s"',
    "",
    base64(signature),
    "--signed--",
    ""
  ].join("\r\n")
});
/** A text body and `pdf` as part 2 with no name and no disposition, as some scanners send one. */
const nameless = (subject: string, day: string, pdf: Uint8Array) => ({
  day,
  raw: [
    ...headers(subject, 'multipart/mixed; boundary="scan"'),
    "--scan",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Scanned document.",
    "--scan",
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    "",
    base64(pdf),
    "--scan--",
    ""
  ].join("\r\n")
});
/** A note with no attachment, received on `day` of 2026. */
const note = (subject: string, day: string) => ({
  day,
  raw: [...headers(subject, "text/plain; charset=utf-8"), `${subject}.`, ""].join("\r\n")
});
/**
 * A CSV export of about `bytes` bytes mailed as plain text, as a nightly report sends one, every
 * field quoted and empty: each quote answers as two bytes once escaped.
 */
const csvExport = (subject: string, day: string, bytes: number) => {
  const row = Array.from({ length: 20 }, () => '""').join(",");
  const rows = Array.from({ length: Math.ceil(bytes / (row.length + 2)) }, () => row);
  return {
    day,
    raw: [...headers(subject, "text/plain; charset=utf-8"), ...rows, ""].join("\r\n")
  };
};
/** One invoice with `pdf` attached, received on `day` of 2026. */
const invoice = (
  subject: string,
  day: string,
  pdf: Uint8Array,
  disposition: "attachment" | "inline" = "attachment"
) => ({
  day,
  raw: [
    ...headers(subject, 'multipart/mixed; boundary="importer-boundary"'),
    "--importer-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `${subject}, attached.`,
    "--importer-boundary",
    `Content-Type: application/pdf; name="${subject}.pdf"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${disposition}; filename="${subject}.pdf"`,
    "",
    base64(pdf),
    "--importer-boundary--",
    ""
  ].join("\r\n")
});
const append = (folder: string, message: { readonly day: string; readonly raw: string }) =>
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

/** `handler`, noting in `into` how many refs each call it refuses as too large asked for. */
const noteTooLarge = (handler: Runtime.Handler, into: number[]): Runtime.Handler =>
  handler.transport === undefined
    ? {
        ...handler,
        run: (args) =>
          handler.run(args).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                if ("code" in error && error.code === "too_large")
                  into.push((args as { readonly refs: ReadonlyArray<unknown> }).refs.length);
              })
            )
          )
      }
    : handler;

const run = `${process.pid}`;

it.layer(services, { timeout: "300 seconds", excludeTestServices: true })(
  "The reference importer, live",
  (it) => {
    it.effect(
      "Dovecot: imports windows past a scan page into tables and files, resuming after each stop",
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
            randomBytes(7_000),
            randomBytes(8_000),
            randomBytes(9_000),
            randomBytes(10_000),
            randomBytes(11_000)
          ] as const;
          const logo = randomBytes(1_000);
          const signature = randomBytes(1_500);
          yield* owned((owner) => owner.mailboxCreate(folder));
          // UID 1 is before the window; 2 to 10 are in it, 6 a named PDF sent inline, 7 a forward,
          // 8 a body with an embedded logo, 9 a signed message and 10 a PDF with no name; 11
          // arrives after the first full import.
          yield* append(folder, invoice("Old", "2026-09-20", pdfs[0]));
          yield* append(folder, invoice("Small", "2026-10-02", pdfs[1]));
          yield* append(folder, invoice("Large", "2026-10-03", pdfs[2]));
          yield* append(folder, invoice("Expunged", "2026-10-04", pdfs[3]));
          yield* append(folder, invoice("Failed", "2026-10-05", pdfs[4]));
          yield* append(folder, invoice("Inline", "2026-10-05", pdfs[5], "inline"));
          yield* append(folder, forward("Forwarded", "2026-10-05", pdfs[6]));
          yield* append(folder, withLogo("Logo", "2026-10-05", pdfs[7], logo));
          yield* append(folder, signed("Signed", "2026-10-05", pdfs[8], signature));
          yield* append(folder, nameless("Scan", "2026-10-05", pdfs[9]));
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
          // The ref counts of the getMessages calls refused as too large.
          const tooLarge: number[] = [];
          const handlers = {
            ...rows,
            ...files,
            ...imap,
            "imap.getMessages": noteTooLarge(
              before(imap["imap.getMessages"], () =>
                Effect.suspend(() => {
                  const uid = expungeOnRead;
                  expungeOnRead = undefined;
                  return uid === undefined ? Effect.void : expunge(folder, uid);
                })
              ),
              tooLarge
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
          // Every row of `table`, page by page.
          const list = (table: string) =>
            Effect.gen(function* () {
              const all: Array<Record<string, unknown>> = [];
              let cursor: string | null = null;
              do {
                const page = (yield* as(
                  rows["tables.list"].run({
                    table,
                    limit: 100,
                    ...(cursor === null ? {} : { cursor })
                  })
                )) as {
                  readonly rows: ReadonlyArray<Record<string, unknown>>;
                  readonly cursor: string | null;
                };
                all.push(...page.rows);
                cursor = page.cursor;
              } while (cursor !== null);
              return all;
            });
          const key = (uid: number) => `${folder}/${uidValidity}/${uid}`;
          const file = (uid: number, part = "2") =>
            `${encodeURIComponent(folder)}.${uidValidity}/${uid}/${part}`;
          const stored = (prefix?: string) =>
            as(
              files["files.list"].run({
                store: "documents",
                limit: 100,
                ...(prefix === undefined ? {} : { prefix })
              })
            ).pipe(
              Effect.map((page) =>
                (page as { readonly files: ReadonlyArray<{ readonly name: string }> }).files.map(
                  (each) => each.name
                )
              )
            );

          // 1. The viewer's staged uploads are full: the run stops before anything is kept.
          const full = [];
          for (let index = 0; index < 16; index++)
            full.push(
              (yield* staging.stage(binding, new Uint8Array([index]), "text/plain")).upload
            );
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
          //    Only the attachments are kept: the forward's PDF, not its text, HTML or container,
          //    the logo message's PDF, not its logo, the signed message's PDF, not its signature,
          //    and the PDF with no name.
          assert.deepStrictEqual(yield* importWindow(), {
            ok: true,
            value: { imported: 8, done: true, stopped: null }
          });
          const attachments = yield* list("attachments");
          assert.sameMembers(
            attachments.map((row) => `${row["message"] as string} ${row["part"] as string}`),
            [
              `${key(2)} 2`,
              `${key(3)} 2`,
              `${key(5)} 2`,
              `${key(6)} 2`,
              `${key(7)} 2.2`,
              `${key(8)} 2`,
              `${key(9)} 1.2`,
              `${key(10)} 2`
            ]
          );
          const kept = new Map(attachments.map((row) => [row["message"] as string, row]));
          assert.deepInclude(kept.get(key(3))!, {
            file: null,
            sha256: null,
            filename: "Large.pdf"
          });
          assert.isAbove(kept.get(key(3))!["size"] as number, BOUND);
          assert.isNull(kept.get(key(10))!["filename"]);
          for (const [uid, part, pdf] of [
            [2, "2", pdfs[1]],
            [5, "2", pdfs[4]],
            [6, "2", pdfs[5]],
            [7, "2.2", pdfs[6]],
            [8, "2", pdfs[7]],
            [9, "1.2", pdfs[8]],
            [10, "2", pdfs[9]]
          ] as const) {
            assert.deepInclude(kept.get(key(uid))!, {
              file: file(uid, part),
              sha256: sha256(pdf),
              size: pdf.byteLength
            });
            assert.strictEqual(
              sha256(
                (yield* as(files["files.get"].run({ store: "documents", name: file(uid, part) })))
                  .bytes
              ),
              sha256(pdf)
            );
          }
          assert.sameMembers(yield* stored(), [
            file(2),
            file(5),
            file(6),
            file(7, "2.2"),
            file(8),
            file(9, "1.2"),
            file(10)
          ]);
          assert.sameMembers(
            (yield* list("messages")).map((row) => row["key"]),
            [key(2), key(3), key(5), key(6), key(7), key(8), key(9), key(10)]
          );
          assert.lengthOf(yield* list("imports"), 1);

          // 4. New mail since: the next run starts from the checkpoint and imports only it.
          yield* append(folder, invoice("Later", "2026-10-06", pdfs[10]));
          assert.deepStrictEqual(yield* importWindow(), {
            ok: true,
            value: { imported: 1, done: true, stopped: null }
          });
          assert.strictEqual(
            sha256(
              (yield* as(files["files.get"].run({ store: "documents", name: file(11) }))).bytes
            ),
            sha256(pdfs[10])
          );
          assert.lengthOf(yield* list("messages"), 9);

          // 5. A window of 130 messages in another folder, past one scan page of 100 and
          //    getMessages' 25 refs, every tenth with a PDF. A row write on the second page fails
          //    once: the run fails after the first page's checkpoint, and the next run reads only
          //    the second page. Every message is kept once, with no gaps.
          const bulk = `Bulk ${run}`;
          const uids = Array.from({ length: 130 }, (_, index) => index + 1);
          const bulkPdfs = new Map(
            uids.filter((uid) => uid % 10 === 0).map((uid) => [uid, randomBytes(1_000 + uid)])
          );
          yield* owned(async (owner) => {
            await owner.mailboxCreate(bulk);
            for (const uid of uids) {
              const day = `2026-10-${String(1 + (uid % 28)).padStart(2, "0")}`;
              const pdf = bulkPdfs.get(uid);
              const message =
                pdf === undefined ? note(`Note ${uid}`, day) : invoice(`Bulk ${uid}`, day, pdf);
              await owner.append(bulk, message.raw, [], new Date(`${day}T10:00:00Z`));
            }
          });
          const bulkValidity = yield* owned(async (owner) => {
            const status = await owner.status(bulk, { uidValidity: true });
            return status === false ? 0 : Number(status.uidValidity);
          });
          const bulkKey = (uid: number) => `${bulk}/${bulkValidity}/${uid}`;
          const bulkFile = (uid: number) => `${encodeURIComponent(bulk)}.${bulkValidity}/${uid}/2`;
          const importBulk = () =>
            invoke("importer.importFolder", { folder: bulk, since: "2026-10-01" });
          // The rows of `table` that belong to folder `name`.
          const inFolder = (name: string, table: string) =>
            Effect.map(list(table), (all) => all.filter((row) => row["folder"] === name));

          failRowOf = bulkKey(110);
          assert.propertyVal(yield* Effect.flip(importBulk()), "_tag", "CallbackRefusal");
          // The first page's 100 and the second page's rows up to the failed one, and its
          // checkpoint.
          assert.lengthOf(yield* inFolder(bulk, "messages"), 109);
          assert.lengthOf(yield* inFolder(bulk, "imports"), 1);

          assert.deepStrictEqual(yield* importBulk(), {
            ok: true,
            value: { imported: 30, done: true, stopped: null }
          });
          const bulkMessages = yield* inFolder(bulk, "messages");
          assert.deepStrictEqual(
            bulkMessages.map((row) => row["uid"] as number).sort((a, b) => a - b),
            uids
          );
          assert.strictEqual(new Set(bulkMessages.map((row) => row["key"])).size, uids.length);
          const bulkAttachments = (yield* list("attachments")).filter((row) =>
            (row["message"] as string).startsWith(`${bulk}/`)
          );
          assert.sameMembers(
            bulkAttachments.map((row) => `${row["message"] as string} ${row["part"] as string}`),
            [...bulkPdfs.keys()].map((uid) => `${bulkKey(uid)} 2`)
          );
          for (const row of bulkAttachments) {
            const uid = Number((row["message"] as string).split("/").at(-1));
            assert.deepInclude(row, {
              file: bulkFile(uid),
              sha256: sha256(bulkPdfs.get(uid)!),
              size: bulkPdfs.get(uid)!.byteLength
            });
          }
          assert.sameMembers(
            yield* stored(`${encodeURIComponent(bulk)}.`),
            [...bulkPdfs.keys()].map(bulkFile)
          );
          assert.lengthOf(yield* inFolder(bulk, "imports"), 1);

          // 6. Long plain-text exports, sized from the result bound so 25 of them answer past it
          //    once their quotes are escaped, then a few notes. The first batch is refused as a
          //    whole and read again in halves, and every message is kept once.
          const resultBound = registry["runtime.result.bytes"].default;
          // A quoted empty field is 3 bytes of text and 5 escaped, so 25 exports answer a tenth
          // past the bound; each stays within the text bound, so none is cut.
          const exportBytes = Math.ceil((resultBound * 1.1) / 25 / (5 / 3));
          assert.isBelow(exportBytes, registry["imap.message.text"].default);
          const long = `Long ${run}`;
          const longUids = Array.from({ length: 30 }, (_, index) => index + 1);
          yield* owned(async (owner) => {
            await owner.mailboxCreate(long);
            for (const uid of longUids) {
              const message =
                uid <= 25
                  ? csvExport(`Export ${uid}`, "2026-10-02", exportBytes)
                  : note(`Note ${uid}`, "2026-10-03");
              await owner.append(long, message.raw, [], new Date(`${message.day}T10:00:00Z`));
            }
          });
          assert.deepStrictEqual(
            yield* invoke("importer.importFolder", { folder: long, since: "2026-10-01" }),
            { ok: true, value: { imported: 30, done: true, stopped: null } }
          );
          assert.deepStrictEqual(tooLarge, [25]);
          const longMessages = yield* inFolder(long, "messages");
          assert.deepStrictEqual(
            longMessages.map((row) => row["uid"] as number).sort((a, b) => a - b),
            longUids
          );
          assert.strictEqual(new Set(longMessages.map((row) => row["key"])).size, longUids.length);
        })
    );
  }
);
