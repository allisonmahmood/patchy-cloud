// @effect-diagnostics nodeBuiltinImport:off -- a local HTTP server proves what the real fetch transport does with a redirect.
import { createServer } from "node:http";
import { assert, describe, it } from "@effect/vitest";
import type { ModelsDecideArgs, ModelsGenerateArgs } from "@patchy/api";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Errors from "./Errors.js";
import * as Source from "./Source.js";

/** What reached the network: the final outbound request, as the provider would see it. */
interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

const KEY = "sk-test-key-marker";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
/** Usage as OpenAI documents it, with its detail objects. */
const documentedUsage = (input: number, output: number) => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: input + output
});
/** A completed Responses answer as OpenAI documents one, whose message holds `parts`. */
const responses = (
  parts: ReadonlyArray<Record<string, unknown>>,
  extra: Record<string, unknown> = {}
) => ({
  id: "resp_1",
  object: "response",
  created_at: 1741476542,
  status: "completed",
  completed_at: 1741476543,
  error: null,
  incomplete_details: null,
  instructions: null,
  max_output_tokens: 200,
  model: "gpt-test",
  output: [
    { type: "message", id: "msg_1", role: "assistant", status: "completed", content: parts }
  ],
  parallel_tool_calls: true,
  previous_response_id: null,
  reasoning: { effort: null, summary: null },
  store: true,
  temperature: 1,
  text: { format: { type: "text" } },
  tool_choice: "auto",
  tools: [],
  top_p: 1,
  truncation: "disabled",
  usage: documentedUsage(12, 7),
  user: null,
  metadata: {},
  ...extra
});
const textPart = (text: string) => ({ type: "output_text", text, annotations: [] });

/** A provider that answers each request with `answer`, or never answers. */
const provider = (answer: (sent: Sent) => Response | "hang") => {
  const sent: Sent[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
      const call: Sent = {
        url: url.href,
        method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers)),
        body: JSON.parse(body)
      };
      sent.push(call);
      const reply = answer(call);
      if (reply === "hang") return yield* Effect.never;
      return HttpClientResponse.fromWeb(request, reply);
    })
  );
  return { sent, source: Source.make.pipe(Effect.provideService(HttpClient.HttpClient, client)) };
};

const target: Source.Target = { model: "gpt-test" };
const deciding: Source.Target = { model: "gpt-6-luna" };
const dispatch = (
  deadlineMs = 60_000,
  beforeSend: Effect.Effect<Redacted.Redacted<string>, Errors.CallError> = Effect.succeed(
    Redacted.make(KEY)
  )
) =>
  Effect.map(Clock.currentTimeMillis, (now) => ({
    deadline: now + deadlineMs,
    attempt: { sent: false } as Source.Attempt,
    beforeSend
  }));
const generateArgs = (
  args: Partial<typeof ModelsGenerateArgs.Type> = {}
): typeof ModelsGenerateArgs.Type => ({
  instructions: "Summarise the request.",
  input: "The printer on floor 2 is out of toner.",
  maxOutputTokens: 200,
  ...args
});
const decideArgs: typeof ModelsDecideArgs.Type = {
  input: { subject: "Refund please", body: "I was charged twice." },
  questions: {
    team: {
      type: "choice",
      instructions: "Which team handles it?",
      options: { billing: "Charges and refunds", technical: "Bugs and outages" }
    },
    urgency: {
      type: "scale",
      instructions: "How urgent is it?",
      levels: ["low", "medium", "high"]
    },
    angry: { type: "yesNo", instructions: "The sender is angry." }
  }
};
/** The limit a refusal names, if it names one. */
const limitOf = (error: object) => ("limitId" in error ? error.limitId : undefined);
const failed = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (error === undefined || error._tag !== "Fail") throw new Error("expected a typed failure");
  return error.error;
};
/** Every header the provider receives, and nothing else: no trace context, no organisation. */
const assertHeaders = (sent: Sent) => {
  const { "content-length": length, ...named } = sent.headers;
  assert.deepStrictEqual(named, {
    accept: "application/json",
    authorization: `Bearer ${KEY}`,
    "content-type": "application/json"
  });
  assert.strictEqual(
    Number(length),
    new TextEncoder().encode(JSON.stringify(sent.body)).byteLength
  );
};
const typed = {
  kind: "object",
  fields: {
    team: { kind: "enum", values: ["billing", "technical"] },
    summary: { kind: "text" },
    tags: { kind: "array", element: { kind: "text" } }
  }
} as const;

