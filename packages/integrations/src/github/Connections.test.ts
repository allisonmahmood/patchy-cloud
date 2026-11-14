import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { Companies, Teams, Users } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import type * as ConnectionStore from "../ConnectionStore.js";
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
          listed.map((item) => [item.account.login, item.repositories.map((repo) => repo.name)]),
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
        const [row] = yield* sql<{
          readonly credentials: string;
        }>`SELECT credentials FROM connections
          WHERE id = ${connection.id}`;
        assert.notInclude(row!.credentials, "ids.org");
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
    "a repository gone from the installation is marked left, and refused before GitHub",
    () =>
      within(({ github: world, org, ids }) =>
        Effect.gen(function* () {
          const store = yield* SqlConnectionStore.make;
          yield* signIn(world, admin, "mira");
          const connection = yield* connect(store, admin, "leaving", [
            [ids.org, 11],
            [ids.org, 12]
          ]);
          // Taken out of the installation, transferred or made private outside it: the mint answers 422.
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
});
