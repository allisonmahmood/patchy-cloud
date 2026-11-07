import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ViewerGroup } from "@patchy/api";
import { Companies, Users } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import * as Testing from "@patchy/sql/testing";
import * as Receipt from "./Receipt.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import * as ViewerApi from "./ViewerApi.js";
import { clerkEnv, signedInCookies, signSession } from "./testing.js";

const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;

const send = Effect.fn(function* (init: RequestInit) {
  const app = yield* HttpRouter.toHttpEffect(
    HttpApiBuilder.layer(HttpApi.make("patchy").add(ViewerGroup)).pipe(
      Layer.provide(ViewerApi.layer)
    )
  );
  const response = yield* app.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(new URL("/api/me/shortcuts", base), init))
    )
  );
  return HttpServerResponse.toWeb(response);
});

/** A POST as the person's own browser on this instance would send it, unless `headers` say otherwise. */
const post = (
  cookie: string | undefined,
  body: Record<string, string> | string,
  headers: Record<string, string> = {}
) =>
  send({
    method: "POST",
    headers: { ...(cookie === undefined ? {} : { cookie }), origin: base, ...headers },
    body: typeof body === "string" ? body : new URLSearchParams(body)
  });
const asJson = { accept: "application/json" };

/** A new company's first person, with their signed-in cookie. */
const person = Effect.fn(function* (handle: string) {
  const { user } = yield* (yield* Companies.Companies).create({
    handle,
    name: `${handle} Inc`,
    clerkUserId: `user_${handle}`,
    email: `${handle}@example.com`,
    userName: "Ada"
  });
  const cookie = signedInCookies(
    signSession({ sub: user.clerkUserId, email: user.email, name: user.name })
  );
  return { ...user, cookie };
});

const stored = Effect.fn(function* (person: { readonly clerkUserId: string }) {
  return (yield* (yield* Users.Users).findByClerkId(person.clerkUserId))?.singleKeyShortcuts;
});

it.layer(
  Layer.mergeAll(Session.layer, Companies.layer, Users.layer, HttpServer.layerServices).pipe(
    Layer.provideMerge(Testing.layer()),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Layer.provideMerge(NodeCryptography.layer)
  )
)("POST /api/me/shortcuts", (it) => {
  it.effect("turns them off and on again, answering the stored value to a JSON request", () =>
    Effect.gen(function* () {
      const ada = yield* person("shortcuts-json");
      assert.isTrue(yield* stored(ada));
      for (const value of ["off", "on", "on"] as const) {
        const response = yield* post(ada.cookie, { value }, asJson);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), { value });
        assert.strictEqual(yield* stored(ada), value === "on");
      }
    })
  );

  it.effect("sends a form post back to its page with a receipt, and only to this instance", () =>
    Effect.gen(function* () {
      const ada = yield* person("shortcuts-form");
      const receipt = (response: Response) => {
        const cookies = Object.fromEntries(
          response.headers.getSetCookie().map((line) => {
            const [pair = ""] = line.split(";");
            return [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
          })
        );
        return Receipt.take(cookies, { userId: ada.id, publicBaseUrl: base }).text;
      };
      const off = yield* post(ada.cookie, { value: "off", return: "/patches?tab=tools" });
      assert.strictEqual(off.status, 303);
      assert.strictEqual(off.headers.get("location"), "/patches?tab=tools");
      assert.strictEqual(receipt(off), "Turned off single-key shortcuts");
      assert.isFalse(yield* stored(ada));
      for (const elsewhere of [undefined, "//elsewhere.example/", "https://elsewhere.example/"]) {
        const on = yield* post(ada.cookie, {
          value: "on",
          ...(elsewhere === undefined ? {} : { return: elsewhere })
        });
        assert.strictEqual(on.status, 303);
        assert.strictEqual(on.headers.get("location"), "/", elsewhere);
        assert.strictEqual(receipt(on), "Turned on single-key shortcuts");
      }
      assert.isTrue(yield* stored(ada));
    })
  );

  it.effect("refuses another origin and a signed-out request, changing nothing", () =>
    Effect.gen(function* () {
      const ada = yield* person("shortcuts-refused");
      const crossSite = yield* post(
        ada.cookie,
        { value: "off" },
        { ...asJson, origin: "https://elsewhere.example" }
      );
      assert.strictEqual(crossSite.status, 403);
      assert.include(yield* Effect.promise(() => crossSite.text()), "Request refused");
      // Without an Origin, only the browser's own same-origin marker admits a POST.
      const unmarked = yield* send({
        method: "POST",
        headers: { cookie: ada.cookie, ...asJson },
        body: new URLSearchParams({ value: "off" })
      });
      assert.strictEqual(unmarked.status, 403);
      const signedOut = yield* post(undefined, { value: "off" }, asJson);
      assert.strictEqual(signedOut.status, 401);
      assert.include(signedOut.headers.get("content-type") ?? "", "text/html");
      assert.isTrue(yield* stored(ada));
    })
  );

  it.effect("refuses a missing, unknown or repeated value, and a JSON body", () =>
    Effect.gen(function* () {
      const ada = yield* person("shortcuts-malformed");
      for (const body of ["", "value=toggle", "value=on&value=off", "value=OFF"]) {
        const response = yield* post(ada.cookie, body, {
          ...asJson,
          "content-type": "application/x-www-form-urlencoded"
        });
        assert.strictEqual(response.status, 400, body.slice(0, 20));
        assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
      }
      const json = yield* post(ada.cookie, JSON.stringify({ value: "off" }), {
        ...asJson,
        "content-type": "application/json"
      });
      assert.strictEqual(json.status, 400);
      assert.isTrue(yield* stored(ada));
    })
  );

  it.effect("keeps a guest's choice their own, as a user of another company", () =>
    Effect.gen(function* () {
      const host = yield* person("shortcuts-host");
      const guest = yield* person("shortcuts-guest");
      assert.strictEqual((yield* post(guest.cookie, { value: "off" }, asJson)).status, 200);
      assert.isFalse(yield* stored(guest));
      assert.isTrue(yield* stored(host));
      // Every first-party page, and a patch's door for a guest, resolves the viewer this way.
      const viewer = yield* RequireSession.resolveViewer.pipe(
        Effect.provideService(RequireSession.SignedIn, {
          sub: guest.clerkUserId,
          email: guest.email,
          name: guest.name,
          sid: "sess_guest"
        })
      );
      assert.isTrue(viewer !== null && !HttpServerResponse.isHttpServerResponse(viewer));
      if (viewer !== null && !HttpServerResponse.isHttpServerResponse(viewer))
        assert.isFalse(viewer.singleKeyShortcuts);
    })
  );
});
