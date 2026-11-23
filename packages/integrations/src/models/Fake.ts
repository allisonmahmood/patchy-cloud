// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalJsonInEffect:off -- a plain loopback HTTP server, answering as a provider does.
/**
 * A fake OpenAI for dev instances, tests and load runs: `POST /v1/responses` and
 * `POST /v1/decisions` on a loopback port, in the shapes OpenAI's documentation gives and
 * `Source.test.ts` holds: usage with its detail objects, a decision's output tokens counted 0, a
 * stop in `incomplete_details.reason`, a refusal as its own content part, documented error bodies
 * and quota codes, and `max_output_tokens` refused below 16. Only the dev runner's entrypoint and
 * tests point a Source at it; production's entrypoint has no way to.
 *
 * It answers from its input, enough to show a model at work: a text call gets a line naming the
 * input's first words and counting them, a typed call a value of its schema made from those
 * words, and a decision leans each choice on the option whose words the input shares, each scale
 * on words of urgency and each yes-or-no on its own statement's words.
 *
 * A marker in the input asks for another answer instead, for a test, a scenario's page or a load
 * run to reach each way a call ends:
 *
 * - `[fake:delay=<ms>]` or `[fake:at=<epoch ms>]`: the usual answer, after that long or then.
 * - `[fake:trickle=<ms>]`: the usual answer, its body sent a few bytes at a time over that long.
 * - `[fake:hang]`: no answer, the connection held open; `[fake:drop]`: the connection closed once
 *   the request is read.
 * - `[fake:rate]` and `[fake:quota]`: 429 for the rate, with `retry-after: 7`, and for the
 *   account's credit; `[fake:key]` 401; `[fake:invalid]` 400; `[fake:overloaded]` 503 with
 *   `retry-after: 2`.
 * - `[fake:refuse]`: a text call's refusal, a decision's last question refused.
 * - `[fake:filter]`, `[fake:truncate]` and `[fake:stop]`: a text call stopped for its content,
 *   at `max_output_tokens` with usage at the cap, and for `max_messages`.
 * - `[fake:short]`: stopped at `max_output_tokens` with usage below the cap; `[fake:atcap]`:
 *   complete with usage equal to it. A client that reads a cut-off from the token count instead of
 *   the stop reason gets both wrong.
 * - `[fake:mismatch]`: a typed answer outside its schema; `[fake:huge]`: an answer past 1 MiB.
 *
 * Each request is recorded without its content: its path, mode, status, how long it took, whether
 * the caller closed it before the answer, and its header names and body keys.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as Effect from "effect/Effect";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface JsonSchema {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly enum?: readonly Json[];
  readonly anyOf?: readonly JsonSchema[];
}

/** One request, as the fake saw it: never its input, instructions or key. */
export interface Entry {
  readonly at: number;
  readonly path: string;
  readonly mode: string;
  status: number | "dropped" | "held";
  durationMs?: number;
  /** The caller closed the connection before the fake answered: a cut-off reached it. */
  closedEarly: boolean;
  readonly headers: ReadonlyArray<string>;
  readonly bodyKeys: ReadonlyArray<string>;
}

export interface Fake {
  /** The base URL a Source is made at, ending in `/v1`. */
  readonly url: string;
  /** Every request so far, oldest first. */
  readonly entries: ReadonlyArray<Entry>;
  /** Requests the fake has read and not yet answered or dropped. */
  readonly open: () => number;
}

/** Usage as OpenAI documents it, with its detail objects. */
export const usage = (input: number, output: number) => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: input + output
});
const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));
const wordsOf = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
/** A word's first five letters, so "charged" and "charges" read as one word. */
const stem = (word: string) => word.slice(0, 5);
/** How many of `other`'s words of at least `least` letters `text` shares, by their stems. */
const shares = (text: string, other: string, least = 4) => {
  const stems = new Set(wordsOf(text).map(stem));
  return wordsOf(other).filter((word) => word.length >= least && stems.has(stem(word))).length;
};
const urgent = ["urgent", "asap", "today", "now", "down", "outage", "blocked", "immediately"];

