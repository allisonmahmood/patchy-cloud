/**
 * Request events, read as the lines stdout carries to CloudWatch. First the
 * outcome rules over a small router, where a 5xx and a defect are easy to
 * provoke. Then the server booted whole: one event for each kind of route,
 * attributed where identity resolves, none for runtime calls beyond their
 * own or for health probes, and nothing secret on any of them.
 */
import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as WideEvents from "@patchy/analytics/wide-events";
import { DEV_SEED } from "@patchy/auth/seed";
import { signedInCookies, signSession } from "@patchy/auth/testing";
import { html, publishBody, send, server } from "./test/server.js";
import * as RequestEvents from "./RequestEvents.js";

/** Every line written to stdout, in order. */
class Lines extends Context.Service<Lines, Queue.Queue<string>>()("test/RequestEvents/Lines") {}

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(WideEvents.WideEvent));

/** The fence's own event closes a request's lines; no request under test uses PATCH. */
const fence = HttpClientRequest.patch("/events-fence");

/**
 * One request's wide events and their raw lines: everything written before
 * the event of the fence request that follows it.
 */
const eventsOf = Effect.fn("eventsOf")(function* (request: HttpClientRequest.HttpClientRequest) {
  const lines = yield* Lines;
  const response = yield* send(request);
  yield* send(fence);
  const events: WideEvents.WideEvent[] = [];
  const written: string[] = [];
  while (true) {
    const line = yield* Queue.take(lines);
    const event = decodeEvent(line);
    if (Option.isNone(event)) continue;
    if (event.value.type === "request" && event.value.method === "PATCH")
      return { response, events, lines: written };
    events.push(event.value);
    written.push(line);
  }
});

/** The single request event a request emitted, failing on none or several. */
const eventOf = Effect.fn("eventOf")(function* (request: HttpClientRequest.HttpClientRequest) {
  const { response, events } = yield* eventsOf(request);
  assert.strictEqual(events.length, 1, `${request.method} ${request.url}`);
  const [event] = events;
  if (event?.type !== "request") return assert.fail(`Expected a request event: ${event?.type}`);
  return { response, event };
});

const patchId = "abcdefghij12";

const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/items/:patchId", HttpServerResponse.text("four"));
    yield* router.add(
      "POST",
      "/items/:patchId/refuse",
      HttpServerResponse.jsonUnsafe(
        { ok: false, code: "name_taken", error: "Taken." },
        { status: 409 }
      )
    );
    yield* router.add(
      "GET",
      "/unavailable",
      HttpServerResponse.jsonUnsafe(
        { ok: false, code: "source_unavailable", error: "Down." },
        { status: 503 }
      )
    );
    yield* router.add("GET", "/defect", Effect.die(new Error("boom")));
    yield* router.add("*", "/*", HttpServerResponse.text("missing", { status: 404 }));
  })
);

const router = HttpRouter.serve(routes.pipe(Layer.provide(RequestEvents.layer)), {
  disableLogger: true,
  disableListenLog: true
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(
    WideEvents.layerWithSink.pipe(
      Layer.provide(
        Layer.effect(
          WideEvents.Sink,
          Effect.map(Lines, (lines) =>
            WideEvents.Sink.of({
              write: (event) => Queue.offer(lines, WideEvents.formatJson(event)).pipe(Effect.asVoid)
            })
          )
        )
      )
    )
  ),
  Layer.provideMerge(Layer.effect(Lines, Queue.unbounded<string>()))
);

it.layer(router)("the request event's outcome rules", (it) => {
  it.effect("names the matched template, method, status and sizes, never the path", () =>
    Effect.gen(function* () {
      const { response, event } = yield* eventOf(
        HttpClientRequest.get(`/items/${patchId}?secret=query`)
      );
      assert.strictEqual(response.status, 200);
      assert.include(event, {
        route: "/items/:patchId",
        method: "GET",
        status: 200,
        outcome: "success",
        patchId,
        responseBytes: 4
      });
      assert.notInclude(WideEvents.formatJson(event), "secret=query");
    })
  );

  it.effect("records a 4xx response as refused with its body's code", () =>
    Effect.gen(function* () {
      const { event } = yield* eventOf(
        HttpClientRequest.post(`/items/${patchId}/refuse`).pipe(
          HttpClientRequest.bodyText("{}", "application/json")
        )
      );
      assert.include(event, {
        route: "/items/:patchId/refuse",
        method: "POST",
        status: 409,
        outcome: "refused",
        code: "name_taken",
        requestBytes: 2
      });
    })
  );

  it.effect("records a 5xx response and a defect as failures", () =>
    Effect.gen(function* () {
      const unavailable = yield* eventOf(HttpClientRequest.get("/unavailable"));
      assert.include(unavailable.event, {
        route: "/unavailable",
        status: 503,
        outcome: "failure",
        code: "source_unavailable"
      });

      const defect = yield* eventOf(HttpClientRequest.get("/defect"));
      assert.strictEqual(defect.response.status, 500);
      assert.include(defect.event, { route: "/defect", status: 500, outcome: "failure" });
    })
  );

  it.effect("records the status an interrupted request is answered with", () =>
    Effect.gen(function* () {
      const record = yield* RequestEvents.make;
      const handler = yield* record("/slow", Effect.never).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request("http://localhost/slow"))
        ),
        Effect.forkChild
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(handler);
      const event = decodeEvent(yield* Queue.take(yield* Lines));
      assert.isTrue(Option.isSome(event));
      assert.include(Option.getOrThrow(event), {
        route: "/slow",
        method: "GET",
        status: 503,
        outcome: "interrupted"
      });
    })
  );
});

