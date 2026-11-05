import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import { Analytics } from "@patchy/analytics";
import { Companies, InviteMail, Users } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AgentConnections from "./AgentConnections.js";
import * as AuthPages from "./AuthPages.js";
import * as BetaLinkPages from "./BetaLinkPages.js";
import * as BetaLinks from "./BetaLinks.js";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import * as Session from "./Session.js";
import { clerkEnv, signSession, signedInCookies } from "./testing.js";

const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const origin = new URL(base).origin;
const notFound = HttpServerResponse.text("not found", { status: 404 });
const routes = Layer.mergeAll(BetaLinkPages.routes(notFound), AuthPages.layer);
const send = Effect.fn(function* (path: string, options: RequestInit = {}) {
  const app = yield* HttpRouter.toHttpEffect(routes);
  const response = yield* app.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(new URL(path, base), options))
    )
  );
  const web = HttpServerResponse.toWeb(response);
  return {
    status: web.status,
    headers: web.headers,
    html: yield* Effect.promise(() => web.text())
  };
});
const post = (body: Record<string, string>, headers: Record<string, string> = { origin }) => ({
  method: "POST",
  body: new URLSearchParams(body),
  headers
});
const claim = (path: string, email: string) => send(path, post({ action: "claim", email }));
const signedIn = (sub: string, email: string) => ({
  headers: { cookie: signedInCookies(signSession({ sub, email, name: "Jane" })) }
});

const invites = Effect.flatMap(InviteMail.Recording, (recording) => recording.events);
const newLink = Effect.fn(function* (label: string) {
  const { link, secret } = yield* BetaLinks.create({ label, days: BetaLinks.DEFAULT_DAYS });
  return { id: link.id, path: `/join/${secret}`, secret };
});
const listed = Effect.fn(function* (id: string) {
  return (yield* BetaLinks.list).find((link) => link.id === id)!;
});
/** Clerk refusing every request: delivery fails and nothing is invited. */
const clerkDown = Effect.provide(InviteMail.layerFailing);
/** Clerk answering a revoke as already accepted, as it does once its person signed up. */
const accepted = Effect.provide(
  Layer.effect(
    InviteMail.InviteMail,
    Effect.map(InviteMail.InviteMail, (mail) =>
      InviteMail.InviteMail.of({
        create: mail.create,
        revoke: (invitationId) =>
          Effect.fail(new InviteMail.InvitationNotPending({ invitationId, state: "accepted" }))
      })
    )
  )
);

