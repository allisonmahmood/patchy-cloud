import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { Companies, Directory, Guests, Users } from "@patchy/companies";
import * as Testing from "@patchy/sql/testing";
import * as AgentConnections from "./AgentConnections.js";
import * as MachineTokens from "./MachineTokens.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { clerkEnv } from "./testing.js";

// Resolves `claims` as their viewer, and answers the statements the resolve sent.
const resolve = Effect.fn("RequireSessionTest.resolve")(function* (claims: {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
}) {
  const statements: Array<string> = [];
  const viewer = yield* RequireSession.resolveViewer.pipe(
    Effect.provideService(RequireSession.SignedIn, { ...claims, sid: "sess_resolve" }),
    Effect.provideService(Statement.CurrentTransformer, (statement) =>
      Effect.sync(() => {
        statements.push(statement.compile()[0]);
        return statement;
      })
    )
  );
  return { viewer, statements };
});

const createCompany = Effect.fn("RequireSessionTest.createCompany")(function* (handle: string) {
  const companies = yield* Companies.Companies;
  return yield* companies.create({
    handle,
    name: `${handle} Inc`,
    clerkUserId: `user_${handle}`,
    email: `${handle}@example.com`,
    userName: "Ada"
  });
});

const targetIdentity = Effect.fn("RequireSessionTest.targetIdentity")(function* (
  companyId: string,
  claims: { readonly clerkUserId: string; readonly email: string; readonly name: string }
) {
  return yield* RequireSession.resolveCompanyIdentity(companyId).pipe(
    Effect.provideService(RequireSession.SignedIn, {
      sub: claims.clerkUserId,
      email: claims.email,
      name: claims.name,
      sid: "sess_guest"
    })
  );
});

const guestIdentity = (guest: Guests.Guest) =>
  ({
    kind: "guest",
    guest: { id: guest.id, email: guest.email, name: guest.name },
    companyId: guest.companyId,
    role: "guest"
  }) satisfies RequireSession.CompanyIdentity;

const connectAgent = (userId: string) =>
  AgentConnections.AgentConnections.use((connections) =>
    connections.create({ userId, clientId: "https://claude.ai/client.json", clientName: "Claude" })
  );

