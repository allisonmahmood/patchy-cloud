/**
 * Model calls end to end: a published tier 2 action on the development executor's own workerd,
 * its callbacks through the execution process's proxy to the host's gateway, the two checks and
 * the host's queue, to the fake provider and back, and every way a call ends reaching the page's
 * call with its code. The action's deadline is six seconds here, so the cut-off and the pre-send
 * floor are reached in moments.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, it } from "@effect/vitest";
import { build } from "esbuild";
import { CURRENT_RELEASE, WIRE_VERSION, type Manifest } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { signedInCookies, signSession } from "@patchy/auth/testing";
import { NodeCryptography } from "@patchy/core";
import { ConnectionStore, ModelsSource } from "@patchy/integrations";
import * as FakeModels from "@patchy/integrations/models-fake";
import { ContractLimits } from "@patchy/limits";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";
import { answer, publish, send, server } from "./test/server.js";

const origin = "https://patchy.example";
const deadline = 6_000;

/** The fake provider for a suite, and the server sending its model calls there. */
class Provider extends Context.Service<Provider, FakeModels.Fake>()("test/ModelCalls/Provider") {}
const suiteWith = (limits: Readonly<Record<string, number>>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return server(
        { NODE_ENV: "development", PATCHY_LIMITS_JSON: JSON.stringify(limits) },
        undefined,
        undefined,
        ModelsSource.layerAt(provider.url)
      );
    })
  ).pipe(
    Layer.provideMerge(Layer.effect(Provider, FakeModels.start())),
    Layer.provide(Layer.succeed(ContractLimits.overrides, { "tier2.action.deadline": deadline })),
    Layer.provide([FetchHttpClient.layer, NodeFileSystem.layer]),
    Layer.provideMerge(NodeCryptography.layer)
  );
// One model-calling action per person, so a second is refused its move into the pool.
const suite = suiteWith({ "tier2.models.viewer": 1 });
// One model call at a time in the execution task, so a second is refused at its proxy.
const permitSuite = suiteWith({ "models.execution.inFlight": 1 });

