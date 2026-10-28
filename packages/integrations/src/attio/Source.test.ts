import { assert, it } from "@effect/vitest";
import { ContractLimits } from "@patchy/limits";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as AttioDouble from "../test/attio.js";
import * as Source from "./Source.js";

const { acme, readKey } = AttioDouble;
const key = (token: string) => Redacted.make(token);

/** The production source over `handler`, with what Attio received. */
const source = (handler: AttioDouble.Handler) =>
  Effect.gen(function* () {
    const double = AttioDouble.make(handler);
    return { source: yield* Source.Source.pipe(Effect.provide(double.layer)), ...double };
  });
const check = (token: string, ...keys: ReadonlyArray<AttioDouble.Key>) =>
  Effect.gen(function* () {
    const { source: attio } = yield* source(AttioDouble.workspace(...keys));
    return yield* attio.check(key(token)).pipe(Effect.flip);
  });
const inspect = (handler: AttioDouble.Handler, token = readKey.token) =>
  Effect.gen(function* () {
    const { source: attio, requests } = yield* source(handler);
    const result = yield* attio.inspect(key(token)).pipe(Effect.result);
    return { result, requests };
  });
const refusedWith = (handler: AttioDouble.Handler) =>
  Effect.map(inspect(handler), ({ result }) =>
    result._tag === "Failure" ? result.failure : assert.fail("discovery succeeded")
  );
const limits = (values: Partial<Record<Parameters<typeof ContractLimits.get>[0], number>>) =>
  Effect.provideService(ContractLimits.overrides, values);

it.effect("accepts a read key, extra read scopes and all, and binds it to its workspace", () =>
  Effect.gen(function* () {
    const { source: attio, requests } = yield* source(AttioDouble.workspace(readKey));
    const self = yield* attio.check(key(readKey.token));
    assert.deepStrictEqual(self.workspace, { id: "ws-acme", name: "Acme", slug: "acme" });
    assert.deepStrictEqual(self.scopes, [...readKey.scopes].sort());
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0]!.url.href, "https://api.attio.com/v2/self");
    assert.strictEqual(requests[0]!.authorization, `Bearer ${readKey.token}`);
  })
);

it.effect("refuses every key the check doesn't pass, naming what to change", () =>
  Effect.gen(function* () {
    // Attio answers a deleted or unknown key 200 { active: false }, and a malformed one 400.
    assert.instanceOf(yield* check("b".repeat(64), readKey), Source.KeyUnknown);
    assert.instanceOf(yield* check("not-a-token", readKey), Source.NotAToken);
    assert.instanceOf(
      yield* check("user", { ...readKey, token: "user", level: "user" }),
      Source.NotWorkspaceKey
    );
    const missing = yield* check("bare", {
      ...readKey,
      token: "bare",
      scopes: ["record_permission:read"]
    });
    assert.instanceOf(missing, Source.MissingScopes);
    assert.include(
      missing.message,
      "set Object configuration, List entries, List configuration and User management to Read"
    );
    const writes = yield* check("notes", {
      ...readKey,
      token: "notes",
      scopes: [...readKey.scopes, "note:read-write"]
    });
    assert.instanceOf(writes, Source.WriteScopes);
    assert.deepStrictEqual((writes as Source.WriteScopes).scopes, ["note:read-write"]);
    assert.include(writes.message, "Notes is Read-write");
    // A setup key lacks no read scope Patchy can name: what it can write is what's wrong.
    const setup = yield* check("setup", {
      ...readKey,
      token: "setup",
      scopes: [
        "record_permission:read-write",
        "object_configuration:read-write",
        "list_entry:read-write",
        "list_configuration:read-write",
        "user_management:read"
      ]
    });
    assert.instanceOf(setup, Source.WriteScopes);
    assert.include(
      setup.message,
      "List configuration, List entries, Object configuration and Records are Read-write"
    );
  })
);

it.effect("fails closed on an answer missing what binds the key", () =>
  Effect.gen(function* () {
    const odd = (self: unknown) => check("odd", { ...readKey, token: "odd", self });
    const base = {
      active: true,
      token_level: "workspace",
      scope: readKey.scopes.join(" "),
      workspace_id: "ws-acme",
      workspace_name: "Acme",
      workspace_slug: "acme"
    };
    const without = (field: keyof typeof base) =>
      Object.fromEntries(Object.entries(base).filter(([name]) => name !== field));
    for (const self of [
      without("workspace_id"),
      without("scope"),
      { ...base, active: "yes" },
      "[]"
    ])
      assert.instanceOf(yield* odd(self), Source.Unavailable);
    const html = yield* Effect.flip(
      Effect.flatMap(
        source(() => new Response("<html>bad gateway</html>", { status: 502 })),
        ({ source: attio }) => attio.check(key(readKey.token))
      )
    );
    assert.instanceOf(html, Source.Unavailable);
  })
);

