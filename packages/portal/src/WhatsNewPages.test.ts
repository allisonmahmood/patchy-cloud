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
import { WhatsNew, WhatsNewLinks } from "@patchy/core";
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

/** Each change a page shows, in reading order: its permalink's id, and whether it starts open. */
const changes = (html: string) =>
  html
    .split('<details class="change"')
    .slice(1)
    .flatMap((entry) => {
      const id = entry.match(/<div class="change-body" id="([^"]+)">/)?.[1];
      return id === undefined ? [] : [{ id, open: entry.startsWith(" open>") }];
    });
/** The ids of every change a page shows, in reading order. */
const shown = (html: string) => changes(html).map(({ id }) => id);
/** The ids of the changes a page shows open and marked new to the viewer, in reading order. */
const marked = (html: string) => {
  const open = changes(html).filter((change) => change.open);
  assert.strictEqual(
    html.match(/aria-label="New to you"/g)?.length ?? 0,
    open.length,
    "every open change, and only those, carries the new-to-you dot"
  );
  return open.map(({ id }) => id);
};
/** The ids of a month's changes that shipped after `seen`. */
const newIn = (month: string, seen: number) =>
  WhatsNew.releases
    .filter((release) => WhatsNewLinks.monthOf(release) === month && release.id > seen)
    .flatMap((release) => release.changes.map((_, n) => WhatsNewLinks.changeId(release, n)));
const months = [...new Set(WhatsNew.releases.map(WhatsNewLinks.monthOf))];
const newest = months[0]!;

