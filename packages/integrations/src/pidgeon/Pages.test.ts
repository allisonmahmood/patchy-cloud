import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { escapeAttribute, switcherRelay } from "@patchy/core";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as PidgeonTest from "../test/pidgeon.js";
import {
  addMember,
  connectedId,
  connectPath,
  cookie,
  createCompany,
  events,
  follow,
  post,
  read,
  send,
  services
} from "../test/pages.js";
import * as Page from "./Page.js";

/**
 * The Pidgeon pages offline, over the scripted double: the connect page in the shared frame, one
 * submit with each refusal under its field, Replace key and Change access as the other
 * integrations draw them, and what they refuse. Connecting against Pidgeon's test mode is in the
 * live tier (`packages/integrations/live`).
 */

const pidgeon = PidgeonTest.double();
pidgeon.inbox("desk@acme.example", { displayName: "Acme Desk" });
pidgeon.inbox("hooks@acme.example", { kind: "events" });

const fields = (handle: string, over: Record<string, string> = {}) => ({
  key: pidgeon.key("send"),
  address: "desk@acme.example",
  access: "send",
  handle,
  description: "Help desk mail",
  ...over
});
/** Requests that could change something in Pidgeon, leaving out the level check. */
const changes = (from: number) =>
  pidgeon.requests
    .slice(from)
    .filter((sent) => sent.method !== "GET" && !sent.path.includes("00000000"));