describe("OpenAI text calls", () => {
  it.effect("sends one Responses request with the key alone and nothing to keep or continue", () =>
    Effect.gen(function* () {
      const fake = provider(() => json(responses([textPart("Order toner for floor 2.")])));
      const source = yield* fake.source;
      const call = yield* dispatch();
      const answer = yield* source.generate(target, generateArgs(), call);
      assert.deepStrictEqual(answer, {
        text: "Order toner for floor 2.",
        usage: { inputTokens: 12, outputTokens: 7 }
      });
      assert.isTrue(call.attempt.sent);
      assert.strictEqual(fake.sent.length, 1);
      const [request] = fake.sent;
      assert.strictEqual(request!.url, "https://api.openai.com/v1/responses");
      assert.strictEqual(request!.method, "POST");
      // No trace context, no organisation or project, nothing but the selected key.
      assertHeaders(request!);
      // The whole body: no storage directive, previous response, tool, conversation or reasoning
      // state; instructions and input in separate positions.
      assert.deepStrictEqual(request!.body, {
        model: "gpt-test",
        max_output_tokens: 200,
        input: [
          { role: "system", content: [{ type: "input_text", text: "Summarise the request." }] },
          {
            role: "user",
            content: [{ type: "input_text", text: "The printer on floor 2 is out of toner." }]
          }
        ]
      });
    })
  );

  it.effect("asks for a typed output through OpenAI's own structured outputs and checks it", () =>
    Effect.gen(function* () {
      const fake = provider(() =>
        json(
          responses([
            textPart(JSON.stringify({ team: "billing", summary: "Refund", tags: ["charge"] }))
          ])
        )
      );
      const source = yield* fake.source;
      const answer = yield* source.generate(
        target,
        generateArgs({ output: typed }),
        yield* dispatch()
      );
      assert.deepStrictEqual(answer, {
        value: { team: "billing", summary: "Refund", tags: ["charge"] },
        usage: { inputTokens: 12, outputTokens: 7 }
      });
      assertHeaders(fake.sent[0]!);
      // The whole body, the compiled schema included: no tool definition, nothing to keep.
      assert.deepStrictEqual(fake.sent[0]!.body, {
        model: "gpt-test",
        max_output_tokens: 200,
        input: [
          { role: "system", content: [{ type: "input_text", text: "Summarise the request." }] },
          {
            role: "user",
            content: [{ type: "input_text", text: "The printer on floor 2 is out of toner." }]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "output",
            description: "Response with a JSON object",
            schema: {
              type: "object",
              properties: {
                team: { type: "string", enum: ["billing", "technical"] },
                summary: { type: "string" },
                tags: { type: "array", items: { type: "string" } }
              },
              required: ["team", "summary", "tags"],
              additionalProperties: false
            },
            strict: true
          }
        }
      });
    })
  );

  it.effect("finishes each way the answer says, from its own status before any decode", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<
        readonly [string, Record<string, unknown>, typeof ModelsGenerateArgs.Type, string]
      > = [
        // A valid-looking partial output is still a cut-off.
        [
          "partial",
          responses([textPart("Order toner for")], {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" }
          }),
          generateArgs(),
          "output_truncated"
        ],
        // A partial typed answer that happens to parse is still a cut-off.
        [
          "typed partial",
          responses([textPart(JSON.stringify({ team: "billing", summary: "R", tags: [] }))], {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" }
          }),
          generateArgs({ output: typed }),
          "output_truncated"
        ],
        // A refusal that carries text is a refusal.
        [
          "refusal with text",
          responses([textPart("Sure, "), { type: "refusal", refusal: "I can't help with that." }]),
          generateArgs(),
          "model_refused"
        ],
        [
          "filtered",
          responses([textPart("Partial")], {
            status: "incomplete",
            incomplete_details: { reason: "content_filter" }
          }),
          generateArgs(),
          "model_refused"
        ],
        [
          "malformed typed",
          responses([textPart("{ not json")]),
          generateArgs({ output: typed }),
          "shape_mismatch"
        ],
        [
          "empty typed",
          responses([textPart("")]),
          generateArgs({ output: typed }),
          "shape_mismatch"
        ],
        [
          "wrong shape",
          responses([textPart(JSON.stringify({ team: "sales", summary: "x", tags: [] }))]),
          generateArgs({ output: typed }),
          "shape_mismatch"
        ],
        [
          "other stop",
          responses([textPart("Hi")], {
            status: "incomplete",
            incomplete_details: { reason: "max_messages" }
          }),
          generateArgs(),
          "source_unavailable"
        ],
        [
          "failed",
          responses([], {
            status: "failed",
            error: { code: "server_error", message: "The server had an error processing it." }
          }),
          generateArgs(),
          "source_unavailable"
        ]
      ];
      for (const [name, body, args, code] of cases) {
        const fake = provider(() => json(body));
        const source = yield* fake.source;
        const call = yield* dispatch();
        const error = failed(yield* Effect.exit(source.generate(target, args, call)));
        assert.strictEqual(error.code, code, name);
        assert.isTrue(call.attempt.sent, name);
        assert.deepStrictEqual(
          call.attempt.usage,
          { inputTokens: 12, outputTokens: 7 },
          `${name} keeps usage`
        );
      }
    })
  );

  it.effect(
    "reads usage as unknown when the answer has none, and succeeds exactly at the cap",
    () =>
      Effect.gen(function* () {
        const missing = provider(() => json(responses([textPart("Hi")], { usage: undefined })));
        const answer = yield* (yield* missing.source).generate(
          target,
          generateArgs(),
          yield* dispatch()
        );
        assert.deepStrictEqual(answer, {
          text: "Hi",
          usage: { inputTokens: null, outputTokens: null }
        });
        const capped = provider(() =>
          json(
            responses([textPart("Exactly")], {
              usage: { input_tokens: 3, output_tokens: 16, total_tokens: 19 }
            })
          )
        );
        const atCap = yield* (yield* capped.source).generate(
          target,
          generateArgs({ maxOutputTokens: 16 }),
          yield* dispatch()
        );
        assert.deepStrictEqual(atCap, {
          text: "Exactly",
          usage: { inputTokens: 3, outputTokens: 16 }
        });
      })
  );

  it.effect("refuses an output Patchy can't send before converting or sending it", () =>
    Effect.gen(function* () {
      const fake = provider(() => json(responses([textPart("{}")])));
      const source = yield* fake.source;
      let deep: Record<string, unknown> = { kind: "text" };
      for (let level = 0; level < 7; level++) deep = { kind: "object", fields: { next: deep } };
      for (const output of [
        { kind: "text" },
        { kind: "object", fields: { when: { kind: "timestamp" } } },
        { kind: "object", fields: { maybe: { kind: "text", optional: true } } },
        deep,
        {
          kind: "object",
          fields: { many: { kind: "enum", values: Array.from({ length: 600 }, (_, i) => `v${i}`) } }
        }
      ]) {
        const error = failed(
          yield* Effect.exit(
            source.generate(
              target,
              generateArgs({
                output: output as NonNullable<(typeof ModelsGenerateArgs.Type)["output"]>
              }),
              yield* dispatch()
            )
          )
        );
        assert.strictEqual(error.code, "invalid_request");
        assert.deepInclude(error.details, { sent: false, reason: "output" });
      }
      assert.strictEqual(fake.sent.length, 0);
    })
  );
});

