import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { NodeCryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import { Runtime } from "@patchy/runtime/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as AttioSource from "../attio/Source.js";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as ImapTest from "../test/imap.js";
import * as Operations from "./Operations.js";
import * as Sessions from "./Sessions.js";
import * as Source from "./Source.js";

/**
 * IMAP reads offline, over a scripted mail server through the network seam: the commands each
 * operation sends, what's refused before anything is sent, the session pool and its gates, the
 * login pause, and the bounds that destroy a session.
 */

const host = "mail.example.test";
const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
class Certs extends Context.Service<Certs, ImapTest.Certificates>()("test/imap/ReadCerts") {}
const fixture = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 4).toString("base64")}`)),
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
  Layer.effect(Certs, ImapTest.certificates([host]))
).pipe(Layer.provideMerge(Testing.layer()), Layer.provideMerge(NodeCryptography.layer));

const day = (index: number) => `2026-10-${String(1 + (index % 28)).padStart(2, "0")}`;
/** INBOX with `count` messages, UIDs 1 to `count`; message 3 has an attachment. */
const inbox = (count: number): ImapTest.ScriptedFolder => ({
  path: "INBOX",
  uidValidity: 7,
  messages: Array.from({ length: count }, (_, index) => ({
    uid: index + 1,
    day: day(index),
    subject: `Invoice ${index + 1}`,
    from: `billing${index % 3}@example.com`,
    to: ["invoices@example.test"],
    text: `Please pay invoice ${index + 1}.\n`,
    ...(index === 2 ? { attachment: { filename: "invoice-3.pdf", bytes: 12_000 } } : {}),
    references: [`<${index}@scripted.test>`]
  }))
});

interface Setup {
  readonly capabilities?: ReadonlyArray<string>;
  readonly mailboxes?: ReadonlyArray<ImapTest.ScriptedFolder>;
  readonly before?: ImapTest.Script["before"];
  readonly limits?: Partial<Record<Parameters<typeof ContractLimits.get>[0], number>>;
}
/** A connected mailbox on a scripted server, and a way to call each read on it. */
const setup = (handle: string, options: Setup = {}) =>
  Effect.gen(function* () {
    const certs = yield* Certs;
    const mailbox: { reply: string | Promise<string> } = { reply: "OK Logged in" };
    const mailboxes = options.mailboxes ?? [inbox(5)];
    const served = yield* ImapTest.serve(certs, {
      capabilities: options.capabilities ?? [
        "IMAP4rev1",
        "AUTH=PLAIN",
        "ID",
        "NAMESPACE",
        "SPECIAL-USE",
        "ESEARCH"
      ],
      login: () => mailbox.reply,
      mailboxes,
      ...(options.before === undefined ? {} : { before: options.before })
    });
    const source = Source.layer.pipe(Layer.provide(ImapTest.network(served, certs)));
    const store = yield* SqlConnectionStore.make.pipe(Effect.provide(source));
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
        password: "the-right-password"
      })
    });
    const sessions = yield* Sessions.make.pipe(
      Effect.provide(source),
      Effect.provideService(ContractLimits.overrides, options.limits ?? {})
    );
    const call = <K extends keyof typeof Operations.operations>(
      name: K,
      input: Parameters<typeof Operations.atMailbox<K, Runtime.AccessDenied>>[2],
      over: Partial<Operations.Target<Runtime.AccessDenied>> = {}
    ) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Operations.atMailbox(
          {
            companyId: who.companyId,
            connection: { id: connection.id, handle },
            deadline: now + 15_000,
            recheck: Effect.void as Effect.Effect<void, Runtime.AccessDenied>,
            ...over
          },
          name,
          input
        )
      ).pipe(
        Effect.provideService(ConnectionStore.ConnectionStore, store),
        Effect.provideService(Sessions.Sessions, sessions),
        Effect.provideService(ContractLimits.overrides, options.limits ?? {})
      );
    const logins = () => served.commands.filter((line) => line.startsWith("AUTH")).length;
    return { served, store, connection, mailbox, mailboxes, call, logins };
  });

/** What a mail client would send to change a mailbox: none of it ever leaves Patchy. */
const writes =
  /^(STORE|UID STORE|COPY|UID COPY|MOVE|UID MOVE|EXPUNGE|UID EXPUNGE|APPEND|SELECT|DELETE|RENAME|CREATE|SUBSCRIBE|UNSUBSCRIBE)\b/i;
const assertReadOnly = (lines: ReadonlyArray<string>) => {
  for (const line of lines) {
    assert.notMatch(line, writes, line);
    // Every body section is fetched with PEEK, so nothing is marked \Seen.
    assert.notMatch(line, /BODY\[/i, line);
  }
};

/** Waits in real time until `done` holds, for at most three seconds. */
const until = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; !done(); tries++) {
      if (tries === 150) return yield* Effect.die(new Error("Timed out waiting."));
      yield* TestClock.withLive(Effect.sleep("20 millis"));
    }
  });

const messages = (value: unknown) =>
  (value as { readonly messages: ReadonlyArray<{ readonly subject: string }> }).messages;

it.layer(fixture)("IMAP reads", (it) => {
  it.effect("reads folders, status, pages and messages with read-only commands", () =>
    Effect.gen(function* () {
      const { served, call, connection } = yield* setup("reads");
      const folders = (yield* call("listFolders", {})) as {
        readonly folders: ReadonlyArray<{ readonly path: string }>;
      };
      assert.deepStrictEqual(
        folders.folders.map((folder) => folder.path),
        ["INBOX"]
      );
      assert.deepStrictEqual(yield* call("folderStatus", { folder: "INBOX" }), {
        ok: true,
        messages: 5,
        unseen: 5,
        uidValidity: 7,
        uidNext: 6
      });
      const scanned = (yield* call("scanMessages", { folder: "INBOX" })) as {
        readonly messages: ReadonlyArray<{ readonly subject: string; readonly ref: unknown }>;
        readonly done: boolean;
        readonly checkpoint: string;
      };
      assert.deepStrictEqual(
        scanned.messages.map((message) => message.subject),
        ["Invoice 1", "Invoice 2", "Invoice 3", "Invoice 4", "Invoice 5"]
      );
      assert.isTrue(scanned.done);
      assert.deepStrictEqual(scanned.messages[0]!.ref, {
        connection: connection.id,
        folder: "INBOX",
        uidValidity: 7,
        uid: 1
      });
      assert.deepStrictEqual(
        messages(yield* call("listMessages", { folder: "INBOX" })).map(
          (message) => message.subject
        ),
        ["Invoice 5", "Invoice 4", "Invoice 3", "Invoice 2", "Invoice 1"]
      );
      assert.deepStrictEqual(
        messages(yield* call("searchMessages", { folder: "INBOX", from: "billing1" })).map(
          (message) => message.subject
        ),
        ["Invoice 5", "Invoice 2"]
      );
      const read = (yield* call("getMessages", {
        refs: [3, 9, 1].map((uid) => ({
          connection: connection.id,
          folder: "INBOX",
          uidValidity: 7,
          uid
        }))
      })) as {
        readonly messages: ReadonlyArray<{
          readonly text?: string;
          readonly hasAttachments?: boolean;
          readonly parts?: ReadonlyArray<{ readonly filename: string | null }>;
          readonly error?: string;
        }>;
      };
      assert.strictEqual(read.messages[0]!.text, "Please pay invoice 3.");
      assert.isTrue(read.messages[0]!.hasAttachments);
      assert.deepStrictEqual(
        read.messages[0]!.parts!.map((part) => part.filename),
        [null, "invoice-3.pdf"]
      );
      assert.deepStrictEqual(read.messages[1], { error: "not_found" });
      assert.strictEqual(read.messages[2]!.text, "Please pay invoice 1.");

      const sent = served.lines.filter(
        (line) => !/^(CAPABILITY|ID|LOGIN|AUTHENTICATE|NAMESPACE|ENABLE|LOGOUT)\b/.test(line)
      );
      assertReadOnly(served.lines);
      assert.isTrue(sent.some((line) => /^EXAMINE INBOX\b/.test(line)));
      assert.isTrue(sent.some((line) => /^UID SEARCH UID 1:5$/.test(line)));
      assert.isTrue(sent.some((line) => /BODY\.PEEK\[HEADER\.FIELDS \(REFERENCES\)\]/i.test(line)));
      assert.isTrue(sent.some((line) => /BODY\.PEEK\[1\]<0\.\d+>/.test(line)));
      assert.isFalse(
        sent.some((line) => /^(UID )?(SEARCH|FETCH)\b/.test(line) && line.includes("*")),
        "a range is never n:*"
      );
    })
  );

  it.effect("borrows one session across calls, with a fresh EXAMINE each time", () =>
    Effect.gen(function* () {
      const { served, call, logins } = yield* setup("pooled");
      const before = logins();
      // Connecting ran its own Test, EXAMINE INBOX included, on a session of its own.
      const examined = served.lines.filter((line) => line.startsWith("EXAMINE")).length;
      yield* call("listMessages", { folder: "INBOX" });
      yield* call("listMessages", { folder: "INBOX" });
      yield* call("folderStatus", { folder: "INBOX" });
      assert.strictEqual(logins() - before, 1);
      assert.strictEqual(
        served.lines.filter((line) => line.startsWith("EXAMINE")).length - examined,
        3
      );
    })
  );

  it.effect(
    "refuses before upstream: a ref of another connection, or of two UIDVALIDITY values",
    () =>
      Effect.gen(function* () {
        const { served, call, connection } = yield* setup("refusals");
        const dials = served.dials.length;
        const ref = { connection: connection.id, folder: "INBOX", uidValidity: 7, uid: 1 };
        const foreign = yield* Effect.flip(
          call("getMessages", { refs: [ref, { ...ref, connection: "conn_someone_else" }] })
        );
        assert.strictEqual(foreign._tag, "ImapForeignRef");
        assert.strictEqual(foreign.code, "invalid_request");
        const twice = yield* Effect.flip(
          call("getMessages", { refs: [ref, { ...ref, uidValidity: 8 }] })
        );
        assert.strictEqual(twice._tag, "ImapMailboxReset");
        assert.strictEqual(served.dials.length, dials);
      })
  );

  it.effect("fails mailbox_reset for a ref, cursor or checkpoint from before a reset", () =>
    Effect.gen(function* () {
      const reset = inbox(150);
      const { call, connection, logins } = yield* setup("reset", { mailboxes: [reset] });
      const page = (yield* call("scanMessages", { folder: "INBOX" })) as {
        readonly cursor: string;
        readonly checkpoint: string;
      };
      const before = logins();
      Object.assign(reset, { uidValidity: 99 });
      const ref = { connection: connection.id, folder: "INBOX", uidValidity: 7, uid: 1 };
      for (const failed of [
        yield* Effect.flip(call("getMessages", { refs: [ref] })),
        yield* Effect.flip(call("scanMessages", { folder: "INBOX", cursor: page.cursor })),
        yield* Effect.flip(call("scanMessages", { folder: "INBOX", after: page.checkpoint }))
      ]) {
        assert.strictEqual(failed._tag, "ImapMailboxReset");
        assert.strictEqual(failed.code, "mailbox_reset");
      }
      // The session answered and goes back: a reset folder costs no login.
      assert.strictEqual(logins(), before);
    })
  );

  it.effect("refuses a cursor reused on another call", () =>
    Effect.gen(function* () {
      const { served, call } = yield* setup("cursors", { mailboxes: [inbox(150)] });
      const page = (yield* call("scanMessages", { folder: "INBOX" })) as {
        readonly cursor: string;
      };
      const searched = served.lines.length;
      const refused = yield* Effect.flip(
        call("searchMessages", { folder: "INBOX", subject: "Invoice", cursor: page.cursor })
      );
      assert.strictEqual(refused._tag, "ImapInvalidCursor");
      assert.isFalse(served.lines.slice(searched).some((line) => /SEARCH|FETCH/.test(line)));
    })
  );

  it.effect("starts since a date with one RETURN (MIN), and walks windows without ESEARCH", () =>
    Effect.gen(function* () {
      const esearch = yield* setup("since-esearch", { mailboxes: [inbox(20)] });
      const page = yield* esearch.call("scanMessages", { folder: "INBOX", since: "2026-10-15" });
      assert.deepStrictEqual(
        messages(page).map((message) => message.subject),
        Array.from({ length: 6 }, (_, index) => `Invoice ${index + 15}`)
      );
      assert.isTrue(
        esearch.served.lines.some((line) =>
          /^UID SEARCH RETURN \(MIN\) UID 1:20 SINCE 15-Oct-2026$/.test(line)
        )
      );
      const plain = yield* setup("since-plain", {
        mailboxes: [inbox(20)],
        capabilities: ["IMAP4rev1", "AUTH=PLAIN", "ID", "NAMESPACE"]
      });
      const walked = yield* plain.call("scanMessages", { folder: "INBOX", since: "2026-10-15" });
      assert.deepStrictEqual(
        messages(walked).map((message) => message.subject),
        messages(page).map((message) => message.subject)
      );
      assert.isFalse(plain.served.lines.some((line) => line.includes("RETURN")));
      assert.isTrue(
        plain.served.lines.some((line) => /^UID SEARCH UID 1:20 SINCE 15-Oct-2026$/.test(line))
      );
    })
  );

  it.effect("passes over a message expunged mid-scan", () =>
    Effect.gen(function* () {
      const folder = inbox(5);
      const { call } = yield* setup("expunged", {
        mailboxes: [folder],
        before: (line) => {
          if (/^\S+ UID FETCH/.test(line)) folder.messages.splice(1, 1);
        }
      });
      const page = yield* call("scanMessages", { folder: "INBOX" });
      assert.deepStrictEqual(
        messages(page).map((message) => message.subject),
        ["Invoice 1", "Invoice 3", "Invoice 4", "Invoice 5"]
      );
    })
  );

  it.effect("retries a dropped session once on a fresh one, and fails when that drops too", () =>
    Effect.gen(function* () {
      let drops = 1;
      const { call, logins } = yield* setup("dropped", {
        before: (line) => (/^\S+ UID SEARCH/.test(line) && drops-- > 0 ? "drop" : undefined)
      });
      const before = logins();
      assert.lengthOf(messages(yield* call("listMessages", { folder: "INBOX" })), 5);
      assert.strictEqual(logins() - before, 2);
      drops = 2;
      const lost = yield* Effect.flip(call("listMessages", { folder: "INBOX" }));
      assert.strictEqual(lost._tag, "ImapSessionLost");
      assert.strictEqual(lost.code, "source_unavailable");
    })
  );

  it.effect("pauses the connection on a refused login, after which calls send nothing", () =>
    Effect.gen(function* () {
      const { served, store, call, connection, mailbox, logins } = yield* setup("paused");
      mailbox.reply = "NO [AUTHENTICATIONFAILED] Authentication failed.";
      const refused = yield* Effect.flip(call("listFolders", {}));
      assert.strictEqual(refused._tag, "ImapLoginRefused");
      assert.strictEqual(refused.code, "auth_failed");
      const paused = yield* store.get(who.companyId, connection.id);
      assert.isTrue(paused.integration === "imap" && paused.display.paused?.during === "call");
      const dials = served.dials.length;
      const attempts = logins();
      const again = yield* Effect.flip(call("listFolders", {}));
      assert.strictEqual(again._tag, "ImapConnectionPaused");
      assert.strictEqual(again.code, "auth_failed");
      assert.strictEqual(served.dials.length, dials);
      assert.strictEqual(logins(), attempts);
    })
  );

  it.effect("sends nothing when the caller is refused once the call holds its gates", () =>
    Effect.gen(function* () {
      const { served, call } = yield* setup("recheck");
      const dials = served.dials.length;
      const refused = yield* Effect.flip(
        call("listFolders", {}, { recheck: Effect.fail(new Runtime.AccessDenied({})) })
      );
      assert.strictEqual(refused._tag, "AccessDenied");
      assert.strictEqual(served.dials.length, dials);
    })
  );

  it.effect("destroys a session past its call's byte budget", () =>
    Effect.gen(function* () {
      const folder = inbox(3);
      folder.messages[0] = { ...folder.messages[0]!, text: "x".repeat(64_000) };
      const { call, connection, logins } = yield* setup("bytes", {
        mailboxes: [folder],
        limits: { "imap.call.bytes": 20_000 }
      });
      const ref = { connection: connection.id, folder: "INBOX", uidValidity: 7, uid: 1 };
      const before = logins();
      const over = yield* Effect.flip(call("getMessages", { refs: [ref] }));
      assert.strictEqual(over._tag, "ImapOverflow");
      assert.strictEqual(over.code, "too_large");
      // The next call can't have the broken session: it logs in again.
      yield* call("folderStatus", { folder: "INBOX" });
      assert.strictEqual(logins() - before, 2);
    })
  );

  it.effect("destroys a session a literal past the parser's bound broke", () =>
    Effect.gen(function* () {
      const folder = inbox(3);
      folder.messages[0] = { ...folder.messages[0]!, text: "y".repeat(20_000) };
      const { call, connection, logins } = yield* setup("literal", {
        mailboxes: [folder],
        limits: { "imap.parser.literal": 4_096 }
      });
      const before = logins();
      const over = yield* Effect.flip(
        call("getMessages", {
          refs: [{ connection: connection.id, folder: "INBOX", uidValidity: 7, uid: 1 }]
        })
      );
      assert.strictEqual(over._tag, "ImapOverflow");
      assert.include(over, { limitId: "imap.parser.literal", code: "too_large" });
      yield* call("folderStatus", { folder: "INBOX" });
      assert.strictEqual(logins() - before, 2);
    })
  );

  it.effect("destroys a session whose call was interrupted mid-command", () =>
    Effect.gen(function* () {
      let release: () => void = () => {};
      let hold = true;
      const { call, logins } = yield* setup("interrupted", {
        before: (line) =>
          hold && /^\S+ UID SEARCH/.test(line)
            ? new Promise<void>((resolve) => {
                release = resolve;
              })
            : undefined
      });
      const before = logins();
      const running = yield* Effect.forkChild(call("listMessages", { folder: "INBOX" }));
      yield* TestClock.withLive(Effect.sleep("300 millis"));
      yield* Fiber.interrupt(running);
      hold = false;
      release();
      yield* call("folderStatus", { folder: "INBOX" });
      assert.strictEqual(logins() - before, 2);
    })
  );

  it.effect("logs out a session it logged in when the call is interrupted before using it", () =>
    Effect.gen(function* () {
      const { served, call, mailbox, logins } = yield* setup("abandoned");
      // Interrupted while the server holds the login: once it's answered, the session closes.
      let answer: (reply: string) => void = () => {};
      mailbox.reply = new Promise<string>((resolve) => {
        answer = resolve;
      });
      const before = logins();
      const logging = yield* Effect.forkChild(call("listFolders", {}));
      yield* until(() => logins() > before);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(logging));
      mailbox.reply = "OK Logged in";
      answer("OK Logged in");
      yield* Fiber.join(interrupting);
      yield* until(() => served.signedIn() === 0);
      // Interrupted at the recheck after a new login, before any command: it closes too.
      let rechecks = 0;
      const checking = yield* Effect.forkChild(
        call(
          "listFolders",
          {},
          { recheck: Effect.suspend(() => (++rechecks === 2 ? Effect.never : Effect.void)) }
        )
      );
      yield* until(() => rechecks === 2);
      assert.strictEqual(served.signedIn(), 1);
      yield* Fiber.interrupt(checking);
      yield* until(() => served.signedIn() === 0);
    })
  );

  it.effect("admits a mailbox's waiters in arrival order; an interrupted one holds nothing", () =>
    Effect.gen(function* () {
      let hold = true;
      const releases: Array<() => void> = [];
      const { served, call } = yield* setup("queued", {
        limits: { "imap.calls.concurrent": 1 },
        before: (line) =>
          hold && /^\S+ UID SEARCH/.test(line)
            ? new Promise<void>((resolve) => releases.push(resolve))
            : undefined
      });
      const arrive = <A, E, R>(read: Effect.Effect<A, E, R>) =>
        Effect.tap(Effect.forkChild(read), () => TestClock.withLive(Effect.sleep("200 millis")));
      const first = yield* arrive(call("listMessages", { folder: "INBOX" }));
      const gaveUp = yield* arrive(call("folderStatus", { folder: "INBOX" }));
      const second = yield* arrive(call("listFolders", {}));
      const third = yield* arrive(call("folderStatus", { folder: "INBOX" }));
      yield* Fiber.interrupt(gaveUp);
      const sent = served.lines.length;
      hold = false;
      for (const release of releases) release();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Fiber.join(third);
      const after = served.lines.slice(sent);
      const listed = after.findIndex((line) => line.startsWith("LIST"));
      assert.isAtLeast(listed, 0);
      assert.isAbove(
        after.findIndex((line) => line.startsWith("EXAMINE")),
        listed
      );
    })
  );

  it.effect("refuses busy with nothing sent while the mailbox's calls are full", () =>
    Effect.gen(function* () {
      const releases: Array<() => void> = [];
      const { served, call } = yield* setup("busy", {
        before: (line) =>
          /^\S+ UID SEARCH/.test(line)
            ? new Promise<void>((resolve) => releases.push(resolve))
            : undefined
      });
      const first = yield* Effect.forkChild(call("listMessages", { folder: "INBOX" }));
      const second = yield* Effect.forkChild(call("listMessages", { folder: "INBOX" }));
      yield* TestClock.withLive(Effect.sleep("500 millis"));
      const dials = served.dials.length;
      const waiting = yield* Effect.forkChild(
        Effect.flip(call("listFolders", {}, { deadline: (yield* Clock.currentTimeMillis) + 1_500 }))
      );
      yield* TestClock.withLive(Effect.sleep("100 millis"));
      yield* TestClock.adjust("1 second");
      const busy = yield* Fiber.join(waiting);
      assert.strictEqual(busy._tag, "ImapBusy");
      assert.strictEqual(busy.code, "busy");
      assert.strictEqual(served.dials.length, dials);
      for (const release of releases) release();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    })
  );
});
