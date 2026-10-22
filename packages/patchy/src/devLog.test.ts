import { assert, it } from "@effect/vitest";
import type { Invocation } from "@patchy/runtime/dev";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as DevLog from "./devLog.js";

const settlement: Invocation.DevSettlement = {
  id: "inv_dev",
  companyId: "cmp_dev",
  patchId: "localdev0000",
  versionId: "ver_dev",
  handler: "agent.listDeals",
  kind: "query",
  initiatingViewerId: "usr_dev",
  agent: null,
  parentId: null,
  correlationId: "call_dev",
  startedAt: 0,
  deadline: 3_000,
  argsBytes: 2,
  outcome: "success",
  outcomeCode: null,
  settledAt: 12,
  durationMs: 12,
  guestMs: 3,
  dbMs: 0,
  callbacks: 0,
  resultBytes: 2,
  attempts: 1,
  logLines: [],
  replyDelivered: true
};

it.effect("an agent's call reads as its person via the agent", () =>
  Effect.gen(function* () {
    const lines: unknown[] = [];
    const console = yield* Console.Console;
    yield* Effect.forEach([settlement, { ...settlement, agent: { name: "patchy dev" } }], (event) =>
      DevLog.invocation(event, false)
    ).pipe(
      Effect.provideService(Console.Console, {
        ...console,
        log: (...args) => lines.push(...args)
      })
    );
    assert.deepStrictEqual(lines, [
      "usr_dev agent.listDeals success 12ms",
      "usr_dev via patchy dev agent.listDeals success 12ms"
    ]);
  })
);