describe("OpenAI refusals", () => {
  it.effect("maps each HTTP refusal to Patchy's codes, one request each", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<
        readonly [Response, string, Record<string, unknown>, number | undefined]
      > = [
        [
          json({ error: { type: "rate_limit_error", code: "slow_down" } }, 429, {
            "retry-after": "7"
          }),
          "source_rate_limited",
          { sent: true, limit: "requests" },
          7
        ],
        [
          json({ error: { type: "insufficient_quota", code: "credit_balance_exhausted" } }, 429),
          "source_rate_limited",
          { sent: true, limit: "quota" },
          undefined
        ],
        [
          json({ error: { type: "invalid_request_error", code: "invalid_api_key" } }, 401),
          "source_unavailable",
          { sent: true, reason: "key", upstreamStatus: 401 },
          undefined
        ],
        [
          json({ error: { type: "invalid_request_error" } }, 400),
          "invalid_request",
          { sent: true, reason: "provider", upstreamStatus: 400 },
          undefined
        ],
        [
          json(
            { error: { type: "service_unavailable_error", code: "server_is_overloaded" } },
            503,
            {
              "retry-after": "2"
            }
          ),
          "source_unavailable",
          { sent: true, reason: "provider", upstreamStatus: 503 },
          2
        ]
      ];
      for (const [response, code, details, retryAfter] of cases) {
        const fake = provider(() => response.clone());
        const source = yield* fake.source;
        const error = failed(
          yield* Effect.exit(source.generate(target, generateArgs(), yield* dispatch()))
        );
        assert.strictEqual(error.code, code);
        assert.deepStrictEqual(error.details, details);
        assert.strictEqual(
          "retryAfterSeconds" in error ? error.retryAfterSeconds : undefined,
          retryAfter
        );
        assert.strictEqual(fake.sent.length, 1, "one request, never retried or redirected");
      }
    })
  );

  it.effect("reads at most models.answer.bytes of an answer or a refusal", () =>
    Effect.gen(function* () {
      const big = "x".repeat(1024 * 1024 + 1);
      for (const [status, details] of [
        [200, { sent: true }],
        [500, { sent: true, upstreamStatus: 500 }]
      ] as const) {
        const fake = provider(() => new Response(big, { status }));
        const source = yield* fake.source;
        const error = failed(
          yield* Effect.exit(source.generate(target, generateArgs(), yield* dispatch()))
        );
        assert.strictEqual(error.code, "too_large");
        assert.strictEqual(limitOf(error), "models.answer.bytes");
        assert.deepStrictEqual(error.details, details);
      }
    })
  );

  it.effect(
    "sends nothing past models.request.bytes, below the floor, or when the last check refuses",
    () =>
      Effect.gen(function* () {
        const fake = provider(() => json(responses([textPart("Hi")])));
        const source = yield* fake.source;
        const large = failed(
          yield* Effect.exit(
            source.generate(
              target,
              generateArgs({ input: "y".repeat(1024 * 1024) }),
              yield* dispatch()
            )
          )
        );
        assert.strictEqual(large.code, "too_large");
        assert.strictEqual(limitOf(large), "models.request.bytes");
        assert.deepStrictEqual(large.details, { sent: false });
        const late = yield* dispatch(1_500);
        const floor = failed(yield* Effect.exit(source.generate(target, generateArgs(), late)));
        assert.strictEqual(floor.code, "timeout");
        assert.deepStrictEqual(floor.details, { sent: false });
        assert.strictEqual(limitOf(floor), "models.send.floor");
        assert.isFalse(late.attempt.sent);
        const changed = new Errors.Unavailable({ reason: "connection_changed", sent: false });
        const checked = failed(
          yield* Effect.exit(
            source.generate(target, generateArgs(), yield* dispatch(60_000, Effect.fail(changed)))
          )
        );
        assert.strictEqual(checked, changed);
        assert.strictEqual(fake.sent.length, 0);
      })
  );

  it.live("closes the connection a second before the action's deadline", () =>
    Effect.gen(function* () {
      const fake = provider(() => "hang");
      const source = yield* fake.source;
      const call = yield* dispatch(2_300);
      const started = yield* Clock.currentTimeMillis;
      const error = failed(yield* Effect.exit(source.generate(target, generateArgs(), call)));
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      assert.strictEqual(error.code, "timeout");
      assert.deepStrictEqual(error.details, { sent: true });
      assert.strictEqual(limitOf(error), "models.cutoff");
      assert.isAtLeast(elapsed, 1_200);
      assert.isBelow(elapsed, 2_300 - 800);
    })
  );

  it.effect("keeps the key and the input out of every refusal it says", () =>
    Effect.gen(function* () {
      const marker = "INPUT-MARKER-7f3c";
      const fake = provider(() =>
        json(
          {
            error: {
              type: "invalid_request_error",
              message: `Incorrect API key provided: ${KEY}. Input was: ${marker}`
            }
          },
          401
        )
      );
      const source = yield* fake.source;
      const error = failed(
        yield* Effect.exit(
          source.generate(target, generateArgs({ input: marker }), yield* dispatch())
        )
      );
      for (const said of [
        error.message,
        JSON.stringify(error.details),
        JSON.stringify(error),
        String(error)
      ]) {
        assert.notInclude(said, KEY);
        assert.notInclude(said, marker);
      }
    })
  );
});

