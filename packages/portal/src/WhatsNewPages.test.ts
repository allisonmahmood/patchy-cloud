import { assert, describe, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import { Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { WhatsNew } from "@patchy/core";
import * as Testing from "@patchy/company-database/testing";
import * as WhatsNewPages from "./WhatsNewPages.js";

const services = Layer.mergeAll(Session.layer, Companies.layer, Users.layer).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(Testing.resourceChangesLayer),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);
const layer = HttpRouter.serve(WhatsNewPages.layer, {
  disableLogger: true,
  disableListenLog: true
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(services),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
);

let counter = 0;
/** A member who last looked at What's new when `seen` was the newest release. */
const person = Effect.fn("WhatsNewPagesTest.person")(function* (seen: number) {
  const sql = yield* SqlClient.SqlClient;
  const id = `whats_new_${++counter}`;
  yield* sql`INSERT INTO companies (id, handle, name) VALUES (${`cmp_${id}`}, ${`whats-new-${counter}`}, 'Northwind')`;
  yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role, whats_new_seen)
    VALUES (${`usr_${id}`}, ${`clerk_${id}`}, ${`cmp_${id}`}, ${`${id}@patchy.local`}, 'Sam', 'member', ${seen})`;
  return { id: `usr_${id}`, clerkUserId: `clerk_${id}`, email: `${id}@patchy.local` };
});
type Person = Effect.Success<ReturnType<typeof person>>;

const request = Effect.fn("WhatsNewPagesTest.request")(function* (
  who: Person,
  input: HttpClientRequest.HttpClientRequest
) {
  const cookie = signedInCookies(
    signSession({ sub: who.clerkUserId, email: who.email, name: "Sam" })
  );
  return yield* (yield* HttpClient.HttpClient).execute(
    input.pipe(HttpClientRequest.setHeaders({ cookie }))
  );
});
const seenBy = (who: Person) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ seen: number }>`SELECT whats_new_seen AS seen FROM users WHERE id = ${who.id}`
  ).pipe(Effect.map((rows) => rows[0]?.seen));
const seenPost = (through: string, origin = PUBLIC_BASE_URL) =>
  HttpClientRequest.post("/whats-new/seen").pipe(
    HttpClientRequest.bodyText(
      new URLSearchParams({ through }).toString(),
      "application/x-www-form-urlencoded"
    ),
    HttpClientRequest.setHeaders({ origin })
  );

it.layer(layer)("What's new pages", (it) => {
  it.effect("highlights what shipped since the last visit, then counts the visit as seen", () =>
    Effect.gen(function* () {
      const sam = yield* person(0);
      const first = yield* (yield* request(sam, HttpClientRequest.get("/whats-new"))).text;
      assert.strictEqual(
        first.match(/whats-new-change whats-new-unseen/g)?.length ?? 0,
        WhatsNew.changesSince(0).length
      );
      // The bell on the page itself is already caught up.
      assert.notInclude(first, 'class="whats-new-dot"');
      assert.strictEqual(yield* seenBy(sam), WhatsNew.latestRelease);

      const again = yield* (yield* request(sam, HttpClientRequest.get("/whats-new"))).text;
      assert.notInclude(again, "whats-new-change whats-new-unseen");
    })
  );

  it.effect(
    "takes the bell's report from this site only, and never moves the marker back or past the newest",
    () =>
      Effect.gen(function* () {
        const sam = yield* person(0);
        const elsewhere = yield* request(
          sam,
          seenPost(String(WhatsNew.latestRelease), "https://evil.example")
        );
        assert.strictEqual(elsewhere.status, 403);
        assert.strictEqual(yield* seenBy(sam), 0);

        assert.strictEqual(
          (yield* request(sam, seenPost(String(WhatsNew.latestRelease + 5)))).status,
          204
        );
        assert.strictEqual(yield* seenBy(sam), WhatsNew.latestRelease);
        assert.strictEqual((yield* request(sam, seenPost("0"))).status, 204);
        assert.strictEqual(yield* seenBy(sam), WhatsNew.latestRelease);
        assert.strictEqual((yield* request(sam, seenPost("soon"))).status, 400);
      })
  );
});

describe("the changelog", () => {
  const release = (id: number, date: string, title: string): WhatsNew.Release => ({
    id,
    date,
    through: String(id).repeat(40).slice(0, 40),
    changes: [{ kind: "Fixed", title, detail: `${title} works again.`, prs: [id] }],
    behindTheScenes: []
  });
  // Two releases went out on the 7th, one on the 6th.
  const releases = [
    release(3, "2026-10-07", "Third"),
    release(2, "2026-10-07", "Second"),
    release(1, "2026-10-06", "First")
  ];
  /** The page's changes and seen rule, in reading order. */
  const reading = (seen: number) =>
    [
      ...WhatsNewPages.render(releases, seen).matchAll(
        /<strong>(\w+)<\/strong>|You’ve seen everything below/g
      )
    ].map(([, title]) => title ?? "rule");
  const tinted = (seen: number) =>
    WhatsNewPages.render(releases, seen).match(/whats-new-change whats-new-unseen/g)?.length ?? 0;

  it("rules off where seen changes begin, inside a day or between days", () => {
    assert.deepStrictEqual(reading(2), ["Third", "rule", "Second", "First"]);
    assert.deepStrictEqual(reading(1), ["Third", "Second", "rule", "First"]);
    assert.strictEqual(tinted(2), 1);
    assert.strictEqual(tinted(1), 2);
  });

  it("has no rule or tint once everything is seen, and tints it all for someone new to it", () => {
    assert.deepStrictEqual(reading(3), ["Third", "Second", "First"]);
    assert.strictEqual(tinted(3), 0);
    assert.deepStrictEqual(reading(0), ["Third", "Second", "First"]);
    assert.strictEqual(tinted(0), 3);
  });
});
