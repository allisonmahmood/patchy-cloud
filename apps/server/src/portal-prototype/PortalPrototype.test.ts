// @effect-diagnostics globalDate:off -- the test clock is pinned a minute ahead of the wall; see below.
/**
 * THROWAWAY (prototype #241): the portal walked over a socket with the
 * offline signed-session pattern from `Server.test.ts`. Asserts on rendered
 * text, never on CSS. This is also how a reviewer sees the HTML without a
 * Clerk session: read the bodies this test fetches.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { DEV_SEED } from "@patchy/auth/seed";
import { signedInCookies, signSession } from "@patchy/auth/testing";
import { answer, html, send, server, publish } from "../test/server.js";

const publicBaseUrl = "https://patchy.example";
const sessionCookie = (sub: string = DEV_SEED.clerkUserId, email: string = DEV_SEED.email) =>
  signedInCookies(signSession({ sub, email, azp: publicBaseUrl }));
const get = (path: string, cookie = sessionCookie()) =>
  send(HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader("cookie", cookie)));
const post = (path: string, form: Record<string, string>, cookie = sessionCookie()) =>
  send(
    HttpClientRequest.post(path).pipe(
      HttpClientRequest.setHeaders({ cookie, origin: publicBaseUrl }),
      HttpClientRequest.bodyUrlParams(form)
    )
  );
const revisionOf = (page: string): string => {
  const match = /name="revision" value="(\d+)"/.exec(page);
  assert.isNotNull(match, "the page carries a revision");
  return match![1]!;
};

it.layer(
  server({ PATCHY_PUBLIC_BASE_URL: publicBaseUrl }).pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
  )
)("the portal prototype over a socket", (it) => {
  it.effect("lists, manages, refuses stale actions and answers the CLI", () =>
    Effect.gen(function* () {
      // Actor stamps ride the Effect clock, revisions and machine-token expiry ride SQL
      // `now()`; in production they agree. Pin the test clock a minute ahead of the wall
      // so "since the form" holds here too while the seeded token stays valid.
      yield* TestClock.setTime(Date.now() + 60_000);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES ('usr_portal_sam', 'user_portal_sam', ${DEV_SEED.companyId}, 'sam@example.com', 'Sam Okafor', 'member')`;
      const created = yield* Effect.forEach(
        ["Lunch orders", "Office map", "Vendor list"],
        (title) =>
          Effect.flatMap(publish(DEV_SEED.token, { html: html(title) }), (response) =>
            Effect.map(response.json, (body) => body as { patchId: string; name: string })
          )
      );
      const [lunch, office, vendors] = created as [
        { patchId: string; name: string },
        { patchId: string; name: string },
        { patchId: string; name: string }
      ];
      yield* sql`UPDATE patches SET owner_user_id = 'usr_portal_sam' WHERE id = ${office.patchId}`;
      yield* sql`UPDATE patches SET description = 'Where everyone sits. Updated each quarter.'
        WHERE id = ${office.patchId}`;

      // Signed out, `/` is the sign-in door.
      const door = yield* send(HttpClientRequest.get("/"));
      assert.strictEqual(door.status, 401);
      assert.include(yield* door.text, ">Sign in</a>");

      // The index: Yours first, then Company; the card is the first of Yours.
      const index = yield* get("/");
      assert.strictEqual(index.status, 200);
      const indexBody = yield* index.text;
      assert.include(indexBody, '<h2 class="c-group">Yours</h2>');
      assert.include(indexBody, '<h2 class="c-group">Company</h2>');
      assert.isBelow(
        indexBody.indexOf('<h2 class="c-group">Yours</h2>'),
        indexBody.indexOf('<h2 class="c-group">Company</h2>')
      );
      assert.isBelow(indexBody.indexOf(lunch.name), indexBody.indexOf(office.name));
      assert.include(indexBody, "Where everyone sits");
      assert.notInclude(indexBody, "Updated each quarter");
      assert.include(indexBody, `<h1 class="c-h1">${lunch.name}</h1>`);
      assert.include(indexBody, "prototype only");
      assert.include(indexBody, 'href="/machines"');

      // The card for one patch, with Manage for its owner.
      const card = yield* get(`/patches/${office.name}`);
      assert.strictEqual(card.status, 200);
      const cardBody = yield* card.text;
      assert.include(cardBody, "Sam Okafor");
      assert.include(cardBody, "Where everyone sits. Updated each quarter.");
      assert.include(cardBody, "Manage");
      assert.include(cardBody, "You can do everything an owner can from here, except publish.");
      assert.include(cardBody, "Nothing else reads this patch.");
      assert.include(cardBody, `Anyone at ${DEV_SEED.companyName} who signs in. Not the public.`);

      // Sam, a member, sees the facts and Open but no Manage on the dev user's patch.
      const samCookie = sessionCookie("user_portal_sam", "sam@example.com");
      const samView = yield* get(`/patches/${lunch.name}`, samCookie);
      const samBody = yield* samView.text;
      assert.include(samBody, ">Open</a>");
      assert.notInclude(samBody, "<h2>Manage</h2>");
      assert.include(samBody, "Viewing as: member");
      // An unknown name is the existing 404 shape.
      assert.strictEqual((yield* get("/patches/nope-nope")).status, 404);

      // A description edit lands and is stamped.
      const revision = revisionOf(cardBody);
      const edited = yield* post(`/patches/${office.name}/description`, {
        revision,
        description: "  Where   everyone\nsits.  "
      });
      assert.strictEqual(edited.status, 303);
      assert.strictEqual(edited.headers.location, `/patches/${office.name}`);
      const afterEdit = yield* (yield* get(`/patches/${office.name}`)).text;
      assert.include(afterEdit, "Where everyone sits.</p>");
      assert.include(afterEdit, `Description edited by ${DEV_SEED.userName} on`);

      // The old revision is stale: 409 and the notice, nothing done.
      const stale = yield* post(`/patches/${office.name}/retire`, { revision });
      assert.strictEqual(stale.status, 409);
      const staleBody = yield* stale.text;
      assert.include(
        staleBody,
        "This patch changed while you had this page open: description edited by"
      );
      assert.include(staleBody, "Nothing was done. Check it and try again.");
      assert.include(staleBody, `Retire ${office.name}?`);

      // A fresh revision retires it; the card becomes the retired notice.
      const retirePage = yield* (yield* get(`/patches/${office.name}/retire`)).text;
      assert.include(retirePage, "Nothing else reads this patch.");
      const retired = yield* post(`/patches/${office.name}/retire`, {
        revision: revisionOf(retirePage)
      });
      assert.strictEqual(retired.status, 303);
      const retiredCard = yield* (yield* get(`/patches/${office.name}`)).text;
      assert.include(retiredCard, ">retired</span> by Patchy Dev on");
      assert.include(retiredCard, `Restore ${office.name}</button>`);
      assert.notInclude(retiredCard, "<h2>Manage</h2>");
      // Off is off: the index hides it until asked, and the address answers as unknown.
      assert.notInclude(yield* (yield* get("/")).text, `<span class="c-n">${office.name}</span>`);
      const withAll = yield* (yield* get("/?all=1")).text;
      assert.include(withAll, "Retired and deleted");
      assert.include(withAll, "Retired by Patchy Dev");
      assert.strictEqual((yield* get(`/${DEV_SEED.companyHandle}/${office.name}`)).status, 404);

      // Restore brings it back live.
      const restored = yield* post(`/patches/${office.name}/restore`, {
        revision: revisionOf(retiredCard)
      });
      assert.strictEqual(restored.status, 303);
      const liveAgain = yield* (yield* get(`/patches/${office.name}`)).text;
      assert.include(liveAgain, "<h2>Manage</h2>");
      assert.strictEqual((yield* get(`/${DEV_SEED.companyHandle}/${office.name}`)).status, 200);

      // Delete needs the typed name; the wrong one is a 422 with the page again.
      const deletePage = yield* (yield* get(`/patches/${vendors.name}/delete`)).text;
      assert.include(deletePage, `Delete ${vendors.name}?`);
      const wrongName = yield* post(`/patches/${vendors.name}/delete`, {
        revision: revisionOf(deletePage),
        confirm: "something-else"
      });
      assert.strictEqual(wrongName.status, 422);
      assert.include(yield* wrongName.text, "Type the patch's name exactly to delete it.");
      const deleted = yield* post(`/patches/${vendors.name}/delete`, {
        revision: revisionOf(deletePage),
        confirm: vendors.name
      });
      assert.strictEqual(deleted.status, 303);
      const deletedCard = yield* (yield* get(`/patches/${vendors.name}`)).text;
      assert.include(deletedCard, ">deleted</span> by Patchy Dev on");
      assert.include(deletedCard, "30 days left");

      // Sam cannot manage the dev user's patch.
      const forbidden = yield* post(
        `/patches/${lunch.name}/description`,
        { revision: "0", description: "x" },
        samCookie
      );
      assert.strictEqual(forbidden.status, 403);

      // The CLI's view under the machine token: the deleted one is absent unless asked for.
      const listed = yield* send(
        HttpClientRequest.get("/api/patches").pipe(HttpClientRequest.bearerToken(DEV_SEED.token))
      );
      const list = (yield* answer(listed)) as {
        status: number;
        body: { patches: Array<{ id: string; name: string; state: string; mine: boolean }> };
      };
      assert.strictEqual(list.status, 200);
      const names = list.body.patches.map((patch) => patch.name);
      assert.include(names, lunch.name);
      assert.include(names, office.name);
      assert.notInclude(names, vendors.name);
      assert.isTrue(list.body.patches[0]!.mine, "yours first");
      const all = (yield* (yield* send(
        HttpClientRequest.get("/api/patches?state=all").pipe(
          HttpClientRequest.bearerToken(DEV_SEED.token)
        )
      )).json) as { patches: Array<{ name: string; state: string }> };
      assert.strictEqual(
        all.patches.find((patch) => patch.name === vendors.name)?.state,
        "deleted"
      );
      const byName = yield* send(
        HttpClientRequest.get(`/api/patches/${office.name}`).pipe(
          HttpClientRequest.bearerToken(DEV_SEED.token)
        )
      );
      assert.strictEqual(byName.status, 200);
      assert.deepInclude(yield* byName.json, { id: office.patchId, tables: [], stores: [] });
      assert.strictEqual(
        (yield* send(
          HttpClientRequest.get(`/api/patches/${vendors.name}`).pipe(
            HttpClientRequest.bearerToken(DEV_SEED.token)
          )
        )).status,
        404
      );
      assert.strictEqual(
        (yield* send(
          HttpClientRequest.get(`/api/patches/${vendors.patchId}`).pipe(
            HttpClientRequest.bearerToken(DEV_SEED.token)
          )
        )).status,
        200
      );
      assert.strictEqual((yield* send(HttpClientRequest.get("/api/patches"))).status, 401);
    })
  );
});
