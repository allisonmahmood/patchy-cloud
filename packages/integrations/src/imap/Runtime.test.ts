import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv } from "@patchy/auth/testing";
import { Companies, Users, Teams } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { Limits, OperatingLimits } from "@patchy/limits";
import {
  Binding,
  FileStaging,
  InvocationCapabilities,
  InvocationLog,
  RuntimeLog
} from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as CompanyTesting from "../../../company-database/src/testing.js";
import type { ImapClient } from "../../../patchy/src/imap.js";
import * as MutationTransaction from "../../../primitives/src/MutationTransaction.js";
import * as QuerySnapshot from "../../../primitives/src/QuerySnapshot.js";
import * as TestWakes from "../../../primitives/src/test/wakes.js";
import * as AttioSource from "../attio/Source.js";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as ImapTest from "../test/imap.js";
import * as RuntimeTest from "../test/runtime.js";
import { generate } from "./Generate.js";
import * as Operations from "./Operations.js";
import * as Sessions from "./Sessions.js";
import * as Source from "./Source.js";

/**
 * A mailbox read the way patches read it: the generated client calling back through the gateway
 * as a tier 2 action's viewer, and a tier 2 action in real workerd, both from the packed `patchy`
 * package, over a scripted mail server. The sentinel stands in a subject, a body, an address and
 * a search value: none of it may reach recent calls, a log line or a wide event, and nor may the
 * password.
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const host = "mail.example.test";
const SENTINEL = "SENTINEL-imap-5d27";
const PASSWORD = "the-mailbox-password-7c3e";
class Certs extends Context.Service<Certs, ImapTest.Certificates>()("test/imap/RuntimeCerts") {}

const attachmentBytes = Uint8Array.from({ length: 9_000 }, (_, index) => (index * 11) % 256);
const mailbox = (): ImapTest.ScriptedFolder => ({
  path: "INBOX",
  uidValidity: 11,
  messages: [
    { uid: 1, day: "2026-09-20", subject: "Old statement", from: "bank@example.com", text: "Old." },
    {
      uid: 2,
      day: "2026-10-03",
      subject: `Invoice ${SENTINEL}`,
      from: `${SENTINEL.toLowerCase()}@example.com`,
      text: `Pay ${SENTINEL} by Friday.\n`,
      attachment: {
        filename: `invoice-${SENTINEL}.pdf`,
        bytes: attachmentBytes.byteLength,
        content: attachmentBytes
      }
    },
    { uid: 3, day: "2026-10-04", subject: "Reminder", from: "billing@example.com", text: "Soon." }
  ]
});

/** A connected mailbox on a scripted server, and the IMAP handlers as the server builds them. */
const connected = (handle: string) =>
  Effect.gen(function* () {
    const certs = yield* Certs;
    const served = yield* ImapTest.serve(certs, {
      capabilities: ["IMAP4rev1", "AUTH=PLAIN", "ID", "NAMESPACE", "ESEARCH"],
      mailboxes: [mailbox()]
    });
    const source = Source.layer.pipe(Layer.provide(ImapTest.network(served, certs)));
    const store = yield* SqlConnectionStore.make.pipe(Effect.provide([source, Teams.layer]));
    const connection = yield* store.connect({
      integration: "imap",
      ...who,
      handle,
      description: "Supplier invoices",
      credentials: Source.credentials({
        host,
        port: 993,
        security: "tls",
        username: "invoices@example.test",
        password: PASSWORD
      })
    });
    const sessions = yield* Sessions.make.pipe(Effect.provide(source));
    const staging = ImapTest.recordingStaging();
    const handlers = yield* Operations.makeHandlers.pipe(
      Effect.provideService(Sessions.Sessions, sessions),
      Effect.provideService(ConnectionStore.ConnectionStore, store),
      Effect.provideService(FileStaging.FileStaging, staging.service)
    );
    return { served, store, connection, sessions, handlers, staged: staging.staged };
  });

