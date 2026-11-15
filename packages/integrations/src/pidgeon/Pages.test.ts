import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { switcherRelay } from "@patchy/core";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as PidgeonTest from "../test/pidgeon.js";
import {
  addMember,
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
 * The Pidgeon pages offline, over the scripted double: what renders, what Find inboxes answers,
 * a connect through them, and what they refuse. Connecting against Pidgeon's test mode is in the
 * live tier (`packages/integrations/live`).
 */

const pidgeon = PidgeonTest.double();
const desk = pidgeon.inbox("desk@acme.example", { displayName: "Acme Desk" });
pidgeon.inbox("hooks@acme.example", { kind: "events" });

it.layer(services(pidgeon.layer))("Pidgeon connection pages", (it) => {
  it.effect(
    "connects in the shared frame: the key first, the rest locked until it's checked, with its script outside",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("pidgeon-page");
        const page = yield* read(connectPath, owner.user);
        assert.strictEqual(page.status, 200);
        const { html } = page;
        for (const part of [
          '<h1 class="title">Connect Pidgeon email</h1>',
          'data-pidgeon-connect data-addresses="/settings/integrations/connect/pidgeon/addresses"',
          `<span class="flow-number">1</span>${Page.copy.getIt.title}`,
          Page.copy.getIt.step,
          `<span class="flow-number">2</span>${Page.copy.key.title}`,
          'type="password" id="pidgeon-key"',
          Page.copy.key.hint,
          `data-pidgeon-find-wrap hidden><button class="btn" type="button" data-pidgeon-find="">${Page.copy.key.find}</button>`,
          `<span class="flow-number">3</span>${Page.copy.inboxes.title}`,
          Page.copy.inboxes.intro,
          `<span class="flow-number">4</span>${Page.copy.access.title}`,
          '<span class="flow-number">5</span>Name it',
          "Once connected",
          Page.copy.once.cannot,
          Page.copy.once.caveat,
          '<button class="btn btn-primary" type="submit" data-pending="Testing…"><span>Test and connect</span></button>',
          '<script defer src="/assets/pidgeon-connect.js"></script>',
          "<noscript>"
        ])
          assert.include(html, part);
        // Patchy makes nothing in Pidgeon now: no new-address form, domains or send policy.
        for (const gone of ["local_part", "send_policy", "pidgeon-domain", 'name="attempt"'])
          assert.notInclude(html, gone);
        // One frame: no side panel of its own, and nothing marked done.
        for (const gone of ['class="side-panel"', "card-split", "step-done"])
          assert.notInclude(html.slice(html.indexOf("<body>")), gone);
        // The inbox, Patches may and Name it wait for the key; the key's own part doesn't.
        assert.strictEqual(html.match(/<fieldset class="flow-section" disabled>/g)?.length, 3);
        assert.include(
          html,
          '<fieldset class="fieldset" disabled data-ready-gate><button class="btn btn-primary" type="submit" data-pending="Testing…"><span>Test and connect</span></button></fieldset>'
        );
        assert.notMatch(html.replace(switcherRelay, ""), /<script(?![^>]*\bsrc=)/);
        assert.include(page.response.headers.get("content-security-policy")!, "script-src 'self'");
        const script = yield* send(Page.connectScriptPath, {
          headers: { cookie: cookie(owner.user) }
        });
        assert.strictEqual(script.status, 200);
        assert.include(script.headers.get("content-type")!, "text/javascript");
        assert.strictEqual(script.headers.get("x-content-type-options"), "nosniff");
      })
  );

  it.effect("finds the inboxes a key reaches without writing the key back, then connects one", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("pidgeon-find");
      const token = pidgeon.key("admin");
      const found = yield* send(Page.addressesPath, post(owner.user, { key: token }));
      assert.strictEqual(found.status, 200);
      const fragment = yield* Effect.promise(() => found.text());
      for (const part of [
        "data-pidgeon-key-status",
        Page.copy.status({ test: true, level: "admin", count: 2 }),
        "desk@acme.example",
        "Acme Desk",
        "hooks@acme.example",
        Page.copy.inboxes.eventsOnly
      ])
        assert.include(fragment, part);
      assert.notInclude(fragment, token);
      const connected = yield* follow(
        yield* send(
          connectPath,
          post(owner.user, {
            key: token,
            address: desk,
            access: "send",
            handle: "desk",
            description: "Help desk mail"
          })
        ),
        owner.user
      );
      assert.include(connected.html, Page.copy.results.connect("desk@acme.example"));
      assert.include(connected.html, "<dt>Inbox</dt><dd>desk@acme.example</dd>");
      assert.notInclude(connected.html, token);
    })
  );

  it.effect("refuses what can't be a key, and keeps everything else a refusal typed", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("pidgeon-refused");
      for (const [key, words] of [
        ["", Page.copy.key.missing],
        ["not a key", "Paste a Pidgeon API key: it starts with pgn_."]
      ] as const) {
        const refused = yield* send(Page.addressesPath, post(owner.user, { key }));
        assert.strictEqual(refused.status, 422);
        const fragment = yield* Effect.promise(() => refused.text());
        assert.include(fragment, "data-pidgeon-key-error");
        assert.include(fragment, words);
      }
      const requests = pidgeon.requests.length;
      const typed = pidgeon.key("read");
      const response = yield* send(
        connectPath,
        post(owner.user, {
          key: typed,
          access: "send",
          handle: "desk",
          description: "Help desk mail",
          address: desk
        })
      );
      assert.strictEqual(response.status, 422);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, Page.copy.refusalTitles.pidgeon_key_cant_send);
      assert.include(html, 'value="desk"');
      assert.include(html, 'value="Help desk mail"');
      assert.include(html, `data-kept-address="${desk}"`);
      assert.notInclude(html, typed);
      // Pidgeon was only asked what the key may do.
      assert.isTrue(
        pidgeon.requests
          .slice(requests)
          .every((sent) => sent.method === "GET" || sent.path.includes("00000000"))
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
      const found = yield* send(Page.addressesPath, post(member, { key }));
      assert.strictEqual(found.status, 403);
      assert.include(
        yield* Effect.promise(() => found.text()),
        "Only an admin can manage company connections."
      );
      for (const response of [
        yield* send(
          connectPath,
          post(member, { key, address: desk, access: "read", handle: "member" })
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
      const forged = yield* send(Page.addressesPath, {
        method: "POST",
        headers: { cookie: cookie(owner.user), origin: "https://elsewhere.example" },
        body: new URLSearchParams({ key })
      });
      assert.strictEqual(forged.status, 403);
      assert.strictEqual(pidgeon.requests.length, requests);
    })
  );
});
