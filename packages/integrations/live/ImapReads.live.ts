import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { NodeCryptography } from "@patchy/core";
import { Runtime } from "@patchy/runtime/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ImapFlow } from "imapflow";
import { inject } from "vitest";
import * as AttioSource from "../src/attio/Source.js";
import * as ConnectionStore from "../src/ConnectionStore.js";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as ImapNetwork from "../src/imap/Network.js";
import * as Operations from "../src/imap/Operations.js";
import * as Sessions from "../src/imap/Sessions.js";
import * as Source from "../src/imap/Source.js";
import * as PidgeonSource from "../src/pidgeon/Source.js";
import * as PostgresSource from "../src/postgres/Source.js";
import * as PostHogSource from "../src/posthog/Source.js";
import * as SqlConnectionStore from "../src/SqlConnectionStore.js";
import type { LiveServer } from "./imapHarness.js";

/**
 * IMAP reads against real mail servers in Docker (`imapHarness.ts`): Dovecot and GreenMail. A
 * mail client seeds each test's folder, as mail arriving would; Patchy itself only reads, and every
 * read here leaves every message unseen. The offline suites (`src/imap`) carry each case's
 * correctness; this tier proves real servers answer Patchy's commands as it expects.
 */

const mail = inject("imap");
const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const network = ImapNetwork.loopback(() =>
  [mail.dovecot, mail.greenmail].map((server) => ({
    host: server.host,
    ports: { 993: server.tls, 143: server.plain },
    ca: mail.ca
  }))
);
const services = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 8).toString("base64")}`)),
  RuntimeLog.layer,
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
  Sessions.layer.pipe(Layer.provideMerge(Source.layer.pipe(Layer.provide(network))))
).pipe(Layer.provideMerge(Testing.layer()), Layer.provideMerge(NodeCryptography.layer));

/** A mail client on the server, as the person who owns the mailbox would use one. */
const client = (server: LiveServer) =>
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
  );
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
/** One plain message, its subject as RFC 2047 encoded words so a non-ASCII one survives. */
const raw = (index: number, subject: string, text: string) =>
  [
    `From: Billing <billing${index % 3}@example.com>`,
    "To: invoices@imap-live.test",
    `Subject: =?UTF-8?B?${base64(subject)}?=`,
    `Message-ID: <live-${index}@example.test>`,
    "Date: Mon, 02 Nov 2026 09:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    ""
  ].join("\r\n");
/** A fresh folder holding `count` messages, the nth received on day n of October 2026. */
const seed = (
  server: LiveServer,
  folder: string,
  count: number,
  subject: (index: number) => string = (index) => `Überweisung № ${index}`
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* client(server);
      yield* Effect.promise(async () => {
        await owner.mailboxCreate(folder);
        for (let index = 1; index <= count; index++)
          await owner.append(
            folder,
            raw(index, subject(index), `Bitte zahlen Sie Rechnung ${index}.`),
            [],
            new Date(Date.UTC(2026, 9, 1 + ((index - 1) % 28), 10))
          );
      });
    })
  );
/** Every message's flags as the owner's client sees them now. */
const flags = (server: LiveServer, folder: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* client(server);
      return yield* Effect.promise(async () => {
        const lock = await owner.getMailboxLock(folder, { readOnly: true });
        try {
          const all = await owner.fetchAll("1:*", { uid: true, flags: true });
          return all.map((message) => [...(message.flags ?? [])]);
        } finally {
          lock.release();
        }
      });
    })
  );
const owned = <A>(server: LiveServer, use: (owner: ImapFlow) => Promise<A>) =>
  Effect.scoped(Effect.flatMap(client(server), (owner) => Effect.promise(() => use(owner))));

/** A connected mailbox, and a way to call each read on it as a patch's viewer would. */
const connected = (server: LiveServer, handle: string) =>
  Effect.gen(function* () {
    const store = yield* SqlConnectionStore.make;
    const connection = yield* store.connect({
      integration: "imap",
      ...who,
      handle,
      description: "Live mailbox",
      credentials: Source.credentials({
        host: server.host,
        port: 993,
        security: "tls",
        username: server.username,
        password: server.password
      })
    });
    const call = <K extends keyof typeof Operations.operations>(
      name: K,
      input: Parameters<typeof Operations.atMailbox<K, Runtime.AccessDenied>>[2]
    ) =>
      Operations.atMailbox(
        {
          companyId: who.companyId,
          connection: { id: connection.id, handle },
          deadline: Date.now() + 15_000,
          recheck: Effect.void as Effect.Effect<void, Runtime.AccessDenied>
        },
        name,
        input
      ).pipe(Effect.provideService(ConnectionStore.ConnectionStore, store));
    return { connection, call };
  });

interface Page {
  readonly messages: ReadonlyArray<{
    readonly subject: string | null;
    readonly ref: { readonly uid: number; readonly uidValidity: number };
  }>;
  readonly cursor: string | null;
  readonly checkpoint?: string;
  readonly done: boolean;
}
const servers = [
  ["Dovecot", mail.dovecot],
  ["GreenMail", mail.greenmail]
] as const;
const run = `${process.pid}`;

it.layer(services, { timeout: "120 seconds", excludeTestServices: true })(
  "IMAP reads, live",
  (it) => {
    for (const [name, server] of servers) {
      it.effect(`${name}: reads folders, pages and messages, leaving every one unseen`, () =>
        Effect.gen(function* () {
          const folder = `Reads ${run} Überweisungen`;
          yield* seed(server, folder, 120);
          const { call, connection } = yield* connected(server, `reads-${name.toLowerCase()}`);
          const listed = (yield* call("listFolders", {})) as {
            readonly folders: ReadonlyArray<{ readonly path: string }>;
          };
          assert.isTrue(listed.folders.some((entry) => entry.path === folder));
          assert.deepInclude(yield* call("folderStatus", { folder }), {
            messages: 120,
            unseen: 120
          });

          const scanned: Page["messages"][number][] = [];
          let page = (yield* call("scanMessages", { folder, since: "2026-10-01" })) as Page;
          scanned.push(...page.messages);
          while (page.cursor !== null) {
            page = (yield* call("scanMessages", {
              folder,
              since: "2026-10-01",
              cursor: page.cursor
            })) as Page;
            scanned.push(...page.messages);
          }
          assert.deepStrictEqual(
            scanned.map((message) => message.ref.uid),
            Array.from({ length: 120 }, (_, index) => index + 1)
          );
          assert.strictEqual(scanned[6]!.subject, "Überweisung № 7");
          const after = (yield* call("scanMessages", { folder, after: page.checkpoint! })) as Page;
          assert.deepInclude(after, { messages: [], done: true });

          const newest = (yield* call("listMessages", { folder })) as Page;
          assert.strictEqual(newest.messages[0]!.ref.uid, 120);
          assert.lengthOf(newest.messages, 100);
          // GreenMail's FROM finds no part of an address, so it's searched by subject alone.
          const found = (yield* call("searchMessages", {
            folder,
            subject: "Überweisung № 11",
            ...(name === "Dovecot" ? { from: "billing2" } : {})
          })) as Page;
          assert.includeMembers(
            found.messages.map((message) => message.ref.uid),
            [11, 110]
          );

          const refs = [
            ...scanned.slice(0, 24).map((message) => ({
              connection: connection.id,
              folder,
              uidValidity: message.ref.uidValidity,
              uid: message.ref.uid
            })),
            {
              connection: connection.id,
              folder,
              uidValidity: scanned[0]!.ref.uidValidity,
              uid: 4_000
            }
          ];
          const read = (yield* call("getMessages", { refs })) as {
            readonly messages: ReadonlyArray<{ readonly text?: string; readonly error?: string }>;
          };
          assert.lengthOf(read.messages, 25);
          assert.strictEqual(read.messages[0]!.text, "Bitte zahlen Sie Rechnung 1.");
          assert.deepStrictEqual(read.messages[24], { error: "not_found" });

          // Nothing Patchy sent marked a message read.
          assert.isTrue((yield* flags(server, folder)).every((each) => !each.includes("\\Seen")));
        })
      );

      it.effect(`${name}: answers an empty, finished scan when nothing is since the date`, () =>
        Effect.gen(function* () {
          const folder = `Since ${run}`;
          yield* seed(server, folder, 5);
          const { call } = yield* connected(server, `since-${name.toLowerCase()}`);
          assert.deepInclude(yield* call("scanMessages", { folder, since: "2099-01-01" }), {
            messages: [],
            cursor: null,
            done: true
          });
        })
      );

      it.effect(`${name}: passes over a message expunged mid-scan`, () =>
        Effect.gen(function* () {
          const folder = `Expunge ${run}`;
          yield* seed(server, folder, 150);
          const { call } = yield* connected(server, `expunge-${name.toLowerCase()}`);
          const first = (yield* call("scanMessages", { folder })) as Page;
          assert.lengthOf(first.messages, 100);
          yield* owned(server, async (owner) => {
            const lock = await owner.getMailboxLock(folder);
            try {
              await owner.messageDelete("120", { uid: true });
            } finally {
              lock.release();
            }
          });
          const second = (yield* call("scanMessages", { folder, cursor: first.cursor! })) as Page;
          assert.deepStrictEqual(
            second.messages.map((message) => message.ref.uid),
            Array.from({ length: 50 }, (_, index) => index + 101).filter((uid) => uid !== 120)
          );
          assert.isTrue(second.done);
        })
      );

      it.effect(`${name}: searches across UID gaps, newest first`, () =>
        Effect.gen(function* () {
          const folder = `Gaps ${run}`;
          yield* seed(server, folder, 1_100, (index) =>
            index <= 5 ? `Early ${index}` : `Later ${index}`
          );
          yield* owned(server, async (owner) => {
            const lock = await owner.getMailboxLock(folder);
            try {
              await owner.messageDelete("6:1095", { uid: true });
            } finally {
              lock.release();
            }
          });
          const { call } = yield* connected(server, `gaps-${name.toLowerCase()}`);
          const found: number[] = [];
          let page = (yield* call("searchMessages", { folder, subject: "Early" })) as Page;
          found.push(...page.messages.map((message) => message.ref.uid));
          while (page.cursor !== null) {
            page = (yield* call("searchMessages", {
              folder,
              subject: "Early",
              cursor: page.cursor
            })) as Page;
            found.push(...page.messages.map((message) => message.ref.uid));
          }
          assert.deepStrictEqual(found, [5, 4, 3, 2, 1]);
        })
      );

      it.effect(`${name}: fails mailbox_reset once the folder's UIDVALIDITY changes`, () =>
        Effect.gen(function* () {
          const folder = `Reset ${run}`;
          yield* seed(server, folder, 3);
          const { call, connection } = yield* connected(server, `reset-${name.toLowerCase()}`);
          const page = (yield* call("scanMessages", { folder })) as Page;
          const ref = {
            connection: connection.id,
            folder,
            uidValidity: page.messages[0]!.ref.uidValidity,
            uid: 1
          };
          yield* owned(server, (owner) => owner.mailboxDelete(folder));
          // Dovecot's UIDVALIDITY counts seconds: a folder recreated in the same one could keep it.
          yield* Effect.sleep("1100 millis");
          yield* seed(server, folder, 3);
          const status = (yield* call("folderStatus", { folder })) as {
            readonly uidValidity: number;
          };
          assert.notStrictEqual(status.uidValidity, ref.uidValidity);
          for (const failed of [
            yield* Effect.flip(call("getMessages", { refs: [ref] })),
            yield* Effect.flip(call("scanMessages", { folder, after: page.checkpoint! }))
          ])
            assert.strictEqual(failed.code, "mailbox_reset");
        })
      );
    }
  }
);
