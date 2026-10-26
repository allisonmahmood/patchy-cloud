import { assert, it } from "@effect/vitest";
import { PidgeonSource } from "@patchy/integrations";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isTestKey, revokeKeys } from "./pidgeon.js";

/** Pidgeon as these tests script it: answers by method and path, and every request it saw. */
const scripted = (answers: Record<string, unknown>) => {
  const sent: string[] = [];
  const source = PidgeonSource.Source.of({
    call: (_token, request) => {
      const route = `${request.method} ${request.path}`;
      sent.push(route);
      const answer = answers[route];
      return answer === undefined
        ? Effect.fail(new PidgeonSource.NotFound({}))
        : answer === "unavailable"
          ? Effect.fail(new PidgeonSource.Unavailable({ stage: "status", upstreamStatus: 503 }))
          : Effect.succeed({ body: answer, replayed: false });
    },
    withSlot: () => (effect) => effect
  });
  return { sent, provide: Effect.provideService(PidgeonSource.Source, source) };
};
const key = (name: string, access: string, test = true, revoked_at: string | null = null) => ({
  data: { name, access, test, revoked_at }
});
const admin = Redacted.make("pgn_test_scriptedDevAdmin0001");

it.effect("refuses a live admin key, by its own /me", () =>
  Effect.gen(function* () {
    for (const [test, expected] of [
      [true, true],
      [false, false]
    ] as const) {
      const pidgeon = scripted({ "GET /me": { data: { key: { test } } } });
      assert.strictEqual(yield* isTestKey(admin).pipe(pidgeon.provide), expected);
    }
  })
);

it.effect("revokes only the stored ids that are test keys Patchy named below admin", () =>
  Effect.gen(function* () {
    const pidgeon = scripted({
      "GET /api-keys/ours": key("Patchy support attempt00001", "send"),
      "DELETE /api-keys/ours": { data: { revoked: true } },
      "GET /api-keys/admin": key("Patchy support attempt00002", "admin"),
      "GET /api-keys/live": key("Patchy support attempt00003", "send", false),
      "GET /api-keys/named": key("Someone else's", "read"),
      "GET /api-keys/revoked": key("Patchy support attempt00004", "read", true, "2026-10-26"),
      "GET /api-keys/stuck": key("Patchy support attempt00005", "read"),
      "DELETE /api-keys/stuck": "unavailable"
    });
    const result = yield* revokeKeys(admin, [
      "ours",
      "admin",
      "live",
      "named",
      "revoked",
      "gone",
      "stuck"
    ]).pipe(pidgeon.provide);
    assert.deepStrictEqual(result, {
      revoked: 1,
      // Pidgeon wouldn't revoke it: still active, and the caller removes nothing.
      left: ["stuck"],
      skipped: ["admin", "live", "named"]
    });
    assert.deepStrictEqual(
      pidgeon.sent.filter((route) => route.startsWith("DELETE")),
      ["DELETE /api-keys/ours", "DELETE /api-keys/stuck"]
    );
  })
);
