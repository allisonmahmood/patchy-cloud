import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AttioSource from "../attio/Source.js";
import * as ImapTest from "../test/imap.js";
import { createCompany, follow, post, read, send, services } from "../test/pages.js";
import * as PidgeonTest from "../test/pidgeon.js";
import * as Network from "./Network.js";
import * as Source from "./Source.js";

/**
 * The IMAP pages over scripted mail servers: the shared connect frame with IMAP's walkthrough and
 * fields, a refusal under its field without the password, and the shared connection page with
 * its folders, its own recent-calls wording, and a pause with its two ways out.
 */

const host = "mail.example.test";
/** A host reached through the company's own name, whose server presents the provider's certificate. */
const aliased = "mail.acme.test";
const mailbox = { reply: "OK Logged in" };
const imap = Layer.unwrap(
  Effect.gen(function* () {
    const honest = yield* ImapTest.certificates([host]);
    const provider = yield* ImapTest.certificates(["imap.provider.test", "*.provider.test"]);
    const served = yield* ImapTest.serve(honest, {
      login: () => mailbox.reply,
      folders: [
        "INBOX",
        "Invoices",
        "Invoices/2026",
        "Receipts",
        "Sent",
        "Statements",
        "Trash"
      ].map((path) => ({ path }))
    });
    const elsewhere = yield* ImapTest.serve(provider);
    return Source.layer.pipe(
      Layer.provide(
        Network.loopback(() => [
          { host, ports: { 993: served.tls, 143: served.plain }, ca: honest.ca },
          { host: aliased, ports: { 993: elsewhere.tls }, ca: provider.ca }
        ])
      )
    );
  })
);
const connectPath = "/company/connections/connect/imap";
const fields = (handle: string, over: Record<string, string> = {}) => ({
  handle,
  description: "Supplier invoices",
  host,
  port: "993",
  username: "invoices@example.test",
  password: "the-right-password",
  ...over
});

