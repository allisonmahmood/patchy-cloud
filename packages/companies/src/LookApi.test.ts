import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import {
  Authorization,
  authorizationClient,
  CurrentIdentity,
  Identity,
  LookPublishRequest,
  LookRestoreRequest,
  PatchyApi,
  refuse,
  Unauthorized
} from "@patchy/api";
import * as Testing from "@patchy/sql/testing";
import { readLookFixture } from "../../../test/look-fixtures.js";
import * as LookApi from "./LookApi.js";
import * as Looks from "./Looks.js";
import * as Users from "./Users.js";

const events: Analytics.AnalyticsEvent[] = [];
const recording = Layer.succeed(
  Analytics.Analytics,
  Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
);

/** Bearer `<user id>` acts as that active user. Machine tokens are Auth's to test. */
const bearer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return Authorization.of({
      bearer: (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const userId = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
          const rows = yield* sql<{
            id: string;
            email: string;
            name: string;
            role: "member" | "admin";
            companyId: string;
            handle: string;
            companyName: string;
          }>`SELECT u.id, u.email, u.name, u.role, c.id AS "companyId", c.handle,
              c.name AS "companyName"
            FROM users u JOIN companies c ON c.id = u.company_id
            WHERE u.id = ${userId} AND u.deactivated_at IS NULL`.pipe(Effect.orDie);
          const row = Option.fromNullishOr(rows[0]);
          if (Option.isNone(row))
            return refuse(Unauthorized, { ok: false, error: "Missing or invalid API token." });
          const { id, email, name, role, companyId, handle, companyName } = row.value;
          return yield* Effect.provideService(
            httpEffect,
            CurrentIdentity,
            new Identity({
              user: { id, email, name },
              company: { id: companyId, handle, name: companyName },
              role,
              machine: { id: `mch_${id}`, name: "Laptop" }
            })
          );
        })
    });
  })
);

const layer = Layer.mergeAll(LookApi.layer, HttpServer.layerServices).pipe(
  Layer.provideMerge(bearer),
  Layer.provideMerge(Layer.mergeAll(Looks.layer, Users.layer, recording)),
  Layer.provideMerge(Testing.layer())
);

