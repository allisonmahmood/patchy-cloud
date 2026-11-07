import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { NodeCryptography } from "@patchy/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { inject } from "vitest";
import * as AttioSource from "../src/attio/Source.js";
import type * as ConnectionStore from "../src/ConnectionStore.js";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as ImapNetwork from "../src/imap/Network.js";
import * as Source from "../src/imap/Source.js";
import * as PidgeonSource from "../src/pidgeon/Source.js";
import * as PostgresSource from "../src/postgres/Source.js";
import * as PostHogSource from "../src/posthog/Source.js";
import * as SqlConnectionStore from "../src/SqlConnectionStore.js";
import { UNNAMED_HOST, type LiveServer } from "./imapHarness.js";

/**
 * IMAP connections against real mail servers in Docker (`imapHarness.ts`): Dovecot, over TLS on
 * 993 and STARTTLS on 143, and GreenMail, a baseline server without SPECIAL-USE or BINARY whose
 * 143 has no STARTTLS. Each is connected, tested, refreshed and deleted through the store, as an
 * admin's connections page does it. The refusals' every case is offline (`src/imap`); this tier
 * proves real servers answer as Patchy expects. It needs no secrets: `pnpm test:imap`.
 */

const mail = inject("imap");
const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
// The harness's servers, under the hosts their certificate names; one more name maps to Dovecot
// without being on the certificate.
const network = ImapNetwork.loopback(() => [
  ...[mail.dovecot, mail.greenmail].map((server) => ({
    host: server.host,
    ports: { 993: server.tls, 143: server.plain },
    ca: mail.ca
  })),
  { host: UNNAMED_HOST, ports: { 993: mail.dovecot.tls }, ca: mail.ca }
]);
const services = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 6).toString("base64")}`)),
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
  Source.layer.pipe(Layer.provide(network))
).pipe(Layer.provideMerge(Testing.layer()), Layer.provideMerge(NodeCryptography.layer));

const login = (
  server: LiveServer,
  over: Partial<Pick<Source.Credentials, "host" | "port" | "security" | "password">> = {}
) =>
  Source.credentials({
    host: server.host,
    port: 993,
    security: "tls",
    username: server.username,
    password: server.password,
    ...over
  });
const imap = (connection: ConnectionStore.Connection) =>
  connection.integration === "imap" ? connection : assert.fail("not an IMAP connection");

/** Connect, Test, Refresh folders and Delete, as an admin would; answers the first snapshot. */
const lifecycle = (handle: string, credentials: ReturnType<typeof login>) =>
  Effect.gen(function* () {
    const store = yield* SqlConnectionStore.make;
    const connection = yield* store.connect({
      integration: "imap",
      ...who,
      handle,
      description: "Live mailbox",
      credentials
    });
    const metadata = yield* store.snapshot(who.companyId, connection.id, 1);
    const input = { ...who, id: connection.id };
    assert.isUndefined(imap(yield* store.test(input)).display.paused);
    assert.strictEqual((yield* store.refresh(input)).metadataRevision, 2);
    yield* store.delete(input);
    return metadata.integration === "imap" ? metadata.snapshot : assert.fail("not IMAP");
  });

it.layer(services, { timeout: "120 seconds", excludeTestServices: true })("IMAP, live", (it) => {
  it.effect("connects Dovecot over TLS, with its special-use and non-ASCII folders", () =>
    Effect.gen(function* () {
      const snapshot = yield* lifecycle("dovecot-tls", login(mail.dovecot));
      const folders = new Map(snapshot.folders.map((folder) => [folder.path, folder]));
      assert.deepStrictEqual(folders.get("Sent")?.specialUse, ["\\Sent"]);
      assert.deepStrictEqual(folders.get("Trash")?.specialUse, ["\\Trash"]);
      assert.isTrue(folders.has("INBOX"));
      assert.isTrue(folders.has("Projekte/Überweisungen"));
      assert.strictEqual(folders.get("Projekte/Überweisungen")?.delimiter, "/");
      assert.includeMembers([...snapshot.capabilities], ["SPECIAL-USE", "BINARY"]);
    })
  );

  it.effect("connects Dovecot over STARTTLS on 143", () =>
    Effect.gen(function* () {
      const snapshot = yield* lifecycle(
        "dovecot-starttls",
        login(mail.dovecot, { port: 143, security: "starttls" })
      );
      assert.deepInclude(snapshot, { port: 143, security: "starttls" });
    })
  );

  it.effect("connects GreenMail, a baseline server without SPECIAL-USE or BINARY", () =>
    Effect.gen(function* () {
      const snapshot = yield* lifecycle("greenmail", login(mail.greenmail));
      assert.isTrue(snapshot.folders.some((folder) => folder.path === "INBOX"));
      assert.isTrue(snapshot.folders.every((folder) => folder.specialUse.length === 0));
      assert.notInclude(snapshot.capabilities, "SPECIAL-USE");
      assert.notInclude(snapshot.capabilities, "BINARY");
    })
  );

  it.effect("names what each server misses: STARTTLS, the certificate's name, the password", () =>
    Effect.gen(function* () {
      const store = yield* SqlConnectionStore.make;
      const connect = (handle: string, credentials: ReturnType<typeof login>) =>
        store
          .connect({ integration: "imap", ...who, handle, description: "", credentials })
          .pipe(Effect.flip);
      assert.instanceOf(
        yield* connect(
          "greenmail-plain",
          login(mail.greenmail, { port: 143, security: "starttls" })
        ),
        Source.StartTlsUnavailable
      );
      const unnamed = yield* connect(
        "dovecot-unnamed",
        login(mail.dovecot, { host: UNNAMED_HOST })
      );
      assert.instanceOf(unnamed, Source.CertificateMismatch);
      assert.include(unnamed.message, mail.dovecot.host);
      for (const server of [mail.dovecot, mail.greenmail]) {
        const refused = yield* connect(
          `${server === mail.dovecot ? "dovecot" : "greenmail"}-wrong`,
          login(server, { password: "not-the-password" })
        );
        assert.instanceOf(refused, Source.LoginRefused, server.host);
      }
    })
  );

  it.effect(
    "refuses a wrong new password without pausing the stored one, then takes the right one",
    () =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        const connection = yield* store.connect({
          integration: "imap",
          ...who,
          handle: "dovecot-paused",
          description: "",
          credentials: login(mail.dovecot)
        });
        const input = { ...who, id: connection.id };
        // Only the stored password's refusal pauses a connection: a mistyped new one is refused,
        // and the connection keeps the password that works.
        assert.instanceOf(
          yield* store
            .rotate({ ...input, credentials: login(mail.dovecot, { password: "not-it" }) })
            .pipe(Effect.flip),
          Source.LoginRefused
        );
        assert.isUndefined(imap(yield* store.get(who.companyId, connection.id)).display.paused);
        const replaced = yield* store.rotate({ ...input, credentials: login(mail.dovecot) });
        assert.isUndefined(imap(replaced).display.paused);
        yield* store.delete(input);
      })
  );
});
