// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- the fake is a plain loopback HTTP server, as a provider is.
/**
 * PROTOTYPE: a fake model provider for dev instances, speaking OpenAI's `/v1/responses` and
 * `/v1/decisions` on a loopback port the supervisor hands the server as `PATCHY_DEV_MODELS_URL`.
 * It never ships: only the dev runner starts it, and the server honours the variable only in
 * development on a loopback host. It answers every key.
 *
 * The model id a role maps to picks the behaviour, so an admin's remap changes it without a
 * redeploy:
 *   - `delay-<ms>` anywhere: answer after that many milliseconds.
 *   - `hang`: never answer. `unreachable`: drop the connection at once.
 *   - `rate-limited`: 429 with `retry-after: 7`. `quota`: 429 insufficient_quota.
 *   - `refuse`: a text model refuses; a decision model refuses the last question.
 *   - `invalid`: a typed output that doesn't match its schema.
 *   - `truncated`: stop at max_output_tokens, status incomplete.
 * Each request is logged with whether the caller closed the connection before the answer
 * (`closedEarly`), the evidence that a cut-off cancelled it; `GET /_log` returns the last 200.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as Effect from "effect/Effect";

interface Entry {
  readonly at: string;
  readonly path: string;
  readonly model: string;
  status: number | "dropped" | "pending";
  durationMs?: number;
  closedEarly: boolean;
  /** The request's header names and top-level body keys, never their values. */
  readonly headers: ReadonlyArray<string>;
  readonly bodyKeys: ReadonlyArray<string>;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = {
  readonly type?: string | readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly enum?: readonly Json[];
  readonly anyOf?: readonly Schema[];
};

/** A value of the shape a JSON schema describes: the first enum member, one array item. */
const sample = (schema: Schema, name: string, input: string): Json => {
  if (schema.enum !== undefined && schema.enum.length > 0) return schema.enum[0]!;
  if (schema.anyOf !== undefined && schema.anyOf.length > 0)
    return sample(schema.anyOf[0]!, name, input);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, value]) => [
          key,
          sample(value, key, input)
        ])
      );
    case "array":
      return [sample(schema.items ?? {}, name, input)];
    case "integer":
      return 3;
    case "number":
      return 0.5;
    case "boolean":
      return false;
    default:
      return /reply|draft|text|body/i.test(name) ? draft(input) : `A ${name} from the fake model.`;
  }
};

/** A reply a model might draft, from the request's text: the fake never reads it otherwise. */
const draft = (input: string) => {
  const subject = /subject[":\s]+([^"\n]{3,80})/i.exec(input)?.[1]?.trim();
  return `Dear customer,\n\nThank you for writing to us${subject === undefined ? "" : ` about "${subject}"`}. We have received your request and the right team will follow up within one business day.\n\nKind regards,\nThe support desk`;
};
const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

const has = (text: string, words: readonly string[]) =>
  words.some((word) => text.toLowerCase().includes(word.replace(/s$/, "")));

type Question =
  | { type: "choice"; name: string; choices: { value: string; description: string }[] }
  | { type: "score"; name: string; levels: { label: string }[] }
  | { type: "predicate"; name: string; instructions: string };

/** Probabilities leaning on one index, summing to 1. */
const lean = (count: number, at: number) => {
  const rest = count === 1 ? 0 : 0.3 / (count - 1);
  return Array.from(
    { length: count },
    (_, index) => Math.round((index === at ? 0.7 : rest) * 100) / 100
  );
};

