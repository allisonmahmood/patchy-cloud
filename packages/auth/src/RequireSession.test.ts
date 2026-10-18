import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { Companies, Users } from "@patchy/companies";
import * as Testing from "@patchy/sql/testing";
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

it.layer(
  Layer.mergeAll(Session.layer, Companies.layer, Users.layer).pipe(
    Layer.provideMerge(Testing.layer()),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
  )
)("resolveViewer", (it) => {
  it.effect("resolves a viewer in one statement, applying changed claims", () =>
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
      assert.lengthOf(changed.statements, 1);
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
});
