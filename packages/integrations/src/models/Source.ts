// @effect-diagnostics schemaInFunctionBody:off -- A typed output's shape is the call's own, so its schema is built per call.
/**
 * Model providers behind one Patchy service: decisions on Effect's `DecisionModel.decideSettled`,
 * text on `LanguageModel`, one layer per provider. OpenAI is the first: decisions on its
 * Decisions API (`POST /v1/decisions`), text on its Responses API (`POST /v1/responses`), at its
 * one fixed address with the company's key as a bearer token and nothing else of Patchy's: no
 * storage directive, no trace headers, no previous response, no tool definition, no reasoning
 * state to carry forward.
 *
 * Patchy owns how a call finishes. One request per call, never retried, never following a
 * redirect, sent only after the caller's last check passes immediately before dispatch, and only
 * with at least `models.send.floor` left; the connection is closed `models.cutoff` before the
 * action's deadline. At most `models.answer.bytes` of any answer is read, a refusal's included,
 * and the answer's own status, stop reason and usage are read from those bytes before anything
 * decodes them as typed output, so a cut-off, a refusal or a partial answer that looks complete
 * is never returned as a success.
 */
import {
  type HandlerSchema,
  type ModelAnswer,
  type ModelQuestion,
  type ModelsDecideArgs,
  type ModelsDecided,
  type ModelsGenerateArgs,
  type ModelsGenerated,
  type ModelUsage
} from "@patchy/api";
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient";
import * as OpenAiDecisionModel from "@effect/ai-openai/OpenAiDecisionModel";
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel";
import { registry } from "@patchy/limits/registry";
import type * as AiError from "effect/ai/AiError";
import * as Decision from "effect/ai/Decision";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Errors from "./Errors.js";
import * as Models from "./Models.js";

/** OpenAI's one address; no admin types a host. */
export const OPENAI_URL = "https://api.openai.com/v1";

const REQUEST_BYTES = registry["models.request.bytes"].default;
const ANSWER_BYTES = registry["models.answer.bytes"].default;
const FLOOR_MS = registry["models.send.floor"].default;
/** The models OpenAI documents as answering decision calls. */
const deciding: ReadonlyArray<string> = Models.capabilities.openai.decision.models;
const CUTOFF_MS = registry["models.cutoff"].default;
const OUTPUT_DEPTH = registry["models.output.depth"].default;
const OUTPUT_NODES = registry["models.output.nodes"].default;

/** The role's model as the call's first check found it. */
export interface Target {
  readonly model: string;
}

/** One attempt as the host observes it, written as the call goes, however it ends. */
export interface Attempt {
  /** The request reached the transport, past every check, where its bytes can leave. */
  sent: boolean;
  /** What the provider counted, once an answer said. */
  usage?: ModelUsage;
}

/** How one call is sent: the action's deadline, its record, and the caller's last check. */
export interface Dispatch<E> {
  /** When the action's deadline fires, in epoch milliseconds. */
  readonly deadline: number;
  readonly attempt: Attempt;
  /**
   * The caller's final check, run once the request is prepared, answering the key it approved,
   * which is the key sent. After it only the floor is checked before the request reaches the
   * transport. Its refusal sends nothing.
   */
  readonly beforeSend: Effect.Effect<Redacted.Redacted<string>, E>;
}

export class Source extends Context.Service<
  Source,
  {
    /** One decision request; a question the model refused answers `null`. */
    readonly decide: <E>(
      target: Target,
      args: typeof ModelsDecideArgs.Type,
      dispatch: Dispatch<E>
    ) => Effect.Effect<ModelsDecided, Errors.CallError | E>;
    /** One text request: text, or a value of `output`'s shape, checked here. */
    readonly generate: <E>(
      target: Target,
      args: typeof ModelsGenerateArgs.Type,
      dispatch: Dispatch<E>
    ) => Effect.Effect<ModelsGenerated, Errors.CallError | E>;
  }
>()("@patchy/integrations/models/Source") {}

// ---------- typed output: a subset of handler descriptors, checked before it is converted ----------

type OutputSchema = Schema.Codec<unknown, unknown, never, never>;
const isInvalidRequest = Schema.is(Errors.InvalidRequest);

/**
 * `output` as the schema the answer must match, or why Patchy can't send it: a root object, every
 * field required, of the kinds OpenAI's structured outputs take, within `models.output.depth`
 * and `models.output.nodes`. Checked before anything is converted or sent.
 */
