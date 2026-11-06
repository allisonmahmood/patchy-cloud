import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ImapTest from "../test/imap.js";
import * as PidgeonTest from "../test/pidgeon.js";
import { createCompany, follow, post, read, send, services } from "../test/pages.js";
import * as AttioSource from "../attio/Source.js";
import * as Source from "./Source.js";

/**
 * The IMAP pages over a scripted mail server, on the plain form the design pick replaces: one
 * submit tests and connects, a refusal sits under its field without the password, and a paused
 * connection says so with its way out.
 */

const host = "mail.example.test";
const mailbox = { reply: "OK Logged in" };
const imap = Layer.unwrap(
  Effect.gen(function* () {
    const certs = yield* ImapTest.certificates([host]);
    const served = yield* ImapTest.serve(certs, { login: () => mailbox.reply });
    return Source.layer.pipe(Layer.provide(ImapTest.network(served, certs)));
  })
);
const connectPath = "/company/connections/connect/imap";
const fields = (handle: string, password = "the-right-password") => ({
  handle,
  description: "Supplier invoices",
  host,
  port: "993",
  security: "tls",
  username: "invoices@example.test",
  password
});

it.layer(services(PidgeonTest.canned().layer, AttioSource.layer, imap))(
  "IMAP connection pages",
  (it) => {
    it.effect("asks for the login with the requirements and who reads the mailbox", () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("imap-page");
        const page = yield* read(connectPath, owner.user);
        assert.strictEqual(page.status, 200);
        for (const part of [
          '<h1 class="page-heading">Connect Email (IMAP)</h1>',
          "speak IMAP4rev1 or IMAP4rev2 over TLS 1.2 or later",
          "a certificate from a public authority that names the host you type",
          '<label class="field-prefix" for="connection-handle">imap/</label>',
          'id="connection-host" name="host"',
          'id="connection-port" name="port"',
          'id="connection-security" name="security"',
          'id="connection-username" name="username"',
          'id="connection-password" type="password" name="password"',
          "so do the patch's guests unless you block guests",
          "The password itself isn't read-only."
        ])
          assert.include(page.html, part);
        const catalogue = yield* read("/company/connections/connect", owner.user);
        assert.include(catalogue.html, `href="${connectPath}"`);
      })
    );

    it.effect("refuses a login the server refused under the password, keeping all but it", () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("imap-refused");
        mailbox.reply = "NO [AUTHENTICATIONFAILED] Authentication failed.";
        const response = yield* send(
          connectPath,
          post(owner.user, fields("invoices", "a-wrong-password"))
        );
        mailbox.reply = "OK Logged in";
        assert.strictEqual(response.status, 422);
        const html = yield* Effect.promise(() => response.text());
        assert.include(html, 'id="connection-password-error" role="alert"');
        assert.include(html, "The mail server refused the login");
        assert.include(html, `value="${host}"`);
        assert.include(html, 'value="invoices@example.test"');
        assert.notInclude(html, "a-wrong-password");
      })
    );

    it.effect("shows a paused connection with Test and Replace password", () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("imap-paused");
        const connected = yield* send(connectPath, post(owner.user, fields("invoices")));
        const page = yield* follow(connected, owner.user);
        assert.include(page.html, "Mailbox connected and its folders listed.");
        assert.include(page.html, `<dt>Server</dt><dd>${host}, port 993 (TLS)</dd>`);
        const path = connected.headers.get("location")!.split("?")[0]!;
        mailbox.reply = "NO Login failed.";
        const tested = yield* send(`${path}/test`, post(owner.user));
        mailbox.reply = "OK Logged in";
        const html = yield* Effect.promise(() => tested.text());
        assert.include(html, "Paused: the mail server refused the password");
        assert.include(html, '<span class="tag">Paused · password refused</span>');
        const index = yield* read("/company/connections", owner.user);
        assert.include(index.html, "Paused · password refused");
        assert.include(html, `href="${path}/rotate"`);
        assert.include(html, "Replace password…");
        const retested = yield* send(`${path}/test`, post(owner.user));
        const after = yield* follow(retested, owner.user);
        assert.notInclude(after.html, "Paused: the mail server refused the password");
      })
    );
  }
);
