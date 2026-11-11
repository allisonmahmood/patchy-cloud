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
 * The Pidgeon pages offline: what renders and refuses without asking Pidgeon. Connecting through
 * them against Pidgeon's test mode is in the live tier (`packages/integrations/live`).
 */

const pidgeon = PidgeonTest.canned();

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
          '<input type="hidden" name="attempt"',
          '<span class="flow-number">1</span>Make an admin key',
          "Choose Admin, for every address rather than a few",
          '<span class="flow-number">2</span>Paste the admin key',
          'type="password" id="pidgeon-key"',
          'data-pidgeon-find-wrap hidden><button class="btn" type="button" data-pidgeon-find="">Find addresses</button>',
          '<span class="flow-number">3</span>Choose an address',
          '<span class="flow-number">4</span>Patches may',
          '<span class="flow-number">5</span>Name it',
          "Once connected",
          "What builders' agents send while they build goes nowhere",
          "Revoking your admin key in Pidgeon later disconnects addresses connected with it.",
          '<button class="btn btn-primary" type="submit" data-pending="Testing…"><span>Test and connect</span></button>',
          '<script defer src="/assets/pidgeon-connect.js"></script>',
          "<noscript>"
        ])
          assert.include(html, part);
        // One frame: no side panel of its own, and nothing marked done.
        for (const gone of ['class="side-panel"', "card-split", "step-done"])
          assert.notInclude(html.slice(html.indexOf("<body>")), gone);
        // Address, Patches may and Name it wait for the key; the key's own part doesn't.
        assert.strictEqual(html.match(/<fieldset class="flow-section" disabled>/g)?.length, 3);
        // Test and connect waits with them, shut without script.
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

  it.effect("refuses what can't be an admin key, and keeps everything else a refusal typed", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("pidgeon-refused");
      for (const [key, words] of [
        ["", "Paste a Pidgeon admin key"],
        ["not a key", "Paste a Pidgeon admin key: it starts with pgn_live_ or pgn_test_."]
      ] as const) {
        const refused = yield* send(Page.addressesPath, post(owner.user, { key }));
        assert.strictEqual(refused.status, 422);
        const fragment = yield* Effect.promise(() => refused.text());
        assert.include(fragment, "data-pidgeon-key-error");
        assert.include(fragment, words);
      }
      const typed = "pgn_test_typedButRefused0001";
      const response = yield* send(
        connectPath,
        post(owner.user, {
          attempt: "pageattempt1",
          key: typed,
          access: "send",
          handle: "desk",
          description: "Help desk mail",
          address: "new",
          local_part: "-desk",
          domain: "pidgeon.email",
          display_name: "Desk",
          send_policy: "open"
        })
      );
      assert.strictEqual(response.status, 422);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, "Name the new address with letters, digits");
      assert.include(html, 'value="desk"');
      assert.include(html, 'value="Help desk mail"');
      assert.include(html, 'data-kept-address="new"');
      assert.include(html, 'data-kept-local-part="-desk"');
      assert.include(html, 'data-kept-send-policy="open"');
      assert.include(html, 'value="pageattempt1"');
      // The refusal keeps its place under the address; the address is locked again until the key
      // is checked, so a summary above the actions takes focus and says how to get back.
      assert.include(html, '<p class="field-error" id="pidgeon-address-error">');
      assert.include(html, '<div tabindex="-1" autofocus data-relock>');
      assert.include(
        html,
        "Paste the admin key again and find addresses: your other choices are kept."
      );
      assert.notInclude(html, typed);
      assert.deepStrictEqual(pidgeon.requests, []);
    })
  );

  it.effect(
    "labels a test connection wherever it's shown, and names an old key it hasn't revoked",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("pidgeon-label");
        yield* PidgeonTest.seed({
          id: "conn_page_test",
          companyId: owner.company.id,
          userId: owner.user.id,
          handle: "support",
          test: true,
          retired: [{ id: "key-old", name: "Patchy support oldattempt01" }]
        });
        const tag = "Test, mail stays in Pidgeon";
        const index = yield* read("/settings/integrations", owner.user);
        assert.match(
          index.html,
          /pidgeon\/support<\/a><span class="row-desc">[^<]* · Test, mail stays in Pidgeon<\/span>/
        );
        // An old key left active is its own reason, beside a working connection.
        assert.include(index.html, '<span class="badge badge-warning">Needs attention</span>');
        const page = yield* read("/settings/integrations/conn_page_test", owner.user);
        for (const part of [
          '<h1 class="title">pidgeon/support</h1>',
          tag,
          '<span class="badge badge-warning">Needs attention</span>',
          "<dt>Address</dt><dd>support@acme.example</dd>",
          "<dt>Writes to</dt><dd>Replies only</dd>",
          "<dt>Patches may</dt><dd>Read and send</dd>",
          "2 labels.",
          '<span class="row-name">Billing</span>',
          "The old key is still active in Pidgeon",
          "named Patchy support oldattempt01",
          `<form method="post" action="/settings/integrations/conn_page_test/test"><button class="btn btn-primary btn-sm" type="submit">Test</button></form>`,
          ">Change access…</a>",
          ">Replace key…</a>"
        ])
          assert.include(page.html, part);
        assert.notInclude(page.html, "Rotate");
        // A replacement that couldn't revoke the old key says so, and the warning stays beside it.
        const replaced = yield* read(
          "/settings/integrations/conn_page_test?result=rotate",
          owner.user
        );
        assert.include(replaced.html, "couldn't revoke the old one yet");
        assert.include(replaced.html, "The old key is still active in Pidgeon");
        // Today's sends against the connection's budget, counted as Patchy counts them.
        assert.include(page.html, "<dt>Sends today</dt><dd>0 of 200 · resets at 00:00 UTC</dd>");
        const sql = yield* SqlClient.SqlClient;
        const today = DateTime.formatIsoDateUtc(
          DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
        );
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
        // A live connection carries no label.
        yield* PidgeonTest.seed({
          id: "conn_page_live",
          companyId: owner.company.id,
          userId: owner.user.id,
          handle: "orders"
        });
        const live = yield* read("/settings/integrations/conn_page_live", owner.user);
        assert.include(live.html, '<h1 class="title">pidgeon/orders</h1>');
        assert.notInclude(live.html, tag);
        assert.notInclude(live.html, "Needs attention");
        // A test address with no old key is its own reason, with the way to a live one.
        yield* PidgeonTest.seed({
          id: "conn_page_sandbox",
          companyId: owner.company.id,
          userId: owner.user.id,
          handle: "sandbox",
          test: true
        });
        const sandbox = yield* read("/settings/integrations/conn_page_sandbox", owner.user);
        assert.include(sandbox.html, '<p class="notice-title">This is a test address</p>');
        assert.include(
          sandbox.html,
          '<a class="btn btn-sm" href="/settings/integrations/connect/pidgeon">Connect a live address</a>'
        );
        assert.include(sandbox.html, "patchy add pidgeon/sandbox");
      })
  );

  it.effect("deletes an unused connection and revokes its key, and refuses a declared one", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("pidgeon-delete");
      events.length = 0;
      const unused = yield* PidgeonTest.seed({
        id: "conn_page_unused",
        companyId: owner.company.id,
        userId: owner.user.id,
        handle: "unused"
      });
      const deleted = yield* follow(
        yield* send("/settings/integrations/conn_page_unused/delete", post(owner.user)),
        owner.user
      );
      assert.include(
        deleted.html,
        "Disconnected, and its key revoked in Pidgeon. The address and its mail stay in Pidgeon."
      );
      assert.deepStrictEqual(
        events.flatMap((event) =>
          event.name === "connection.deleted"
            ? [[event.properties.connectionId, event.properties.integration]]
            : []
        ),
        [["conn_page_unused", "pidgeon"]]
      );
      assert.strictEqual(
        pidgeon.requests.filter(PidgeonTest.route("DELETE", `/api-keys/${unused.key.id}`)).length,
        1
      );
      const declared = yield* PidgeonTest.seed({
        id: "conn_page_declared",
        companyId: owner.company.id,
        userId: owner.user.id,
        handle: "declared"
      });
      const sql = yield* SqlClient.SqlClient;
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
      assert.strictEqual(
        pidgeon.requests.filter(PidgeonTest.route("DELETE", `/api-keys/${declared.key.id}`)).length,
        0
      );
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
      const admin = "pgn_test_neverSentAnywhere001";
      const requests = pidgeon.requests.length;
      const found = yield* send(Page.addressesPath, post(member, { key: admin }));
      assert.strictEqual(found.status, 403);
      assert.include(
        yield* Effect.promise(() => found.text()),
        "Only a super admin can manage company connections."
      );
      for (const response of [
        yield* send(
          connectPath,
          post(member, {
            attempt: "pageattemp20",
            key: admin,
            address: "idn",
            access: "read",
            handle: "member"
          })
        ),
        yield* send(
          `${path}/access`,
          post(member, { attempt: "pageattemp21", key: admin, access: "read" })
        ),
        yield* send(`${path}/rotate`, post(member, { attempt: "pageattemp22", key: admin })),
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
        body: new URLSearchParams({ key: admin })
      });
      assert.strictEqual(forged.status, 403);
      assert.strictEqual(pidgeon.requests.length, requests);
    })
  );
});