export const outputSchema = (
  output: HandlerSchema
): Schema.Codec<Record<string, unknown>, Record<string, unknown>> | Errors.InvalidRequest => {
  let nodes = 0;
  const refuse = (path: string) =>
    new Errors.InvalidRequest({ reason: "output", sent: false, path });
  const walk = (
    descriptor: HandlerSchema,
    path: string,
    depth: number
  ): OutputSchema | Errors.InvalidRequest => {
    nodes += descriptor.kind === "enum" ? 1 + descriptor.values.length : 1;
    if (descriptor.optional === true || depth > OUTPUT_DEPTH || nodes > OUTPUT_NODES)
      return refuse(path);
    const described = (schema: OutputSchema): OutputSchema =>
      descriptor.description === undefined
        ? schema
        : schema.annotate({ description: descriptor.description });
    switch (descriptor.kind) {
      case "text":
        return described(Schema.String);
      case "integer":
        return described(Schema.Int);
      case "number":
        return described(Schema.Finite);
      case "boolean":
        return described(Schema.Boolean);
      case "enum":
        return descriptor.values.length === 0
          ? refuse(path)
          : described(Schema.Literals(descriptor.values));
      case "nullable": {
        const value = walk(descriptor.value, path, depth);
        return isInvalidRequest(value) ? value : described(Schema.NullOr(value));
      }
      case "array": {
        const element = walk(descriptor.element, `${path}[]`, depth + 1);
        return isInvalidRequest(element) ? element : described(Schema.Array(element));
      }
      case "object": {
        const fields: Record<string, OutputSchema> = {};
        for (const [name, field] of Object.entries(descriptor.fields)) {
          const schema = walk(field, path === "" ? name : `${path}.${name}`, depth + 1);
          if (isInvalidRequest(schema)) return schema;
          fields[name] = schema;
        }
        return described(Schema.Struct(fields));
      }
      default:
        return refuse(path);
    }
  };
  if (output.kind !== "object") return refuse("");
  const schema = walk(output, "", 0);
  return isInvalidRequest(schema)
    ? schema
    : (schema as Schema.Codec<Record<string, unknown>, Record<string, unknown>>);
};

// ---------- the answer as it arrived, read under its bound ----------

/** What a 2xx answer says of how it ended, read leniently from its bytes. */
const Envelope = Schema.Struct({
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  incomplete_details: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ reason: Schema.optionalKey(Schema.NullOr(Schema.String)) }))
  ),
  usage: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        output_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number))
      })
    )
  ),
  output: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          type: Schema.String,
          status: Schema.optionalKey(Schema.NullOr(Schema.String)),
          content: Schema.optionalKey(
            Schema.NullOr(Schema.Array(Schema.Struct({ type: Schema.String })))
          )
        })
      )
    )
  )
});
type Envelope = typeof Envelope.Type;
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope));
/** A refusal's body, `{ error: { type, code } }`, read leniently. */
const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    type: Schema.optionalKey(Schema.NullOr(Schema.String)),
    code: Schema.optionalKey(Schema.NullOr(Schema.String))
  })
});
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));
const utf8 = new TextDecoder();

/** One call's view of the wire, which its outcome is decided from. */
interface Wire<E> {
  /** The caller's check, the floor or the request bound refused: nothing was sent. */
  refused?: Errors.CallError | E;
  /** An answer was past `models.answer.bytes`, with the status it came with. */
  oversized?: { readonly status: number };
  /** The answer's HTTP status, and what it said, once read. */
  status?: number;
  retryAfter?: number;
  error?: { readonly type?: string; readonly code?: string };
  envelope?: Envelope;
}

const tokens = (value: number | null | undefined): number | null =>
  value === undefined || value === null || !Number.isSafeInteger(value) || value < 0 ? null : value;
const usageOf = (envelope: Envelope | undefined): ModelUsage => ({
  inputTokens: tokens(envelope?.usage?.input_tokens),
  outputTokens: tokens(envelope?.usage?.output_tokens)
});
/** `Retry-After` in seconds, at least 1, from a number of seconds or an HTTP date; none if neither. */
const retryAfter = (value: string | undefined, now: number) => {
  if (value === undefined || value.trim() === "") return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - now) / 1_000;
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : undefined;
};
/** Statuses whose response has no body, which a rebuilt response must not be given. */
const bodyless = new Set([101, 103, 204, 205, 304]);