it.layer(layer)("What's new pages", (it) => {
  it.effect(
    "open the newest month, mark what shipped since the last visit, then count it seen",
    () =>
      Effect.gen(function* () {
        const sam = yield* person(0);
        const first = yield* request(sam, HttpClientRequest.get("/whats-new"));
        assert.strictEqual(first.status, 200);
        const html = yield* first.text;
        assert.deepStrictEqual(shown(html), newIn(newest, -1));
        assert.deepStrictEqual(marked(html), newIn(newest, 0));
        // The bell on the page itself is already caught up.
        assert.notInclude(html, 'class="whats-new-dot"></span>');
        assert.strictEqual(yield* seenBy(sam), WhatsNew.latestRelease);
        // Its earlier month carries the marker the page was drawn with, so it still marks.
        assert.include(html, `href="/whats-new/${months[1]}?since=0"`);

        const again = yield* (yield* request(sam, HttpClientRequest.get(`/whats-new/${newest}`)))
          .text;
        assert.deepStrictEqual(shown(again), shown(html));
        assert.deepStrictEqual(marked(again), []);
      })
  );

  it.effect("give an earlier month its own address, and leave the marker where it was", () =>
    Effect.gen(function* () {
      const sam = yield* person(0);
      const response = yield* request(sam, HttpClientRequest.get(`/whats-new/${months[1]}`));
      assert.strictEqual(response.status, 200);
      const html = yield* response.text;
      assert.deepStrictEqual(marked(html), newIn(months[1]!, 0));
      assert.include(html, `href="/whats-new/${newest}?since=0"`);
      assert.strictEqual(yield* seenBy(sam), 0);
    })
  );

  it.effect("mark what was new when a link was drawn, never less than the marker says", () =>
    Effect.gen(function* () {
      const before = WhatsNew.latestRelease - 1;
      const caughtUp = yield* person(WhatsNew.latestRelease);
      const fromPanel = yield* (yield* request(
        caughtUp,
        HttpClientRequest.get(`/whats-new?since=${before}`)
      )).text;
      assert.deepStrictEqual(marked(fromPanel), newIn(newest, before));

      // Each opens the newest month, which raises the marker, so each is someone new. An empty
      // or blank value is no marker, not zero.
      for (const since of [String(WhatsNew.latestRelease), "soon", "-1", "", "%20", "0x1"]) {
        const html = yield* (yield* request(
          yield* person(before),
          HttpClientRequest.get(`/whats-new/${newest}?since=${since}`)
        )).text;
        assert.deepStrictEqual(marked(html), newIn(newest, before));
      }
    })
  );

  it.effect("answer a month nothing shipped in inside the app, without moving the marker", () =>
    Effect.gen(function* () {
      const sam = yield* person(0);
      for (const month of ["2025-01", "nonsense"]) {
        const response = yield* request(sam, HttpClientRequest.get(`/whats-new/${month}`));
        assert.strictEqual(response.status, 404);
        const html = yield* response.text;
        assert.include(html, "Nothing shipped that month");
        assert.include(html, 'class="app-foot"');
      }
      assert.strictEqual(yield* seenBy(sam), 0);
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

  it.effect("serves the public changelog to anyone, cacheable for five minutes", () =>
    Effect.gen(function* () {
      const response = yield* (yield* HttpClient.HttpClient).execute(
        HttpClientRequest.get("/whats-new.json")
      );
      assert.strictEqual(response.status, 200);
      assert.include(response.headers["content-type"], "application/json");
      assert.strictEqual(response.headers["cache-control"], "public, max-age=300");
      assert.notProperty(response.headers, "set-cookie");
      assert.notProperty(response.headers, "access-control-allow-origin");
      assert.deepStrictEqual(yield* response.json, {
        releases: WhatsNewPages.publicReleases(WhatsNew.releases)
      });
    })
  );
});

describe("a month of What's new", () => {
  const release = (
    id: number,
    date: string,
    title: string,
    behindTheScenes: ReadonlyArray<string> = []
  ): WhatsNew.Release => ({
    id,
    date,
    through: String(id).repeat(40).slice(0, 40),
    changes: [{ kind: "Fixed", title, detail: `${title} works again.`, prs: [id] }],
    behindTheScenes,
    patchChanges: []
  });
  // Two releases went out on 7 October, one in September and one in November.
  const releases = [
    release(4, "2026-11-02", "Fourth"),
    release(3, "2026-10-07", "Third", ["Quieter logs."]),
    release(2, "2026-10-07", "Second"),
    release(1, "2026-09-30", "First")
  ];
  const october = (seen: number) => WhatsNewPages.render(releases, "2026-10", seen)!.body;

  it("shows one month's days, its changes newest first, opening at their permalinks", () => {
    const html = october(0);
    assert.deepStrictEqual(shown(html), ["change-3-0", "change-2-0"]);
    assert.strictEqual(html.match(/<h2 class="section-title">/g)?.length, 1);
    assert.include(html, '<h2 class="section-title">Wednesday, 7 October</h2>');
    assert.include(html, '<a href="/whats-new/2026-10#change-3-0">Link to this change</a>');
    assert.include(html, "Behind the scenes · 1 change");
    assert.include(html, "<li>Quieter logs.</li>");
  });

  it("marks only what shipped after the marker", () => {
    assert.deepStrictEqual(marked(october(0)), ["change-3-0", "change-2-0"]);
    assert.deepStrictEqual(marked(october(2)), ["change-3-0"]);
    assert.deepStrictEqual(marked(october(4)), []);
    assert.include(october(2), "1 new to you");
    assert.notInclude(october(4), "new to you");
  });

  it("links the months either side, carrying the marker while anything is new", () => {
    assert.include(october(2), 'href="/whats-new/2026-09?since=2"');
    assert.include(october(2), 'href="/whats-new/2026-11?since=2"');
    assert.include(october(4), 'href="/whats-new/2026-09"');
    assert.include(october(4), 'href="/whats-new/2026-11"');
    const november = WhatsNewPages.render(releases, "2026-11", 4)!.body;
    assert.include(november, 'href="/whats-new/2026-10"');
    assert.notInclude(november, "/whats-new/2026-12");
    assert.isUndefined(WhatsNewPages.render(releases, "2026-08", 0));
  });

  it("publishes only New and Improved changes, without PRs, through, patch changes or releases left empty", () => {
    const change = (kind: WhatsNew.ChangeKind, title: string): WhatsNew.Change => ({
      kind,
      title,
      detail: `${title} in detail.`,
      prs: [1]
    });
    const behindTheScenes = ["Quieter logs."];
    const patchChanges = ["A stricter type."];
    assert.deepStrictEqual(
      WhatsNewPages.publicReleases([
        {
          id: 2,
          date: "2026-10-08",
          through: "2".repeat(40),
          changes: [change("Fixed", "Mended")],
          behindTheScenes,
          patchChanges
        },
        {
          id: 1,
          date: "2026-10-07",
          through: "1".repeat(40),
          changes: [
            change("New", "Added"),
            change("Fixed", "Mended"),
            change("Improved", "Faster")
          ],
          behindTheScenes,
          patchChanges
        }
      ]),
      [
        {
          id: 1,
          date: "2026-10-07",
          changes: [
            { kind: "New", title: "Added", detail: "Added in detail." },
            { kind: "Improved", title: "Faster", detail: "Faster in detail." }
          ]
        }
      ]
    );
  });
});
