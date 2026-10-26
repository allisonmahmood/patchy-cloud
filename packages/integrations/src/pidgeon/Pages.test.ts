import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as ConnectionPages from "../ConnectionPages.js";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as PidgeonDouble from "../test/pidgeon.js";
import * as Page from "./Page.js";

const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const origin = new URL(base).origin;
const SENTINEL = "pgn_live_SENTINELpageAdminKey00000";
const double = PidgeonDouble.make();
double.fake.addKey({ token: SENTINEL, access: "admin", reach: "all", at: 0 });
double.fake.addKey({
  token: "pgn_live_pageSendKeyHelp00001",
  access: "send",
  reach: [double.fake.address("help@acme.example")!.id],
  at: 0
});

const events: Analytics.AnalyticsEvent[] = [];
const services = Layer.mergeAll(
  Session.layer,
  Companies.layer,
  Users.layer,
  HttpServer.layerServices,
  SqlConnectionStore.layer,
  Layer.succeed(
    Analytics.Analytics,
    Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
  )
).pipe(
  Layer.provideMerge(RuntimeLog.layer),
  Layer.provideMerge(
    Layer.succeed(
      PostgresSource.Source,
      PostgresSource.Source.of({
        test: () => Effect.die("no Postgres here"),
        inspect: () => Effect.die("no Postgres here")
      })
    )
  ),
  Layer.provideMerge(PostHogSource.layer),
  Layer.provideMerge(double.layer),
  Layer.provideMerge(
    CredentialKeys.layerFromKeys(Redacted.make("test:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="))
  ),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
);

const cookie = (user: Users.User) =>
  signedInCookies(signSession({ sub: user.clerkUserId, email: user.email, name: user.name }));
const post = (user: Users.User, fields: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { cookie: cookie(user), origin },
  body: new URLSearchParams(fields)
});
const send = Effect.fn(function* (path: string, options: RequestInit = {}) {
  const app = yield* HttpRouter.toHttpEffect(ConnectionPages.layer);
  return HttpServerResponse.toWeb(
    yield* app.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(new URL(path, base), options))
      )
    )
  );
});
const read = Effect.fn(function* (path: string, user: Users.User) {
  const response = yield* send(path, { headers: { cookie: cookie(user) } });
  return { status: response.status, html: yield* Effect.promise(() => response.text()), response };
});
const follow = Effect.fn(function* (response: Response, user: Users.User) {
  assert.strictEqual(response.status, 303);
  return yield* read(response.headers.get("location")!, user);
});
const createCompany = Effect.fn(function* (handle: string) {
  return yield* (yield* Companies.Companies).create({
    handle,
    name: handle,
    clerkUserId: `user_${handle}_admin`,
    email: `${handle}-admin@example.com`,
    userName: `${handle} Admin`
  });
});
const addMember = Effect.fn(function* (owner: {
  readonly company: Companies.Company;
  readonly user: Users.User;
}) {
  const companies = yield* Companies.Companies;
  const email = `${owner.company.handle}-member@example.com`;
  const invite = yield* companies.createInvite({
    companyId: owner.company.id,
    invitedBy: owner.user.id,
    email,
    role: "member"
  });
  return yield* companies.consumeInvite({
    inviteId: invite.id,
    clerkUserId: `user_${owner.company.handle}_member`,
    email,
    name: "Member"
  });
});
const connectPath = "/company/connections/connect/pidgeon";
/** The connect form as the page's script posts it, after Find addresses. */
const connectForm = (fields: Record<string, string>) => ({
  attempt: "pageattempt1",
  key: PidgeonDouble.ADMIN_KEY,
  access: "send",
  description: "Customer questions",
  ...fields
});
const connectedId = Effect.fn(function* (companyId: string, handle: string) {
  const connections = yield* (yield* ConnectionStore.ConnectionStore).list(companyId);
  return connections.find((item) => item.integration === "pidgeon" && item.handle === handle)!;
});