/** A company with admins Ada and Cleo, a member Ben and a deactivated admin Dot. */
const company = Effect.fn("company")(function* (handle: string) {
  const sql = yield* SqlClient.SqlClient;
  const id = `cmp_${handle}`;
  yield* sql`INSERT INTO companies (id, handle, name) VALUES (${id}, ${handle}, 'Acme Co')`;
  const people = {
    ada: ["Ada Lovelace", "admin"],
    cleo: ["Cleo Park", "admin"],
    ben: ["Ben Okafor", "member"],
    dot: ["Dot Reyes", "admin"]
  } as const;
  for (const [key, [name, role]] of Object.entries(people)) {
    yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role, deactivated_at)
      VALUES (${`usr_${handle}_${key}`}, ${`clerk_${handle}_${key}`}, ${id},
        ${`${key}@${handle}.example`}, ${name}, ${role}, ${key === "dot" ? new Date() : null})`;
  }
  const client = (key: keyof typeof people) =>
    HttpApiTest.groups(PatchyApi, ["look"]).pipe(
      Effect.provide(authorizationClient(Redacted.make(`usr_${handle}_${key}`)))
    );
  return {
    ada: { id: `usr_${handle}_ada`, api: yield* client("ada") },
    ben: { id: `usr_${handle}_ben`, api: yield* client("ben") }
  };
});

const publish = (note: string, files = readLookFixture("patchy")) => ({
  payload: new LookPublishRequest({ note, files })
});
const restore = (revision: number | null) => ({ payload: new LookRestoreRequest({ revision }) });

it.layer(layer)("look group", (it) => {
  it.effect(
    "an admin publishes revisions 1 and 2, restores 1 and then none, and a member reads each state",
    () =>
      Effect.gen(function* () {
        events.length = 0;
        const { ada, ben } = yield* company("lifecycle");
        const author = { id: ada.id, name: "Ada Lovelace" };
        const first = yield* ada.api.publishLook(publish("first capture"));
        assert.deepInclude(first.current, { revision: 1, author, note: "first capture" });
        const second = yield* ada.api.publishLook(
          publish("  darker   green ", readLookFixture("linear"))
        );
        assert.deepInclude(second.current, { revision: 2, author, note: "darker green" });

        const response = yield* ben.api.getLook({ responseMode: "response-only" });
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
        const two = yield* ben.api.getLook();
        assert.deepStrictEqual(two.current?.files, readLookFixture("linear"));
        assert.deepInclude(two.current, { revision: 2, note: "darker green" });
        assert.deepStrictEqual(
          two.revisions.map(({ revision, author, note }) => ({ revision, author, note })),
          [
            { revision: 2, author, note: "darker green" },
            { revision: 1, author, note: "first capture" }
          ]
        );

        const restored = yield* ada.api.restoreLook(restore(1));
        assert.strictEqual(restored.current?.revision, 1);
        const one = yield* ben.api.getLook();
        assert.deepStrictEqual(one.current?.files, readLookFixture("patchy"));
        assert.deepStrictEqual(
          one.revisions.map(({ revision }) => revision),
          [2, 1]
        );

        assert.deepStrictEqual(
          { ...(yield* ada.api.restoreLook(restore(null))) },
          {
            ok: true,
            current: null
          }
        );
        const none = yield* ben.api.getLook();
        assert.strictEqual(none.current, null);
        assert.strictEqual(none.revisions.length, 2);
        // Restoring the current state changes nothing and reports nothing.
        yield* ada.api.restoreLook(restore(null));

        const bytes = (files: object) => Buffer.byteLength(Object.values(files).join(""));
        assert.deepStrictEqual(
          events.map(({ name, principalId, properties }) => ({ name, principalId, properties })),
          [
            {
              name: "look.published",
              principalId: ada.id,
              properties: {
                revision: 1,
                fromRevision: null,
                bytes: bytes(readLookFixture("patchy")),
                logo: true
              }
            },
            {
              name: "look.published",
              principalId: ada.id,
              properties: {
                revision: 2,
                fromRevision: 1,
                bytes: bytes(readLookFixture("linear")),
                logo: false
              }
            },
            {
              name: "look.restored",
              principalId: ada.id,
              properties: { revision: 1, fromRevision: 2 }
            },
            {
              name: "look.restored",
              principalId: ada.id,
              properties: { revision: null, fromRevision: 1 }
            }
          ]
        );
      })
  );

  it.effect("refuses a member's publish and restore, naming the company's active admins", () =>
    Effect.gen(function* () {
      const { ada, ben } = yield* company("members");
      yield* ada.api.publishLook(publish("first capture"));
      const admins = [
        { id: "usr_members_ada", name: "Ada Lovelace" },
        { id: "usr_members_cleo", name: "Cleo Park" }
      ];
      for (const refused of [
        yield* ben.api.publishLook(publish("mine now")).pipe(Effect.flip),
        yield* ben.api.restoreLook(restore(null)).pipe(Effect.flip)
      ]) {
        assert.deepStrictEqual(refused, {
          ok: false,
          code: "admin_required",
          error: "Only an admin can change Acme Co's look. Ask Ada Lovelace or Cleo Park.",
          admins
        });
      }
      const look = yield* ben.api.getLook();
      assert.strictEqual(look.current?.revision, 1);
      assert.strictEqual(look.revisions.length, 1);
    })
  );

  it.effect("refuses a look that fails its checks, storing nothing, and accepts it fixed", () =>
    Effect.gen(function* () {
      const { ada } = yield* company("checks");
      const fixed = readLookFixture("patchy");
      const failing = {
        ...fixed,
        "look.css": fixed["look.css"].replace("--look-muted: #69645a;", "--look-muted: #7d786d;")
      };
      assert.deepStrictEqual(
        yield* ada.api.publishLook(publish("too faint", failing)).pipe(Effect.flip),
        {
          ok: false,
          code: "invalid_look",
          error: "The look failed its checks; nothing was published.",
          errors: [
            "--look-muted on --look-bg is 4.31:1; text colours need 4.5:1.",
            "--look-muted on --look-surface is 4.35:1; text colours need 4.5:1."
          ]
        }
      );
      assert.deepStrictEqual({ ...(yield* ada.api.getLook()) }, { current: null, revisions: [] });
      assert.strictEqual(
        (yield* ada.api.publishLook(publish("readable", fixed))).current.revision,
        1
      );
    })
  );

  it.effect("keeps each company's look and revisions to that company", () =>
    Effect.gen(function* () {
      const home = yield* company("home");
      const other = yield* company("other");
      yield* other.ada.api.publishLook(publish("theirs"));
      assert.deepStrictEqual(
        { ...(yield* home.ben.api.getLook()) },
        { current: null, revisions: [] }
      );
      assert.deepInclude(yield* home.ada.api.restoreLook(restore(1)).pipe(Effect.flip), {
        code: "revision_unavailable",
        error: "Acme Co has no look revision 1."
      });
    })
  );

  it.effect("numbers concurrent publishes one after the other", () =>
    Effect.gen(function* () {
      const { ada } = yield* company("racing");
      const published = yield* Effect.all(
        Array.from({ length: 6 }, (_, index) => ada.api.publishLook(publish(`take ${index}`))),
        { concurrency: "unbounded" }
      );
      assert.deepStrictEqual(
        published.map(({ current }) => current.revision).sort(),
        [1, 2, 3, 4, 5, 6]
      );
    })
  );
});