/** Clerk taking its time over each new invitation: `sending` opens, then it waits for `release`. */
const slowClerk = (sending: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  Effect.provide(
    Layer.effect(
      InviteMail.InviteMail,
      Effect.map(InviteMail.InviteMail, (mail) =>
        InviteMail.InviteMail.of({
          create: (email) =>
            Deferred.succeed(sending, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(mail.create(email))
            ),
          revoke: mail.revoke
        })
      )
    )
  );
/** Until another transaction on this database is waiting for a lock. */
const someoneWaits = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (let attempt = 0; attempt < 2_000; attempt++) {
    yield* sql`SELECT pg_stat_clear_snapshot()`;
    const waiting = yield* sql`SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting.length > 0) return;
  }
  return yield* Effect.die(new Error("nothing waited for the lock"));
});

const services = Layer.mergeAll(
  Session.layer,
  Companies.layer,
  Users.layer,
  InviteMail.layerRecording
).pipe(
  Layer.provideMerge(DeviceLogins.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provideMerge(AgentConnections.layer),
  Layer.provideMerge(
    Layer.succeed(Analytics.Analytics, Analytics.Analytics.of({ track: () => Effect.void }))
  ),
  Layer.provide(Limits.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  Layer.provideMerge(NodeCryptography.layer)
);

it.layer(services)("beta links", (it) => {
  it.effect("takes one email, invites it once, and never shows the link's secret or address", () =>
    Effect.gen(function* () {
      const { path, secret } = yield* newLink("Acme");
      const open = yield* send(path);
      assert.strictEqual(open.status, 200);
      assert.include(open.html, "A Patchy Cloud spot for Acme");
      assert.include(open.html, "set up Acme's company next");
      assert.notInclude(open.html, secret);
      assert.strictEqual(open.headers.get("referrer-policy"), "same-origin");
      assert.include(open.headers.get("content-security-policy")!, "form-action 'self'");

      const foreign = yield* send(
        path,
        post({ action: "claim", email: "jane@acme.test" }, { origin: "https://foreign.invalid" })
      );
      assert.strictEqual(foreign.status, 403);
      const invalid = yield* claim(path, "jane at acme");
      assert.strictEqual(invalid.status, 422);
      assert.include(invalid.html, 'role="alert"');
      assert.include(invalid.html, 'value="jane at acme"');
      assert.deepStrictEqual(yield* invites, []);

      const claimed = yield* claim(path, "  Jane@Acme.test ");
      assert.strictEqual(claimed.status, 303);
      assert.strictEqual(claimed.headers.get("location"), path);
      const [invite] = yield* invites;
      assert.deepInclude(invite, { operation: "create", email: "jane@acme.test" });
      const sent = yield* send(path);
      assert.include(sent.html, "Check your email");
      assert.include(sent.html, "j•••@acme.test");
      assert.notInclude(sent.html, "jane@");
      assert.notInclude(sent.html, "<form method");

      // The link is taken: another address, or none, changes nothing and invites no one.
      assert.strictEqual((yield* claim(path, "sam@acme.test")).status, 303);
      assert.strictEqual((yield* claim(path, "")).status, 303);
      assert.lengthOf(yield* invites, 1);
      assert.include((yield* send(path)).html, "j•••@acme.test");
    })
  );

  it.effect("keeps an address to one live link, until that link is revoked", () =>
    Effect.gen(function* () {
      const first = yield* newLink("Globex");
      const second = yield* newLink("Globex again");
      yield* claim(first.path, "hank@globex.test");
      const refused = yield* claim(second.path, "HANK@globex.test");
      assert.strictEqual(refused.status, 409);
      assert.include(refused.html, "That email already has an invitation.");
      assert.isNull((yield* listed(second.id)).email);

      yield* BetaLinks.revoke(first.id);
      assert.strictEqual((yield* claim(second.path, "hank@globex.test")).status, 303);
      assert.strictEqual((yield* listed(second.id)).email, "hank@globex.test");
    })
  );

  it.effect("keeps the address when Clerk fails, so Try again invites only that one", () =>
    Effect.gen(function* () {
      const { id, path } = yield* newLink("Initech");
      yield* claim(path, "pete@initech.test").pipe(clerkDown);
      const failed = yield* send(path);
      assert.include(failed.html, "We couldn't send your invitation");
      assert.include(failed.html, "p•••@initech.test");
      assert.include(failed.html, 'value="retry"');
      assert.strictEqual(BetaLinks.state(yield* listed(id), 0), "failed");

      yield* claim(path, "someone@else.test");
      assert.strictEqual((yield* listed(id)).email, "pete@initech.test");
      yield* send(path, post({ action: "retry" })).pipe(clerkDown);
      assert.strictEqual(BetaLinks.state(yield* listed(id), 0), "failed");

      assert.strictEqual((yield* send(path, post({ action: "retry" }))).status, 303);
      const mail = yield* invites;
      assert.deepInclude(mail.at(-1), { operation: "create", email: "pete@initech.test" });
      assert.include((yield* send(path)).html, "Check your email");
    })
  );

  it.effect(
    "stops Try again after its attempts, and says Patchy can't vouch for a lost reply",
    () =>
      Effect.gen(function* () {
        const { id, path } = yield* newLink("Vandelay");
        yield* claim(path, "art@vandelay.test").pipe(clerkDown);
        for (let attempt = 0; attempt < BetaLinks.MAX_ATTEMPTS + 2; attempt++)
          yield* send(path, post({ action: "retry" })).pipe(clerkDown);
        assert.strictEqual((yield* listed(id)).inviteAttempts, BetaLinks.MAX_ATTEMPTS);
        const spent = yield* send(path);
        assert.include(spent.html, "Ask the person who sent you this link.");
        assert.notInclude(spent.html, 'value="retry"');
        const before = (yield* invites).length;
        yield* send(path, post({ action: "retry" }));
        assert.lengthOf(yield* invites, before);

        // Clerk may have made an invitation whose answer was lost: revoke can't name it.
        assert.strictEqual((yield* BetaLinks.revoke(id)).invitation, "unconfirmed");
      })
  );

  it.effect("refuses an address another link is claiming at the same moment", () =>
    Effect.gen(function* () {
      const first = yield* newLink("Pendant");
      const second = yield* newLink("Pendant again");
      const sending = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const claiming = yield* Effect.forkChild(
        claim(first.path, "kel@pendant.test").pipe(slowClerk(sending, release))
      );
      yield* Deferred.await(sending);
      const racing = yield* Effect.forkChild(claim(second.path, "kel@pendant.test"));
      yield* someoneWaits;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(claiming);
      const refused = yield* Fiber.join(racing);
      assert.strictEqual(refused.status, 409);
      assert.include(refused.html, "That email already has an invitation.");
      assert.isNull((yield* listed(second.id)).email);
    })
  );

  it.effect("ends an open link at its end date, while a sent invitation stays sent", () =>
    Effect.gen(function* () {
      const open = yield* newLink("Umbrella");
      const sent = yield* newLink("Umbrella labs");
      yield* claim(sent.path, "alice@umbrella.test");
      yield* TestClock.adjust("31 days");
      const ended = yield* send(open.path);
      assert.strictEqual(ended.status, 410);
      assert.include(ended.html, "This link no longer works");
      assert.strictEqual((yield* claim(open.path, "late@umbrella.test")).status, 303);
      assert.strictEqual((yield* claim(open.path, "not an email")).status, 303);
      assert.isNull((yield* listed(open.id)).email);
      assert.include((yield* send(sent.path)).html, "Check your email");
    })
  );

  it.effect("marks its first arrival and starts their company with the link's name", () =>
    Effect.gen(function* () {
      const { id, path } = yield* newLink("Hooli");
      yield* claim(path, "gavin@hooli.test");
      const person = signedIn("user_gavin", "Gavin@Hooli.test");
      const join = yield* send("/join", person);
      assert.include(join.html, 'name="name" value="Hooli"');
      assert.include(join.html, 'name="handle" value="hooli"');
      const first = yield* listed(id);
      assert.strictEqual(first.clerkUserId, "user_gavin");
      assert.isNotNull(first.signedInAt);

      yield* TestClock.adjust("1 hour");
      yield* send("/join", person);
      assert.deepStrictEqual((yield* listed(id)).signedInAt, first.signedInAt);
      const used = yield* send(path);
      assert.include(used.html, "This link has been used");
      assert.include(used.html, "https://accounts.patchy.invalid/sign-in");

      // Anyone else's create-or-join is untouched by the link.
      const other = yield* send("/join", signedIn("user_other", "other@hooli.test"));
      assert.include(other.html, 'name="name" value="Jane&#39;s company"');

      yield* send(
        "/join",
        post(
          { action: "create", name: "Hooli XYZ", handle: "hooli-xyz" },
          { ...person.headers, origin }
        )
      );
      assert.strictEqual((yield* listed(id)).company, "hooli-xyz");
    })
  );

  it.effect("resends by withdrawing the old invitation, and revokes by ending the link", () =>
    Effect.gen(function* () {
      const { id, path } = yield* newLink("Stark");
      assert.strictEqual((yield* BetaLinks.resend(id)).invitation, "none");
      yield* claim(path, "pepper@stark.test");
      const old = (yield* listed(id)).clerkInvitationId!;

      const resent = yield* BetaLinks.resend(id);
      assert.strictEqual(resent.invitation, "sent");
      assert.notStrictEqual(resent.link.clerkInvitationId, old);
      const afterResend = (yield* invites).slice(-2);
      assert.deepStrictEqual(afterResend[0], { operation: "revoke", id: old });
      assert.deepInclude(afterResend[1], { operation: "create", email: "pepper@stark.test" });

      const revoked = yield* BetaLinks.revoke(id);
      assert.strictEqual(revoked.invitation, "withdrawn");
      assert.strictEqual(BetaLinks.state(revoked.link, 0), "ended");
      assert.deepStrictEqual((yield* invites).at(-1), {
        operation: "revoke",
        id: resent.link.clerkInvitationId!
      });
      assert.strictEqual((yield* send(path)).status, 410);
      // Again retries Clerk, and keeps the first revocation's time.
      yield* TestClock.adjust("1 hour");
      const again = yield* BetaLinks.revoke(id);
      assert.deepStrictEqual(again.link.revokedAt, revoked.link.revokedAt);
      assert.strictEqual((yield* BetaLinks.resend(id)).invitation, "none");
    })
  );

  it.effect("holds a revoke until the invitation being sent is stored, then withdraws it", () =>
    Effect.gen(function* () {
      const { id, path } = yield* newLink("Cyberdyne");
      const sending = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const claiming = yield* Effect.forkChild(
        claim(path, "miles@cyberdyne.test").pipe(slowClerk(sending, release))
      );
      yield* Deferred.await(sending);
      const revoking = yield* Effect.forkChild(BetaLinks.revoke(id));
      yield* someoneWaits;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(claiming);
      const revoked = yield* Fiber.join(revoking);
      assert.strictEqual(revoked.invitation, "withdrawn");
      const mail = yield* invites;
      const created = mail.find(
        (event) => event.operation === "create" && event.email === "miles@cyberdyne.test"
      )!;
      assert.deepStrictEqual(mail.at(-1), { operation: "revoke", id: created.id });
    })
  );

  it.effect("makes no new invitation once its person accepted the old one", () =>
    Effect.gen(function* () {
      const { id, path } = yield* newLink("Wayne");
      yield* claim(path, "lucius@wayne.test");
      const before = (yield* invites).length;
      assert.strictEqual((yield* BetaLinks.resend(id).pipe(accepted)).invitation, "accepted");
      assert.lengthOf(yield* invites, before);
      assert.strictEqual((yield* BetaLinks.revoke(id).pipe(accepted)).invitation, "accepted");
    })
  );

  it.effect("answers a secret no link has with not found", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* send("/join/not-a-link")).status, 404);
      assert.strictEqual((yield* claim("/join/not-a-link", "x@y.test")).status, 404);
      const missing = yield* BetaLinks.revoke("bln_missing").pipe(Effect.flip);
      assert.strictEqual(missing._tag, "BetaLinkNotFound");
    })
  );
});