/** Stdout as the server writes it, so the test reads what CloudWatch would. */
const stdout = Layer.effectContext(
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string>();
    const console = yield* Console.Console;
    return Context.make(Lines, lines).pipe(
      Context.add(Console.Console, {
        ...console,
        log: (...args: ReadonlyArray<unknown>) => {
          Queue.offerUnsafe(lines, String(args[0]));
        }
      })
    );
  })
);

const publicBaseUrl = "https://patchy.example";
const sessionJwt = signSession({
  sub: DEV_SEED.clerkUserId,
  email: DEV_SEED.email,
  azp: publicBaseUrl
});
const cookie = signedInCookies(sessionJwt);
const signedIn = (request: HttpClientRequest.HttpClientRequest) =>
  request.pipe(HttpClientRequest.setHeaders({ cookie, origin: publicBaseUrl }));
const bearer = HttpClientRequest.bearerToken(DEV_SEED.token);
const attributed = { viewerId: DEV_SEED.userId, companyId: DEV_SEED.companyId };

const readPublished = HttpIncomingMessage.schemaBodyJson(
  Schema.Struct({
    patchId: Schema.String,
    versionId: Schema.String,
    name: Schema.String,
    address: Schema.String
  })
);
const readRelease = HttpIncomingMessage.schemaBodyJson(
  Schema.Struct({ package: Schema.Struct({ tarball: Schema.String }) })
);
const readStarted = HttpIncomingMessage.schemaBodyJson(
  Schema.Struct({ deviceCode: Schema.String, userCode: Schema.String })
);
const readCompleted = HttpIncomingMessage.schemaBodyJson(
  Schema.Struct({ status: Schema.Literal("complete"), token: Schema.String })
);