it.layer(
  Layer.mergeAll(
    Session.layer,
    Companies.layer,
    Users.layer,
    Directory.layer,
    MachineTokens.layer,
    AgentConnections.layer
  ).pipe(
    Layer.provideMerge(Testing.layer()),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
  )
)("resolveViewer", (it) => {
  it.effect("resolves a viewer in one statement, and refreshes changed claims in three", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const created = yield* createCompany("resolve-one");
      const viewer = (email: string, name: string) =>
        RequireSession.Viewer.of({
          user: { id: created.user.id, email, name },
          company: {
            id: created.company.id,
            handle: created.company.handle,
            name: created.company.name
          },
          role: "admin",
          whatsNewSeen: created.user.whatsNewSeen
        });
      const sub = created.user.clerkUserId;
      const unchanged = yield* resolve({ sub, email: "Resolve-One@Example.com", name: "Ada" });
      assert.deepStrictEqual(unchanged.viewer, viewer("resolve-one@example.com", "Ada"));
      assert.lengthOf(unchanged.statements, 1);
      const changed = yield* resolve({ sub, email: "moved@example.com", name: "Grace" });
      assert.deepStrictEqual(changed.viewer, viewer("moved@example.com", "Grace"));
      // Changed claims add the write and a read of the company after it.
      assert.lengthOf(changed.statements, 3);
      assert.deepInclude(yield* users.findByClerkId(sub), {
        email: "moved@example.com",
        name: "Grace"
      });
      const absent = yield* resolve({ sub: "user_absent", email: "absent@example.com", name: "" });
      assert.isNull(absent.viewer);
      assert.lengthOf(absent.statements, 1);
    })
  );

  it.effect("refuses a deactivated user with the sign-out page", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { user } = yield* createCompany("resolve-deactivated");
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${user.id}`;
      const { viewer, statements } = yield* resolve({
        sub: user.clerkUserId,
        email: user.email,
        name: user.name
      });
      if (!HttpServerResponse.isHttpServerResponse(viewer))
        return assert.fail("expected the deactivated page");
      const page = HttpServerResponse.toWeb(viewer);
      assert.strictEqual(page.status, 403);
      assert.include(
        yield* Effect.promise(() => page.text()),
        "Your account at resolve-deactivated Inc is deactivated"
      );
      assert.lengthOf(statements, 1);
    })
  );

  it.effect("treats a user whose company row is missing as a defect", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { user } = yield* createCompany("resolve-orphan");
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Replica mode skips the foreign key and the directory trigger, so the row can
            // point nowhere; the rollback puts it back.
            yield* sql`SET LOCAL session_replication_role = replica`;
            yield* sql`UPDATE users SET company_id = 'cmp_missing' WHERE id = ${user.id}`;
            const exit = yield* Effect.exit(
              resolve({ sub: user.clerkUserId, email: user.email, name: user.name })
            );
            assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
            const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
            assert.strictEqual(
              defect instanceof Error ? defect.message : defect,
              "User company is missing"
            );
            return yield* Effect.fail("rollback");
          })
        )
        .pipe(Effect.flip);
    })
  );

  it.effect("keeps A member authority separate from B and C guest identities", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const directory = yield* Directory.Directory;
      const tokens = yield* MachineTokens.MachineTokens;
      const agents = yield* AgentConnections.AgentConnections;
      const a = yield* createCompany("identity-a");
      const b = yield* createCompany("identity-b");
      const c = yield* createCompany("identity-c");
      const bg = yield* Guests.create({ ...a.user, companyId: b.company.id });
      const cg = yield* Guests.create({ ...a.user, companyId: c.company.id });
      const member = (yield* resolve({ sub: a.user.clerkUserId, ...a.user })).viewer;
      if (!member || HttpServerResponse.isHttpServerResponse(member))
        return assert.fail("expected A's active member viewer");
      assert.deepStrictEqual(yield* targetIdentity(a.company.id, a.user), {
        kind: "member",
        viewer: member
      });
      assert.deepStrictEqual(yield* targetIdentity(b.company.id, a.user), guestIdentity(bg));
      assert.deepStrictEqual(yield* targetIdentity(c.company.id, a.user), guestIdentity(cg));
      assert.isNull(yield* targetIdentity("cmp_unrelated", a.user));
      // Neither target's guest lookup changes A's role or enrolls the person in B/C.
      assert.strictEqual((yield* users.findByClerkId(a.user.clerkUserId))?.id, a.user.id);
      assert.strictEqual((yield* users.list(b.company.id)).length, 1);
      assert.isNull(yield* directory.get(b.company.id, bg.id));
      assert.isNull(yield* directory.get(c.company.id, cg.id));
      const machine = yield* tokens.mint({ userId: a.user.id, name: "A laptop" });
      const agent = yield* connectAgent(a.user.id);
      assert.strictEqual((yield* tokens.authenticate(machine.token))?.company.id, a.company.id);
      assert.strictEqual(
        (yield* agents.authenticate(agent.tokens.accessToken))?.company.id,
        a.company.id
      );
      assert.deepStrictEqual(
        (yield* resolve({ sub: a.user.clerkUserId, ...a.user })).viewer,
        member
      );
    })
  );

  it.effect("resolves a guest-only account without enrollment or member capabilities", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const tokens = yield* MachineTokens.MachineTokens;
      const directory = yield* Directory.Directory;
      const b = yield* createCompany("only-guest-b");
      const c = yield* createCompany("only-guest-c");
      const claims = { clerkUserId: "clerk_guest_only", email: "guest@example.com", name: "Guest" };
      const bg = yield* Guests.create({ ...claims, companyId: b.company.id });
      const cg = yield* Guests.create({ ...claims, companyId: c.company.id });
      assert.deepStrictEqual(yield* targetIdentity(b.company.id, claims), guestIdentity(bg));
      assert.deepStrictEqual(yield* targetIdentity(c.company.id, claims), guestIdentity(cg));
      assert.isNull((yield* resolve({ sub: claims.clerkUserId, ...claims })).viewer);
      assert.isNull(yield* users.findByClerkId(claims.clerkUserId));
      assert.isNull(yield* users.findByEmail(claims.email));
      assert.isNull(yield* directory.get(b.company.id, bg.id));
      assert.deepStrictEqual(
        (yield* directory.list(b.company.id, 20)).rows.map((row) => row.id),
        [b.user.id]
      );
      assert.strictEqual(
        (yield* Effect.flip(tokens.mint({ userId: bg.id, name: "Guest laptop" })))._tag,
        "UserUnavailable"
      );
      assert.strictEqual((yield* Effect.flip(connectAgent(bg.id)))._tag, "UserUnavailable");
      assert.isNull(
        yield* targetIdentity(b.company.id, { ...claims, clerkUserId: "someone_else" })
      );
    })
  );

  it.effect("applies member and guest deactivation independently on every resolution", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tokens = yield* MachineTokens.MachineTokens;
      const agents = yield* AgentConnections.AgentConnections;
      const a = yield* createCompany("inactive-a");
      const b = yield* createCompany("inactive-b");
      const c = yield* createCompany("inactive-c");
      const bg = yield* Guests.create({ ...a.user, companyId: b.company.id });
      const cg = yield* Guests.create({ ...a.user, companyId: c.company.id });
      const machine = yield* tokens.mint({ userId: a.user.id, name: "A laptop" });
      const agent = yield* connectAgent(a.user.id);
      const ref = { companyId: b.company.id, clerkUserId: a.user.clerkUserId };
      yield* Guests.setDeactivated({ ...ref, deactivated: true });
      assert.isNull(yield* targetIdentity(b.company.id, a.user));
      assert.deepStrictEqual(yield* targetIdentity(c.company.id, a.user), guestIdentity(cg));
      assert.deepInclude(yield* targetIdentity(a.company.id, a.user), { kind: "member" });
      assert.strictEqual((yield* tokens.authenticate(machine.token))?.user.id, a.user.id);
      assert.strictEqual(
        (yield* agents.authenticate(agent.tokens.accessToken))?.user.id,
        a.user.id
      );
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${a.user.id}`;
      const own = yield* targetIdentity(a.company.id, a.user);
      assert.isTrue(HttpServerResponse.isHttpServerResponse(own) && own.status === 403);
      const member = (yield* resolve({ sub: a.user.clerkUserId, ...a.user })).viewer;
      assert.isTrue(HttpServerResponse.isHttpServerResponse(member) && member.status === 403);
      assert.isNull(yield* tokens.authenticate(machine.token));
      assert.isNull(yield* agents.authenticate(agent.tokens.accessToken));
      assert.strictEqual(
        (yield* Effect.flip(tokens.mint({ userId: a.user.id, name: "Denied" })))._tag,
        "UserUnavailable"
      );
      assert.strictEqual((yield* Effect.flip(connectAgent(a.user.id)))._tag, "UserUnavailable");
      assert.isNull(yield* targetIdentity(b.company.id, a.user));
      assert.deepStrictEqual(yield* targetIdentity(c.company.id, a.user), guestIdentity(cg));
      yield* Guests.setDeactivated({ ...ref, deactivated: false });
      assert.deepStrictEqual(yield* targetIdentity(b.company.id, a.user), guestIdentity(bg));
      yield* Guests.end(ref);
      assert.isNull(yield* targetIdentity(b.company.id, a.user));
      assert.deepStrictEqual(yield* targetIdentity(c.company.id, a.user), guestIdentity(cg));
    })
  );

  it.effect("refreshes guest claims by Clerk identity within only the target company", () =>
    Effect.gen(function* () {
      const b = yield* createCompany("claims-guest-b");
      const c = yield* createCompany("claims-guest-c");
      const claims = { clerkUserId: "clerk_guest_claims", email: "old@example.com", name: "Old" };
      const bg = yield* Guests.create({ ...claims, companyId: b.company.id });
      const cg = yield* Guests.create({ ...claims, companyId: c.company.id });
      const changed = { ...claims, email: "New@Example.com", name: " " };
      const expected = {
        ...guestIdentity(bg),
        guest: { id: bg.id, email: "new@example.com", name: "new" }
      };
      assert.deepStrictEqual(yield* targetIdentity(b.company.id, changed), expected);
      assert.deepStrictEqual(yield* targetIdentity(b.company.id, changed), expected);
      assert.deepStrictEqual(yield* Guests.findById(cg.id), cg);
      yield* Guests.end({ companyId: b.company.id, clerkUserId: claims.clerkUserId });
      assert.isNull(yield* targetIdentity(b.company.id, { ...claims, name: "Later" }));
      assert.strictEqual((yield* Guests.findById(bg.id))?.name, "new");
    })
  );

  it.effect(
    "uses membership after same-company conversion, with no guest fallback on deactivation",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const b = yield* createCompany("convert-guest-b");
        const claims = {
          clerkUserId: "clerk_convert_guest",
          email: "convert@example.com",
          name: "Mia"
        };
        const bg = yield* Guests.create({ ...claims, companyId: b.company.id });
        yield* sql`INSERT INTO users (id, company_id, clerk_user_id, email, name, role)
        VALUES ('usr_convert_guest', ${b.company.id}, ${claims.clerkUserId}, ${claims.email}, ${claims.name}, 'member')`;
        const identity = yield* targetIdentity(b.company.id, claims);
        if (
          !identity ||
          HttpServerResponse.isHttpServerResponse(identity) ||
          identity.kind !== "member"
        )
          return assert.fail("expected the real member viewer");
        assert.strictEqual(identity.viewer.user.id, "usr_convert_guest");
        assert.strictEqual(identity.viewer.role, "member");
        assert.instanceOf((yield* Guests.findById(bg.id))?.endedAt, Date);
        yield* sql`UPDATE users SET deactivated_at = now() WHERE id = 'usr_convert_guest'`;
        const inactive = yield* targetIdentity(b.company.id, claims);
        assert.isTrue(HttpServerResponse.isHttpServerResponse(inactive) && inactive.status === 403);
      })
  );
});