/** A transport failure carrying nothing; the refusal it stands for waits in the wire. */
const withheld = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: "Not sent." })
  });

/** Reads the body under the bound, records what it says, and hands on a response over it. */
const collect = <E>(response: HttpClientResponse.HttpClientResponse, wire: Wire<E>) =>
  Effect.gen(function* () {
    const over = () => {
      wire.oversized = { status: response.status };
      return new HttpClientError.HttpClientError({
        reason: new HttpClientError.DecodeError({
          request: response.request,
          response,
          description: "The answer is past models.answer.bytes."
        })
      });
    };
    wire.status = response.status;
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > ANSWER_BYTES) return yield* Effect.fail(over());
    const read = yield* response.stream.pipe(
      Stream.runFoldEffect(
        () => ({ bytes: 0, chunks: [] as Uint8Array[] }),
        (state, chunk) => {
          if (state.bytes + chunk.byteLength > ANSWER_BYTES) return Effect.fail(over());
          state.bytes += chunk.byteLength;
          state.chunks.push(chunk);
          return Effect.succeed(state);
        }
      ),
      // A redirect or a refusal may come with no body at all.
      Effect.catchTags({
        HttpClientError: (error) =>
          error.reason._tag === "EmptyBodyError"
            ? Effect.succeed({ bytes: 0, chunks: [] as Uint8Array[] })
            : Effect.fail(error)
      })
    );
    const body = new Uint8Array(read.bytes);
    let offset = 0;
    for (const chunk of read.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const decoded = utf8.decode(body);
    if (response.status >= 200 && response.status < 300)
      wire.envelope = Option.getOrUndefined(decodeEnvelope(decoded));
    else {
      const retry = retryAfter(response.headers["retry-after"], yield* Clock.currentTimeMillis);
      if (retry !== undefined) wire.retryAfter = retry;
      const error = Option.getOrUndefined(decodeErrorBody(decoded))?.error;
      wire.error = {
        ...(typeof error?.type === "string" ? { type: error.type } : {}),
        ...(typeof error?.code === "string" ? { code: error.code } : {})
      };
    }
    return HttpClientResponse.fromWeb(
      response.request,
      new Response(bodyless.has(response.status) ? null : body, {
        status: response.status,
        headers: { ...response.headers }
      })
    );
  });

/**
 * The provider client's `transformClient`. Before dispatch: the bound on the request, the
 * caller's final check, which answers the key to send, then the floor on what is left of the
 * action, so a check that takes long can't send late. Each request is owned by a scope that
 * spans its answer's reading and aborts it on the way out, so a stalled or oversized body never
 * outlives the call or its permits. The answer, a refusal's body included, which arrives as a
 * failure holding an unread body after the client's status filter, is read under its bound.
 */
const guarded =
  <E>(wire: Wire<E>, dispatch: Dispatch<E>) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequestEffect((request) =>
        Effect.gen(function* () {
          const bytes = request.body._tag === "Uint8Array" ? request.body.body.byteLength : 0;
          if (bytes > REQUEST_BYTES) {
            wire.refused = new Errors.TooLarge({ limitId: "models.request.bytes" });
            return yield* Effect.fail(withheld(request));
          }
          const checked = yield* Effect.exit(dispatch.beforeSend);
          if (Exit.isFailure(checked)) {
            const error = Cause.findErrorOption(checked.cause);
            // Interrupted or a defect: no refusal to keep, and nothing was sent.
            if (Option.isNone(error)) return yield* Effect.orDie(Effect.failCause(checked.cause));
            wire.refused = error.value;
            return yield* Effect.fail(withheld(request));
          }
          const left = dispatch.deadline - (yield* Clock.currentTimeMillis);
          if (left < FLOOR_MS) {
            wire.refused = new Errors.Timeout({ sent: false, milliseconds: Math.max(0, left) });
            return yield* Effect.fail(withheld(request));
          }
          return HttpClientRequest.bearerToken(request, Redacted.value(checked.value));
        })
      ),
      HttpClient.withScope,
      HttpClient.transformResponse((effect) =>
        Effect.scoped(
          effect.pipe(
            Effect.flatMap((response) => collect(response, wire)),
            Effect.catchTags({
              HttpClientError: (error) =>
                error.reason._tag === "StatusCodeError"
                  ? Effect.flatMap(collect(error.reason.response, wire), (response) =>
                      Effect.fail(
                        new HttpClientError.HttpClientError({
                          reason: new HttpClientError.StatusCodeError({
                            request: error.reason.request,
                            response
                          })
                        })
                      )
                    )
                  : Effect.fail(error)
            })
          )
        )
      )
    );