it.layer(server({ PATCHY_PUBLIC_BASE_URL: publicBaseUrl }).pipe(Layer.provideMerge(stdout)))(
  "request events, the server booted whole",
  (it) => {
    it.effect("emits one event per route, attributed where identity resolves", () =>
      Effect.gen(function* () {
        const published = yield* eventOf(
          HttpClientRequest.post("/api/publish").pipe(
            bearer,
            HttpClientRequest.bodyJsonUnsafe(publishBody({ html: html("Events") }))
          )
        );
        assert.strictEqual(published.response.status, 201);
        const created = yield* readPublished(published.response);
        assert.include(published.event, {
          route: "/api/publish",
          method: "POST",
          status: 201,
          outcome: "success",
          patchId: created.patchId,
          versionId: created.versionId,
          ...attributed
        });

        const releaseRead = yield* eventOf(HttpClientRequest.get("/api/release"));
        assert.include(releaseRead.event, { route: "/api/release", status: 200 });
        const release = yield* readRelease(releaseRead.response);
        const expected: ReadonlyArray<
          readonly [HttpClientRequest.HttpClientRequest, Partial<WideEvents.RequestEvent>]
        > = [
          [HttpClientRequest.get("/api/me").pipe(bearer), { route: "/api/me", ...attributed }],
          [
            HttpClientRequest.get(`/api/patches/${created.patchId}`).pipe(bearer),
            {
              route: "/api/patches/:patchRef",
              patchId: created.patchId,
              versionId: created.versionId,
              ...attributed
            }
          ],
          // A query that does not decode is answered by the server, not the handler.
          [
            HttpClientRequest.get("/api/patches?state=bogus").pipe(bearer),
            { route: "/api/patches", status: 400, outcome: "refused" }
          ],
          [
            HttpClientRequest.put(`/api/patches/${created.patchId}/description`).pipe(
              bearer,
              HttpClientRequest.bodyJsonUnsafe({ description: "Watched by request events." })
            ),
            {
              route: "/api/patches/:patchId/description",
              status: 200,
              patchId: created.patchId,
              versionId: created.versionId,
              ...attributed
            }
          ],
          [
            HttpClientRequest.post(`/api/patches/${created.patchId}/share`).pipe(
              bearer,
              HttpClientRequest.bodyJsonUnsafe({ scope: "company" })
            ),
            {
              route: "/api/patches/:patchId/share",
              status: 200,
              patchId: created.patchId,
              versionId: created.versionId,
              ...attributed
            }
          ],
          [
            HttpClientRequest.get(`/api/patches/${created.patchId}/inventory`).pipe(bearer),
            {
              route: "/api/patches/:patchId/inventory",
              status: 200,
              patchId: created.patchId,
              versionId: created.versionId,
              ...attributed
            }
          ],
          [signedIn(HttpClientRequest.get("/")), { route: "/", status: 200, ...attributed }],
          // Serving answers HEAD as GET; the event keeps what the client sent and received.
          [
            signedIn(HttpClientRequest.head("/")),
            { route: "/", status: 200, responseBytes: 0, ...attributed }
          ],
          [
            signedIn(HttpClientRequest.get(`/patches/${created.name}`)),
            {
              route: "/patches/:name",
              status: 200,
              patchId: created.patchId,
              versionId: created.versionId,
              ...attributed
            }
          ],
          [HttpClientRequest.get("/login"), { route: "/login", status: 200 }],
          [
            signedIn(HttpClientRequest.get("/login/device")),
            { route: "/login/device", ...attributed }
          ],
          [
            signedIn(HttpClientRequest.get("/company/connections")),
            { route: "/company/connections", status: 200, ...attributed }
          ],
          [
            signedIn(HttpClientRequest.get(new URL(created.address).pathname)),
            {
              route: "/:company/:name/*",
              status: 200,
              patchId: created.patchId,
              versionId: created.versionId,
              ...attributed
            }
          ],
          [
            HttpClientRequest.get(new URL(release.package.tarball).pathname),
            { route: "/sdk/patchy-:archive.tgz", status: 200, outcome: "success" }
          ],
          [HttpClientRequest.get("/no-such-page"), { route: "/*", status: 404 }],
          // A target that does not decode fails the router before even `/*` matches.
          [HttpClientRequest.get("/public/%"), { route: "/*", status: 404, outcome: "refused" }],
          [
            HttpClientRequest.get("/api/no-such-route").pipe(bearer),
            { route: "/api/*", status: 404, outcome: "refused", ...attributed }
          ],
          // The guard answers a probe the router never sees, after the token.
          [
            HttpClientRequest.post("/api%2Fpublish").pipe(bearer),
            { route: "/api/*", status: 404, outcome: "refused", ...attributed }
          ]
        ];
        for (const [request, fields] of expected) {
          const { response, event } = yield* eventOf(request);
          assert.include(
            event,
            { method: request.method, status: response.status, ...fields },
            `${request.method} ${request.url}`
          );
        }
      })
    );

    it.effect("refuses with the code the client received, and replays name the version", () =>
      Effect.gen(function* () {
        const stale = publishBody({ html: html("Stale") });
        const { response, event } = yield* eventOf(
          HttpClientRequest.post("/api/publish").pipe(
            bearer,
            HttpClientRequest.bodyJsonUnsafe({
              ...stale,
              manifest: { ...stale.manifest, release: "0.0.0-stale" }
            })
          )
        );
        assert.strictEqual(response.status, 422);
        assert.include(event, {
          route: "/api/publish",
          status: 422,
          outcome: "refused",
          code: "release_mismatch",
          ...attributed
        });

        const publish = HttpClientRequest.post("/api/publish").pipe(
          bearer,
          HttpClientRequest.bodyJsonUnsafe(publishBody({ html: html("Replayed") }))
        );
        const first = yield* eventOf(publish);
        const created = yield* readPublished(first.response);
        const replayed = yield* eventOf(publish);
        assert.strictEqual(replayed.response.status, 201);
        assert.include(replayed.event, {
          route: "/api/publish",
          status: 201,
          patchId: created.patchId,
          versionId: created.versionId
        });
      })
    );

    it.effect("keeps a runtime call's own event and emits nothing for health probes", () =>
      Effect.gen(function* () {
        const runtime = yield* eventOf(
          HttpClientRequest.post("/api/runtime/call").pipe(
            HttpClientRequest.bodyText("{}", "application/json")
          )
        );
        assert.strictEqual(runtime.event.outcome, "refused");
        for (const field of ["route", "method", "status", "parentId"])
          assert.notProperty(runtime.event, field);

        assert.deepStrictEqual((yield* eventsOf(HttpClientRequest.get("/healthz"))).events, []);
      })
    );

    it.effect("never writes a token, cookie, code, body, filename or raw path", () =>
      Effect.gen(function* () {
        const title = "Quarterly numbers nobody should log";
        const document = html(title);
        const filename = "board-meeting-secrets.html";
        const publishPath = "/api/publish?attempt=private-query";
        const published = yield* eventsOf(
          HttpClientRequest.post(publishPath).pipe(
            bearer,
            HttpClientRequest.bodyJsonUnsafe(
              publishBody({ html: document, metadata: { filename } })
            )
          )
        );
        assert.strictEqual(published.response.status, 201);
        const created = yield* readPublished(published.response);
        const address = new URL(created.address).pathname;
        const pagePath = `${address}?view=private-query`;
        const page = yield* eventsOf(signedIn(HttpClientRequest.get(pagePath)));
        assert.strictEqual(page.response.status, 200);

        const started = yield* eventsOf(
          HttpClientRequest.post("/api/login/device").pipe(
            HttpClientRequest.bodyJsonUnsafe({ machineNameHint: "Events laptop" })
          )
        );
        const { deviceCode, userCode } = yield* readStarted(started.response);
        const confirmPath = `/login/device?code=${encodeURIComponent(userCode)}`;
        const confirmPage = yield* eventsOf(signedIn(HttpClientRequest.get(confirmPath)));
        const confirmed = yield* eventsOf(
          signedIn(HttpClientRequest.post("/login/device")).pipe(
            HttpClientRequest.bodyUrlParams({
              code: userCode,
              userId: DEV_SEED.userId,
              action: "confirm",
              machineName: "Events laptop"
            })
          )
        );
        assert.strictEqual(confirmed.response.status, 200);
        const polled = yield* eventsOf(
          HttpClientRequest.post("/api/login/device/token").pipe(
            HttpClientRequest.bodyJsonUnsafe({ deviceCode })
          )
        );
        const { token } = yield* readCompleted(polled.response);

        const lines = [published, page, started, confirmPage, confirmed, polled].flatMap(
          (exchange) => exchange.lines
        );
        assert.strictEqual(lines.length, 6);
        for (const secret of [
          DEV_SEED.token,
          sessionJwt,
          deviceCode,
          userCode,
          token,
          title,
          filename,
          publishPath,
          address,
          confirmPath,
          "private-query"
        ])
          for (const line of lines) assert.notInclude(line, secret);
      })
    );
  }
);

it.layer(
  server({
    PATCHY_PUBLIC_BASE_URL: publicBaseUrl,
    PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE: "1"
  }).pipe(Layer.provideMerge(stdout))
)("request events for the API guard's own answers", (it) => {
  it.effect("records a rate-limited request under the API fallback", () =>
    Effect.gen(function* () {
      const allowed = yield* eventOf(HttpClientRequest.get("/api/me").pipe(bearer));
      assert.strictEqual(allowed.event.route, "/api/me");
      const { response, event } = yield* eventOf(HttpClientRequest.get("/api/me").pipe(bearer));
      assert.strictEqual(response.status, 429);
      assert.include(event, {
        route: "/api/*",
        method: "GET",
        status: 429,
        outcome: "refused",
        code: "rate_limited",
        limitId: "rate.protectedApi.perMinute"
      });
    })
  );
});