it.effect(
  "discovers objects, lists, attributes and active options, naming what it leaves out",
  () =>
    Effect.gen(function* () {
      const { result, requests } = yield* inspect(AttioDouble.workspace(readKey));
      if (result._tag !== "Success") return assert.fail(String(result.failure));
      const { snapshot } = result.success;
      assert.deepStrictEqual(snapshot.workspace, { id: "ws-acme", name: "Acme", slug: "acme" });
      assert.deepStrictEqual(
        snapshot.objects.map((object) => object.slug),
        ["companies", "people", "deals"]
      );
      const deals = snapshot.objects.find((object) => object.slug === "deals")!;
      assert.deepStrictEqual(
        deals.attributes.find((item) => item.slug === "stage"),
        {
          id: "att-d-stage",
          slug: "stage",
          title: "Deal stage",
          type: "status",
          multiselect: false,
          options: ["Lead", "In Progress", "Won 🎉", "Lost"]
        }
      );
      assert.deepStrictEqual(deals.attributes.find((item) => item.slug === "segment")?.options, [
        "Enterprise",
        "SMB"
      ]);
      // A reference keeps the targets the snapshot has, by id and slug.
      assert.deepStrictEqual(
        deals.attributes.find((item) => item.slug === "associated_company")?.targets,
        [{ id: "obj-companies", slug: "companies" }]
      );
      assert.deepStrictEqual(snapshot.lists, [
        {
          id: "lst-pipeline",
          slug: "pipeline",
          name: "Pipeline",
          parents: [{ id: "obj-deals", slug: "deals" }],
          attributes: [
            {
              id: "att-l-stage",
              slug: "stage",
              title: "Stage",
              type: "status",
              multiselect: false,
              options: ["Qualify", "Close"]
            },
            {
              id: "att-l-entered",
              slug: "entered_on",
              title: "Entered on",
              type: "date",
              multiselect: false
            }
          ]
        }
      ]);
      assert.sameDeepMembers(
        [...snapshot.excluded],
        [
          { kind: "object", name: "Workspace hidden", reason: "no_slug" },
          { kind: "list", name: "orphans", reason: "no_parent" },
          { kind: "list", name: "Untitled", reason: "no_slug" },
          {
            kind: "attribute",
            in: { kind: "object", slug: "companies" },
            name: "legacy_score",
            reason: "archived"
          },
          {
            kind: "attribute",
            in: { kind: "object", slug: "deals" },
            name: "forecast",
            reason: "unsupported_type"
          }
        ]
      );
      // Self, objects, lists, four containers' attributes, three option reads.
      assert.strictEqual(requests.length, 10);
      assert.isTrue(requests.every((request) => request.url.origin === "https://api.attio.com"));
      assert.isTrue(
        requests
          .filter((request) => request.url.pathname.endsWith("/attributes"))
          .every((request) => request.url.searchParams.get("show_archived") === "true")
      );
    })
);

it.effect("pages through attributes until a short page", () =>
  Effect.gen(function* () {
    const many = Array.from({ length: 510 }, (_, index) => ({
      id: `att-${index}`,
      slug: `field_${index}`,
      type: "text",
      archived: index >= 450
    }));
    const wide = {
      ...acme,
      objects: [{ id: "obj-wide", slug: "wide", name: "Wide", attributes: many }],
      lists: []
    };
    const { result, requests } = yield* inspect(
      AttioDouble.workspace({ ...readKey, workspace: wide })
    );
    if (result._tag !== "Success") return assert.fail(String(result.failure));
    assert.strictEqual(result.success.snapshot.objects[0]!.attributes.length, 450);
    assert.strictEqual(result.success.snapshot.excluded.length, 60);
    assert.deepStrictEqual(
      requests
        .filter((request) => request.url.pathname === "/v2/objects/obj-wide/attributes")
        .map((request) => request.url.searchParams.get("offset")),
      ["0", "500"]
    );
  })
);