/** Spending limits OpenAI answers 429 with, which waiting doesn't clear. */
const quota = new Set([
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "billing_hard_limit_reached",
  "insufficient_quota"
]);

/** A refusal by HTTP status, in Patchy's codes; the provider's words stay in the cause. */
const byStatus = (status: number, wire: Wire<unknown>, cause: unknown): Errors.CallError => {
  const upstream = { upstreamStatus: status };
  const redacted = Redacted.make(cause);
  if (status === 401 || status === 403)
    return new Errors.Unavailable({ reason: "key", sent: true, ...upstream, cause: redacted });
  if (status === 429)
    return quota.has(wire.error?.code ?? "") || wire.error?.type === "insufficient_quota"
      ? new Errors.RateLimited({ limit: "quota" })
      : new Errors.RateLimited({
          limit: "requests",
          ...(wire.retryAfter === undefined ? {} : { retryAfterSeconds: wire.retryAfter })
        });
  if (status >= 400 && status < 500)
    return new Errors.InvalidRequest({
      reason: "provider",
      sent: true,
      ...upstream,
      cause: redacted
    });
  // A redirect, never followed, and every server failure.
  return new Errors.Unavailable({
    reason: "provider",
    sent: true,
    ...upstream,
    ...(wire.retryAfter === undefined ? {} : { retryAfterSeconds: wire.retryAfter }),
    cause: redacted
  });
};

/** A failed request in Patchy's codes: what the wire saw decides, the client's error comes last. */
const failure = <E>(
  error: AiError.AiError,
  wire: Wire<E>,
  attempt: Attempt
): Errors.CallError | E => {
  if (wire.refused !== undefined) return wire.refused;
  if (wire.oversized !== undefined)
    return new Errors.TooLarge({
      limitId: "models.answer.bytes",
      ...(wire.oversized.status >= 300 ? { upstreamStatus: wire.oversized.status } : {})
    });
  if (wire.status !== undefined && (wire.status < 200 || wire.status >= 300))
    return byStatus(wire.status, wire, error);
  if (wire.status === undefined)
    return new Errors.Unavailable({
      reason: "unreachable",
      sent: attempt.sent,
      cause: Redacted.make(error)
    });
  return new Errors.Unavailable({
    reason: "answer",
    sent: true,
    usage: usageOf(wire.envelope),
    cause: Redacted.make(error)
  });
};

/**
 * How a text answer ended, from its own status: `undefined` when it completed and isn't a
 * refusal. A refusal reports first, then a cut-off at `maxOutputTokens`, then any other stop.
 */
const ending = (
  envelope: Envelope | undefined,
  maxOutputTokens: number
): Errors.CallError | undefined => {
  if (envelope === undefined) return new Errors.Unavailable({ reason: "answer", sent: true });
  const usage = usageOf(envelope);
  const reason = envelope.incomplete_details?.reason ?? undefined;
  const messages = (envelope.output ?? []).filter((item) => item.type === "message");
  // A message that stopped short leaves its answer unfinished, whatever the outer status says.
  const short = messages.some((item) => item.status === "incomplete");
  const status =
    envelope.status === "completed" || envelope.status === undefined || envelope.status === null
      ? reason !== undefined || short
        ? "incomplete"
        : "completed"
      : envelope.status;
  const refused = messages.some((item) =>
    (item.content ?? []).some((part) => part.type === "refusal")
  );
  if (status === "completed") return refused ? new Errors.Refused({ usage }) : undefined;
  if (status === "incomplete" && reason === "content_filter") return new Errors.Refused({ usage });
  if (status === "incomplete" && reason === "max_output_tokens")
    return new Errors.OutputTruncated({ maxOutputTokens, usage });
  return new Errors.Unavailable({ reason: "stopped", sent: true, usage });
};

// ---------- decisions ----------