describe("OpenAI decision calls", () => {
  /** A Decisions answer as OpenAI documents one: output tokens are free and count 0. */
  const decisions = (answers: ReadonlyArray<Record<string, unknown>>) =>
    json({ answers, model: "gpt-6-luna", usage: documentedUsage(40, 0) });

  it.effect("sends fixed questions to the Decisions API and answers each in its own terms", () =>
    Effect.gen(function* () {
      const fake = provider(() =>
        decisions([
          {
            type: "choice",
            name: "team",
            choice: "billing",
            confidence: 0.9,
            probabilities: [
              { value: "billing", probability: 0.9 },
              { value: "technical", probability: 0.1 }
            ]
          },
          {
            type: "score",
            name: "urgency",
            score: 1.1,
            confidence: 0.7,
            probabilities: [
              { value: 0, label: "low", probability: 0.1 },
              { value: 1, label: "medium", probability: 0.7 },
              { value: 2, label: "high", probability: 0.2 }
            ]
          },
          { type: "predicate", name: "angry", probability: 0.2 }
        ])
      );
      const source = yield* fake.source;
      const answer = yield* source.decide(deciding, decideArgs, yield* dispatch());
      assert.deepStrictEqual(answer, {
        answers: {
          team: { choice: "billing", probabilities: { billing: 0.9, technical: 0.1 } },
          urgency: {
            level: "medium",
            score: 1.1,
            probabilities: { low: 0.1, medium: 0.7, high: 0.2 }
          },
          angry: { probability: 0.2 }
        },
        usage: { inputTokens: 40, outputTokens: 0 }
      });
      const [request] = fake.sent;
      assert.strictEqual(request!.url, "https://api.openai.com/v1/decisions");
      assertHeaders(request!);
      // The whole body. The input goes as text, never as structured parts an image key could
      // steer, and the model is the one the role is mapped to.
      assert.deepStrictEqual(request!.body, {
        model: "gpt-6-luna",
        input: JSON.stringify({ subject: "Refund please", body: "I was charged twice." }),
        questions: [
          {
            type: "choice",
            name: "team",
            instructions: "Which team handles it?",
            choices: [
              { value: "billing", description: "Charges and refunds" },
              { value: "technical", description: "Bugs and outages" }
            ]
          },
          {
            type: "score",
            name: "urgency",
            instructions: "How urgent is it?",
            levels: [
              { label: "low", description: "low" },
              { label: "medium", description: "medium" },
              { label: "high", description: "high" }
            ]
          },
          { type: "predicate", name: "angry", instructions: "The sender is angry." }
        ]
      });
    })
  );

  it.effect("answers null for a refused question while the others answer", () =>
    Effect.gen(function* () {
      const fake = provider(() =>
        decisions([
          {
            type: "choice",
            name: "team",
            choice: "technical",
            confidence: 0.8,
            probabilities: [
              { value: "billing", probability: 0.2 },
              { value: "technical", probability: 0.8 }
            ]
          },
          { type: "refusal", name: "urgency" },
          { type: "predicate", name: "angry", probability: 0.6 }
        ])
      );
      const answer = yield* (yield* fake.source).decide(deciding, decideArgs, yield* dispatch());
      assert.strictEqual(answer.answers.urgency, null);
      assert.deepStrictEqual(answer.answers.angry, { probability: 0.6 });
    })
  );

  it.effect("refuses an answer outside its question's terms", () =>
    Effect.gen(function* () {
      const fake = provider(() =>
        decisions([
          {
            type: "choice",
            name: "team",
            choice: "sales",
            confidence: 0.8,
            probabilities: [{ value: "sales", probability: 1 }]
          },
          { type: "refusal", name: "urgency" },
          { type: "predicate", name: "angry", probability: 1.4 }
        ])
      );
      const call = yield* dispatch();
      const error = failed(
        yield* Effect.exit((yield* fake.source).decide(deciding, decideArgs, call))
      );
      assert.strictEqual(error.code, "source_unavailable");
      assert.deepStrictEqual(error.details, { sent: true, reason: "answer" });
      assert.deepStrictEqual(call.attempt.usage, { inputTokens: 40, outputTokens: 0 });
    })
  );
});