it.effect("refuses each bound the moment it's passed, returning nothing", () =>
  Effect.gen(function* () {
    const refused = (values: Parameters<typeof limits>[0]) =>
      refusedWith(AttioDouble.workspace(readKey)).pipe(limits(values));
    const at = (error: unknown) => {
      assert.instanceOf(error, Source.DiscoveryTooLarge);
      return { limitId: error.limitId, at: error.at };
    };
    assert.deepStrictEqual(at(yield* refused({ "attio.discovery.objects": 2 })), {
      limitId: "attio.discovery.objects",
      at: undefined
    });
    assert.deepStrictEqual(at(yield* refused({ "attio.discovery.lists": 0 })), {
      limitId: "attio.discovery.lists",
      at: undefined
    });
    assert.deepStrictEqual(at(yield* refused({ "attio.discovery.attributes": 5 })), {
      limitId: "attio.discovery.attributes",
      at: "deals"
    });
    assert.deepStrictEqual(at(yield* refused({ "attio.discovery.options": 3 })), {
      limitId: "attio.discovery.options",
      at: "deals"
    });
    assert.strictEqual(
      at(yield* refused({ "attio.discovery.requests": 5 })).limitId,
      "attio.discovery.requests"
    );
    assert.strictEqual(
      at(yield* refused({ "attio.discovery.response": 600 })).limitId,
      "attio.discovery.response"
    );
    assert.strictEqual(
      at(yield* refused({ "attio.discovery.bytes": 1_200 })).limitId,
      "attio.discovery.bytes"
    );
  })
);

it.effect("counts what it leaves out toward the snapshot's bytes as it reads, not after", () =>
  Effect.gen(function* () {
    // An object of archived attributes: nothing kept, everything named, across two pages.
    const archived = Array.from({ length: 600 }, (_, index) => ({
      id: `att-${index}`,
      slug: `old_field_${index}`,
      type: "text",
      archived: true
    }));
    const attic = {
      ...acme,
      objects: [{ id: "obj-attic", slug: "attic", name: "Attic", attributes: archived }],
      lists: []
    };
    const { result, requests } = yield* inspect(
      AttioDouble.workspace({ ...readKey, workspace: attic })
    ).pipe(limits({ "attio.discovery.bytes": 4_000 }));
    if (result._tag !== "Failure") return assert.fail("discovery succeeded");
    assert.instanceOf(result.failure, Source.DiscoveryTooLarge);
    assert.strictEqual(result.failure.limitId, "attio.discovery.bytes");
    // The first page was enough to pass the bound: the second was never asked for.
    assert.isFalse(requests.some((request) => request.url.searchParams.get("offset") === "500"));
  })
);

it.effect("shares one call's byte budget between requests collecting at once", () =>
  Effect.gen(function* () {
    const { source: attio } = yield* source(() => AttioDouble.json(200, [1, 2, 34]));
    const budget = { remaining: 10 };
    const results = yield* Effect.all(
      [1, 2].map(() =>
        attio
          .send(key(readKey.token), HttpClientRequest.get("/v2/objects"), { max: 100, budget })
          .pipe(Effect.result)
      ),
      { concurrency: "unbounded" }
    );
    // Each answer is 8 bytes: the budget holds one of them, never both.
    assert.deepStrictEqual(results.map((result) => result._tag).sort(), ["Failure", "Success"]);
    assert.isAtLeast(budget.remaining, 0);
  })
);

it.effect("marks the selects and statuses whose options it ran out of budget for", () =>
  Effect.gen(function* () {
    const skipped = (values: Parameters<typeof limits>[0]) =>
      Effect.gen(function* () {
        const { result, requests } = yield* inspect(AttioDouble.workspace(readKey)).pipe(
          limits({ "attio.discovery.concurrent": 1, ...values })
        );
        if (result._tag !== "Success") return assert.fail(String(result.failure));
        const all = [...result.success.snapshot.objects, ...result.success.snapshot.lists].flatMap(
          (container) => container.attributes
        );
        return {
          skipped: all.filter((item) => item.optionsSkipped === true).map((item) => item.id),
          read: all.filter((item) => item.options !== undefined).map((item) => item.id),
          optionRequests: requests.filter((request) =>
            /\/(options|statuses)$/.test(request.url.pathname)
          ).length
        };
      });
    // Seven requests come first: self, objects, lists and four containers' attributes.
    assert.deepStrictEqual(yield* skipped({ "attio.discovery.optionRequests": 8 }), {
      skipped: ["att-d-segment", "att-l-stage"],
      read: ["att-d-stage"],
      optionRequests: 1
    });
    assert.deepStrictEqual(yield* skipped({ "attio.discovery.optionDeadline": 0 }), {
      skipped: ["att-d-stage", "att-d-segment", "att-l-stage"],
      read: [],
      optionRequests: 0
    });
  })
);

it.effect("times out at the discovery deadline", () =>
  Effect.gen(function* () {
    const stalled = AttioDouble.workspace(readKey);
    const handler: AttioDouble.Handler = (request) =>
      request.url.pathname === "/v2/lists" ? new Promise<Response>(() => {}) : stalled(request);
    const fiber = yield* inspect(handler).pipe(
      limits({ "attio.discovery.deadline": 5_000 }),
      Effect.forkChild
    );
    yield* TestClock.withLive(Effect.sleep("20 millis"));
    yield* TestClock.adjust("5 seconds");
    const { result } = yield* Fiber.join(fiber);
    if (result._tag !== "Failure") return assert.fail("discovery finished");
    assert.instanceOf(result.failure, Source.Timeout);
    assert.strictEqual(result.failure.milliseconds, 5_000);
  })
);

