import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { Companies, Teams, Users } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { registry } from "@patchy/limits/registry";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as AttioSource from "../attio/Source.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as GithubDouble from "../test/github.js";
import * as ImapTest from "../test/imap.js";
import * as PatchVisibilityTest from "../test/patchVisibility.js";
import * as Access from "./Access.js";
import * as Connection from "./Connection.js";
import * as Flows from "./Flows.js";
import * as Page from "./Page.js";
import * as Source from "./Source.js";

/**
 * GitHub connections offline, over a scripted GitHub: who may connect what, the one-company
 * claim, and what each of the probe's answers does to a connection once it's saved.
 */

interface Admin {
  readonly companyId: string;
  readonly userId: string;
}
const admin: Admin = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const redirectUri = "https://patchy.test/settings/integrations/github/callback";

const services = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 5).toString("base64")}`)),
  RuntimeLog.layer,
  Companies.layer,
  Users.layer,
  // Never called: these connections reach no database, PostHog project, Pidgeon or Attio.
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
  ImapTest.offline
).pipe(
  Layer.provideMerge(PatchVisibilityTest.layer),
  Layer.provideMerge(Teams.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(NodeCryptography.layer)
);

/**
 * An organization with three repositories, a personal account and an account of another type,
 * and two people: mira administers api, web, her own account's repository and the other type's
 * one, and reads docs, whose listing says nothing of her permissions; theo administers api.
 */
let scenes = 0;
const scene = () => {
  // Installations are platform rows the block's database keeps, so each scene has its own.
  const base = ++scenes * 1000;
  const ids = { org: base + 1, personal: base + 2, odd: base + 3, reinstalled: base + 4 };
  const github = GithubDouble.world();
  const org = github.add({
    id: ids.org,
    account: { id: 9001, login: "northwind-labs", type: "Organization" },
    repositories: [
      { id: 11, name: "api" },
      { id: 12, name: "web" },
      { id: 13, name: "docs", private: false }
    ]
  });
  github.add({
    id: ids.personal,
    account: { id: 7001, login: "mira-okafor", type: "User" },
    repositories: [{ id: 21, name: "dotfiles", private: false }]
  });
  github.add({
    id: ids.odd,
    account: { id: 8001, login: "acme-holdings", type: "Enterprise" },
    repositories: [{ id: 31, name: "tools" }]
  });
  github.person("mira", {
    id: 7001,
    login: "mira-okafor",
    sees: new Set([ids.org, ids.personal, ids.odd]),
    admin: new Set([11, 12, 21, 31]),
    silent: new Set([13])
  });
  github.person("theo", {
    id: 7002,
    login: "theo-ng",
    sees: new Set([ids.org]),
    admin: new Set([11])
  });
  return { github, org, ids };
};
type World = ReturnType<typeof scene>["github"];

/** Runs a test's body over a fresh scene, with GitHub's services built for it. */
const within = <A, E, R>(body: (world: ReturnType<typeof scene>) => Effect.Effect<A, E, R>) => {
  const made = scene();
  return body(made).pipe(Effect.provide(made.github.layer));
};

/** The admin presses Continue with GitHub and comes back from GitHub signed in as `login`. */
const signIn = Effect.fn("test.signIn")(function* (
  world: World,
  who: Admin,
  login: string,
  purpose: Flows.Purpose = "connect",
  connectionId: string | null = null
) {
  const flows = yield* Flows.Flows;
  const url = yield* flows.start({
    ...who,
    purpose,
    connectionId,
    redirectUri,
    selectAccount: false
  });
  const { code, state } = world.authorize(login, url);
  return yield* flows.callback({ ...who, code, state, redirectUri });
});

const connect = (
  store: ConnectionStore.ConnectionStore["Service"],
  who: Admin,
  handle: string,
  repositories: ReadonlyArray<readonly [number, number]>
) =>
  store.connect({
    integration: "github",
    ...who,
    handle,
    description: "",
    credentials: Connection.request({
      repositories: repositories.map(([installationId, id]) => ({ installationId, id }))
    })
  });

const github = (connection: ConnectionStore.Connection) =>
  connection.integration === "github" ? connection : assert.fail("not a GitHub connection");

/** A second company and its admin. */
const company = Effect.fn("test.company")(function* (handle: string) {
  const made = yield* (yield* Companies.Companies).create({
    handle,
    name: handle,
    clerkUserId: `user_${handle}_admin`,
    email: `${handle}-admin@example.com`,
    userName: `${handle} Admin`
  });
  return { companyId: made.company.id, userId: made.user.id };
});

const reach = (id: string, repository: string, who: Admin = admin) =>
  Effect.gen(function* () {
    const access = yield* Access.Access;
    return yield* access.reach({
      ...who,
      id,
      repository,
      deadline: (yield* Clock.currentTimeMillis) + 15_000
    });
  });

/** The admin's signed-in token, as their live flow holds it. */
const signedInToken = (flow: Option.Option<Flows.Flow>) =>
  Redacted.value(Option.getOrThrow(Option.getOrThrow(flow).signedIn).token);

/** Waits, in real time, until `done` holds. */
const until = (done: () => boolean) =>
  Effect.gen(function* () {
    while (!done()) yield* TestClock.withLive(Effect.sleep("5 millis"));
  });
const isExchange = (request: GithubDouble.Request) =>
  request.url.pathname === "/login/oauth/access_token";
const isMint = (request: GithubDouble.Request) => request.url.pathname.endsWith("/access_tokens");

/** Holds the first request `matches` accepts until `release`, then lets the world answer it. */
const holdFirst = (world: World, matches: (request: GithubDouble.Request) => boolean) => {
  let release = () => {};
  const held = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  let armed = true;
  world.state.override = (request) => {
    if (!armed || !matches(request)) return undefined;
    armed = false;
    return held;
  };
  return {
    /** Until the held request has been sent. */
    sent: until(() => world.requests.some(matches)),
    release: Effect.sync(() => release())
  };
};

/**
 * Holds every one of the installation's slots in this process. `queued` waits until another call
 * has begun waiting for one; `release` lets them all go.
 */
const occupy = Effect.fn("test.occupy")(function* (world: World, installationId: number) {
  const source = yield* Source.Source;
  const go = yield* Deferred.make<void>();
  const deadline = (yield* Clock.currentTimeMillis) + 60_000;
  const holders: Array<Fiber.Fiber<void, Source.Busy | Source.Timeout>> = [];
  for (let slot = 0; slot < registry["github.calls.concurrent"].default; slot++) {
    const entered = yield* Deferred.make<void>();
    holders.push(
      yield* source
        .withSlot(
          installationId,
          deadline
        )(Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)))
        .pipe(Effect.forkChild)
    );
    yield* Deferred.await(entered);
  }
  const admitted = world.state.admissions;
  return {
    queued: until(() => world.state.admissions > admitted),
    release: Effect.andThen(
      Deferred.succeed(go, undefined),
      Effect.forEach(holders, Fiber.join, { discard: true })
    )
  };
});

/** Moves the test clock a second at a time until `fiber` ends, and joins it. */
const settled = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust("1 second");
      yield* TestClock.withLive(Effect.sleep("2 millis"));
    }
    return yield* Fiber.join(fiber);
  });

const claims = Effect.fn("test.claims")(function* (installationId: number) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ readonly companyId: string }>`SELECT company_id AS "companyId"
      FROM github_installation_claims WHERE installation_id = ${installationId} ORDER BY 1`).map(
    (row) => row.companyId
  );
});

it.layer(services)("GitHub connections", (it) => {
  it.effect("connects only repositories GitHub shows the admin administering, on one account", () =>
    within(({ github: world, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        const flows = yield* Flows.Flows;
        const sql = yield* SqlClient.SqlClient;
        yield* signIn(world, admin, "mira");
        const flow = yield* flows.current(admin);
        const signedIn = Option.getOrThrow(Option.getOrThrow(flow).signedIn);
        assert.strictEqual(signedIn.login, "mira-okafor");
        // docs says nothing of her permissions, and the other type's account isn't offered.
        const listed = yield* flows.listing(signedIn.token);
        assert.deepStrictEqual(
          listed.accounts.map((item) => [
            item.account.login,
            item.repositories.map((repo) => repo.name)
          ]),
          [
            ["northwind-labs", ["api", "web"]],
            ["mira-okafor", ["dotfiles"]]
          ]
        );
        const connection = github(
          yield* connect(store, admin, "platform", [
            [ids.org, 11],
            [ids.org, 12]
          ])
        );
        assert.deepStrictEqual(connection.display, {
          installationId: ids.org,
          account: { id: 9001, login: "northwind-labs", type: "Organization" },
          repositories: [
            { id: 11, name: "api", private: true },
            { id: 12, name: "web", private: true }
          ],
          successes: 1
        });
        const metadata = yield* store.snapshot(admin.companyId, connection.id, 1);
        assert.strictEqual(metadata.integration, "github");
        if (metadata.integration === "github")
          assert.deepStrictEqual(
            metadata.snapshot.repositories.map((repo) => [repo.name, repo.defaultBranch]),
            [
              ["api", "main"],
              ["web", "main"]
            ]
          );
        // The flow is consumed with the save, and the admin's GitHub token revoked.
        assert.isTrue(Option.isNone(yield* flows.current(admin)));
        assert.include(world.revoked, Redacted.value(signedIn.token));
        assert.deepStrictEqual(yield* claims(ids.org), [admin.companyId]);
        // The installation and repository ids are sealed: not in the clear, and the keyring opens them.
        const [row] = yield* sql<{
          readonly credentials: string;
          readonly keyId: string;
        }>`SELECT credentials, key_id AS "keyId" FROM connections WHERE id = ${connection.id}`;
        for (const plain of ["installationId", "repositoryIds"])
          assert.notInclude(row!.credentials, plain);
        const opened = yield* (yield* CredentialKeys.CredentialKeys).decrypt(
          { companyId: admin.companyId, id: connection.id, integration: "github" },
          row!
        );
        assert.deepStrictEqual(yield* Connection.parseCredentials(opened), {
          installationId: ids.org,
          repositoryIds: [11, 12]
        });
      })
    )
  );

  it.effect("refuses what the listing doesn't show, exactly, as administered", () =>
    within(({ github: world, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        yield* signIn(world, admin, "mira");
        const refused = (repositories: ReadonlyArray<readonly [number, number]>) =>
          Effect.flip(connect(store, admin, "refused", repositories));
        // A repository whose listing carries no permissions at all, and a forged id.
        const silent = yield* refused([[ids.org, 13]]);
        assert.instanceOf(silent, Connection.NotAdmin);
        assert.deepStrictEqual(silent.repositories, ["docs"]);
        const forged = yield* refused([
          [ids.org, 11],
          [ids.org, 999]
        ]);
        assert.instanceOf(forged, Connection.NotAdmin);
        assert.deepStrictEqual(forged.repositories, ["#999"]);
        assert.instanceOf(
          yield* refused([
            [ids.org, 11],
            [ids.personal, 21]
          ]),
          Connection.OneAccount
        );
        assert.instanceOf(yield* refused([]), Connection.NoRepositories);
        // An account that's neither a person nor an organization, though GitHub says admin.
        assert.instanceOf(yield* refused([[ids.odd, 31]]), Connection.AccountType);
        // A person GitHub shows reading but not administering.
        yield* signIn(world, admin, "theo");
        assert.instanceOf(yield* refused([[ids.org, 12]]), Connection.NotAdmin);
        // Listed as an admin, but no longer by the time they submit: the submit's read decides.
        yield* signIn(world, admin, "mira");
        const flows = yield* Flows.Flows;
        const listed = yield* flows.listing(
          Redacted.make(signedInToken(yield* flows.current(admin)))
        );
        assert.isTrue(
          listed.accounts.some((account) => account.repositories.some((repo) => repo.id === 12))
        );
        world.people.get("mira")!.admin.delete(12);
        assert.instanceOf(yield* refused([[ids.org, 12]]), Connection.NotAdmin);
        const sql = yield* SqlClient.SqlClient;
        assert.lengthOf(
          yield* sql`SELECT 1 FROM connections WHERE integration = 'github'
          AND handle = 'refused'`,
          0
        );
      })
    )
  );

  it.effect("consumes a sign-in once, for its own admin, and judges an exchange by its body", () =>
    within(({ github: world }) =>
      Effect.gen(function* () {
        const flows = yield* Flows.Flows;
        const url = yield* flows.start({
          ...admin,
          purpose: "connect",
          connectionId: null,
          redirectUri,
          selectAccount: false
        });
        const first = world.authorize("mira", url);
        // Another admin's session finds nothing under this state.
        const other = yield* company("ghreplay");
        assert.instanceOf(
          yield* Effect.flip(flows.callback({ ...other, ...first, redirectUri })),
          Connection.SignInRequired
        );
        yield* flows.callback({ ...admin, ...first, redirectUri });
        // A replay of the same return, on any host, finds the nonce consumed.
        assert.instanceOf(
          yield* Effect.flip(flows.callback({ ...admin, ...first, redirectUri })),
          Connection.SignInRequired
        );
        // A used code answers 200 with an error: not signed in, whatever the status said.
        const again = yield* flows.start({
          ...admin,
          purpose: "connect",
          connectionId: null,
          redirectUri,
          selectAccount: false
        });
        const second = new URL(again).searchParams.get("state")!;
        const failed = yield* Effect.flip(
          flows.callback({ ...admin, code: first.code, state: second, redirectUri })
        );
        assert.instanceOf(failed, Source.SignInFailed);
        assert.strictEqual(failed.error, "bad_verification_code");
        assert.isTrue(Option.isNone(Option.getOrThrow(yield* flows.current(admin)).signedIn));
        // A body carrying a token and an error is refused too: only a token with no error signs in.
        const third = yield* flows.start({
          ...admin,
          purpose: "connect",
          connectionId: null,
          redirectUri,
          selectAccount: false
        });
        world.state.override = (request) =>
          isExchange(request)
            ? new Response(
                JSON.stringify({ access_token: "ghu_mixed", error: "bad_verification_code" }),
                { status: 200, headers: { "content-type": "application/json" } }
              )
            : undefined;
        const mixed = yield* Effect.flip(
          flows.callback({ ...admin, ...world.authorize("mira", third), redirectUri })
        );
        assert.instanceOf(mixed, Source.SignInFailed);
        assert.isTrue(Option.isNone(Option.getOrThrow(yield* flows.current(admin)).signedIn));
      })
    )
  );

  it.effect("the setup return starts a new request on the admin's live sign-in, or none", () =>
    within(({ github: world }) =>
      Effect.gen(function* () {
        const flows = yield* Flows.Flows;
        const nobody = yield* company("ghsetup");
        assert.isTrue(Option.isNone(yield* flows.restart({ ...nobody, redirectUri })));
        const url = yield* flows.start({
          ...admin,
          purpose: "connect",
          connectionId: null,
          redirectUri,
          selectAccount: false
        });
        const restarted = Option.getOrThrow(yield* flows.restart({ ...admin, redirectUri }));
        const state = new URL(restarted).searchParams.get("state");
        assert.notStrictEqual(state, new URL(url).searchParams.get("state"));
        // The old request's state no longer signs anyone in; the new one does.
        assert.instanceOf(
          yield* Effect.flip(
            flows.callback({ ...admin, ...world.authorize("mira", url), redirectUri })
          ),
          Connection.SignInRequired
        );
        yield* flows.callback({ ...admin, ...world.authorize("mira", restarted), redirectUri });
      })
    )
  );

  it.effect("one company holds an organization's installation; the other is told the way out", () =>
    within(({ github: world, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        const globex = yield* company("ghclaim");
        yield* signIn(world, admin, "mira");
        yield* signIn(world, globex, "theo");
        // Both at once: one claims it, and the other's transaction finds it claimed.
        const people = [admin, globex] as const;
        const results = yield* Effect.all(
          people.map((who) => Effect.exit(connect(store, who, "claimed", [[ids.org, 11]]))),
          { concurrency: 2 }
        );
        const won = results.flatMap((exit, at) =>
          Exit.isSuccess(exit) ? [{ holder: people[at]!, held: github(exit.value) }] : []
        );
        const refusals = results.flatMap((exit) =>
          Exit.isFailure(exit) ? Option.toArray(Exit.findErrorOption(exit)) : []
        );
        assert.lengthOf(won, 1);
        assert.lengthOf(refusals, 1);
        const refusal = refusals[0];
        assert.instanceOf(refusal, Connection.InstallationClaimed);
        assert.include(refusal.message, "uninstall");
        const { holder, held } = won[0]!;
        const other = holder === admin ? globex : admin;
        // Pausing keeps the claim.
        yield* store.disconnect({ ...holder, id: held.id });
        yield* signIn(world, other, other === admin ? "mira" : "theo");
        assert.instanceOf(
          yield* Effect.flip(connect(store, other, "second", [[ids.org, 11]])),
          Connection.InstallationClaimed
        );
        yield* store.reconnect({ ...holder, id: held.id });
        // Disconnecting the holder's last connection on it frees it.
        yield* store.delete({ ...holder, id: held.id });
        assert.deepStrictEqual(yield* claims(ids.org), []);
        yield* connect(store, other, "second", [[ids.org, 11]]);
        assert.deepStrictEqual(yield* claims(ids.org), [other.companyId]);
      })
    )
  );

  it.effect("a personal account's own user connects it to any company", () =>
    within(({ github: world, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        const second = yield* company("ghpersonal");
        yield* signIn(world, admin, "mira");
        yield* connect(store, admin, "dotfiles", [[ids.personal, 21]]);
        yield* signIn(world, second, "mira");
        yield* connect(store, second, "dotfiles", [[ids.personal, 21]]);
        assert.deepStrictEqual(
          yield* claims(ids.personal),
          [admin.companyId, second.companyId].sort()
        );
      })
    )
  );

  it.effect(
    "an uninstalled App pauses the connection; Reconnect moves it to the new installation",
    () =>
      within(({ github: world, org, ids }) =>
        Effect.gen(function* () {
          const store = yield* SqlConnectionStore.make;
          yield* signIn(world, admin, "mira");
          const connection = yield* connect(store, admin, "moving", [
            [ids.org, 11],
            [ids.org, 12]
          ]);
          world.installations.delete(ids.org);
          assert.instanceOf(
            yield* Effect.flip(reach(connection.id, "api")),
            Connection.InstallationGone
          );
          const paused = github(yield* store.get(admin.companyId, connection.id));
          assert.strictEqual(paused.status, "disconnected");
          assert.strictEqual(paused.display.attention?.reason, "uninstalled");
          assert.instanceOf(yield* Effect.flip(reach(connection.id, "api")), Access.NotConnected);
          // Reinstalled: a new installation on the same account, which another company claims first.
          world.add({ ...org, id: ids.reinstalled });
          world.people.get("mira")!.sees.add(ids.reinstalled);
          world.people.get("theo")!.sees.add(ids.reinstalled);
          const globex = yield* company("ghreinstall");
          yield* signIn(world, globex, "theo");
          const theirs = yield* connect(store, globex, "api", [[ids.reinstalled, 11]]);
          const reconnect = () =>
            store.rotate({
              ...admin,
              id: connection.id,
              credentials: Connection.change({ action: "reconnect" })
            });
          yield* signIn(world, admin, "mira", "reconnect", connection.id);
          assert.instanceOf(yield* Effect.flip(reconnect()), Connection.InstallationClaimed);
          yield* store.delete({ ...globex, id: theirs.id });
          yield* signIn(world, admin, "mira", "reconnect", connection.id);
          const moved = github(yield* reconnect());
          assert.strictEqual(moved.status, "connected");
          assert.strictEqual(moved.display.installationId, ids.reinstalled);
          assert.isUndefined(moved.display.attention);
          assert.deepStrictEqual(yield* claims(ids.reinstalled), [admin.companyId]);
          assert.deepStrictEqual(yield* claims(ids.org), []);
          assert.strictEqual((yield* reach(connection.id, "web")).installationId, ids.reinstalled);
        })
      )
  );

  it.effect(
    "a repository taken out of the installation is marked left, refused before GitHub, and found again by Refresh",
    () =>
      within(({ github: world, org, ids }) =>
        Effect.gen(function* () {
          const store = yield* SqlConnectionStore.make;
          yield* signIn(world, admin, "mira");
          const connection = yield* connect(store, admin, "leaving", [
            [ids.org, 11],
            [ids.org, 12]
          ]);
          // Taken out of the installation: the mint for the set answers 422.
          org.repositories = org.repositories.filter((repo) => repo.id !== 12);
          assert.instanceOf(
            yield* Effect.flip(reach(connection.id, "web")),
            Connection.RepositoryNotFound
          );
          const marked = github(yield* store.get(admin.companyId, connection.id));
          assert.strictEqual(marked.status, "connected");
          assert.strictEqual(marked.metadataRevision, 2);
          assert.isAbove(marked.credentialRevision, connection.credentialRevision);
          assert.deepStrictEqual(
            marked.display.repositories.map((repo) => [repo.name, repo.left === true]),
            [
              ["api", false],
              ["web", true]
            ]
          );
          const before = world.requests.length;
          assert.instanceOf(
            yield* Effect.flip(reach(connection.id, "web")),
            Connection.RepositoryNotFound
          );
          assert.strictEqual(world.requests.length, before);
          assert.strictEqual((yield* reach(connection.id, "api")).repositoryId, 11);
          assert.instanceOf(
            yield* Effect.flip(reach(connection.id, "docs")),
            Connection.RepositoryNotFound
          );
          // Put back, a Refresh finds it.
          org.repositories.push({ id: 12, name: "web" });
          const refreshed = github(yield* store.refresh({ ...admin, id: connection.id }));
          assert.isFalse(refreshed.display.repositories.some((repo) => repo.left === true));
          assert.strictEqual((yield* reach(connection.id, "web")).repositoryId, 12);
        })
      )
  );

  it.effect("a suspended App is refused and said so, never paused, and heals by itself", () =>
    within(({ github: world, org, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        yield* signIn(world, admin, "mira");
        const connection = yield* connect(store, admin, "suspended", [[ids.org, 11]]);
        org.suspended = true;
        const refused = yield* Effect.flip(reach(connection.id, "api"));
        assert.instanceOf(refused, Source.Unavailable);
        assert.strictEqual(refused.reason, "suspended");
        const seen = github(yield* store.get(admin.companyId, connection.id));
        assert.strictEqual(seen.status, "connected");
        assert.isNotNull(seen.suspendedAt);
        org.suspended = false;
        yield* reach(connection.id, "api");
        assert.isNull(github(yield* store.get(admin.companyId, connection.id)).suspendedAt);
        // A Refresh that reads the installation again after it's unsuspended says so too.
        org.suspended = true;
        yield* Effect.flip(store.refresh({ ...admin, id: connection.id }));
        assert.isNotNull(github(yield* store.get(admin.companyId, connection.id)).suspendedAt);
        org.suspended = false;
        yield* store.refresh({ ...admin, id: connection.id });
        assert.isNull(github(yield* store.get(admin.companyId, connection.id)).suspendedAt);
      })
    )
  );

  it.effect("a deleted App key refuses for the operator, writing nothing to the connection", () =>
    within(({ github: world, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        yield* signIn(world, admin, "mira");
        const connection = yield* connect(store, admin, "keyless", [[ids.org, 11]]);
        world.state.keyDeleted = true;
        const refused = yield* Effect.flip(reach(connection.id, "api"));
        assert.instanceOf(refused, Source.Unavailable);
        assert.strictEqual(refused.reason, "key");
        const after = yield* store.get(admin.companyId, connection.id);
        assert.strictEqual(after.status, "connected");
        assert.strictEqual(after.credentialRevision, connection.credentialRevision);
      })
    )
  );

  it.effect("a 422 for a permission the installation lost pauses it for that reason", () =>
    within(({ github: world, org, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        yield* signIn(world, admin, "mira");
        const connection = yield* connect(store, admin, "narrowed", [[ids.org, 11]]);
        org.permissions = Object.fromEntries(
          Object.entries(Source.permissions).filter(([name]) => name !== "actions")
        );
        const refused = yield* Effect.flip(reach(connection.id, "api"));
        assert.instanceOf(refused, Connection.PermissionsChanged);
        const paused = github(yield* store.get(admin.companyId, connection.id));
        assert.strictEqual(paused.status, "disconnected");
        assert.deepStrictEqual(paused.display.attention?.missing, ["actions"]);
      })
    )
  );

  it.effect("a 422 that nothing missing explains fails the call and writes nothing", () =>
    within(({ github: world, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        yield* signIn(world, admin, "mira");
        const connection = yield* connect(store, admin, "unexplained", [[ids.org, 11]]);
        let mints = 0;
        world.state.override = (request) =>
          request.url.pathname.endsWith("/access_tokens") && mints++ === 0
            ? new Response(JSON.stringify({ message: "Unprocessable" }), { status: 422 })
            : undefined;
        assert.instanceOf(yield* Effect.flip(reach(connection.id, "api")), Source.Unavailable);
        const after = yield* store.get(admin.companyId, connection.id);
        assert.strictEqual(after.credentialRevision, connection.credentialRevision);
        assert.strictEqual(after.metadataRevision, 1);
      })
    )
  );

  it.effect("a failure that began before a newer success pauses nothing", () =>
    within(({ github: world, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        yield* signIn(world, admin, "mira");
        const connection = yield* connect(store, admin, "stale", [[ids.org, 11]]);
        let release: (answer: Response) => void = () => undefined;
        const held = new Promise<Response>((resolve) => {
          release = resolve;
        });
        let first = true;
        world.state.override = (request) => {
          if (!first || !request.url.pathname.endsWith("/access_tokens")) return undefined;
          first = false;
          return held;
        };
        const call = yield* Effect.flip(reach(connection.id, "api")).pipe(Effect.forkChild);
        yield* TestClock.withLive(Effect.sleep("50 millis"));
        // An admin's Test succeeds while the call's mint is still out.
        yield* store.test({ ...admin, id: connection.id });
        release(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
        assert.instanceOf(yield* Fiber.join(call), Connection.InstallationGone);
        const after = github(yield* store.get(admin.companyId, connection.id));
        assert.strictEqual(after.status, "connected");
        assert.isUndefined(after.display.attention);
      })
    )
  );

  it.effect("a secondary limit with neither header cools the installation down for a minute", () =>
    within(({ github: world, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        yield* signIn(world, admin, "mira");
        const connection = yield* connect(store, admin, "limited", [[ids.org, 11]]);
        let limited = true;
        world.state.override = (request) =>
          limited && request.url.pathname.endsWith("/access_tokens")
            ? new Response(
                JSON.stringify({
                  message:
                    "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."
                }),
                { status: 403 }
              )
            : undefined;
        const refused = yield* Effect.flip(reach(connection.id, "api"));
        assert.instanceOf(refused, Source.RateLimited);
        assert.strictEqual(refused.retryAfterSeconds, 60);
        limited = false;
        // Every host refuses the installation's calls until it passes, without asking GitHub.
        const before = world.requests.length;
        assert.instanceOf(yield* Effect.flip(reach(connection.id, "api")), Source.RateLimited);
        assert.strictEqual(world.requests.length, before);
        yield* TestClock.adjust("61 seconds");
        yield* reach(connection.id, "api");
        assert.strictEqual((yield* store.get(admin.companyId, connection.id)).status, "connected");
      })
    )
  );

  it.effect("a limit on the person's own token refuses the sign-in without cooling anything", () =>
    within(({ github: world, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        yield* signIn(world, admin, "mira");
        world.state.override = (request) =>
          request.url.pathname === "/user/installations"
            ? new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
                status: 403,
                headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "120" }
              })
            : undefined;
        const refused = yield* Effect.flip(connect(store, admin, "throttled", [[ids.org, 11]]));
        assert.instanceOf(refused, Source.RateLimited);
        assert.strictEqual(refused.who, "user");
        const sql = yield* SqlClient.SqlClient;
        assert.lengthOf(
          yield* sql`SELECT 1 FROM github_installations
            WHERE installation_id = ${ids.org} AND cooldown_until IS NOT NULL`,
          0
        );
      })
    )
  );

  it.effect("Add needs a sign-in as an admin of what's added; Remove needs none", () =>
    within(({ github: world, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        yield* signIn(world, admin, "mira");
        const connection = yield* connect(store, admin, "changing", [[ids.org, 11]]);
        const change = (keep: ReadonlyArray<number>, add: ReadonlyArray<number>) =>
          store.rotate({
            ...admin,
            id: connection.id,
            credentials: Connection.change({
              action: "repositories",
              keep,
              add: add.map((id) => ({ installationId: ids.org, id }))
            })
          });
        assert.instanceOf(yield* Effect.flip(change([11], [12])), Connection.SignInRequired);
        yield* signIn(world, admin, "mira", "add", connection.id);
        assert.instanceOf(yield* Effect.flip(change([11], [13])), Connection.NotAdmin);
        const added = github(yield* change([11], [12]));
        assert.deepStrictEqual(
          added.display.repositories.map((repo) => repo.name),
          ["api", "web"]
        );
        const removed = github(yield* change([12], []));
        assert.deepStrictEqual(
          removed.display.repositories.map((repo) => repo.name),
          ["web"]
        );
        assert.instanceOf(
          yield* Effect.flip(reach(connection.id, "api")),
          Connection.RepositoryNotFound
        );
        assert.instanceOf(yield* Effect.flip(change([], [])), Connection.LastRepository);
      })
    )
  );

  it.effect(
    "a return from before a restart neither replaces the newer sign-in nor keeps its token",
    () =>
      within(({ github: world }) =>
        Effect.gen(function* () {
          const flows = yield* Flows.Flows;
          const url = yield* flows.start({
            ...admin,
            purpose: "connect",
            connectionId: null,
            redirectUri,
            selectAccount: false
          });
          const exchange = holdFirst(world, isExchange);
          const slow = yield* flows
            .callback({ ...admin, ...world.authorize("mira", url), redirectUri })
            .pipe(Effect.flip, Effect.forkChild);
          yield* exchange.sent;
          // The setup URL's return starts a newer request on the same flow, which comes back first.
          const restarted = Option.getOrThrow(yield* flows.restart({ ...admin, redirectUri }));
          yield* flows.callback({ ...admin, ...world.authorize("mira", restarted), redirectUri });
          const newer = signedInToken(yield* flows.current(admin));
          yield* exchange.release;
          assert.instanceOf(yield* Fiber.join(slow), Connection.SignInRequired);
          assert.strictEqual(signedInToken(yield* flows.current(admin)), newer);
          assert.notInclude(world.revoked, newer);
          assert.isTrue(world.revoked.some((token) => token.startsWith("ghu_") && token !== newer));
        })
      )
  );

  it.effect(
    "a token no flow takes is revoked, even when its return is interrupted; so is an expired flow's",
    () =>
      within(({ github: world }) =>
        Effect.gen(function* () {
          const flows = yield* Flows.Flows;
          const url = yield* flows.start({
            ...admin,
            purpose: "connect",
            connectionId: null,
            redirectUri,
            selectAccount: false
          });
          const isUser = (request: GithubDouble.Request) => request.url.pathname === "/user";
          const user = holdFirst(world, isUser);
          const back = yield* flows
            .callback({ ...admin, ...world.authorize("mira", url), redirectUri })
            .pipe(Effect.forkChild);
          // Exchanged, and the request for who it is still out: the return is interrupted.
          yield* user.sent;
          yield* Fiber.interrupt(back);
          const token = world.requests.find(isUser)!.authorization!.replace(/^Bearer /, "");
          assert.include(world.revoked, token);
          assert.isTrue(Option.isNone(Option.getOrThrow(yield* flows.current(admin)).signedIn));
          yield* user.release;
          // A flow that expires is swept, and the token it held then revoked.
          yield* signIn(world, admin, "mira");
          const held = signedInToken(yield* flows.current(admin));
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE github_flows SET expires_at = now() - interval '1 second'
          WHERE company_id = ${admin.companyId} AND user_id = ${admin.userId}`;
          yield* flows.sweep;
          assert.include(world.revoked, held);
        })
      )
  );

  it.effect(
    "a save revokes the token its flow holds then, though a newer return replaced the one it read",
    () =>
      within(({ github: world, ids }) =>
        Effect.gen(function* () {
          const store = yield* SqlConnectionStore.make;
          const flows = yield* Flows.Flows;
          yield* signIn(world, admin, "mira");
          const mint = holdFirst(world, isMint);
          const saving = yield* connect(store, admin, "resigned", [[ids.org, 11]]).pipe(
            Effect.forkChild
          );
          // Verified with the first token; while the save checks the installation, the admin signs
          // in again on the same flow through the setup URL.
          yield* mint.sent;
          const restarted = Option.getOrThrow(yield* flows.restart({ ...admin, redirectUri }));
          yield* flows.callback({ ...admin, ...world.authorize("mira", restarted), redirectUri });
          const newer = signedInToken(yield* flows.current(admin));
          yield* mint.release;
          yield* Fiber.join(saving);
          assert.include(world.revoked, newer);
        })
      )
  );

  it.effect("a personal account's exemption on Add and Reconnect is its own user's alone", () =>
    within(({ github: world, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        const personal = world.installations.get(ids.personal)!;
        personal.repositories.push({ id: 22, name: "notes" });
        world.people.get("mira")!.admin.add(22);
        // Someone GitHub shows administering the account's repositories, who isn't the account.
        world.person("kai", {
          id: 7003,
          login: "kai-osei",
          sees: new Set([ids.personal]),
          admin: new Set([21, 22])
        });
        const second = yield* company("ghexempt");
        yield* signIn(world, admin, "mira");
        const mine = yield* connect(store, admin, "exempt", [[ids.personal, 21]]);
        yield* signIn(world, second, "mira");
        const theirs = yield* connect(store, second, "exempt", [[ids.personal, 21]]);
        const add = () =>
          store.rotate({
            ...second,
            id: theirs.id,
            credentials: Connection.change({
              action: "repositories",
              keep: [21],
              add: [{ installationId: ids.personal, id: 22 }]
            })
          });
        yield* signIn(world, second, "kai", "add", theirs.id);
        assert.instanceOf(yield* Effect.flip(add()), Connection.InstallationClaimed);
        yield* signIn(world, second, "mira", "add", theirs.id);
        yield* add();
        // Reinstalled: a new installation on the account, which the first company claims first.
        world.installations.delete(ids.personal);
        world.add({ ...personal, id: ids.reinstalled });
        world.people.get("mira")!.sees.add(ids.reinstalled);
        world.people.get("kai")!.sees.add(ids.reinstalled);
        const reconnect = (who: Admin, id: string) =>
          store.rotate({ ...who, id, credentials: Connection.change({ action: "reconnect" }) });
        yield* signIn(world, admin, "mira", "reconnect", mine.id);
        yield* reconnect(admin, mine.id);
        yield* signIn(world, second, "kai", "reconnect", theirs.id);
        assert.instanceOf(
          yield* Effect.flip(reconnect(second, theirs.id)),
          Connection.InstallationClaimed
        );
        yield* signIn(world, second, "mira", "reconnect", theirs.id);
        yield* reconnect(second, theirs.id);
        assert.deepStrictEqual(
          yield* claims(ids.reinstalled),
          [admin.companyId, second.companyId].sort()
        );
      })
    )
  );

  it.effect(
    "Disconnect refuses a connection a Reconnect moved after it looked, and frees nothing",
    () =>
      within(({ github: world, ids }) =>
        Effect.gen(function* () {
          const store = yield* SqlConnectionStore.make;
          const sql = yield* SqlClient.SqlClient;
          yield* signIn(world, admin, "mira");
          const connection = yield* connect(store, admin, "moved", [[ids.org, 11]]);
          const locked = yield* Deferred.make<void>();
          const go = yield* Deferred.make<void>();
          // A Reconnect holds the connection's row, and moves it once Disconnect is waiting for it.
          const reconnect = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT 1 FROM connections WHERE id = ${connection.id} FOR UPDATE`;
                yield* Deferred.succeed(locked, undefined);
                yield* Deferred.await(go);
                yield* sql`UPDATE connections SET display = jsonb_set(display, '{installationId}',
                to_jsonb(${ids.reinstalled}::int)) WHERE id = ${connection.id}`;
              })
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(locked);
          const disconnect = yield* Effect.flip(store.delete({ ...admin, id: connection.id })).pipe(
            Effect.forkChild
          );
          let waiting = 0;
          while (waiting === 0) {
            yield* TestClock.withLive(Effect.sleep("5 millis"));
            const [row] = yield* sql<{ readonly waiting: number }>`SELECT count(*)::int AS waiting
            FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
            waiting = row?.waiting ?? 0;
          }
          yield* Deferred.succeed(go, undefined);
          yield* Fiber.join(reconnect);
          assert.instanceOf(yield* Fiber.join(disconnect), ConnectionStore.ConnectionChanged);
          assert.deepStrictEqual(yield* claims(ids.org), [admin.companyId]);
          // Tried again, it locks the installation the connection names now.
          yield* store.delete({ ...admin, id: connection.id });
        })
      )
  );

  it.effect(
    "a call that waited for a slot is refused by a cooldown written meanwhile, without asking GitHub",
    () =>
      within(({ github: world, ids }) =>
        Effect.gen(function* () {
          const store = yield* SqlConnectionStore.make;
          const access = yield* Access.Access;
          yield* signIn(world, admin, "mira");
          const connection = yield* connect(store, admin, "queued", [[ids.org, 11]]);
          const full = yield* occupy(world, ids.org);
          const call = yield* Effect.flip(reach(connection.id, "api")).pipe(Effect.forkChild);
          yield* full.queued;
          yield* access.cooldown(ids.org, (yield* Clock.currentTimeMillis) + 60_000);
          const before = world.requests.length;
          yield* full.release;
          assert.instanceOf(yield* Fiber.join(call), Source.RateLimited);
          assert.strictEqual(world.requests.length, before);
        })
      )
  );

  it.effect(
    "a call whose connection moved to another installation while it waited is refused",
    () =>
      within(({ github: world, org, ids }) =>
        Effect.gen(function* () {
          const store = yield* SqlConnectionStore.make;
          const sql = yield* SqlClient.SqlClient;
          yield* signIn(world, admin, "mira");
          const connection = yield* connect(store, admin, "rehomed", [[ids.org, 11]]);
          world.add({ ...org, id: ids.reinstalled });
          const full = yield* occupy(world, ids.org);
          const call = yield* Effect.flip(reach(connection.id, "api")).pipe(Effect.forkChild);
          yield* full.queued;
          // A Reconnect moves it to the account's new installation meanwhile.
          yield* sql`UPDATE connections SET credential_revision = credential_revision + 1,
            display = jsonb_set(display, '{installationId}', to_jsonb(${ids.reinstalled}::int))
          WHERE id = ${connection.id}`;
          const before = world.requests.length;
          yield* full.release;
          assert.instanceOf(yield* Fiber.join(call), Source.Unavailable);
          assert.strictEqual(world.requests.length, before);
          // The next call is admitted under the installation it names now.
          assert.strictEqual((yield* reach(connection.id, "api")).installationId, ids.reinstalled);
        })
      )
  );

  it.effect("a refused replacement mint answers unavailable, and the left marks stay", () =>
    within(({ github: world, org, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        yield* signIn(world, admin, "mira");
        const connection = yield* connect(store, admin, "replaced", [
          [ids.org, 11],
          [ids.org, 12]
        ]);
        org.repositories = org.repositories.filter((repo) => repo.id !== 12);
        // The first mint for the set is GitHub's own 422; the one for what remains is refused too.
        let mints = 0;
        world.state.override = (request) =>
          isMint(request) && request.body.includes("repository_ids") && ++mints === 2
            ? new Response(JSON.stringify({ message: "Unprocessable" }), { status: 422 })
            : undefined;
        assert.instanceOf(yield* Effect.flip(reach(connection.id, "api")), Source.Unavailable);
        const after = github(yield* store.get(admin.companyId, connection.id));
        assert.strictEqual(after.status, "connected");
        assert.deepStrictEqual(
          after.display.repositories.map((repo) => [repo.name, repo.left === true]),
          [
            ["api", false],
            ["web", true]
          ]
        );
      })
    )
  );

  it.effect("Resume finds repositories that came back, though every one had left", () =>
    within(({ github: world, org, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        yield* signIn(world, admin, "mira");
        const connection = yield* connect(store, admin, "returning", [[ids.org, 12]]);
        const web = org.repositories.find((repo) => repo.id === 12)!;
        org.repositories = org.repositories.filter((repo) => repo.id !== 12);
        assert.instanceOf(
          yield* Effect.flip(reach(connection.id, "web")),
          Connection.RepositoryNotFound
        );
        yield* store.disconnect({ ...admin, id: connection.id });
        // Still gone: Resume says that none of them are in the installation, not that GitHub failed.
        const gone = yield* Effect.flip(store.reconnect({ ...admin, id: connection.id }));
        assert.include(
          gone.message,
          "None of this connection's repositories are in Patchy Cloud's"
        );
        // Put back on GitHub; Refresh refuses a paused connection, and Resume reads it again first.
        org.repositories.push(web);
        const resumed = github(yield* store.reconnect({ ...admin, id: connection.id }));
        assert.strictEqual(resumed.status, "connected");
        assert.isFalse(resumed.display.repositories.some((repo) => repo.left === true));
        assert.strictEqual((yield* reach(connection.id, "web")).repositoryId, 12);
      })
    )
  );

  it.effect("a slot's one deadline bounds all the work it holds, however many steps", () =>
    within(() =>
      Effect.gen(function* () {
        const source = yield* Source.Source;
        const start = yield* Clock.currentTimeMillis;
        // Two steps, each within the deadline alone, but not together.
        const held = yield* source
          .withSlot(
            1,
            start + 15_000
          )(Effect.forEach([1, 2], () => Effect.sleep("10 seconds"), { discard: true }))
          .pipe(Effect.flip, Effect.forkChild);
        assert.instanceOf(yield* settled(held), Source.Timeout);
        assert.isAtMost((yield* Clock.currentTimeMillis) - start, 16_000);
      })
    )
  );

  it.effect("Refresh has longer than a call's deadline to read an installation", () =>
    within(({ github: world, ids }) =>
      Effect.gen(function* () {
        const store = yield* SqlConnectionStore.make;
        yield* signIn(world, admin, "mira");
        const connection = yield* connect(store, admin, "unhurried", [[ids.org, 11]]);
        const sentSince = (from: number, path: (pathname: string) => boolean) =>
          until(() => world.requests.slice(from).some((request) => path(request.url.pathname)));
        // Two requests of ten seconds each: either fits a call's deadline, both don't.
        const from = world.requests.length;
        const read = holdFirst(world, (request) =>
          request.url.pathname.startsWith("/app/installations/")
        );
        const refresh = yield* store
          .refresh({ ...admin, id: connection.id })
          .pipe(Effect.forkChild);
        yield* sentSince(from, (pathname) => pathname.startsWith("/app/installations/"));
        yield* TestClock.adjust("10 seconds");
        const listed = world.requests.length;
        const listing = holdFirst(
          world,
          (request) => request.url.pathname === "/installation/repositories"
        );
        yield* read.release;
        yield* sentSince(listed, (pathname) => pathname === "/installation/repositories");
        yield* TestClock.adjust("10 seconds");
        yield* listing.release;
        assert.strictEqual(github(yield* Fiber.join(refresh)).status, "connected");
      })
    )
  );

  it.effect("a person's own reads wait their turn in GitHub's host-wide slots", () =>
    within(({ github: world }) =>
      Effect.gen(function* () {
        const flows = yield* Flows.Flows;
        const source = yield* Source.Source;
        yield* signIn(world, admin, "mira");
        const token = Redacted.make(signedInToken(yield* flows.current(admin)));
        const go = yield* Deferred.make<void>();
        const deadline = (yield* Clock.currentTimeMillis) + 60_000;
        // Every one of GitHub's slots in this process is held, each through its own installation.
        for (let slot = 0; slot < registry["github.host.concurrent"].default; slot++) {
          const entered = yield* Deferred.make<void>();
          yield* source
            .withSlot(
              90_000 + slot,
              deadline
            )(Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)))
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
        }
        const before = world.requests.length;
        const listing = yield* flows.listing(token).pipe(Effect.flip, Effect.forkChild);
        const refused = yield* settled(listing);
        assert.instanceOf(refused, Source.Busy);
        assert.strictEqual(refused.limitId, "github.host.concurrent");
        assert.strictEqual(world.requests.length, before);
        yield* Deferred.succeed(go, undefined);
      })
    )
  );

  it.effect(
    "the listing pages through installations to its bound, and says when there were more",
    () =>
      within(({ github: world, ids }) =>
        Effect.gen(function* () {
          const flows = yield* Flows.Flows;
          const bound = registry["github.picker.installations"].default;
          const many = Array.from({ length: bound + 1 }, (_, at) => ids.org + 100 + at);
          for (const [at, id] of many.entries())
            world.add({
              id,
              account: { id: 60_000 + at, login: `account-${at}`, type: "Organization" },
              repositories: at === 0 ? [{ id: 41, name: "first" }] : []
            });
          world.person("wide", {
            id: 7004,
            login: "wide-reach",
            sees: new Set(many),
            admin: new Set([41])
          });
          yield* signIn(world, admin, "wide");
          const listed = yield* flows.listing(
            Redacted.make(signedInToken(yield* flows.current(admin)))
          );
          assert.lengthOf(listed.accounts, bound);
          assert.isFalse(listed.complete);
          const page = Page.connectSpec({
            signIn: {
              kind: "signed-in",
              login: "wide-reach",
              listed,
              installUrl: "https://github.com"
            },
            query: "",
            chosen: []
          });
          assert.include(
            page.choose?.({})[0]?.body ?? "",
            `Showing what you administer on the first ${bound} accounts GitHub listed for you.`
          );
          // With nothing administered among those read, the empty answer says how far it read.
          const empty = Page.connectSpec({
            signIn: {
              kind: "signed-in",
              login: "wide-reach",
              listed: { accounts: [], complete: false },
              installUrl: "https://github.com"
            },
            query: "",
            chosen: []
          });
          assert.include(
            empty.choose?.({})[0]?.body ?? "",
            `Patchy read only the first ${bound} accounts GitHub listed for you.`
          );
        })
      )
  );
});