it.layer(services(pidgeon.layer))("Pidgeon connection pages", (it) => {
  it.effect("asks for the key, the inbox and what patches may do, in the shared frame", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("pidgeon-page");
      const page = yield* read(connectPath, owner.user);
      assert.strictEqual(page.status, 200);
      const at = (part: string) => {
        const index = page.html.indexOf(part);
        assert.isAbove(index, -1, part);
        return index;
      };
      const order = [
        '<h1 class="title">Connect Pidgeon email</h1>',
        `<span class="flow-number">1</span>${Page.copy.getIt.title}`,
        Page.copy.getIt.step,
        Page.copy.getIt.note,
        `<span class="flow-number">2</span>${Page.copy.paste}`,
        // Each field's label, then its hint, then the control.
        Page.copy.key.hint,
        'type="password" id="connection-key"',
        Page.copy.inbox.hint,
        'id="connection-address"',
        `placeholder="${Page.copy.inbox.placeholder}"`,
        Page.copy.access.hint,
        '<select class="field field-w-sm" id="connection-access"',
        '<option value="read" selected>Read</option><option value="send">Read and send</option>',
        '<span class="flow-number">3</span>Name it',
        `data-fallback="${Page.copy.name.example}"`,
        `placeholder="${escapeAttribute(Page.copy.name.describe)}"`,
        "Once connected",
        `Every member reads ${Page.copy.once.reads} through patches that use it`,
        "Builders' agents read it while they build",
        "Guests of those patches too, unless you block guests",
        Page.copy.once.also,
        ...Page.copy.once.cannot,
        Page.copy.once.caveat,
        '<button class="btn btn-primary" type="submit" data-pending="Testing…"><span>Test and connect</span></button>'
      ].map(at);
      assert.deepStrictEqual(
        order,
        [...order].sort((a, b) => a - b)
      );
      // The address is typed exactly: a phone neither capitalises nor corrects it.
      assert.match(page.html, /id="connection-address"[^>]*autocapitalize="none"/);
      const body = page.html.slice(page.html.indexOf("<body>"));
      // One frame, one submit: nothing locked, no script of its own, nothing marked done.
      for (const gone of [
        "disabled>",
        "<noscript>",
        "pidgeon-connect",
        'name="attempt"',
        "step-done"
      ])
        assert.notInclude(body, gone);
      assert.notMatch(page.html.replace(switcherRelay, ""), /<script(?![^>]*\bsrc=)/);
    })
  );

  it.effect(
    "connects in one submit, finding the inbox by its address however it's typed, never writing the key back",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("pidgeon-connect");
        const requests = pidgeon.requests.length;
        const typed = fields("desk", { address: "  Desk@ACME.example " });
        const connected = yield* follow(
          yield* send(connectPath, post(owner.user, typed)),
          owner.user
        );
        assert.include(connected.html, Page.copy.results.connect("desk@acme.example"));
        assert.include(connected.html, "<dt>Inbox</dt><dd>desk@acme.example</dd>");
        assert.include(connected.html, "<dt>Patches may</dt><dd>Read and send</dd>");
        assert.notInclude(connected.html, typed.key);
        // Pidgeon was only read, and asked whether the key may send.
        assert.deepStrictEqual(changes(requests), []);
      })
  );

  it.effect(
    "refuses each part under its own field, in order, keeping all but the key and saving nothing",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("pidgeon-refused");
        const refusal = (over: Record<string, string>) =>
          Effect.gen(function* () {
            const submitted = fields("desk", over);
            const response = yield* send(connectPath, post(owner.user, submitted));
            assert.strictEqual(response.status, 422);
            const html = yield* Effect.promise(() => response.text());
            assert.include(html, 'value="desk"');
            assert.include(html, 'value="Help desk mail"');
            assert.notInclude(html, submitted.key);
            return html;
          });
        const under = (html: string, field: string, words: string) => {
          assert.match(
            html,
            new RegExp(`<p class="field-error" id="connection-${field}-error">[^<]*${words}`)
          );
          assert.strictEqual(html.match(/<p class="field-error"/g)?.length, 1);
          // Nothing above Test and connect: the field is where the fix is, and it alone takes focus.
          assert.notMatch(html, /autofocus><div class="notice/);
          assert.strictEqual(html.match(/autofocus/g)?.length, 1);
        };
        const requests = pidgeon.requests.length;
        under(yield* refusal({ key: "not a key" }), "key", "Paste a Pidgeon API key");
        // A key of the wrong shape never reaches Pidgeon.
        assert.strictEqual(pidgeon.requests.length, requests);
        under(
          yield* refusal({ key: `pgn_test_${"r".repeat(32)}` }),
          "key",
          "Pidgeon didn't accept this key"
        );
        // An address no inbox has, and one that only receives events, sit under Inbox; the
        // refusal names none of the account's other inboxes.
        const missing = yield* refusal({ address: "sales@acme.example" });
        under(missing, "address", "No inbox this key reaches has that address");
        assert.include(missing, 'value="sales@acme.example"');
        for (const other of ["desk@acme.example", "hooks@acme.example", "Acme Desk"])
          assert.notInclude(missing, other);
        under(
          yield* refusal({ address: "hooks@acme.example" }),
          "address",
          "hooks@acme.example only receives events"
        );
        // Read and send with a Read key: under Patches may, saying how to fix it.
        const reader = yield* refusal({ key: pidgeon.key("read") });
        under(reader, "access", Page.copy.refusalTitles.pidgeon_key_cant_send);
        assert.include(reader, "Make a Send key in Pidgeon and paste it, or choose Read.");
        assert.include(reader, '<option value="send" selected>Read and send</option>');
        // A native select takes no focus of its own, so the refused one sits in what does.
        assert.include(
          reader,
          '<div tabindex="-1" autofocus><div class="fieldset"><label class="field-label" for="connection-access">'
        );
        assert.deepStrictEqual(changes(requests), []);
        assert.isUndefined(yield* connectedId(owner.company.id, "desk"));
      })
  );

  it.effect(
    "replaces the key and changes access as the other integrations do, each refusal under its field",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("pidgeon-change");
        yield* send(connectPath, post(owner.user, fields("desk")));
        const { id } = yield* connectedId(owner.company.id, "desk");
        const rotate = yield* read(`/settings/integrations/${id}/rotate`, owner.user);
        for (const part of [
          "Replace the key for pidgeon/desk",
          Page.copy.rotate.consequence("desk@acme.example"),
          'type="password" id="connection-key"',
          Page.copy.key.hint
        ])
          assert.include(rotate.html, part);
        assert.notInclude(rotate.html, 'id="connection-address"');
        const replaced = yield* send(
          `/settings/integrations/${id}/rotate`,
          post(owner.user, { key: pidgeon.key("read") })
        );
        assert.strictEqual(replaced.status, 422);
        const refusedKey = yield* Effect.promise(() => replaced.text());
        assert.match(
          refusedKey,
          /<p class="field-error" id="connection-key-error">[^<]*change access to Read first/
        );
        const access = yield* read(`/settings/integrations/${id}/access`, owner.user);
        assert.include(access.html, '<select class="field field-w-sm" id="connection-access"');
        assert.include(access.html, '<option value="send" selected>Read and send</option>');
        // Lowered, then raised with a stored key that only reads: under Patches may.
        yield* send(`/settings/integrations/${id}/access`, post(owner.user, { access: "read" }));
        yield* send(
          `/settings/integrations/${id}/rotate`,
          post(owner.user, { key: pidgeon.key("read") })
        );
        const raised = yield* send(
          `/settings/integrations/${id}/access`,
          post(owner.user, { access: "send" })
        );
        assert.strictEqual(raised.status, 409);
        assert.match(
          yield* Effect.promise(() => raised.text()),
          /<p class="field-error" id="connection-access-error">[^<]*Read and send needs a Send key/
        );
      })
  );

  it.effect("labels a test connection wherever it's shown, and counts today's emails", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("pidgeon-label");
      yield* PidgeonTest.seed({
        id: "conn_page_test",
        companyId: owner.company.id,
        userId: owner.user.id,
        handle: "support",
        test: true
      });
      const index = yield* read("/settings/integrations", owner.user);
      assert.match(
        index.html,
        new RegExp(`pidgeon/support</a><span class="row-desc">[^<]* · ${Page.copy.tag}</span>`)
      );
      const page = yield* read("/settings/integrations/conn_page_test", owner.user);
      for (const part of [
        '<h1 class="title">pidgeon/support</h1>',
        Page.copy.tag,
        "<dt>Inbox</dt><dd>support@acme.example</dd>",
        "<dt>Patches may</dt><dd>Read and send</dd>",
        `<dt>Key</dt><dd>${Page.copy.facts.keyValue(true)}</dd>`,
        "2 labels.",
        '<span class="row-name">Billing</span>',
        `<p class="notice-title">${Page.copy.testKey.title}</p>`,
        ">Change access…</a>",
        ">Replace key…</a>"
      ])
        assert.include(page.html, part);
      for (const gone of ["Writes to", "Address key", "made 20"])
        assert.notInclude(page.html, gone);
      assert.include(page.html, "<dt>Sends today</dt><dd>0 of 200 · resets at 00:00 UTC</dd>");
      const sql = yield* SqlClient.SqlClient;
      const today = DateTime.formatIsoDateUtc(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      yield* sql`INSERT INTO pidgeon_sends (connection_id, day, sends)
        VALUES ('conn_page_test', ${today}::date, 2)`;
      assert.include(
        (yield* read("/settings/integrations/conn_page_test", owner.user)).html,
        "<dt>Sends today</dt><dd>2 of 200 · resets at 00:00 UTC</dd>"
      );
      // A connection that only reads, and sent nothing today, has no such line.
      yield* PidgeonTest.seed({
        id: "conn_page_read",
        companyId: owner.company.id,
        userId: owner.user.id,
        handle: "invoices",
        access: "read"
      });
      assert.notInclude(
        (yield* read("/settings/integrations/conn_page_read", owner.user)).html,
        "Sends today"
      );
      // A live connection carries no label and needs nothing.
      yield* PidgeonTest.seed({
        id: "conn_page_live",
        companyId: owner.company.id,
        userId: owner.user.id,
        handle: "orders"
      });
      const live = yield* read("/settings/integrations/conn_page_live", owner.user);
      assert.include(live.html, '<h1 class="title">pidgeon/orders</h1>');
      assert.notInclude(live.html, Page.copy.tag);
      assert.notInclude(live.html, "Needs attention");
    })
  );

  it.effect(
    "deletes an unused connection, saying to revoke its key, and refuses a declared one",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("pidgeon-delete");
        events.length = 0;
        yield* PidgeonTest.seed({
          id: "conn_page_unused",
          companyId: owner.company.id,
          userId: owner.user.id,
          handle: "unused"
        });
        // An email in doubt is named in the confirmation.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO pidgeon_drafts (connection_id, draft, digest, state, draft_id, created_at)
        VALUES ('conn_page_unused', 'draft', 'digest', 'held', 'msg_held', now())`;
        const confirm = yield* read("/settings/integrations/conn_page_unused/delete", owner.user);
        assert.include(confirm.html, Page.copy.consequences.delete);
        assert.include(confirm.html, Page.copy.consequences.unsettled(1));
        const requests = pidgeon.requests.length;
        const deleted = yield* follow(
          yield* send("/settings/integrations/conn_page_unused/delete", post(owner.user)),
          owner.user
        );
        assert.include(deleted.html, Page.copy.results.delete);
        assert.deepStrictEqual(
          events.flatMap((event) =>
            event.name === "connection.deleted"
              ? [[event.properties.connectionId, event.properties.integration]]
              : []
          ),
          [["conn_page_unused", "pidgeon"]]
        );
        // Patchy can't revoke a dashboard key, so it asks Pidgeon nothing.
        assert.strictEqual(pidgeon.requests.length, requests);
        yield* PidgeonTest.seed({
          id: "conn_page_declared",
          companyId: owner.company.id,
          userId: owner.user.id,
          handle: "declared"
        });
        yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
        VALUES ('pat_page_declared', ${owner.company.id}, ${owner.user.id}, 'Desk', 'desk')`;
        yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key, content_hash,
        file_size, created_by_machine_token_id, owner_user_id, tier, release, manifest_version,
        wire_version, schema_revision, manifest, publish_key, payload_digest, publish_response,
        publish_status)
        VALUES ('ver_page_declared', 'pat_page_declared', 1, 'desk.html', 'test', 1, ${DEV_SEED.tokenId},
          ${owner.user.id}, 1, 'test', 1, 1, 0,
          ${JSON.stringify({ uses: { desk: { kind: "pidgeon", handle: "declared", id: "conn_page_declared", revision: 1 } } })}::jsonb,
          'page-declared', 'test', '{}'::jsonb, 201)`;
        const refused = yield* send(
          "/settings/integrations/conn_page_declared/delete",
          post(owner.user)
        );
        assert.strictEqual(refused.status, 409);
      })
  );

  it.effect("lets neither members nor another company manage it", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("pidgeon-guard");
      const member = yield* addMember(owner);
      yield* PidgeonTest.seed({
        id: "conn_page_guarded",
        companyId: owner.company.id,
        userId: owner.user.id,
        handle: "guarded"
      });
      const path = "/settings/integrations/conn_page_guarded";
      const key = pidgeon.key("send");
      const requests = pidgeon.requests.length;
      for (const response of [
        yield* send(
          connectPath,
          post(member, { key, address: "desk@acme.example", access: "read", handle: "member" })
        ),
        yield* send(`${path}/access`, post(member, { access: "read" })),
        yield* send(`${path}/rotate`, post(member, { key })),
        yield* send(`${path}/test`, post(member)),
        yield* send(`${path}/delete`, post(member))
      ])
        assert.strictEqual(response.status, 403);
      const view = yield* read(path, member);
      assert.include(view.html, "Only admins can change it.");
      const foreign = yield* createCompany("pidgeon-guard-foreign");
      assert.strictEqual((yield* read(path, foreign.user)).status, 404);
      assert.strictEqual((yield* send(`${path}/delete`, post(foreign.user))).status, 404);
      // A form posted from elsewhere never reaches Pidgeon either.
      const forged = yield* send(connectPath, {
        method: "POST",
        headers: { cookie: cookie(owner.user), origin: "https://elsewhere.example" },
        body: new URLSearchParams(fields("forged", { key }))
      });
      assert.strictEqual(forged.status, 403);
      assert.strictEqual(pidgeon.requests.length, requests);
    })
  );
});