/** Probabilities leaning on one index, summing to 1. */
const lean = (count: number, at: number) =>
  Array.from({ length: count }, (_, index) =>
    count === 1 ? 1 : index === at ? 0.7 : 0.3 / (count - 1)
  );

type Question =
  | {
      readonly type: "choice";
      readonly name: string;
      readonly instructions: string;
      readonly choices: ReadonlyArray<{ readonly value: string; readonly description: string }>;
    }
  | {
      readonly type: "score";
      readonly name: string;
      readonly instructions: string;
      readonly levels: ReadonlyArray<{ readonly label: string; readonly description: string }>;
    }
  | { readonly type: "predicate"; readonly name: string; readonly instructions: string };

const decide = (input: string, questions: ReadonlyArray<Question>, refuse: boolean) =>
  questions.map((question, index) => {
    if (refuse && index === questions.length - 1) return { type: "refusal", name: question.name };
    if (question.type === "choice") {
      const scores = question.choices.map((choice) =>
        shares(input, `${choice.value} ${choice.description}`)
      );
      const best = Math.max(...scores);
      const at = best === 0 ? 0 : scores.indexOf(best);
      const probabilities = lean(question.choices.length, at);
      return {
        type: "choice",
        name: question.name,
        choice: question.choices[at]!.value,
        confidence: probabilities[at]!,
        probabilities: question.choices.map((choice, i) => ({
          value: choice.value,
          probability: probabilities[i]!
        }))
      };
    }
    if (question.type === "score") {
      const last = question.levels.length - 1;
      const hits = wordsOf(input).filter((word) => urgent.includes(word)).length;
      const at = Math.min(last, hits === 0 ? 0 : hits === 1 ? Math.ceil(last / 2) : last);
      const probabilities = lean(question.levels.length, at);
      return {
        type: "score",
        name: question.name,
        score: probabilities.reduce((sum, p, i) => sum + p * i, 0),
        confidence: probabilities[at]!,
        probabilities: question.levels.map((level, i) => ({
          value: i,
          label: level.label,
          probability: probabilities[i]!
        }))
      };
    }
    return {
      type: "predicate",
      name: question.name,
      // A statement's short words, "this" or "that", say nothing of whether it holds.
      probability: shares(input, question.instructions, 5) > 0 ? 0.8 : 0.1
    };
  });

/** A value of the shape a JSON schema describes, made from the input's words. */
const sample = (schema: JsonSchema, input: string, mismatch: boolean): Json => {
  if (schema.anyOf !== undefined && schema.anyOf.length > 0)
    return sample(
      schema.anyOf.find((branch) => branch.type !== "null") ?? schema.anyOf[0]!,
      input,
      mismatch
    );
  if (schema.enum !== undefined && schema.enum.length > 0)
    return mismatch
      ? "none of these"
      : (schema.enum.find((value) => typeof value === "string" && shares(input, value) > 0) ??
          schema.enum[0]!);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  const words = wordsOf(input);
  switch (type) {
    case "object":
      return mismatch
        ? { unexpected: true }
        : Object.fromEntries(
            Object.entries(schema.properties ?? {}).map(([key, value]) => [
              key,
              sample(value, input, false)
            ])
          );
    case "array":
      return words.slice(0, 2).map(() => sample(schema.items ?? {}, input, false));
    case "integer":
      return words.length;
    case "number":
      return Math.round((input.length / 100) * 100) / 100;
    case "boolean":
      return input.includes("?");
    default:
      return words.slice(0, 6).join(" ") || "nothing";
  }
};

interface ResponsesBody {
  readonly model?: string;
  readonly max_output_tokens?: number;
  readonly input?: ReadonlyArray<{
    readonly role: string;
    readonly content: ReadonlyArray<{ readonly text?: string }>;
  }>;
  readonly text?: { readonly format?: { readonly type?: string; readonly schema?: JsonSchema } };
}