/** One action asks a role: `decide`, `generate` for text, or `typed`, after waiting `waitMs`. */
const guest = Effect.promise(async () => {
  const built = await build({
    stdin: {
      contents: `import { action, createGuest, t } from "patchy/server";
const questions = {
  team: { type: "choice", instructions: "Which team handles it?",
    options: { billing: "Charges and refunds", technical: "Bugs and outages" } },
  urgency: { type: "scale", instructions: "How urgent is it?", levels: ["low", "medium", "high"] },
  spam: { type: "yesNo", instructions: "It is spam." }
};
const ask = action({
  args: { call: t.text(), input: t.text(), waitMs: t.integer() }, result: t.json(),
  handler: async (ctx, args) => {
    if (args.call === "quick") return { quick: true };
    // Two at once: the second meets a task holding one model call at a time.
    if (args.call === "pair")
      return await Promise.all([
        ctx.connections.writer.generate({ input: "[fake:delay=1500]", maxOutputTokens: 60 }),
        ctx.connections.writer.generate({ input: args.input, maxOutputTokens: 60 })
      ]);
    if (args.call === "oversized")
      return await ctx.connections.writer.generate({
        input: "x".repeat(1_100_000), maxOutputTokens: 60
      });
    // Both roles' calls past the cap, refused in the same words; the text call's is relayed.
    if (args.call === "twins") {
      await ctx.connections.triage.decide({ input: "x".repeat(1_100_000), questions }).catch(() => null);
      return await ctx.connections.writer.generate({
        input: "x".repeat(1_100_000), maxOutputTokens: 60
      });
    }
    if (args.waitMs > 0) await new Promise((done) => setTimeout(done, args.waitMs));
    if (args.call === "decide")
      return await ctx.connections.triage.decide({ input: args.input, questions });
    if (args.call === "typed")
      return await ctx.connections.writer.generate({
        instructions: "Plan the reply.", input: args.input, maxOutputTokens: 200,
        output: t.object({ team: t.enum(["billing", "technical"]), reply: t.text() })
      });
    return await ctx.connections.writer.generate({
      instructions: "Summarise it.", input: args.input, maxOutputTokens: 60
    });
  }
});
export default createGuest({ demo: { ask } }, [], {}, [], [], [], [], { triage: "decision", writer: "text" });`,
      resolveDir: new URL("../../../packages/patchy", import.meta.url).pathname,
      sourcefile: "model-calls-fixture.ts"
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["development"]
  });
  return built.outputFiles[0]!.text;
});

/**
 * An OpenAI key of the company's, a decision role and a text role on it, and a patch calling both
 * as `triage` and `writer`; each case gets its own, by `name`.
 */
const published = Effect.fn("test.published")(function* (name: string) {
  // The server's own store: its layer doesn't name it among what it provides.
  const store = Option.getOrThrow(yield* Effect.serviceOption(ConnectionStore.ConnectionStore));
  const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
  const provider = yield* store.connectProvider({
    ...who,
    provider: "openai",
    handle: `${name}-key`,
    credentials: Redacted.make("sk-fake-provider-key")
  });
  const role = (handle: string, kind: "decision" | "text", model: string) =>
    store.createRole({ ...who, handle, kind, description: "", providerId: provider.id, model });
  const triage = yield* role(`${name}-triage`, "decision", "gpt-6-luna");
  const writer = yield* role(`${name}-writer`, "text", "gpt-5-mini");
  const declared = (connection: ConnectionStore.ModelsConnection) => ({
    kind: "models" as const,
    handle: connection.handle,
    id: connection.id,
    revision: connection.metadataRevision
  });
  const manifest: typeof Manifest.Type = {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: { triage: declared(triage), writer: declared(writer) },
    handlers: {
      "demo.ask": {
        kind: "action",
        args: { call: { kind: "text" }, input: { kind: "text" }, waitMs: { kind: "integer" } },
        result: { kind: "json" }
      }
    }
  };
  const response = yield* publish(DEV_SEED.token, {
    html: "<!doctype html><html><body><h1>Triage</h1></body></html>",
    server: yield* guest,
    manifest
  });
  assert.strictEqual(response.status, 201);
  return (yield* response.json) as { readonly patchId: string; readonly versionId: string };
});

interface Person {
  readonly userId: string;
  readonly clerkUserId: string;
  readonly email: string;
}
const seeded: Person = {
  userId: DEV_SEED.userId,
  clerkUserId: DEV_SEED.clerkUserId,
  email: DEV_SEED.email
};
/** Another member of the seeded company, by number. */
const member = Effect.fn("test.member")(function* (number: number) {
  const sql = yield* SqlClient.SqlClient;
  const person: Person = {
    userId: `usr_models_${number}`,
    clerkUserId: `user_models_${number}`,
    email: `member${number}@models.example`
  };
  yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
    VALUES (${person.userId}, ${person.clerkUserId}, ${DEV_SEED.companyId}, ${person.email},
      ${`Member ${number}`}, 'member')`;
  return person;
});

/** The page's call of a handler, as a person, the seeded one unless named, and its answer. */
const callHandler = (
  patch: { readonly patchId: string; readonly versionId: string },
  handler: string,
  args: Readonly<Record<string, unknown>>,
  person: Person = seeded
) =>
  Effect.flatMap(
    send(
      HttpClientRequest.post("/api/runtime/call").pipe(
        HttpClientRequest.setHeaders({
          origin,
          cookie: signedInCookies(
            signSession({ sub: person.clerkUserId, email: person.email, azp: origin })
          ),
          "x-patchy-wire": String(WIRE_VERSION),
          "x-patchy-principal": JSON.stringify({ userId: person.userId })
        }),
        HttpClientRequest.bodyJsonUnsafe({
          patchId: patch.patchId,
          versionId: patch.versionId,
          wire: WIRE_VERSION,
          principal: { userId: person.userId },
          op: "server.call",
          args: { handler, args }
        })
      )
    ),
    answer
  );

/** The page's call of the action, as a person, the seeded one unless named, and its answer. */
const ask = (
  patch: { readonly patchId: string; readonly versionId: string },
  call: "decide" | "generate" | "typed" | "quick" | "pair" | "oversized" | "twins",
  input: string,
  waitMs = 0,
  person: Person = seeded
) => callHandler(patch, "demo.ask", { call, input, waitMs }, person);
/** What a refusal says to the page: its code, limit, retry advice, details and operation. */
const refusal = (body: unknown) => {
  const { code, limitId, retryAfter, details, operation } = body as Record<string, unknown>;
  return JSON.parse(JSON.stringify({ code, limitId, retryAfter, details, operation })) as unknown;
};

it.layer(suite, { excludeTestServices: true, timeout: "120 seconds" })(
  "model calls end to end",
  (it) => {
    it.effect(
      "answers a decision, a short text and a typed value from the fake provider",
      () =>
        Effect.gen(function* () {
          const patch = yield* published("answers");
          const decided = yield* ask(
            patch,
            "decide",
            "I was charged twice, please refund me today"
          );
          assert.strictEqual(decided.status, 200);
          const { value } = decided.body as {
            readonly value: {
              readonly answers: Readonly<
                Record<string, { readonly choice?: string; readonly level?: string } | null>
              >;
              readonly usage: { readonly outputTokens: number };
            };
          };
          assert.strictEqual(value.answers.team?.choice, "billing");
          assert.strictEqual(value.answers.urgency?.level, "medium");
          // A decision's output tokens are free and count 0.
          assert.strictEqual(value.usage.outputTokens, 0);
          const text = yield* ask(patch, "generate", "The printer on floor two is out of toner");
          assert.deepInclude((text.body as { value: unknown }).value, {
            text: 'Read 9 words, starting "the printer on floor two".'
          });
          const typed = yield* ask(patch, "typed", "Refund the double charge on my card");
          assert.deepInclude((typed.body as { value: unknown }).value, {
            value: { team: "billing", reply: "refund the double charge on my" }
          });
          // A refused question answers null while the others answer.
          const refusedQuestion = yield* ask(patch, "decide", "Bugs everywhere [fake:refuse]");
          const answers = (refusedQuestion.body as { value: { answers: Record<string, unknown> } })
            .value.answers;
          assert.deepStrictEqual(
            Object.values(answers).map((answer) => answer === null),
            [false, false, true]
          );
          // The provider saw only what Patchy sends: the selected key, nothing to keep or trace.
          const provider = yield* Provider;
          for (const entry of provider.entries) {
            assert.notInclude(entry.headers, "traceparent");
            assert.notInclude(entry.headers, "openai-organization");
            assert.notInclude(entry.bodyKeys, "store");
            assert.notInclude(entry.bodyKeys, "tools");
            assert.notInclude(entry.bodyKeys, "previous_response_id");
          }
        }),
      60_000
    );

    it.effect(
      "hands the page every way a call ends, with its code and whether anything was sent",
      () =>
        Effect.gen(function* () {
          const patch = yield* published("ends");
          const ends: ReadonlyArray<
            readonly [string, "decide" | "generate" | "typed", string, number, unknown]
          > = [
            [
              "cut off",
              "generate",
              "[fake:hang]",
              0,
              {
                code: "timeout",
                limitId: "models.cutoff",
                details: { sent: true },
                operation: "models.generate"
              }
            ],
            [
              "too late to send",
              "generate",
              "late",
              deadline - 1_500,
              {
                code: "timeout",
                limitId: "models.send.floor",
                details: { sent: false },
                operation: "models.generate"
              }
            ],
            [
              "rate limited",
              "generate",
              "[fake:rate]",
              0,
              {
                code: "source_rate_limited",
                retryAfter: 7,
                details: { sent: true, limit: "requests" },
                operation: "models.generate"
              }
            ],
            [
              "out of credit",
              "decide",
              "[fake:quota]",
              0,
              {
                code: "source_rate_limited",
                details: { sent: true, limit: "quota" },
                operation: "models.decide"
              }
            ],
            [
              "refused",
              "generate",
              "[fake:refuse]",
              0,
              { code: "model_refused", details: { sent: true }, operation: "models.generate" }
            ],
            [
              "truncated",
              "generate",
              "[fake:truncate]",
              0,
              {
                code: "output_truncated",
                details: { sent: true, maxOutputTokens: 60 },
                operation: "models.generate"
              }
            ],
            [
              "the wrong shape",
              "typed",
              "[fake:mismatch]",
              0,
              { code: "shape_mismatch", details: { sent: true }, operation: "models.generate" }
            ],
            [
              "the provider failing",
              "generate",
              "[fake:overloaded]",
              0,
              {
                code: "source_unavailable",
                retryAfter: 2,
                details: { sent: true, reason: "provider", upstreamStatus: 503 },
                operation: "models.generate"
              }
            ],
            [
              "too large an answer",
              "decide",
              "[fake:huge]",
              0,
              {
                code: "too_large",
                limitId: "models.answer.bytes",
                details: { sent: true },
                operation: "models.decide"
              }
            ],
            [
              "an invalid request",
              "generate",
              "[fake:invalid]",
              0,
              {
                code: "invalid_request",
                details: { sent: true, reason: "provider", upstreamStatus: 400 },
                operation: "models.generate"
              }
            ]
          ];
          for (const [name, call, input, waitMs, expected] of ends) {
            const ended = yield* ask(patch, call, input, waitMs);
            assert.notStrictEqual(ended.status, 200, name);
            assert.deepStrictEqual(refusal(ended.body), expected, name);
          }
        }),
      90_000
    );

    it.effect(
      "refuses a second person's action its place in the model pool, busy, nothing sent",
      () =>
        Effect.gen(function* () {
          const patch = yield* published("busy");
          const provider = yield* Provider;
          const before = provider.entries.length;
          // The first holds the person's one place while its answer is on its way.
          const holding = yield* ask(patch, "generate", "[fake:delay=2500]").pipe(Effect.forkChild);
          while (provider.open() === 0) yield* Effect.sleep(10);
          const refused = yield* ask(patch, "generate", "second");
          assert.strictEqual(refused.status, 429);
          assert.deepInclude(refusal(refused.body) as object, {
            code: "busy",
            limitId: "tier2.models.viewer",
            details: { sent: false },
            operation: "models.generate"
          });
          assert.strictEqual(provider.entries.length, before + 1);
          const held = yield* Fiber.join(holding);
          assert.strictEqual(held.status, 200);
        }),
      30_000
    );

    it.effect(
      "runs other people's quick actions while eight people wait on slow model calls",
      () =>
        Effect.gen(function* () {
          const patch = yield* published("load");
          const provider = yield* Provider;
          const waiting = yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], member);
          const others = yield* Effect.forEach([9, 10, 11, 12], member);
          // Eight slow model calls, one per person: under the old counting they'd hold all eight
          // of the company's action slots until they answered.
          const slow = yield* Effect.forEach(
            waiting,
            (person) => ask(patch, "generate", "[fake:delay=3000]", 0, person),
            { concurrency: "unbounded" }
          ).pipe(Effect.forkChild);
          while (provider.open() < waiting.length) yield* Effect.sleep(10);
          const quick = yield* Effect.forEach(
            others,
            (person) => ask(patch, "quick", "", 0, person),
            { concurrency: "unbounded" }
          );
          assert.deepStrictEqual(
            quick.map(({ status, body }) => [status, body]),
            others.map(() => [200, { ok: true, value: { quick: true } }])
          );
          // Every slow call was still open when the quick ones finished, and then answered.
          assert.strictEqual(provider.open(), waiting.length);
          const answered = yield* Fiber.join(slow);
          assert.deepStrictEqual(
            answered.map(({ status }) => status),
            waiting.map(() => 200)
          );
        }),
      30_000
    );
  }
);

/** The refusal an execution task gives a model call past its one permit, as the proxy words it. */
const taskBusy = {
  ok: false,
  source: "patchy",
  code: "busy",
  error:
    "Too many model calls are running in this company's execution task, so nothing was sent. Try again shortly.",
  scope: "company",
  limitId: "models.execution.inFlight",
  value: 1,
  retryAfter: 1,
  details: { sent: false }
};

/** A patch whose action claims that refusal without making any call: no SDK, its own reply. */
const fabricating = Effect.gen(function* () {
  const bundle = `export default { async fetch(request) {
  const input = await request.json();
  if (input.type === "describe")
    return Response.json({ ok: true, handlers: { "demo.claim": { kind: "action", args: {}, result: { kind: "json" } } } });
  return Response.json(${JSON.stringify(taskBusy)});
}};`;
  const response = yield* publish(DEV_SEED.token, {
    html: "<!doctype html><html><body><h1>Claims</h1></body></html>",
    server: bundle,
    manifest: {
      manifestVersion: 1,
      release: CURRENT_RELEASE,
      tier: 2,
      tables: {},
      files: {},
      uses: {},
      handlers: { "demo.claim": { kind: "action", args: {}, result: { kind: "json" } } }
    } satisfies typeof Manifest.Type
  });
  assert.strictEqual(response.status, 201);
  return (yield* response.json) as { readonly patchId: string; readonly versionId: string };
});

it.layer(permitSuite, { excludeTestServices: true, timeout: "120 seconds" })(
  "an execution task's own refusals",
  (it) => {
    it.effect(
      "hand the page the task's busy and too_large with their limits, and no patch can claim one",
      () =>
        Effect.gen(function* () {
          const patch = yield* published("task");
          // A second call while the task holds its one model call: refused at the task's proxy.
          const busy = yield* ask(patch, "pair", "second");
          assert.strictEqual(busy.status, 429);
          assert.deepStrictEqual(busy.body, { ...taskBusy, operation: "models.generate" });
          // Arguments past models.ingress.bytes: refused by the loader, before they leave
          // workerd, in its own words.
          const large = yield* ask(patch, "oversized", "");
          assert.strictEqual(large.status, 413);
          assert.deepStrictEqual(refusal(large.body), {
            code: "too_large",
            limitId: "models.ingress.bytes",
            details: { sent: false },
            operation: "models.generate"
          });
          assert.include(large.body as object, {
            error: "The model call exceeds models.ingress.bytes, so nothing was sent."
          });
          // Two operations given the same refusal: the record can't say which was relayed, so
          // the page is told neither.
          const twins = yield* ask(patch, "twins", "");
          assert.strictEqual(twins.status, 413);
          assert.deepStrictEqual(refusal(twins.body), {
            code: "too_large",
            limitId: "models.ingress.bytes",
            details: { sent: false }
          });
          // The same words from patch code, with no call behind them, are the patch's own failure.
          const claimed = yield* callHandler(yield* fabricating, "demo.claim", {});
          assert.include(claimed.body as object, { ok: false, code: "handler_failed" });
        }),
      60_000
    );
  }
);
