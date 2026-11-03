import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Analytics } from "@patchy/analytics";
import { Users } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import * as Testing from "@patchy/sql/testing";
import * as DemoLink from "./DemoLink.js";
import { DEV_SEED } from "./seed.js";
import * as Session from "./Session.js";
import { clerkEnv, PUBLIC_BASE_URL } from "./testing.js";

/** The SHA-256 of `demo-secret`, the link's secret in these cases. */
const DIGEST = "cd577fe2561ebff23505db0bb006300c7cdecbd46bc0e03c449afafaca2c25bf";
const setting = (clerkUserId: string = DEV_SEED.clerkUserId, day = "2027-02-01") =>
  `${DIGEST}:${clerkUserId}:${day}`;
const notFound = HttpServerResponse.text("not found", { status: 404 });

/** What Clerk's sign-in token endpoint was asked for, and whether it refuses. */
const clerk = { minted: [] as Array<unknown>, refuse: false };
const events: Array<Analytics.AnalyticsEvent> = [];

const backend = HttpRouter.serve(
  HttpRouter.use((router) =>
    router.add(
      "POST",
      "/v1/sign_in_tokens",
      Effect.gen(function* () {
        if (clerk.refuse)
          return HttpServerResponse.jsonUnsafe(
            { errors: [{ code: "form_param_missing", message: "refused" }] },
            { status: 422 }
          );
        clerk.minted.push(yield* (yield* HttpServerRequest.HttpServerRequest).json);
        return HttpServerResponse.jsonUnsafe({
          object: "sign_in_token",
          id: `sit_${clerk.minted.length}`,
          user_id: DEV_SEED.clerkUserId,
          token: `ticket-${clerk.minted.length}`,
          status: "pending",
          url: `https://accounts.patchy.invalid/sign-in?__clerk_ticket=ticket-${clerk.minted.length}`,
          created_at: 0,
          updated_at: 0
        });
      })
    )
  ),
  { disableLogger: true, disableListenLog: true }
).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

const layer = Layer.mergeAll(backend, Users.layer).pipe(
  Layer.provideMerge(
    Layer.succeed(
      Analytics.Analytics,
      Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
    )
  ),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(NodeCryptography.layer)
);

/** Builds the routes under `PATCHY_DEMO_LINK=<link>` against the stub Clerk, then sends one GET. */
const visit = Effect.fn(function* (path: string, link: string) {
  const server = yield* HttpServer.HttpServer;
  if (server.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP");
  const app = yield* HttpRouter.toHttpEffect(DemoLink.routes(notFound)).pipe(
    Effect.provideService(Session.backendApiUrl, `http://127.0.0.1:${server.address.port}`),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ ...clerkEnv(), PATCHY_DEMO_LINK: link }))
    )
  );
  const response = yield* app.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(new URL(path, PUBLIC_BASE_URL)))
    )
  );
  return HttpServerResponse.toWeb(response);
});

const reset = Effect.sync(() => {
  clerk.minted.length = 0;
  clerk.refuse = false;
  events.length = 0;
});

it.layer(layer)("the demo link", (it) => {
  it.effect("signs every visit in as its account with a token of its own", () =>
    Effect.gen(function* () {
      yield* reset;
      for (const ticket of ["ticket-1", "ticket-2"]) {
        const response = yield* visit("/signin/demo-secret", setting());
        assert.strictEqual(response.status, 303);
        assert.strictEqual(
          response.headers.get("location"),
          `https://accounts.patchy.invalid/sign-in?__clerk_ticket=${ticket}&redirect_url=${encodeURIComponent(`${PUBLIC_BASE_URL}/`)}`
        );
        assert.strictEqual(response.headers.get("cache-control"), "no-store");
        assert.strictEqual(response.headers.get("referrer-policy"), "no-referrer");
      }
      const minted = { user_id: DEV_SEED.clerkUserId, expires_in_seconds: 60 };
      assert.deepStrictEqual(clerk.minted, [minted, minted]);
      const opened: Analytics.AnalyticsEvent = {
        name: "demo_link.opened",
        principalId: DEV_SEED.userId,
        companyId: DEV_SEED.companyId,
        properties: {}
      };
      assert.deepStrictEqual(events, [opened, opened]);
    })
  );

  it.effect("answers any other secret, and its own after its day, as an unknown address", () =>
    Effect.gen(function* () {
      yield* reset;
      for (const path of ["/signin/demo-secreT", "/signin/cd577fe2561ebff2"]) {
        assert.strictEqual((yield* visit(path, setting())).status, 404);
      }
      // The test clock starts at 1970-01-01T00:00:00Z, the moment this link stops working.
      const ended = setting(DEV_SEED.clerkUserId, "1970-01-01");
      assert.strictEqual((yield* visit("/signin/demo-secret", ended)).status, 404);
      assert.deepStrictEqual(clerk.minted, []);
      assert.deepStrictEqual(events, []);
    })
  );

  it.effect("has no route without a link", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(visit("/signin/demo-secret", ""));
      assert.isTrue(Exit.isFailure(exit));
    })
  );

  it.effect("signs an account without a company in without an event", () =>
    Effect.gen(function* () {
      yield* reset;
      const response = yield* visit("/signin/demo-secret", setting("user_nocompany"));
      assert.strictEqual(response.status, 303);
      assert.strictEqual(clerk.minted.length, 1);
      assert.deepStrictEqual(events, []);
    })
  );

  it.effect("says sign-in is unavailable when Clerk refuses the token", () =>
    Effect.gen(function* () {
      yield* reset;
      clerk.refuse = true;
      const response = yield* visit("/signin/demo-secret", setting());
      assert.strictEqual(response.status, 502);
      assert.include(yield* Effect.promise(() => response.text()), "Sign-in service unavailable");
      assert.deepStrictEqual(events, []);
    })
  );

  it.effect("refuses a setting that is not a digest, a Clerk user and a calendar day", () =>
    Effect.gen(function* () {
      for (const link of [
        `${DIGEST}:${DEV_SEED.clerkUserId}:2027-02-30`,
        `${DIGEST.toUpperCase()}:${DEV_SEED.clerkUserId}:2027-02-01`,
        `${DIGEST}:usr_dev:2027-02-01`,
        "demo-secret"
      ]) {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            return yield* DemoLink.config;
          }).pipe(
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_DEMO_LINK: link }))
            )
          )
        );
        assert.isTrue(Exit.isFailure(exit), link);
      }
    })
  );
});
