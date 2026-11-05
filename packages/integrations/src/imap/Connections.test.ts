import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { NodeCryptography } from "@patchy/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as AttioSource from "../attio/Source.js";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as ImapTest from "../test/imap.js";
import * as Source from "./Source.js";

/**
 * IMAP connections in the store, offline over a scripted mail server: connect, Test, Replace
 * password, Refresh folders and Reconnect, and the login pause every process honours.
 */

const host = "mail.example.test";
const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const as = (id: string) => ({ ...who, id });
class Certs extends Context.Service<Certs, ImapTest.Certificates>()("test/imap/StoreCerts") {}
const fixture = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 9).toString("base64")}`)),
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

const login = (password: string) =>
  Source.credentials({
    host,
    port: 993,
    security: "tls",
    username: "invoices@example.test",
    password
  });
/** A scripted mailbox whose answer to a login a test can change, and two stores over one database. */
const setup = (handle: string) =>
  Effect.gen(function* () {
    const certs = yield* Certs;
    const mailbox = { reply: "OK Logged in" };
    const served = yield* ImapTest.serve(certs, {
      login: () => mailbox.reply,
      folders: [{ path: "INBOX" }, { path: "Invoices/2026" }]
    });
    const source = Source.layer.pipe(Layer.provide(ImapTest.network(served, certs)));
    // Two host processes: each its own store and source, sharing only the database.
    const store = yield* SqlConnectionStore.make.pipe(Effect.provide(source));
    const other = yield* SqlConnectionStore.make.pipe(Effect.provide(source));
    const connection = yield* store.connect({
      integration: "imap",
      ...who,
      handle,
      description: "Supplier invoices",
      credentials: login("the-right-password")
    });
    const logins = () => served.commands.filter((command) => command.startsWith("AUTH")).length;
    return { store, other, served, mailbox, logins, connection, id: connection.id };
  });
const imap = (connection: ConnectionStore.Connection) =>
  connection.integration === "imap" ? connection : assert.fail("not an IMAP connection");
const declaration = (connection: ConnectionStore.Connection) => ({
  kind: "imap" as const,
  handle: connection.handle,
  id: connection.id,
  revision: connection.metadataRevision
});

it.layer(fixture)("IMAP connections", (it) => {
  it.effect("connects a mailbox, keeping its folders and never its password", () =>
    Effect.gen(function* () {
      const { store, id, connection } = yield* setup("invoices");
      assert.deepStrictEqual(imap(connection).display, {
        host,
        port: 993,
        security: "tls",
        username: "invoices@example.test"
      });
      const metadata = yield* store.snapshot(who.companyId, id, 1);
      if (metadata.integration !== "imap") return assert.fail("not an IMAP snapshot");
      assert.deepStrictEqual(
        metadata.snapshot.folders.map((folder) => folder.path),
        ["INBOX", "Invoices/2026"]
      );
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ readonly credentials: string; readonly display: string }>`
        SELECT credentials, display::text FROM connections WHERE id = ${id}`;
      assert.notInclude(row!.credentials, "the-right-password");
      assert.notInclude(row!.display, "the-right-password");
      const [call] = yield* (yield* RuntimeLog.RuntimeLog).recent({
        companyId: who.companyId,
        connectionId: id
      });
      assert.deepInclude(call, { op: "imap.connect", outcome: "success", deadlineMs: 30_000 });
    })
  );

  it.effect("refuses to connect a mailbox whose Test fails, saving nothing", () =>
    Effect.gen(function* () {
      const { store, mailbox } = yield* setup("invoices-refused");
      mailbox.reply = "NO [AUTHENTICATIONFAILED] Authentication failed.";
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT id FROM connections`;
      const refused = yield* store
        .connect({
          integration: "imap",
          ...who,
          handle: "invoices-wrong",
          description: "",
          credentials: login("a-wrong-password")
        })
        .pipe(Effect.flip);
      assert.instanceOf(refused, Source.LoginRefused);
      assert.lengthOf(yield* sql`SELECT id FROM connections`, before.length);
    })
  );

  it.effect("pauses on a refused login, so no process logs in until Replace password works", () =>
    Effect.gen(function* () {
      const { store, other, mailbox, logins, id, connection } = yield* setup("invoices-paused");
      mailbox.reply = "NO [AUTHENTICATIONFAILED] Authentication failed.";
      const tested = yield* store.test(as(id)).pipe(Effect.flip);
      assert.instanceOf(tested, Source.LoginRefused);
      const paused = imap(yield* other.get(who.companyId, id)).display.paused;
      assert.deepInclude(paused, { reply: "AUTHENTICATIONFAILED", during: "test", by: who.userId });
      const sent = logins();
      // Another process neither hands out the password nor logs in with it.
      const pooled = yield* other
        .poolCredentials(who.companyId, declaration(connection), connection.credentialRevision)
        .pipe(Effect.flip);
      assert.instanceOf(pooled, Source.ConnectionPaused);
      assert.strictEqual(pooled.code, "auth_failed");
      assert.instanceOf(yield* other.refresh(as(id)).pipe(Effect.flip), Source.ConnectionPaused);
      assert.strictEqual(logins(), sent);
      // A new password that works unpauses it, as a new credential revision.
      mailbox.reply = "OK Logged in";
      const replaced = imap(
        yield* other.rotate({ ...as(id), credentials: login("the-new-password") })
      );
      assert.isUndefined(replaced.display.paused);
      assert.strictEqual(replaced.credentialRevision, connection.credentialRevision + 1);
      assert.strictEqual(replaced.metadataRevision, connection.metadataRevision);
      const secret = yield* store.poolCredentials(
        who.companyId,
        declaration(connection),
        replaced.credentialRevision
      );
      assert.strictEqual((yield* Source.parseCredentials(secret)).password, "the-new-password");
    })
  );

  it.effect("unpauses when an admin's Test logs in again", () =>
    Effect.gen(function* () {
      const { store, mailbox, id } = yield* setup("invoices-retest");
      mailbox.reply = "NO Login failed.";
      assert.instanceOf(yield* store.test(as(id)).pipe(Effect.flip), Source.LoginRefused);
      assert.deepInclude(imap(yield* store.get(who.companyId, id)).display.paused, {
        reply: null
      });
      mailbox.reply = "OK Logged in";
      assert.isUndefined(imap(yield* store.test(as(id))).display.paused);
    })
  );

  it.effect("never pauses on UNAVAILABLE, a referral, BAD or a throttle", () =>
    Effect.gen(function* () {
      const { store, mailbox, id } = yield* setup("invoices-transient");
      for (const reply of [
        "NO [UNAVAILABLE] Try again later.",
        "NO [REFERRAL imap://invoices@other.example.test/] Go elsewhere.",
        "BAD Malformed.",
        "BAD Request is throttled. Suggested Backoff Time: 20 milliseconds"
      ]) {
        mailbox.reply = reply;
        yield* store.test(as(id)).pipe(Effect.flip);
        assert.isUndefined(imap(yield* store.get(who.companyId, id)).display.paused, reply);
      }
    })
  );

  it.effect("records a call's refused login once, and never over a newer password", () =>
    Effect.gen(function* () {
      const { store, id, connection } = yield* setup("invoices-call");
      const stale = { companyId: who.companyId, id, reply: null } as const;
      yield* store.pauseLogin({ ...stale, credentialRevision: connection.credentialRevision - 1 });
      assert.isUndefined(imap(yield* store.get(who.companyId, id)).display.paused);
      yield* store.pauseLogin({
        ...stale,
        credentialRevision: connection.credentialRevision,
        reply: "EXPIRED"
      });
      yield* store.pauseLogin({ ...stale, credentialRevision: connection.credentialRevision });
      const paused = imap(yield* store.get(who.companyId, id)).display.paused;
      assert.deepInclude(paused, { during: "call", reply: "EXPIRED" });
      assert.notProperty(paused, "by");
    })
  );

  it.effect("refreshes folders as a new revision, and reconnects on a fresh login", () =>
    Effect.gen(function* () {
      const { store, logins, id } = yield* setup("invoices-lifecycle");
      assert.strictEqual((yield* store.refresh(as(id))).metadataRevision, 2);
      yield* store.disconnect(as(id));
      const before = logins();
      const reconnected = yield* store.reconnect(as(id));
      assert.strictEqual(reconnected.status, "connected");
      assert.strictEqual(logins(), before + 1);
      // Another mailbox is another connection.
      const moved = yield* store
        .retarget({ ...as(id), credentials: login("the-right-password") })
        .pipe(Effect.flip);
      assert.instanceOf(moved, ConnectionStore.ConnectionRetargetUnavailable);
      const deleted = yield* store.delete(as(id));
      assert.strictEqual(deleted.connection.id, id);
    })
  );

  it.effect("stays hidden from the release before IMAP", () =>
    Effect.gen(function* () {
      const { id, connection } = yield* setup("invoices-hidden");
      // That release's queries: the same store, knowing only the integrations it shipped.
      const before = yield* SqlConnectionStore.knowing([
        "postgres",
        "posthog",
        "pidgeon",
        "attio"
      ]).pipe(Effect.provide(ImapTest.offline));
      assert.notInclude(
        (yield* before.list(who.companyId)).map((item) => item.id),
        id
      );
      const refusals = yield* Effect.all([
        Effect.flip(before.get(who.companyId, id)),
        Effect.flip(before.resolve(who.companyId, declaration(connection))),
        Effect.flip(
          before.poolCredentials(
            who.companyId,
            declaration(connection),
            connection.credentialRevision
          )
        )
      ]);
      assert.deepStrictEqual(
        refusals.map((error) => error._tag),
        ["ConnectionNotFound", "ConnectionNotConnected", "ConnectionNotConnected"]
      );
    })
  );
});