describe("OpenAI calls at their edges", () => {
  /** A dispatch whose final check takes `checkMs` and approves the key. */
  const checked = (deadlineMs: number, checkMs: number) =>
    Effect.map(Clock.currentTimeMillis, (now) => ({
      deadline: now + deadlineMs,
      attempt: { sent: false } as Source.Attempt,
      beforeSend: Effect.sleep(checkMs).pipe(Effect.as(Redacted.make(KEY)))
    }));

  it.live("sends nothing when the final check crosses the floor", () =>
    Effect.gen(function* () {
      const fake = provider(() => json(responses([textPart("Hi")])));
      const source = yield* fake.source;
      const call = yield* checked(2_300, 500);
      const error = failed(yield* Effect.exit(source.generate(target, generateArgs(), call)));
      assert.strictEqual(error.code, "timeout");
      assert.deepStrictEqual(error.details, { sent: false });
      assert.isFalse(call.attempt.sent);
      assert.strictEqual(fake.sent.length, 0);
    })
  );

  it.effect("aborts an oversized answer whose body stays open before it returns", () =>
    Effect.gen(function* () {
      const signals: AbortSignal[] = [];
      const client = HttpClient.make((request, _url, signal) =>
        Effect.sync(() => {
          signals.push(signal);
          return HttpClientResponse.fromWeb(
            request,
            new Response(new ReadableStream({ start: () => undefined }), {
              status: 200,
              headers: { "content-type": "application/json", "content-length": "2097152" }
            })
          );
        })
      );
      const source = yield* Source.make.pipe(Effect.provideService(HttpClient.HttpClient, client));
      const error = failed(
        yield* Effect.exit(source.generate(target, generateArgs(), yield* dispatch()))
      );
      assert.strictEqual(error.code, "too_large");
      assert.strictEqual(signals.length, 1);
      assert.isTrue(signals[0]!.aborted, "the request is aborted before the call returns");
    })
  );

  it.effect(
    "reads a message that stopped short as unfinished, with or without an outer status",
    () =>
      Effect.gen(function* () {
        const shortMessage = {
          id: "resp_1",
          object: "response",
          created_at: 1,
          model: "gpt-test",
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "incomplete",
              content: [textPart("Order toner for")]
            }
          ],
          usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 }
        };
        const fake = provider(() => json(shortMessage));
        const error = failed(
          yield* Effect.exit(
            (yield* fake.source).generate(target, generateArgs(), yield* dispatch())
          )
        );
        assert.strictEqual(error.code, "source_unavailable");
        assert.deepStrictEqual(error.details, { sent: true, reason: "stopped" });
      })
  );

  it.effect("reads an explicit refusal as a refusal, even in a message that stopped short", () =>
    Effect.gen(function* () {
      const fake = provider(() =>
        json(
          responses([], {
            output: [
              {
                type: "message",
                id: "msg_1",
                role: "assistant",
                status: "incomplete",
                content: [textPart("I"), { type: "refusal", refusal: "I can't help with that." }]
              }
            ]
          })
        )
      );
      const error = failed(
        yield* Effect.exit((yield* fake.source).generate(target, generateArgs(), yield* dispatch()))
      );
      assert.strictEqual(error.code, "model_refused");
      assert.deepStrictEqual(error.details, { sent: true });
    })
  );

  it.effect("answers a bodyless 204, 205 or 304 without faulting", () =>
    Effect.gen(function* () {
      for (const [status, details] of [
        [204, { sent: true, reason: "answer" }],
        [205, { sent: true, reason: "answer" }],
        [304, { sent: true, reason: "provider", upstreamStatus: 304 }]
      ] as const) {
        const fake = provider(() => new Response(null, { status }));
        const error = failed(
          yield* Effect.exit(
            (yield* fake.source).generate(target, generateArgs(), yield* dispatch())
          )
        );
        assert.strictEqual(error.code, "source_unavailable", String(status));
        assert.deepStrictEqual(error.details, details, String(status));
      }
    })
  );

  it.effect("answers a status no response can carry without faulting", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const real = HttpClientResponse.fromWeb(request, json(responses([textPart("Hi")])));
          // A transport that surfaced an interim status, which fetch itself never does.
          return Object.create(real, { status: { value: 103 } }) as typeof real;
        })
      );
      const source = yield* Source.make.pipe(Effect.provideService(HttpClient.HttpClient, client));
      const error = failed(yield* Effect.exit(source.generate(target, generateArgs(), yield* dispatch())));
      assert.strictEqual(error.code, "source_unavailable");
      assert.deepStrictEqual(error.details, { sent: true, reason: "provider", upstreamStatus: 103 });
    })
  );

  it.effect("sends a decision only to a model its provider documents as deciding", () =>
    Effect.gen(function* () {
      const fake = provider(() => json({ answers: [] }));
      const error = failed(
        yield* Effect.exit((yield* fake.source).decide(target, decideArgs, yield* dispatch()))
      );
      assert.strictEqual(error.code, "source_unavailable");
      assert.deepStrictEqual(error.details, { sent: false, reason: "model" });
      assert.strictEqual(fake.sent.length, 0);
    })
  );

  it.effect("honours Retry-After as a date, and a billing limit as quota whatever its type", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const dated = provider(() =>
        json({ error: { type: "rate_limit_error", code: "rate_limit_exceeded" } }, 429, {
          "retry-after": new Date(now + 30_000).toUTCString()
        })
      );
      const later = failed(
        yield* Effect.exit(
          (yield* dated.source).generate(target, generateArgs(), yield* dispatch())
        )
      );
      assert.strictEqual(later.code, "source_rate_limited");
      assert.isAtLeast("retryAfterSeconds" in later ? (later.retryAfterSeconds ?? 0) : 0, 29);
      const billing = provider(() =>
        json({ error: { type: "invalid_request_error", code: "billing_hard_limit_reached" } }, 429)
      );
      const spent = failed(
        yield* Effect.exit(
          (yield* billing.source).generate(target, generateArgs(), yield* dispatch())
        )
      );
      assert.deepStrictEqual(spent.details, { sent: true, limit: "quota" });
    })
  );
});