it.layer(services(PidgeonTest.canned().layer, AttioSource.layer, imap))(
  "IMAP connection pages",
  (it) => {
    it.effect("asks for the login in the shared walkthrough, with one port choice", () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("imap-page");
        const page = yield* read(connectPath, owner.user);
        assert.strictEqual(page.status, 200);
        const at = (part: string) => {
          const index = page.html.indexOf(part);
          assert.isAbove(index, -1, part);
          return index;
        };
        const order = [
          '<h1 class="page-heading">Connect Email (IMAP)</h1>',
          '<ol class="steps">',
          '<h2 class="step-title">Get a login for the mailbox</h2>',
          "IMAP over TLS 1.2 or later, on port 993, or 143 with STARTTLS",
          "A certificate from a public authority naming the host you type",
          "A username and password, or an app password",
          "An address reachable from the internet, with no IP allowlist",
          "Accounts that need Google or Microsoft sign-in can't connect this way.",
          '<li class="step step-current" aria-current="step">',
          '<h2 class="step-title">Fill it in</h2>',
          '<label class="field-prefix" for="connection-handle">imap/</label>',
          'id="connection-description" name="description"',
          'id="connection-host" name="host"',
          '<select class="field" id="connection-port" name="port"',
          '<option value="993" selected>993 (TLS)</option><option value="143">143 (STARTTLS)</option>',
          'id="connection-username" name="username"',
          'id="connection-password" type="password" name="password"',
          '<strong class="note-title">Company-wide access</strong>',
          "so do its guests unless you block guests on the connection's page",
          '<button class="btn btn-primary" type="submit">Test and connect</button>',
          '<h2 class="step-title">Use it in a patch</h2>',
          "such as imap/invoices"
        ].map(at);
        assert.deepStrictEqual(
          order,
          [...order].sort((a, b) => a - b)
        );
        for (const gone of [
          'name="security"',
          "Block guests",
          "after a disconnect",
          "refreshes on its own",
          "<script>"
        ])
          assert.notInclude(page.html, gone);
        const catalogue = yield* read("/company/connections/connect", owner.user);
        assert.include(catalogue.html, `href="${connectPath}"`);
      })
    );

    it.effect(
      "refuses a certificate for another name under Server, naming the names it carries",
      () =>
        Effect.gen(function* () {
          const owner = yield* createCompany("imap-certificate");
          const response = yield* send(
            connectPath,
            post(owner.user, fields("invoices", { host: aliased }))
          );
          assert.strictEqual(response.status, 422);
          const html = yield* Effect.promise(() => response.text());
          assert.include(html, 'id="connection-host-error" role="alert"');
          assert.include(html, "The certificate names another server");
          assert.include(html, "It names imap.provider.test, *.provider.test.");
          assert.include(html, `value="${aliased}"`);
          assert.include(html, 'value="invoices@example.test"');
          assert.notInclude(html, "the-right-password");
        })
    );

    it.effect("shows a security that disagrees with the port under Port, where the choice is", () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("imap-security");
        const response = yield* send(
          connectPath,
          post(owner.user, fields("invoices", { port: "993", security: "starttls" }))
        );
        assert.strictEqual(response.status, 422);
        const html = yield* Effect.promise(() => response.text());
        assert.include(html, 'id="connection-port-error" role="alert"');
        assert.include(html, "The security follows the port: 993 opens TLS");
        assert.include(html, `value="${host}"`);
        assert.notInclude(html, "the-right-password");
      })
    );

    it.effect("refuses a login the server refused under the password, keeping all but it", () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("imap-refused");
        mailbox.reply = "NO [AUTHENTICATIONFAILED] Authentication failed.";
        const response = yield* send(
          connectPath,
          post(owner.user, fields("invoices", { password: "a-wrong-password" }))
        );
        mailbox.reply = "OK Logged in";
        assert.strictEqual(response.status, 422);
        const html = yield* Effect.promise(() => response.text());
        assert.include(html, 'id="connection-password-error" role="alert"');
        assert.include(html, "The mail server refused the login");
        assert.include(html, `value="${host}"`);
        assert.notInclude(html, "a-wrong-password");
      })
    );

    it.effect(
      "shows the connected mailbox on the shared page, its folders and its own calls wording",
      () =>
        Effect.gen(function* () {
          const owner = yield* createCompany("imap-connected");
          // The one choice picks the port and its security: 143 starts TLS.
          const connected = yield* send(
            connectPath,
            post(owner.user, fields("invoices", { port: "143" }))
          );
          const page = yield* follow(connected, owner.user);
          for (const part of [
            "Mailbox connected and its folders listed.",
            `<dt>Server</dt><dd>${host}, port 143 (STARTTLS)</dd>`,
            "<dt>Username</dt><dd>invoices@example.test</dd>",
            "<dt>Added by</dt>",
            "7 folders. Found",
            "<code>INBOX</code>",
            "<code>Receipts</code>",
            "And 2 more.",
            "subjects, bodies, addresses and search values are never logged"
          ])
            assert.include(page.html, part);
          assert.notInclude(page.html, "Query text keeps its first 8 KiB");
          assert.notInclude(page.html, '<span class="tag">');
        })
    );

    it.effect(
      "pauses with a notice, a tag and Needs attention, until Test again or a new password",
      () =>
        Effect.gen(function* () {
          const owner = yield* createCompany("imap-paused");
          const connected = yield* send(connectPath, post(owner.user, fields("invoices")));
          const path = connected.headers.get("location")!.split("?")[0]!;
          mailbox.reply = "NO Login failed.";
          const tested = yield* send(`${path}/test`, post(owner.user));
          mailbox.reply = "OK Logged in";
          const html = yield* Effect.promise(() => tested.text());
          assert.include(
            html,
            '<h1 class="page-heading">imap/invoices<span class="tag">Paused</span></h1>'
          );
          assert.include(
            html,
            '<div class="note note-refused" role="alert"><strong class="note-title">Paused: the mail server refused the password</strong>'
          );
          assert.include(html, "calls stop until Test or Replace password succeeds");
          assert.include(
            html,
            `<a class="btn btn-primary" href="${path}/rotate">Replace password…</a>`
          );
          assert.include(
            html,
            `<form method="post" action="${path}/test"><button class="btn" type="submit">Test again</button></form>`
          );
          const index = yield* read("/company/connections", owner.user);
          assert.include(index.html, "1 connection needs attention");
          assert.include(
            index.html,
            "imap/invoices</a> is paused because its mail server refused the password"
          );
          const attention = yield* read("/company/connections?view=attention", owner.user);
          assert.include(attention.html, `href="${path}"`);
          // Replace password is the shared page, and a new password that works resumes it.
          const replace = yield* read(`${path}/rotate`, owner.user);
          for (const part of [
            "Replace the password for imap/invoices",
            `Patchy logs in to ${host} as invoices@example.test with the new password before saving it.`,
            'id="connection-password" type="password" name="password"',
            "Test and replace password"
          ])
            assert.include(replace.html, part);
          const replaced = yield* send(
            `${path}/rotate`,
            post(owner.user, { password: "a-new-password" })
          );
          const after = yield* follow(replaced, owner.user);
          assert.include(after.html, "Password replaced and tested.");
          assert.notInclude(after.html, "Paused: the mail server refused the password");
        })
    );
  }
);