it.layer(services)("Pidgeon connection pages", (it) => {
  it.effect(
    "connects as one page: the key first, the rest dim until it's checked, with its script outside",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("pidgeon-page");
        const page = yield* read(connectPath, owner.user);
        assert.strictEqual(page.status, 200);
        const { html } = page;
        for (const part of [
          "Connect Pidgeon email",
          'data-pidgeon-connect data-addresses="/company/connections/connect/pidgeon/addresses"',
          '<input type="hidden" name="attempt"',
          'id="pidgeon-key" type="password" name="key"',
          '<span class="form-step-number" aria-hidden="true">1</span>Admin key',
          '<button class="btn btn-primary" type="submit" disabled data-pidgeon-submit>Connect</button>',
          '<aside class="side-panel"',
          "Choose <strong>Admin</strong> and <strong>Live</strong>, for every address rather than a few",
          "Your admin key is used once and never stored.",
          "revoke it only to retire it or after a leak, then replace their keys here",
          "A key just for Patchy keeps a revocation to Patchy.",
          "Builders' agents read it while they build; what they send in dev goes nowhere.",
          '<script defer src="/assets/pidgeon-connect.js"></script>',
          "<noscript>"
        ])
          assert.include(html, part);
        // Address, Patches may and Name it wait for the key; the key's own part doesn't.
        assert.strictEqual(
          html.match(/<fieldset class="form-step" id="[^"]+" disabled data-pidgeon-step>/g)?.length,
          3
        );
        assert.notMatch(html, /<script(?![^>]*\bsrc=)/);
        assert.include(page.response.headers.get("content-security-policy")!, "script-src 'self'");
        const script = yield* send(Page.connectScriptPath, {
          headers: { cookie: cookie(owner.user) }
        });
        assert.strictEqual(script.status, 200);
        assert.include(script.headers.get("content-type")!, "text/javascript");
        assert.strictEqual(script.headers.get("x-content-type-options"), "nosniff");
      })
  );

  it.effect("finds the addresses an admin key reaches, never answering with the key", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("pidgeon-find");
      const found = yield* send(Page.addressesPath, post(owner.user, { key: SENTINEL }));
      assert.strictEqual(found.status, 200);
      assert.strictEqual(found.headers.get("cache-control"), "private, no-store");
      const html = yield* Effect.promise(() => found.text());
      const help = double.fake.address("help@acme.example")!;
      const alerts = double.fake.address("alerts@acme.example")!;
      assert.include(html, "Live · reaches 2 addresses · not stored.");
      assert.include(html, `value="${help.id}"`);
      assert.include(html, "Acme Help · Replies only");
      assert.match(html, new RegExp(`value="${alerts.id}"[^>]* disabled`));
      assert.include(html, "Alerts · no inbox, can't be connected");
      assert.include(html, 'value="new"');
      assert.include(html, "On pidgeon.email or acme.example, replies only to start");
      assert.include(html, '<option value="pidgeon.email">');
      assert.notInclude(html, SENTINEL);
      for (const [key, words] of [
        ["pgn_test_anyTestKey00000001", "That's a test-mode key"],
        ["pgn_live_pageSendKeyHelp00001", "That key isn't an admin key"],
        ["", "Paste a Pidgeon admin key"]
      ] as const) {
        const refused = yield* send(Page.addressesPath, post(owner.user, { key }));
        assert.strictEqual(refused.status, 422);
        const fragment = yield* Effect.promise(() => refused.text());
        assert.include(fragment, "data-pidgeon-key-error");
        assert.include(fragment, words);
      }
    })
  );

  it.effect("creates support@ on the shared domain at send, minting one key for it alone", () =>
    Effect.gen(function* () {
      events.length = 0;
      const owner = yield* createCompany("pidgeon-create");
      const response = yield* send(
        connectPath,
        post(
          owner.user,
          connectForm({
            handle: "support",
            address: "new",
            local_part: "support",
            domain: "pidgeon.email",
            display_name: "Support",
            send_policy: "reply_only"
          })
        )
      );
      const location = response.headers.get("location")!;
      assert.notInclude(location, PidgeonDouble.ADMIN_KEY);
      const { html } = yield* follow(response, owner.user);
      for (const part of [
        "pidgeon/support",
        "Patchy made a send key for support@pidgeon.email and kept only that. Your admin key wasn't stored.",
        "<dt>Address</dt><dd>support@pidgeon.email</dd>",
        "<dt>Writes to</dt><dd>Replies only</dd>",
        "<dt>Patches may</dt><dd>Read and send</dd>",
        "support@pidgeon.email: threads, messages and attachment text, and replies, sends and triage from it. It only replies: patches can't start a conversation. No labels.",
        "patchy add pidgeon/support",
        ">Rotate key</button>",
        ">Change access…</a>",
        ">Replace key…</a>",
        "Rotate gives Patchy's key a new secret, with no admin key."
      ])
        assert.include(html, part);
      assert.notInclude(html, "Point it elsewhere");
      const connection = yield* connectedId(owner.company.id, "support");
      const support = double.fake.address("support@pidgeon.email")!;
      const keys = double.fake
        .keys(0)
        .filter((key) => key.name.startsWith("Patchy support pageattempt1 "));
      assert.deepStrictEqual(
        keys.map((key) => [key.revoked_at, key.identity_ids, key.access]),
        [[null, [support.id], "send"]]
      );
      assert.deepStrictEqual(
        events.flatMap((event) =>
          event.name === "connection.connected"
            ? [[event.name, event.properties.connectionId, event.properties.integration]]
            : []
        ),
        [["connection.connected", connection.id, "pidgeon"]]
      );
    })
  );

  it.effect("keeps everything typed but the key when a connect is refused", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("pidgeon-refused");
      const response = yield* send(
        connectPath,
        post(
          owner.user,
          connectForm({
            key: "pgn_live_pageSendKeyHelp00001",
            handle: "desk",
            description: "Help desk mail",
            address: "new",
            local_part: "desk",
            domain: "acme.example",
            display_name: "Desk",
            send_policy: "open"
          })
        )
      );
      assert.strictEqual(response.status, 422);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, "That key isn't an admin key");
      assert.include(html, 'value="desk"');
      assert.include(html, 'value="Help desk mail"');
      assert.include(html, 'data-kept-address="new"');
      assert.include(html, 'data-kept-local-part="desk"');
      assert.include(html, 'data-kept-send-policy="open"');
      assert.include(html, 'value="pageattempt1"');
      assert.include(html, 'aria-invalid="true" autofocus');
      assert.notInclude(html, "pgn_live_pageSendKeyHelp00001");
      // A refusal never echoes an admin key, whatever went wrong.
      yield* send(
        connectPath,
        post(
          owner.user,
          connectForm({
            key: SENTINEL,
            handle: "sentinel",
            address: double.fake.address("help@acme.example")!.id
          })
        )
      );
      const again = yield* send(
        connectPath,
        post(
          owner.user,
          connectForm({
            key: SENTINEL,
            handle: "sentinel",
            address: double.fake.address("help@acme.example")!.id,
            attempt: "pageattempt2"
          })
        )
      );
      const taken = yield* Effect.promise(() => again.text());
      assert.include(taken, "This company already has a connection with that name.");
      assert.notInclude(taken, SENTINEL);
      const page = yield* read(
        `/company/connections/${(yield* connectedId(owner.company.id, "sentinel")).id}`,
        owner.user
      );
      assert.notInclude(page.html, SENTINEL);
    })
  );

  it.effect("rotates, changes access and replaces the key from the connection's page", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("pidgeon-lifecycle");
      const help = double.fake.address("help@acme.example")!;
      yield* send(connectPath, post(owner.user, connectForm({ handle: "help", address: help.id })));
      const connection = yield* connectedId(owner.company.id, "help");
      const path = `/company/connections/${connection.id}`;
      const rotated = yield* follow(yield* send(`${path}/renew`, post(owner.user)), owner.user);
      assert.include(rotated.html, "Key rotated");
      assert.include(rotated.html, "The old one stops working at");
      // An address's labels show on its page.
      assert.include(rotated.html, "2 labels.");
      for (const label of ["Billing", "Bugs"])
        assert.include(rotated.html, `<li class="list-row"><code>${label}</code></li>`);
      assert.include(
        rotated.html,
        '<button class="btn" type="button" disabled>Rotate key</button>'
      );
      const form = yield* read(`${path}/access`, owner.user);
      assert.include(form.html, "Change what patches may do with pidgeon/help");
      assert.include(form.html, 'class="choice-cards"');
      assert.include(form.html, 'name="key"');
      // The old key refuses to go: the page names it, and Test connection tries again.
      const before = yield* connectedId(owner.company.id, "help");
      if (before.integration !== "pidgeon") return assert.fail("A Pidgeon connection");
      double.fault(PidgeonDouble.route("DELETE", `/api-keys/${before.display.key.id}`), {
        kind: "fail"
      });
      const changed = yield* follow(
        yield* send(
          `${path}/access`,
          post(owner.user, {
            attempt: "pageattempt3",
            key: PidgeonDouble.ADMIN_KEY,
            access: "read"
          })
        ),
        owner.user
      );
      assert.include(changed.html, "Patches may now read.");
      assert.include(changed.html, "<dt>Patches may</dt><dd>Read</dd>");
      assert.include(changed.html, "The old key is still active in Pidgeon");
      assert.include(changed.html, `named ${before.display.key.name}`);
      assert.isNull(
        double.fake.keys(0).find((key) => key.id === before.display.key.id)!.revoked_at
      );
      const tested = yield* follow(yield* send(`${path}/test`, post(owner.user)), owner.user);
      assert.notInclude(tested.html, "The old key is still active in Pidgeon");
      assert.isNotNull(
        double.fake.keys(0).find((key) => key.id === before.display.key.id)!.revoked_at
      );
      const replaced = yield* follow(
        yield* send(
          `${path}/rotate`,
          post(owner.user, { attempt: "pageattempt4", key: PidgeonDouble.ADMIN_KEY })
        ),
        owner.user
      );
      assert.include(replaced.html, "Patchy made a new read key for help@acme.example");
      // A retarget is a new connection, never a move.
      const retarget = yield* read(`${path}/retarget`, owner.user);
      assert.include(retarget.html, "This connection doesn't offer that.");
    })
  );

  it.effect("deletes an unused connection and revokes its key, and refuses a declared one", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("pidgeon-delete");
      events.length = 0;
      const help = double.fake.address("help@acme.example")!;
      yield* send(
        connectPath,
        post(
          owner.user,
          connectForm({ handle: "unused", address: help.id, attempt: "pageattemp10" })
        )
      );
      const unused = yield* connectedId(owner.company.id, "unused");
      const deleted = yield* follow(
        yield* send(`/company/connections/${unused.id}/delete`, post(owner.user)),
        owner.user
      );
      assert.include(
        deleted.html,
        "Connection deleted, and its key revoked in Pidgeon. The address and its mail stay in Pidgeon."
      );
      assert.deepStrictEqual(
        events.flatMap((event) =>
          event.name === "connection.deleted"
            ? [[event.properties.connectionId, event.properties.integration]]
            : []
        ),
        [[unused.id, "pidgeon"]]
      );
      assert.isNotNull(
        double.fake.keys(0).find((key) => key.name.startsWith("Patchy unused pageattemp10 "))!
          .revoked_at
      );
      yield* send(
        connectPath,
        post(
          owner.user,
          connectForm({ handle: "declared", address: help.id, attempt: "pageattemp11" })
        )
      );
      const declared = yield* connectedId(owner.company.id, "declared");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
        VALUES ('pat_page_declared', ${owner.company.id}, ${owner.user.id}, 'Desk', 'desk')`;
      yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key, content_hash,
        file_size, created_by_machine_token_id, owner_user_id, tier, release, manifest_version,
        wire_version, schema_revision, manifest, publish_key, payload_digest, publish_response,
        publish_status)
        VALUES ('ver_page_declared', 'pat_page_declared', 1, 'desk.html', 'test', 1, ${DEV_SEED.tokenId},
          ${owner.user.id}, 1, 'test', 1, 1, 0,
          ${JSON.stringify({ uses: { desk: { kind: "pidgeon", handle: "declared", id: declared.id, revision: 1 } } })}::jsonb,
          'page-declared', 'test', '{}'::jsonb, 201)`;
      const refused = yield* send(`/company/connections/${declared.id}/delete`, post(owner.user));
      assert.strictEqual(refused.status, 409);
      assert.isNull(
        double.fake.keys(0).find((key) => key.name.startsWith("Patchy declared pageattemp11 "))!
          .revoked_at
      );
    })
  );

  it.effect("lets neither members nor another company manage it", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("pidgeon-guard");
      const member = yield* addMember(owner);
      const help = double.fake.address("help@acme.example")!;
      yield* send(
        connectPath,
        post(
          owner.user,
          connectForm({ handle: "guarded", address: help.id, attempt: "pageattemp20" })
        )
      );
      const connection = yield* connectedId(owner.company.id, "guarded");
      const path = `/company/connections/${connection.id}`;
      const requests = double.requests.length;
      const found = yield* send(Page.addressesPath, post(member, { key: PidgeonDouble.ADMIN_KEY }));
      assert.strictEqual(found.status, 403);
      assert.include(
        yield* Effect.promise(() => found.text()),
        "Only an admin can manage company connections."
      );
      for (const response of [
        yield* send(connectPath, post(member, connectForm({ handle: "member", address: help.id }))),
        yield* send(`${path}/renew`, post(member)),
        yield* send(
          `${path}/access`,
          post(member, { attempt: "pageattemp21", key: PidgeonDouble.ADMIN_KEY, access: "read" })
        ),
        yield* send(
          `${path}/rotate`,
          post(member, { attempt: "pageattemp22", key: PidgeonDouble.ADMIN_KEY })
        ),
        yield* send(`${path}/delete`, post(member))
      ])
        assert.strictEqual(response.status, 403);
      assert.strictEqual(double.requests.length, requests);
      const view = yield* read(path, member);
      assert.notInclude(view.html, ">Rotate key</button>");
      assert.include(view.html, "Only admins can change this connection.");
      const foreign = yield* createCompany("pidgeon-guard-foreign");
      assert.strictEqual((yield* read(path, foreign.user)).status, 404);
      assert.strictEqual((yield* send(`${path}/renew`, post(foreign.user))).status, 404);
      assert.strictEqual(double.requests.length, requests);
      // A form posted from elsewhere never reaches Pidgeon either.
      const forged = yield* send(Page.addressesPath, {
        method: "POST",
        headers: { cookie: cookie(owner.user), origin: "https://elsewhere.example" },
        body: new URLSearchParams({ key: PidgeonDouble.ADMIN_KEY })
      });
      assert.strictEqual(forged.status, 403);
      assert.strictEqual(double.requests.length, requests);
    })
  );
});