describe("OpenAI's transport", () => {
  it.live("never follows a redirect, through the real fetch", () =>
    Effect.gen(function* () {
      const hits: string[] = [];
      const server = yield* Effect.acquireRelease(
        Effect.callback<ReturnType<typeof createServer>>((resume) => {
          const listening = createServer((request, response) => {
            hits.push(request.url ?? "");
            if (request.url?.endsWith("/responses")) {
              response.writeHead(302, { location: "/elsewhere" });
              response.end();
            } else {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify(responses([textPart("followed")])));
            }
          });
          listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)));
        }),
        (listening) =>
          Effect.callback<void>((resume) => {
            listening.close(() => resume(Effect.void));
          })
      );
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const source = yield* Source.makeAt(`http://127.0.0.1:${port}/v1`).pipe(
        Effect.provide(FetchHttpClient.layer)
      );
      const error = failed(
        yield* Effect.exit(source.generate(target, generateArgs(), yield* dispatch()))
      );
      assert.strictEqual(error.code, "source_unavailable");
      assert.deepStrictEqual(error.details, {
        sent: true,
        reason: "provider",
        upstreamStatus: 302
      });
      assert.deepStrictEqual(hits, ["/v1/responses"]);
    }).pipe(Effect.scoped)
  );

  it.effect("relays OpenAI's 400 for a schema it rejects as invalid_request, sent", () =>
    Effect.gen(function* () {
      const fake = provider(() =>
        json(
          {
            error: {
              message: "Invalid schema for response_format 'output'.",
              type: "invalid_request_error",
              param: "text.format.schema",
              code: "invalid_json_schema"
            }
          },
          400
        )
      );
      const error = failed(
        yield* Effect.exit(
          (yield* fake.source).generate(target, generateArgs({ output: typed }), yield* dispatch())
        )
      );
      assert.strictEqual(error.code, "invalid_request");
      assert.deepStrictEqual(error.details, {
        sent: true,
        reason: "provider",
        upstreamStatus: 400
      });
    })
  );
});