const credentials = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 3).toString("base64")}`)),
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
  // No IMAP source here: layers memoize by reference, so an outer one would stand in for the
  // scripted mailbox's.
  Layer.effect(Certs, ImapTest.certificates([host]))
);

/** The declaration's generated client, bundled from the packed package and loaded as a page does. */
const generatedClient = (
  connection: { readonly id: string; readonly handle: string },
  call: RuntimeTest.Call
) =>
  RuntimeTest.bundle(
    generate(
      { kind: "imap", ...connection, revision: 1, description: "Invoices" },
      {
        version: 1,
        host,
        port: 993,
        security: "tls",
        username: "invoices@example.test",
        capabilities: ["IMAP4rev1"],
        folders: [{ path: "INBOX", delimiter: "/", specialUse: [], selectable: true }],
        truncated: false
      }
    ).client,
    "mail.ts"
  ).pipe(
    Effect.flatMap((code) =>
      Effect.promise(
        () =>
          import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Promise<{
            createClient: (alias: string, call: RuntimeTest.Call) => ImapClient;
          }>
      )
    ),
    Effect.map((module) => module.createClient("mail", call))
  );

/** Every recent call and log line, as text, for the sentinel to be looked for in. */
const everything = Effect.fn("ImapJourney.everything")(function* (logs: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly row: string;
  }>`SELECT row_to_json(c)::text AS row FROM runtime_calls c WHERE company_id = ${who.companyId}`;
  return { rows: rows.length, text: [...rows.map((row) => row.row), ...logs].join("\n") };
});

/** The call host staging binds an Upload to, for stages made outside a page's call. */
const viewer = {
  user: { id: who.userId, name: "Dev", email: "dev@patchy.local" },
  company: { id: who.companyId, name: "Patchy Dev", handle: "patchy-dev" },
  admin: false
};
const stagingBinding = Binding.Binding.of({
  companyId: who.companyId,
  patchId: "imapstaging",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  wireVersion: WIRE_VERSION,
  scope: "company",
  correlationId: "imap-staging",
  principal: { userId: who.userId },
  identity: viewer,
  reauthorize: Effect.succeed(viewer),
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: {}
  }
});

const patchId = "imapcallback";
const versionId = "ver_aaaaaaaaaaaaaaaaaaaaaaaa";
let declared: { readonly id: string; readonly handle: string } = {
  id: "conn_none",
  handle: "none"
};
const tier1 = Layer.mergeAll(
  Session.layer,
  WideEvents.layerNoop,
  Companies.layer,
  Users.layer,
  Limits.layer,
  OperatingLimits.layer,
  RuntimeLog.layer,
  credentials,
  RuntimeTest.versions(patchId, versionId, () => ({
    mail: { kind: "imap" as const, ...declared, revision: 1 }
  }))
)
  .pipe(
    Layer.provideMerge(Testing.layer()),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
  )
  .pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCryptography.layer));

it.layer(tier1)("IMAP from a tier 2 action's callbacks", (it) => {
  it.effect(
    "the generated client reads the mailbox as the viewer, and records no mail",
    () => {
      const logs: string[] = [];
      return Effect.gen(function* () {
        const { served, connection, sessions, handlers, store, staged } =
          yield* connected("journey");
        declared = { id: connection.id, handle: connection.handle };
        const call = yield* RuntimeTest.page(handlers, patchId, versionId);
        const mail = yield* generatedClient(declared, call);

        const folders = yield* Effect.promise(() => mail.listFolders());
        assert.deepStrictEqual(
          folders.folders.map((folder) => folder.path),
          ["INBOX"]
        );
        const status = yield* Effect.promise(() => mail.folderStatus("INBOX"));
        assert.deepInclude(status, { messages: 3, uidValidity: 11, uidNext: 4 });
        const scan = yield* Effect.promise(() =>
          mail.scanMessages({ folder: "INBOX", since: "2026-10-01" })
        );
        assert.deepStrictEqual(
          scan.messages.map((message) => message.ref.uid),
          [2, 3]
        );
        assert.isTrue(scan.done);
        const search = yield* Effect.promise(() =>
          mail.searchMessages({ folder: "INBOX", subject: SENTINEL })
        );
        assert.deepStrictEqual(
          search.messages.map((message) => message.ref.uid),
          [2]
        );
        const [message] = yield* Effect.promise(() => mail.getMessages([scan.messages[0]!.ref]));
        assert.isTrue(message !== undefined && "text" in message);
        if (message !== undefined && "text" in message) {
          assert.strictEqual(message.text, `Pay ${SENTINEL} by Friday.`);
          assert.isTrue(message.hasAttachments);
        }
        // An attachment stages through host staging: its true size and digest come back with
        // the Upload, and the sender's filename only as display text.
        const attachment = yield* Effect.promise(() =>
          mail.stageAttachment({ ref: scan.messages[0]!.ref, part: "2" })
        );
        assert.deepInclude(attachment, {
          size: attachmentBytes.byteLength,
          sha256: createHash("sha256").update(attachmentBytes).digest("hex"),
          contentType: "application/pdf",
          filename: `invoice-${SENTINEL}.pdf`
        });
        assert.deepStrictEqual(
          staged.map((each) => each.token),
          [attachment.upload.token]
        );
        // A reset folder fails mailbox_reset with its own details, narrowed by integration.
        const reset = yield* Effect.promise(() =>
          mail
            .getMessages([{ ...scan.messages[0]!.ref, uidValidity: 10 }])
            .catch((error: unknown) => error)
        );
        assert.include(reset as object, { code: "mailbox_reset", operation: "imap.getMessages" });
        assert.deepStrictEqual((reset as { readonly details: unknown }).details, {
          folder: "INBOX"
        });

        // An alias the version doesn't declare, and arguments past the wire, are refused unsent.
        const before = served.lines.length;
        assert.include(
          yield* Effect.promise(() => call("imap.listFolders", { connection: "nope" })),
          { code: "connection_not_declared" }
        );
        assert.include(
          yield* Effect.promise(() =>
            call("imap.searchMessages", {
              connection: "mail",
              folder: "INBOX",
              text: SENTINEL,
              unseen: "yes"
            })
          ),
          { code: "invalid_request" }
        );
        assert.strictEqual(served.lines.length, before);

        // Recent calls name the operation and its outcome; nothing holds mail or the password.
        const log = yield* RuntimeLog.RuntimeLog;
        const calls = yield* log.recent({
          companyId: who.companyId,
          connectionId: connection.id,
          patchIds: [patchId]
        });
        assert.includeMembers(
          calls.map((recent) => recent.op),
          [
            "imap.listFolders",
            "imap.scanMessages",
            "imap.searchMessages",
            "imap.getMessages",
            "imap.stageAttachment"
          ]
        );
        // A staged attachment is recorded by its size: never its filename or its Upload.
        assert.strictEqual(
          calls.find((recent) => recent.op === "imap.stageAttachment")?.bytes,
          attachmentBytes.byteLength
        );
        const seen = yield* everything(logs);
        assert.isAbove(seen.rows, 6);
        assert.notInclude(seen.text, SENTINEL);
        assert.notInclude(seen.text, SENTINEL.toLowerCase());
        assert.notInclude(seen.text, PASSWORD);
        assert.notInclude(seen.text, attachment.upload.token);

        // Wide events carry the pool's values for tuning, and no mail either.
        const recorded: WideEvents.WideEvent[] = [];
        const events = yield* WideEvents.make.pipe(
          Effect.provideService(WideEvents.Sink, {
            write: (event) => Effect.sync(() => void recorded.push(event))
          })
        );
        const target = {
          companyId: who.companyId,
          connection: declared,
          deadline: Date.now() + 15_000,
          recheck: Effect.void
        };
        const recordedRead = <A, E, R>(read: Effect.Effect<A, E, R>) =>
          events.withEvent(
            { type: "request" },
            read.pipe(
              Effect.provideService(Sessions.Sessions, sessions),
              Effect.provideService(ConnectionStore.ConnectionStore, store),
              Effect.ignore
            )
          );
        yield* recordedRead(
          Operations.atMailbox(target, "searchMessages", { folder: "INBOX", text: SENTINEL })
        );
        yield* recordedRead(
          Operations.atMailbox(target, "getMessages", { refs: [scan.messages[0]!.ref] })
        );
        yield* recordedRead(
          Operations.atMailbox(target, "folderStatus", { folder: `Missing ${SENTINEL}` })
        );
        const staging = ImapTest.recordingStaging();
        yield* recordedRead(
          Operations.stageAttachmentAt(target, { ref: scan.messages[0]!.ref, part: "2" }).pipe(
            Effect.provideService(FileStaging.FileStaging, staging.service),
            Effect.provideService(Binding.Binding, stagingBinding)
          )
        );
        yield* Effect.yieldNow;
        const text = JSON.stringify(recorded);
        assert.isAtLeast(recorded.length, 3);
        assert.include(text, '"imapSession":"pooled"');
        assert.include(text, `"stagedBytes":${attachmentBytes.byteLength}`);
        assert.notInclude(text, staging.staged[0]!.token);
        assert.notInclude(text, SENTINEL);
        assert.notInclude(text, SENTINEL.toLowerCase());
        assert.notInclude(text, PASSWORD);
        assert.notInclude(served.lines.join("\n"), PASSWORD);
      }).pipe(
        Effect.provide(
          Logger.layer([Logger.make((event) => void logs.push(JSON.stringify(event.message)))], {
            mergeWithExisting: true
          })
        ),
        Effect.scoped
      );
    },
    60_000
  );
});

const tier2 = Layer.mergeAll(
  RuntimeLog.layer,
  InvocationLog.layer,
  OperatingLimits.layer,
  QuerySnapshot.layer,
  MutationTransaction.layer,
  credentials
).pipe(
  Layer.provideMerge(InvocationCapabilities.layer),
  Layer.provideMerge(CompanyTesting.layer()),
  Layer.provideMerge(TestWakes.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(NodeCryptography.layer)
);

const importer = `import { action, createGuest, t } from "patchy/server";
const importWindow = action({
  args: { since: t.text() },
  result: t.json(),
  handler: async (ctx, { since }) => {
    const mail = ctx.connections.mail;
    const folders = await mail.listFolders();
    const refs = [];
    let checkpoint;
    let cursor;
    do {
      const page = await mail.scanMessages({ folder: "INBOX", since, cursor });
      refs.push(...page.messages.map((message) => message.ref));
      checkpoint = page.checkpoint;
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    const again = await mail.scanMessages({ folder: "INBOX", after: checkpoint });
    const found = await mail.searchMessages({ folder: "INBOX", from: "billing" });
    const read = await mail.getMessages(refs);
    return {
      folders: folders.folders.map((folder) => folder.path),
      scanned: refs.map((ref) => ref.uid),
      newer: again.messages.length,
      found: found.messages.map((message) => message.subject),
      texts: read.map((message) => ("text" in message ? message.text : message.error))
    };
  }
});
const peek = action({ readOnly: true, args: {}, result: t.json(), handler: async (ctx) => (await ctx.connections.mail.folderStatus("INBOX")).messages });
export default createGuest({ desk: { importWindow, peek } }, [], {}, [], [], ["mail"]);
`;

it.layer(tier2, { excludeTestServices: true, timeout: 60_000 })("IMAP in a tier 2 action", (it) => {
  it.effect(
    "an action in workerd scans a window and reads it through ctx.connections",
    () =>
      Effect.gen(function* () {
        const { handlers, connection } = yield* connected("importer");
        const viewer = {
          user: { id: who.userId, name: "Dev", email: "dev@patchy.local" },
          company: { id: who.companyId, name: "Patchy Dev", handle: "patchy-dev" },
          admin: false
        };
        const binding = Binding.Binding.of({
          companyId: who.companyId,
          patchId: "imaptier2pgx",
          versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
          wireVersion: WIRE_VERSION,
          scope: "company",
          correlationId: "imap-tier2",
          principal: { userId: who.userId },
          identity: viewer,
          reauthorize: Effect.succeed(viewer),
          manifest: {
            manifestVersion: 1,
            release: CURRENT_RELEASE,
            tier: 2,
            tables: {},
            files: {},
            uses: {
              mail: {
                kind: "imap",
                id: connection.id,
                handle: connection.handle,
                revision: connection.metadataRevision
              }
            },
            handlers: {
              "desk.importWindow": {
                kind: "action",
                args: { since: { kind: "text" } },
                result: { kind: "json" }
              },
              "desk.peek": { kind: "action", readOnly: true, args: {}, result: { kind: "json" } }
            }
          }
        });
        const invoke = yield* RuntimeTest.invoker(handlers, binding, importer);
        assert.deepStrictEqual(yield* invoke("desk.importWindow", { since: "2026-10-01" }), {
          ok: true,
          value: {
            folders: ["INBOX"],
            scanned: [2, 3],
            newer: 0,
            found: ["Reminder"],
            texts: [`Pay ${SENTINEL} by Friday.`, "Soon."]
          }
        });
        assert.deepStrictEqual(yield* invoke("desk.peek"), { ok: true, value: 3 });
      }),
    60_000
  );
});
