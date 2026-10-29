import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Keys from "./Keys.js";
import * as Source from "./Source.js";
import { NodeCryptography } from "@patchy/core";

/**
 * Minting when answers go missing, offline over scripted answers in the shapes Pidgeon sends: what
 * Patchy decides once it can't tell whether a key exists. The live tier drops answers for real.
 */

const ADDRESS = "00000000-0000-4000-8000-000000000001";
const me = {
  data: {
    kind: "key",
    key: { id: "admin", access: "admin", reaches_all_addresses: true, test: true },
    workspace: { plan: "free" },
    reaches: 1
  }
};
const identity = {
  data: {
    id: ADDRESS,
    email: "support@acme.example",
    display_name: null,
    has_inbox: true,
    send_policy: "reply_only",
    test: true
  }
};
type Step =
  | { readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> }
  | "lost";

/** The production source over `steps`, answered in order; "lost" never answers. */
const scripted = (steps: Array<Step>) => {
  const sent: string[] = [];
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      sent.push(`${request.method} ${url.pathname.replace(/^\/api\/v1/, "")}`);
      const step = steps.shift() ?? { status: 500, body: {} };
      if (step === "lost")
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "lost" })
        });
      return HttpClientResponse.fromWeb(
        request,
        Response.json(step.body, { status: step.status, headers: step.headers ?? {} })
      );
    })
  );
  return {
    sent,
    layer: Layer.effect(Source.Source, Source.make).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http))
    )
  };
};
const connect = (layer: Layer.Layer<Source.Source>) =>
  Keys.provision({
    request: {
      adminKey: "pgn_test_scriptedAdminKey0001",
      attempt: "attempt00001",
      access: "send",
      address: { id: ADDRESS }
    },
    handle: "support",
    scope: "company"
  }).pipe(Effect.provide(layer), Effect.flip);

it.effect(
  "names a key it may have minted when the ask again is refused, keeping when to retry",
  () =>
    Effect.gen(function* () {
      const { sent, layer } = scripted([
        { status: 200, body: me },
        { status: 200, body: identity },
        "lost",
        {
          status: 429,
          body: { error: { code: "rate_limited", message: "Slow down." } },
          headers: { "retry-after": "30" }
        }
      ]);
      const error = yield* connect(layer);
      if (error._tag !== "PidgeonStrayKey") return assert.fail(`A stray key, not ${error._tag}`);
      assert.strictEqual(error.key, "Patchy support attempt00001");
      assert.include(error.message, "named Patchy support attempt00001");
      assert.include(error.message, "Try again in 30 seconds.");
      assert.deepStrictEqual(sent.slice(2), ["POST /api-keys", "POST /api-keys"]);
    }).pipe(Effect.provide(NodeCryptography.layer))
);

it.effect("refuses an admin key that doesn't reach the whole account, or isn't admin", () =>
  Effect.gen(function* () {
    for (const [key, refusal] of [
      [{ ...me.data.key, reaches_all_addresses: false }, "PidgeonPartialAdminKey"],
      [{ ...me.data.key, access: "send" }, "PidgeonNotAdminKey"]
    ] as const) {
      const { sent, layer } = scripted([{ status: 200, body: { data: { ...me.data, key } } }]);
      assert.strictEqual((yield* connect(layer))._tag, refusal);
      assert.deepStrictEqual(sent, ["GET /me"]);
    }
  }).pipe(Effect.provide(NodeCryptography.layer))
);

it.effect("refuses outright when nothing was lost, and nothing can have been minted", () =>
  Effect.gen(function* () {
    const { layer } = scripted([
      { status: 200, body: me },
      { status: 200, body: identity },
      {
        status: 429,
        body: { error: { code: "rate_limited", message: "Slow down." } },
        headers: { "retry-after": "30" }
      }
    ]);
    assert.strictEqual((yield* connect(layer))._tag, "PidgeonRateLimited");
  }).pipe(Effect.provide(NodeCryptography.layer))
);

it.effect("keeps a replayed key named when the admin key can't revoke it", () =>
  Effect.gen(function* () {
    const replay = {
      data: {
        id: "minted",
        name: "Patchy support attempt00001",
        token: null,
        test: true,
        created_at: "2026-10-26T00:00:00.000Z"
      }
    };
    const { sent, layer } = scripted([
      { status: 200, body: me },
      { status: 200, body: identity },
      "lost",
      { status: 201, body: replay, headers: { "idempotent-replay": "true" } },
      // The admin key stopped working: that says nothing about the key it made.
      { status: 401, body: { error: { code: "unauthenticated", message: "Not valid." } } }
    ]);
    const error = yield* connect(layer);
    if (error._tag !== "PidgeonStrayKey") return assert.fail(`A stray key, not ${error._tag}`);
    assert.strictEqual(error.key, "Patchy support attempt00001");
    assert.deepStrictEqual(sent.slice(2), [
      "POST /api-keys",
      "POST /api-keys",
      "DELETE /api-keys/minted"
    ]);
  }).pipe(Effect.provide(NodeCryptography.layer))
);