it.effect("classifies Attio's refusals and failures", () =>
  Effect.gen(function* () {
    const honest = AttioDouble.workspace(readKey);
    const on = (path: string, answer: () => Response) =>
      refusedWith((request) => (request.url.pathname === path ? answer() : honest(request)));
    // Attio names a missing scope only in prose: Patchy names it from what it was reading.
    const listsDenied = yield* on("/v2/lists", () =>
      AttioDouble.json(403, { status_code: 403, type: "auth_error", code: "unauthorized" })
    );
    assert.instanceOf(listsDenied, Source.AccessDenied);
    assert.strictEqual((listsDenied as Source.AccessDenied).scope, "list_configuration:read");
    const limited = yield* on("/v2/objects", () =>
      AttioDouble.json(
        429,
        { status_code: 429, type: "rate_limit_error", code: "rate_limit_exceeded" },
        { "retry-after": "Thu, 01 Jan 1970 00:00:00 GMT" }
      )
    );
    assert.instanceOf(limited, Source.RateLimited);
    assert.strictEqual((limited as Source.RateLimited).retryAfterSeconds, 1);
    for (const answer of [
      () => AttioDouble.json(500, {}),
      () => new Response("<html>502</html>", { status: 502 }),
      () => new Response("<html>400</html>", { status: 400 }),
      () => new Response("", { status: 302, headers: { location: "https://elsewhere.example/" } }),
      () => new Response("{not json", { status: 200 }),
      () => AttioDouble.json(200, { data: "not a list" })
    ])
      assert.instanceOf(yield* on("/v2/objects", answer), Source.Unavailable);
    const revoked = yield* on("/v2/objects", () =>
      AttioDouble.json(401, { status_code: 401, type: "auth_error", code: "unauthorized" })
    );
    assert.instanceOf(revoked, Source.Unavailable);
    assert.include(revoked.message, "Replace the key");
  })
);

it.effect("shares a workspace's slots across its connections, and Attio's across workspaces", () =>
  Effect.gen(function* () {
    const other = { ...readKey, token: "c".repeat(64) };
    const elsewhere = {
      ...readKey,
      token: "d".repeat(64),
      workspace: { ...acme, id: "ws-other", name: "Other", slug: "other" }
    };
    const honest = AttioDouble.workspace(readKey, other, elsewhere);
    let first = true;
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { source: attio } = yield* source(async (request) => {
      if (request.url.pathname === "/v2/objects" && first) {
        first = false;
        await opened;
      }
      return honest(request);
    }).pipe(limits({ "attio.calls.concurrent": 1, "attio.host.concurrent": 2 }));
    const held = yield* attio.inspect(key(readKey.token)).pipe(Effect.forkChild);
    yield* TestClock.withLive(Effect.sleep("20 millis"));
    // A second connection's key to the same workspace waits within its deadline, then is busy.
    const waiting = yield* attio.inspect(key(other.token)).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.withLive(Effect.sleep("20 millis"));
    // Past the waiting call's own deadline, short of the held discovery's.
    yield* TestClock.adjust("59500 millis");
    const busy = yield* Fiber.join(waiting);
    assert.instanceOf(busy, Source.Busy);
    assert.strictEqual((busy as Source.Busy).limitId, "attio.calls.concurrent");
    // Another workspace still has room under Attio's host bound.
    const free = yield* attio.inspect(key(elsewhere.token));
    assert.strictEqual(free.self.workspace.id, "ws-other");
    open();
    assert.strictEqual((yield* Fiber.join(held)).self.workspace.id, "ws-acme");
  })
);

it.effect("refuses busy when Attio's host bound is full, sending nothing", () =>
  Effect.gen(function* () {
    const { source: attio, requests } = yield* source(AttioDouble.workspace(readKey)).pipe(
      limits({ "attio.host.concurrent": 1 })
    );
    const gate = yield* Deferred.make<void>();
    const holding = yield* attio
      .withSlot(
        "ws-a",
        60_000
      )(Deferred.await(gate))
      .pipe(Effect.forkChild);
    yield* TestClock.withLive(Effect.sleep("10 millis"));
    const busy = yield* attio
      .withSlot(
        "ws-b",
        500
      )(attio.check(key(readKey.token)))
      .pipe(Effect.flip);
    assert.instanceOf(busy, Source.Busy);
    assert.strictEqual((busy as Source.Busy).limitId, "attio.host.concurrent");
    assert.strictEqual(requests.length, 0);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(holding);
  })
);