const decisions = (body: { input: string; questions: Question[] }, refuse: boolean) => {
  const input = typeof body.input === "string" ? body.input : JSON.stringify(body.input);
  return {
    answers: body.questions.map((question, index) => {
      if (refuse && index === body.questions.length - 1)
        return { type: "refusal", name: question.name };
      if (question.type === "choice") {
        const words = (choice: { value: string; description: string }) =>
          `${choice.value} ${choice.description}`
            .toLowerCase()
            .split(/[^a-z]+/)
            .filter((word) => word.length > 3);
        const found = question.choices.findIndex((choice) => has(input, words(choice)));
        const at = found === -1 ? 0 : found;
        const probabilities = lean(question.choices.length, at);
        return {
          type: "choice",
          name: question.name,
          choice: question.choices[at]!.value,
          confidence: 0.7,
          probabilities: question.choices.map((choice, i) => ({
            value: choice.value,
            probability: probabilities[i]!
          }))
        };
      }
      if (question.type === "score") {
        const last = question.levels.length - 1;
        const at = has(input, ["today", "urgent", "asap", "now", "down", "blocked"])
          ? last
          : has(input, ["this week", "soon", "friday"])
            ? Math.min(1, last)
            : 0;
        const probabilities = lean(question.levels.length, at);
        return {
          type: "score",
          name: question.name,
          score: probabilities.reduce((sum, p, i) => sum + p * i, 0),
          confidence: 0.7,
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
        probability: has(input, ["unsubscribe", "discount", "offer", "partnership", "seo"])
          ? 0.93
          : 0.04
      };
    }),
    usage: { input_tokens: tokens(input), output_tokens: body.questions.length }
  };
};

interface ResponsesBody {
  model: string;
  input: { role: string; content: string | { text?: string }[] }[];
  max_output_tokens?: number;
  text?: { format?: { type: string; schema?: Schema } };
}

const responses = (body: ResponsesBody, model: string) => {
  const input = body.input
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text ?? "").join("")
    )
    .join("\n");
  const format = body.text?.format;
  let text =
    format?.type === "json_schema" && format.schema !== undefined
      ? JSON.stringify(
          model.includes("invalid") ? { unexpected: true } : sample(format.schema, "value", input)
        )
      : draft(input);
  const cap = body.max_output_tokens ?? 1_000;
  const truncated = model.includes("truncated") || tokens(text) > cap;
  if (truncated) text = text.slice(0, Math.max(1, Math.min(text.length - 1, cap * 4 - 1)));
  const content = model.includes("refuse")
    ? [{ type: "refusal", refusal: "I can't help with that request." }]
    : [{ type: "output_text", text, annotations: [] }];
  return {
    id: `resp_fake_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: truncated ? "incomplete" : "completed",
    ...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    model,
    output: [
      {
        type: "message",
        id: "msg_fake",
        status: truncated ? "incomplete" : "completed",
        role: "assistant",
        content
      }
    ],
    usage: {
      input_tokens: tokens(input),
      output_tokens: truncated ? cap : tokens(text),
      total_tokens: tokens(input) + (truncated ? cap : tokens(text)),
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 }
    }
  };
};

const send = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** Starts the fake on a free loopback port for the scope; its base URL ends in `/v1`. */
export const start = (log: (line: string) => void) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const entries: Entry[] = [];
      const record = (entry: Entry) => {
        entries.push(entry);
        if (entries.length > 200) entries.shift();
      };
      const say = (entry: Entry) =>
        log(
          `${entry.path} model=${entry.model} status=${entry.status} durationMs=${entry.durationMs ?? "-"} closedEarly=${entry.closedEarly}`
        );
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.method === "GET" && req.url === "/_log") return send(res, 200, entries);
        if (req.url === "/trap") {
          record({
            at: new Date().toISOString(),
            path: "/trap",
            model: "",
            status: 200,
            closedEarly: false,
            headers: Object.keys(req.headers).sort(),
            bodyKeys: []
          });
          return send(res, 200, { followed: true });
        }
        let raw = "";
        req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
        req.on("end", () => {
          const started = Date.now();
          let body: Record<string, unknown>;
          try {
            body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
          } catch {
            return send(res, 400, {
              error: { message: "Invalid JSON", type: "invalid_request_error" }
            });
          }
          const model = typeof body.model === "string" ? body.model : "";
          const entry: Entry = {
            at: new Date(started).toISOString(),
            path: req.url ?? "",
            model,
            status: "pending",
            closedEarly: false,
            headers: Object.keys(req.headers).sort(),
            bodyKeys: Object.keys(body).sort()
          };
          record(entry);
          res.on("close", () => {
            entry.durationMs = Date.now() - started;
            if (!res.writableEnded) entry.closedEarly = true;
            say(entry);
          });
          const answer = () => {
            if (model.includes("unreachable")) {
              entry.status = "dropped";
              return req.socket.destroy();
            }
            if (model.includes("hang")) return;
            if (model.includes("redirect")) {
              // A provider that sends the request elsewhere: a client that follows carries the key.
              entry.status = 307;
              res.writeHead(307, { location: "/trap" });
              return res.end();
            }
            if (model.includes("rate-limited")) {
              entry.status = 429;
              return send(
                res,
                429,
                {
                  error: {
                    message: "Rate limit reached for requests",
                    type: "requests",
                    code: "rate_limit_exceeded"
                  }
                },
                { "retry-after": "7" }
              );
            }
            if (model.includes("quota")) {
              entry.status = 429;
              return send(res, 429, {
                error: {
                  message: "You exceeded your current quota",
                  type: "insufficient_quota",
                  code: "insufficient_quota"
                }
              });
            }
            entry.status = 200;
            if (req.url?.endsWith("/decisions"))
              return send(
                res,
                200,
                decisions(
                  body as unknown as { input: string; questions: Question[] },
                  model.includes("refuse")
                )
              );
            if (req.url?.endsWith("/responses"))
              return send(res, 200, responses(body as unknown as ResponsesBody, model));
            entry.status = 404;
            return send(res, 404, {
              error: { message: "Not found", type: "invalid_request_error" }
            });
          };
          const delay = /delay-(\d+)/.exec(model);
          if (delay === null) answer();
          else setTimeout(answer, Number(delay[1]));
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}/v1`,
            close: () => {
              server.closeAllConnections();
              server.close();
            }
          })
        );
      });
    }),
    (fake) => Effect.sync(fake.close)
  );