/** A question as Effect's decision kinds hold it; levels describe themselves. */
const decisionOf = (question: ModelQuestion) => {
  switch (question.type) {
    case "choice":
      return Decision.classify({ instructions: question.instructions, criteria: question.options });
    case "scale":
      return Decision.rate({ instructions: question.instructions, criteria: question.levels });
    case "yesNo":
      return Decision.probability({ instructions: question.instructions });
  }
};
/** A settled answer in its question's terms: `null` when refused, undefined when it doesn't read. */
const answerOf = (
  question: ModelQuestion,
  outcome: Decision.Outcome<ReturnType<typeof decisionOf>>
): ModelAnswer | undefined => {
  if (Result.isFailure(outcome)) return outcome.failure.reason === "Refused" ? null : undefined;
  const answer = outcome.success;
  if (question.type === "choice" && "label" in answer && !("rating" in answer))
    return { choice: answer.label, probabilities: { ...answer.probabilities } };
  if (question.type === "scale" && "rating" in answer)
    return {
      level: answer.label,
      score: answer.rating,
      probabilities: { ...answer.probabilities }
    };
  if (question.type === "yesNo" && "probability" in answer)
    return { probability: answer.probability };
  return undefined;
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
/**
 * The input as the model reads it: a string as it is, anything else as JSON text. Sent as text, an
 * object under a decision's image key is never sent as an image.
 */
const inputText = (input: typeof Schema.Json.Type) =>
  typeof input === "string" ? input : encodeJson(input);

/**
 * OpenAI's layer over the process's HTTP client. Published, dev and test calls alike pass the
 * host's admission queue before they get here.
 */
export const makeAt = Effect.fn("ModelsSource.make")(function* (apiUrl: string) {
  const http = yield* HttpClient.HttpClient;

  /**
   * The provider's client for one call, reading the wire through `wire`. It holds no key: the
   * final check answers the one to send. `sent` turns true as the request reaches the
   * transport, past every check, where its bytes can leave.
   */
  const client = <E>(wire: Wire<E>, dispatch: Dispatch<E>) =>
    OpenAiClient.layer({ apiUrl, transformClient: guarded(wire, dispatch) }).pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          // The transport: it receives the request once every check before it has passed.
          HttpClient.makeWith(
            (
              prepared: Effect.Effect<
                HttpClientRequest.HttpClientRequest,
                HttpClientError.HttpClientError
              >
            ) =>
              Effect.flatMap(prepared, (request) =>
                Effect.suspend(() => {
                  dispatch.attempt.sent = true;
                  return http.execute(request);
                })
              ),
            (request: HttpClientRequest.HttpClientRequest) => Effect.succeed(request)
          )
        )
      )
    );

  /**
   * Sends under the cut-off, never following a redirect, without trace context, and with no
   * spans: Effect's own would keep the provider's error text, which can echo the key or the
   * input, and the answer. The host's `model` event is the call's record.
   */
  const sending = <A, E, R>(effect: Effect.Effect<A, E, R>, dispatch: Dispatch<unknown>) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const window = Math.max(0, dispatch.deadline - CUTOFF_MS - started);
      return yield* effect.pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.timeoutOrElse({
          duration: window,
          orElse: () =>
            Effect.fail(new Errors.Timeout({ sent: dispatch.attempt.sent, milliseconds: window }))
        }),
        Effect.withTracerEnabled(false)
      );
    });

  const decide = <E>(
    target: Target,
    args: typeof ModelsDecideArgs.Type,
    dispatch: Dispatch<E>
  ): Effect.Effect<ModelsDecided, Errors.CallError | E> =>
    Effect.gen(function* () {
      // Only a model the provider documents as deciding is sent a decision.
      if (!deciding.includes(target.model))
        return yield* new Errors.Unavailable({ reason: "model", sent: false });
      const entries = Object.entries(args.questions);
      const definition = yield* Effect.try({
        try: () =>
          Decision.make({
            input: Schema.String,
            decisions: Object.fromEntries(entries.map(([name, value]) => [name, decisionOf(value)]))
          }),
        catch: () => new Errors.InvalidRequest({ reason: "provider", sent: false })
      });
      const wire: Wire<E> = {};
      const response = yield* sending(
        DecisionModel.decideSettled(definition, { input: inputText(args.input) }).pipe(
          Effect.provide(
            OpenAiDecisionModel.layer({ model: target.model }).pipe(
              Layer.provide(client(wire, dispatch))
            )
          ),
          Effect.mapError((error) => failure(error, wire, dispatch.attempt))
        ),
        dispatch
      );
      const usage = usageOf(wire.envelope);
      dispatch.attempt.usage = usage;
      const answers: Record<string, ModelAnswer> = {};
      for (const [name, question] of entries) {
        const outcome = response.outcomes[name];
        const answer = outcome === undefined ? undefined : answerOf(question, outcome);
        if (answer === undefined)
          return yield* new Errors.Unavailable({ reason: "answer", sent: true, usage });
        answers[name] = answer;
      }
      return { answers, usage } satisfies ModelsDecided;
    });

  const generate = <E>(
    target: Target,
    args: typeof ModelsGenerateArgs.Type,
    dispatch: Dispatch<E>
  ): Effect.Effect<ModelsGenerated, Errors.CallError | E> =>
    Effect.gen(function* () {
      const schema = args.output === undefined ? undefined : outputSchema(args.output);
      if (isInvalidRequest(schema)) return yield* schema;
      const prompt = [
        ...(args.instructions === undefined
          ? []
          : [{ role: "system" as const, content: args.instructions }]),
        { role: "user" as const, content: inputText(args.input) }
      ];
      const wire: Wire<E> = {};
      // One turn on any model id: no developer role and no reasoning state to send back later.
      const model = OpenAiLanguageModel.layer({
        model: target.model,
        config: { max_output_tokens: args.maxOutputTokens, reasoningModel: false }
      }).pipe(Layer.provide(client(wire, dispatch)));
      /** The answer's own ending decides first; only a completed one is read for its content. */
      const finished = <A>(
        exit: Exit.Exit<A, AiError.AiError>
      ): Effect.Effect<A, Errors.CallError | E> => {
        const usage = usageOf(wire.envelope);
        if (wire.status !== undefined) dispatch.attempt.usage = usage;
        const answered =
          wire.refused === undefined &&
          wire.oversized === undefined &&
          wire.status !== undefined &&
          wire.status >= 200 &&
          wire.status < 300;
        if (!answered)
          return Effect.fail(
            Exit.isSuccess(exit)
              ? new Errors.Unavailable({ reason: "answer", sent: true, usage })
              : Option.match(Cause.findErrorOption(exit.cause), {
                  onNone: () => new Errors.Unavailable({ reason: "answer", sent: true, usage }),
                  onSome: (error) => failure(error, wire, dispatch.attempt)
                })
          );
        const ended = ending(wire.envelope, args.maxOutputTokens);
        if (ended !== undefined) return Effect.fail(ended);
        if (Exit.isSuccess(exit)) return Effect.succeed(exit.value);
        // A completed answer that didn't decode: the typed output's shape, or Patchy's reading.
        const error = Cause.findErrorOption(exit.cause);
        return Effect.fail(
          Option.isSome(error) && error.value.reason._tag === "StructuredOutputError"
            ? new Errors.ShapeMismatch({ usage })
            : new Errors.Unavailable({ reason: "answer", sent: true, usage })
        );
      };
      const settle = <A>(effect: Effect.Effect<A, AiError.AiError, LanguageModel.LanguageModel>) =>
        sending(
          effect.pipe(
            Effect.provide(model),
            Effect.exit,
            Effect.flatMap((exit): Effect.Effect<A, Errors.CallError | E> =>
              Exit.isFailure(exit) && !Cause.hasFails(exit.cause)
                ? Effect.orDie(Effect.failCause(exit.cause))
                : finished(exit)
            )
          ),
          dispatch
        );
      if (schema === undefined) {
        const response = yield* settle(LanguageModel.generateText({ prompt }));
        return { text: response.text, usage: usageOf(wire.envelope) } satisfies ModelsGenerated;
      }
      const response = yield* settle(
        LanguageModel.generateObject({ prompt, schema, objectName: "output" })
      );
      return {
        value: response.value as typeof Schema.Json.Type,
        usage: usageOf(wire.envelope)
      } satisfies ModelsGenerated;
    });

  return Source.of({ decide, generate });
});

/** OpenAI at its one address; `makeAt` exists for tests of the transport against a local server. */
export const make = makeAt(OPENAI_URL);

/** OpenAI over the process's fetch. */
export const layer = Layer.effect(Source, make).pipe(Layer.provide(FetchHttpClient.layer));