const respond = (body: ResponsesBody, mode: string) => {
  const input = (body.input ?? [])
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content.map((part) => part.text ?? ""))
    .join("\n");
  const cap = body.max_output_tokens ?? 16;
  const format = body.text?.format;
  const words = wordsOf(input.replace(/\[fake:[^\]]*\]/g, ""));
  let text =
    format?.type === "json_schema" && format.schema !== undefined
      ? JSON.stringify(sample(format.schema, input, mode === "mismatch"))
      : `Read ${words.length} words, starting "${words
          .slice(0, 5)
          .map((word) => word.slice(0, 24))
          .join(" ")}".`;
  if (mode === "huge") text = "x".repeat(1024 * 1024 + 1);
  const stop =
    mode === "filter"
      ? "content_filter"
      : mode === "stop"
        ? "max_messages"
        : mode === "truncate" || mode === "short" || (mode !== "huge" && tokens(text) > cap)
          ? "max_output_tokens"
          : undefined;
  if (stop === "max_output_tokens")
    text = text.slice(0, Math.max(1, Math.min(text.length - 1, cap * 4)));
  const used =
    mode === "short"
      ? Math.max(1, Math.floor(cap / 2))
      : mode === "atcap" || stop === "max_output_tokens"
        ? cap
        : tokens(text);
  const content =
    mode === "refuse"
      ? [{ type: "refusal", refusal: "I can't help with that request." }]
      : [{ type: "output_text", text, annotations: [] }];
  const status = stop === undefined ? "completed" : "incomplete";
  return {
    id: `resp_fake_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    completed_at: stop === undefined ? Math.floor(Date.now() / 1000) : null,
    error: null,
    incomplete_details: stop === undefined ? null : { reason: stop },
    instructions: null,
    max_output_tokens: cap,
    model: body.model ?? "",
    output: [{ type: "message", id: "msg_fake", role: "assistant", status, content }],
    parallel_tool_calls: true,
    previous_response_id: null,
    store: true,
    text: { format: format ?? { type: "text" } },
    tool_choice: "auto",
    tools: [],
    truncation: "disabled",
    usage: usage(tokens(input), used),
    metadata: {}
  };
};

interface Failure {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly error: Readonly<Record<string, string>>;
}
/** The documented error bodies a marker asks for, by mode. */
const failures = {
  rate: {
    status: 429,
    headers: { "retry-after": "7" },
    error: {
      message: "Rate limit reached for requests.",
      type: "requests",
      code: "rate_limit_exceeded"
    }
  },
  quota: {
    status: 429,
    error: {
      message: "Your credit balance is too low.",
      type: "insufficient_quota",
      code: "credit_balance_exhausted"
    }
  },
  key: {
    status: 401,
    error: {
      message: "Incorrect API key provided.",
      type: "invalid_request_error",
      code: "invalid_api_key"
    }
  },
  invalid: {
    status: 400,
    error: { message: "Invalid request.", type: "invalid_request_error" }
  },
  overloaded: {
    status: 503,
    headers: { "retry-after": "2" },
    error: {
      message: "The server is overloaded.",
      type: "service_unavailable_error",
      code: "server_is_overloaded"
    }
  }
} satisfies Readonly<Record<string, Failure>>;
const failureOf = (mode: string): Failure | undefined =>
  Object.hasOwn(failures, mode) ? failures[mode as keyof typeof failures] : undefined;

/** The marker a request's text carries, and its argument: `[fake:delay=500]` is delay, 500. */
const markerOf = (raw: string) => {
  const found = /\[fake:([a-z]+)(?:=(\d+))?\]/.exec(raw);
  return { mode: found?.[1] ?? "", argument: found?.[2] === undefined ? 0 : Number(found[2]) };
};

/** Starts the fake on a free loopback port for the scope. */
export const start = (options: { readonly onEntry?: (entry: Entry) => void } = {}) =>
  Effect.acquireRelease(
    Effect.callback<Fake & { readonly close: () => Promise<void> }>((resume) => {
      const entries: Entry[] = [];
      let open = 0;
      const send = (
        res: ServerResponse,
        status: number,
        body: unknown,
        headers: Readonly<Record<string, string>> = {}
      ) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: Record<string, unknown> = {};
          try {
            body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
          } catch {
            return send(res, 400, {
              error: { message: "We could not parse the JSON body.", type: "invalid_request_error" }
            });
          }
          const { mode, argument } = markerOf(raw);
          const entry: Entry = {
            at: Date.now(),
            path: req.url ?? "",
            mode,
            status: "held",
            closedEarly: false,
            headers: Object.keys(req.headers).sort(),
            bodyKeys: Object.keys(body).sort()
          };
          entries.push(entry);
          open++;
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            open--;
            entry.durationMs = Date.now() - entry.at;
            options.onEntry?.(entry);
          };
          res.on("close", () => {
            if (!res.writableFinished) entry.closedEarly = true;
            settle();
          });
          const reply = (
            status: number,
            answer: unknown,
            headers: Readonly<Record<string, string>> = {}
          ) => {
            entry.status = status;
            if (mode !== "trickle") return send(res, status, answer, headers);
            // A slow body: the headers at once, then the answer in pieces over `argument` ms.
            const bytes = Buffer.from(JSON.stringify(answer));
            res.writeHead(status, { "content-type": "application/json", ...headers });
            const pieces = 20;
            const size = Math.ceil(bytes.length / pieces);
            let sent = 0;
            const next = () => {
              if (res.destroyed) return;
              res.write(bytes.subarray(sent, sent + size));
              sent += size;
              if (sent >= bytes.length) res.end();
              else setTimeout(next, argument / pieces);
            };
            next();
          };
          const answer = () => {
            if (!/^Bearer \S+$/.test(req.headers.authorization ?? ""))
              return reply(failures.key.status, { error: failures.key.error });
            if (mode === "drop") {
              entry.status = "dropped";
              return req.socket.destroy();
            }
            if (mode === "hang") return;
            const failure = failureOf(mode);
            if (failure !== undefined)
              return reply(failure.status, { error: failure.error }, failure.headers);
            if (req.method === "POST" && req.url === "/v1/decisions") {
              if (body.model !== "gpt-6-luna")
                return reply(400, {
                  error: {
                    message: "The model does not support decisions.",
                    type: "invalid_request_error",
                    param: "model"
                  }
                });
              const input =
                typeof body.input === "string" ? body.input : JSON.stringify(body.input);
              const questions = Array.isArray(body.questions) ? (body.questions as Question[]) : [];
              const answers = decide(input, questions, mode === "refuse");
              return reply(200, {
                answers:
                  mode === "huge" ? [...answers, { padding: "x".repeat(1024 * 1024) }] : answers,
                model: "gpt-6-luna",
                usage: usage(tokens(input), 0)
              });
            }
            if (req.method === "POST" && req.url === "/v1/responses") {
              const cap = body.max_output_tokens;
              if (typeof cap !== "number" || cap < 16)
                return reply(400, {
                  error: {
                    message: `Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got ${String(cap)} instead.`,
                    type: "invalid_request_error",
                    param: "max_output_tokens",
                    code: "integer_below_min_value"
                  }
                });
              return reply(200, respond(body as ResponsesBody, mode));
            }
            return reply(404, {
              error: { message: "Unknown request URL.", type: "invalid_request_error" }
            });
          };
          if (mode === "delay") setTimeout(answer, argument);
          else if (mode === "at") setTimeout(answer, Math.max(0, argument - Date.now()));
          else answer();
        });
      });
      server.keepAliveTimeout = 60_000;
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}/v1`,
            entries,
            open: () => open,
            close: () =>
              new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => done());
              })
          })
        );
      });
    }),
    (fake) => Effect.promise(fake.close)
  );
