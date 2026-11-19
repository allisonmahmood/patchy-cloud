// @effect-diagnostics schemaInFunctionBody:off -- A typed output's schema is the call's own, so it is built per call.
import type { HandlerSchema, ModelQuestion, ModelsDecided, ModelUsage } from "@patchy/api";
import { handlerJsonSchema, ModelRoleKind } from "@patchy/api";
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient";
import * as OpenAiDecisionModel from "@effect/ai-openai/OpenAiDecisionModel";
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel";
import type * as AiError from "effect/ai/AiError";
import * as Decision from "effect/ai/Decision";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Telemetry from "effect/ai/Telemetry";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Errors from "./Errors.js";

/**
 * Model providers, called through Effect's AI module with the company's key. The hosting server
 * makes every call, only to the provider's API (`https://api.openai.com/v1`), never following a
 * redirect and without trace context, and reads at most `MAX_ANSWER_BYTES` of any answer, a
 * refusal's included. One request per call, never retried. A dev instance may point the provider
 * at a loopback fake instead (`PATCHY_DEV_MODELS_URL`), which the server refuses outside
 * development. PROTOTYPE.
 *
 * `generate` has two versions, for comparing them: one through `LanguageModel`, one through the
 * provider's generated client, reading the Responses answer itself. `PATCHY_DEV_MODEL_CLIENT=raw`
 * picks the second.
 */

export const PRODUCTION_URL = "https://api.openai.com/v1";

// ---------- what the two integrations store ----------

/** A provider connection's key, sealed like every connection's credentials. */
export const OpenAiCredentials = Schema.Struct({
  apiKey: Schema.String.check(Schema.isMinLength(1))
});
export type OpenAiCredentials = typeof OpenAiCredentials.Type;
export const OpenAiDisplay = Schema.Struct({ keyHint: Schema.String });
export type OpenAiDisplay = typeof OpenAiDisplay.Type;

/** A role holds no secret: its provider connection does. */
export const RoleCredentials = Schema.Struct({});
const ModelId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/));
/**
 * Where a role points now: its provider connection, by id, and the model there. An admin's remap
 * changes this, not the snapshot, so a published patch follows it without a republish.
 */
export const RoleDisplay = Schema.Struct({
  kind: ModelRoleKind,
  provider: Schema.String,
  model: ModelId
});
export type RoleDisplay = typeof RoleDisplay.Type;

const openAiCredentialsJson = Schema.fromJsonString(OpenAiCredentials);
const decodeOpenAiCredentials = Schema.decodeUnknownEffect(openAiCredentialsJson, {
  onExcessProperty: "error"
});
const encodeOpenAiCredentials = Schema.encodeSync(openAiCredentialsJson);
const encodeRoleCredentials = Schema.encodeSync(Schema.fromJsonString(RoleCredentials));
export const openAiCredentials = (value: OpenAiCredentials): Redacted.Redacted<string> =>
  Redacted.make(encodeOpenAiCredentials(value));
export const roleCredentials = (): Redacted.Redacted<string> =>
  Redacted.make(encodeRoleCredentials({}));
export const parseOpenAiCredentials = Effect.fn("Models.parseOpenAiCredentials")(function* (
  secret: Redacted.Redacted<string>
) {
  return yield* decodeOpenAiCredentials(Redacted.value(secret)).pipe(
    Effect.mapError(
      (cause) => new Errors.Unavailable({ reason: "key", cause: Redacted.make(cause) })
    )
  );
});

// ---------- the calls ----------

export interface DecideCall {
  readonly key: Redacted.Redacted<string>;
  readonly model: string;
  readonly input: typeof Schema.Json.Type;
  readonly questions: Readonly<Record<string, ModelQuestion>>;
}
export interface GenerateCall {
  readonly key: Redacted.Redacted<string>;
  readonly model: string;
  readonly instructions?: string;
  readonly input: typeof Schema.Json.Type;
  readonly maxOutputTokens: number;
  readonly output?: HandlerSchema;
}
export type Generated =
  | { readonly text: string; readonly usage: ModelUsage }
  | { readonly value: typeof Schema.Json.Type; readonly usage: ModelUsage };

export class DevProviderRefused extends Schema.TaggedError<DevProviderRefused>()(
  "ModelsDevProviderRefused",
  { url: Schema.String }
) {
  override get message() {
    return `PATCHY_DEV_MODELS_URL points model calls at ${this.url}: it is honoured only with NODE_ENV=development or test and a loopback host.`;
  }
}

export class Source extends Context.Service<
  Source,
  {
    /** Where provider requests go: the provider's API, or a dev instance's loopback fake. */
    readonly apiUrl: string;
    /** Which `generate` runs: through `LanguageModel`, or the provider's client directly. */
    readonly client: "effect-ai" | "raw";
    /** One Decisions request. A question the model refused answers `null`. */
    readonly decide: (call: DecideCall) => Effect.Effect<ModelsDecided, Errors.CallError>;
    /** One Responses request: text, or a value of `output`'s shape, checked here. */
    readonly generate: (call: GenerateCall) => Effect.Effect<Generated, Errors.CallError>;
  }
>()("@patchy/integrations/models/Source") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const inputText = (input: typeof Schema.Json.Type) =>
  typeof input === "string" ? input : encodeJson(input);
const MAX_INPUT_CHARS = 200_000;
/** The most of one provider answer Patchy reads, a refusal's body included. */
export const MAX_ANSWER_BYTES = 1024 * 1024;

// ---------- reading answers under a bound ----------

/** One call's bound, which says afterwards whether an answer passed it. */
interface Bound {
  exceeded: boolean;
  status?: number;
}
const overBound = (bound: Bound, response: HttpClientResponse.HttpClientResponse) => {
  bound.exceeded = true;
  bound.status = response.status;
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.DecodeError({
      request: response.request,
      response,
      description: `The answer is larger than ${MAX_ANSWER_BYTES} bytes.`
    })
  });
};
/** The body, collected under the bound before anything decodes it, as a response of its own. */
const collect = (response: HttpClientResponse.HttpClientResponse, bound: Bound) =>
  Effect.gen(function* () {
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES)
      return yield* overBound(bound, response);
    const chunks = yield* response.stream.pipe(
      Stream.runFoldEffect(
        () => ({ bytes: 0, chunks: [] as Uint8Array[] }),
        (state, chunk) => {
          if (state.bytes + chunk.byteLength > MAX_ANSWER_BYTES)
            return Effect.fail(overBound(bound, response));
          state.bytes += chunk.byteLength;
          state.chunks.push(chunk);
          return Effect.succeed(state);
        }
      )
    );
    const body = new Uint8Array(chunks.bytes);
    let offset = 0;
    for (const chunk of chunks.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return HttpClientResponse.fromWeb(
      response.request,
      new Response(body, { status: response.status, headers: { ...response.headers } })
    );
  });
/**
 * The client's `transformClient`. It runs after the client's status filter, so a refusal arrives
 * as a failure holding an unread body: that body is collected under the bound too, before the
 * client's error mapping reads it.
 */
const bounded =
  (bound: Bound) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.transformResponse((effect) =>
        effect.pipe(
          Effect.flatMap((response) => collect(response, bound)),
          Effect.catchTag("HttpClientError", (error) =>
            error.reason._tag === "StatusCodeError"
              ? Effect.flatMap(collect(error.reason.response, bound), (response) =>
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
          )
        )
      )
    );

/** The provider's error, in Patchy's codes; the provider's own words stay in the cause. */
const refusal = (error: AiError.AiError, bound: Bound): Errors.CallError => {
  if (bound.exceeded)
    return new Errors.TooLarge({
      maxBytes: MAX_ANSWER_BYTES,
      ...(bound.status === undefined || bound.status < 300 ? {} : { upstreamStatus: bound.status })
    });
  const reason = error.reason;
  const http = "http" in reason ? reason.http : undefined;
  const upstreamStatus = http?.response?.status;
  const status = upstreamStatus === undefined ? {} : { upstreamStatus };
  const cause = Redacted.make(error);
  switch (reason._tag) {
    case "NetworkError":
      return new Errors.Unavailable({ reason: "unreachable", cause });
    case "RateLimitError":
      return new Errors.RateLimited({
        limit: "requests",
        ...(reason.retryAfter === undefined
          ? {}
          : { retryAfterSeconds: Math.max(1, Math.ceil(Duration.toSeconds(reason.retryAfter))) })
      });
    case "QuotaExhaustedError":
      return new Errors.RateLimited({ limit: "quota" });
    case "AuthenticationError":
      return new Errors.Unavailable({ reason: "key", ...status, cause });
    case "ContentPolicyError":
      return new Errors.Refused({});
    case "InvalidRequestError":
      return new Errors.InvalidRequest({ reason: "provider", ...status, cause });
    case "InvalidOutputError":
      return new Errors.Unavailable({ reason: "answer", cause });
    case "StructuredOutputError":
      return new Errors.ShapeMismatch({});
    case "UnsupportedSchemaError":
      return new Errors.InvalidRequest({ reason: "output", cause });
    case "InvalidUserInputError":
      return new Errors.InvalidRequest({ reason: "input", cause });
    default:
      // A redirect, which fetch never follows, lands here as an unknown status.
      return new Errors.Unavailable({ reason: "provider", ...status, cause });
  }
};
// ---------- typed output: a subset of handler descriptors, checked before anything is sent ----------

type OutputSchema = Schema.Codec<unknown, unknown, never, never>;
const isInvalidRequest = Schema.is(Errors.InvalidRequest);
/** The output's schema, or the first descriptor outside the subset, by its path. */
const outputSchema = (
  descriptor: HandlerSchema,
  path: string
): OutputSchema | Errors.InvalidRequest => {
  const refused = new Errors.InvalidRequest({ reason: "output", path });
  if (descriptor.optional === true) return refused;
  const described = <S extends OutputSchema>(schema: S): OutputSchema =>
    descriptor.description === undefined
      ? schema
      : (schema.annotate({ description: descriptor.description }) as OutputSchema);
  switch (descriptor.kind) {
    case "text":
      return described(Schema.String);
    case "integer":
      return described(Schema.Int);
    case "number":
      return described(Schema.Number);
    case "boolean":
      return described(Schema.Boolean);
    case "enum":
      return described(Schema.Literals(descriptor.values));
    case "array": {
      const element = outputSchema(descriptor.element, `${path}[]`);
      return isInvalidRequest(element) ? element : described(Schema.Array(element));
    }
    case "object": {
      const fields: Record<string, OutputSchema> = {};
      for (const [name, field] of Object.entries(descriptor.fields)) {
        const schema = outputSchema(field, path === "" ? name : `${path}.${name}`);
        if (isInvalidRequest(schema)) return schema;
        fields[name] = schema;
      }
      return described(Schema.Struct(fields));
    }
    default:
      return refused;
  }
};

// ---------- decisions ----------

type Answer = ModelsDecided["answers"][string];
/** A question as Effect's decision kinds hold it. Levels describe themselves. */
const decisionOf = (value: ModelQuestion) => {
  switch (value.type) {
    case "choice":
      return Decision.classify({ instructions: value.instructions, criteria: value.options });
    case "scale":
      return Decision.rate({ instructions: value.instructions, criteria: value.levels });
    case "yesNo":
      return Decision.probability({ instructions: value.instructions });
  }
};
/** A settled answer in its question's terms: `null` when refused, undefined when it doesn't read. */
const answerOf = (
  question: ModelQuestion,
  outcome: Decision.Outcome<ReturnType<typeof decisionOf>>
): Answer | undefined => {
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

const tokens = (value: number | undefined): number | null =>
  value === undefined || !Number.isFinite(value) ? null : value;

/** A typed output's schema and the Responses format it asks for, or the refusal of its shape. */
const outputOf = (output: HandlerSchema | undefined) =>
  output === undefined
    ? undefined
    : output.kind === "object"
      ? outputSchema(output, "")
      : new Errors.InvalidRequest({ reason: "output", path: "output" });

export const make = Effect.gen(function* () {
  const dev = yield* Config.option(Config.String("PATCHY_DEV_MODELS_URL"));
  let apiUrl = PRODUCTION_URL;
  if (Option.isSome(dev)) {
    const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("production"));
    const host = URL.canParse(dev.value) ? new URL(dev.value).hostname : "";
    if (
      (environment !== "development" && environment !== "test") ||
      !(host === "127.0.0.1" || host === "localhost" || host === "[::1]")
    )
      return yield* new DevProviderRefused({ url: dev.value });
    apiUrl = dev.value;
  }
  const client =
    (yield* Config.String("PATCHY_DEV_MODEL_CLIENT").pipe(Config.withDefault("effect-ai"))) ===
    "raw"
      ? ("raw" as const)
      : ("effect-ai" as const);

  /** The provider's client with this key, over fetch, built for the one call, reading under `bound`. */
  const provider = (key: Redacted.Redacted<string>, bound: Bound) =>
    OpenAiClient.layer({ apiUrl, apiKey: key, transformClient: bounded(bound) }).pipe(
      Layer.provide(FetchHttpClient.layer)
    );
  /** Every request: never follow a redirect, which would carry the key elsewhere; no trace context. */
  const outbound = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(Tracer.DisablePropagation, true)
    );

  const decide = Effect.fn("Models.decide")(function* (call: DecideCall) {
    const text = inputText(call.input);
    if (text.length > MAX_INPUT_CHARS) return yield* new Errors.InvalidRequest({ reason: "input" });
    const entries = Object.entries(call.questions);
    // The input goes as a string: as JSON, an object under Decision's image key would be sent
    // as an image.
    const definition = Decision.make({
      input: Schema.String,
      decisions: Object.fromEntries(entries.map(([name, value]) => [name, decisionOf(value)]))
    });
    const bound: Bound = { exceeded: false };
    // decideSettled keeps the other answers when one question is refused; decide fails them all.
    const response = yield* DecisionModel.decideSettled(definition, { input: text }).pipe(
      Effect.provide(
        OpenAiDecisionModel.layer({ model: call.model }).pipe(
          Layer.provide(provider(call.key, bound))
        )
      ),
      outbound,
      Effect.mapError((error) => refusal(error, bound))
    );
    const answers: Record<string, Answer> = {};
    for (const [name, value] of entries) {
      const outcome = response.outcomes[name];
      const answer = outcome === undefined ? undefined : answerOf(value, outcome);
      if (answer === undefined) return yield* new Errors.Unavailable({ reason: "answer" });
      answers[name] = answer;
    }
    return {
      answers,
      usage: {
        inputTokens: tokens(response.usage.inputTokens),
        outputTokens: tokens(response.usage.outputTokens)
      }
    } satisfies ModelsDecided;
  });

  /** `generate` through `LanguageModel`. */
  const generateWithLanguageModel = Effect.fn("Models.generate")(function* (call: GenerateCall) {
    const text = inputText(call.input);
    if (text.length > MAX_INPUT_CHARS) return yield* new Errors.InvalidRequest({ reason: "input" });
    const schema = outputOf(call.output);
    if (isInvalidRequest(schema)) return yield* schema;
    const prompt = [
      ...(call.instructions === undefined
        ? []
        : [{ role: "system" as const, content: call.instructions }]),
      { role: "user" as const, content: text }
    ];
    const bound: Bound = { exceeded: false };
    const model = OpenAiLanguageModel.layer({
      model: call.model,
      // One turn, never stored: no developer role and no encrypted reasoning to carry forward,
      // whatever the model id looks like.
      config: { max_output_tokens: call.maxOutputTokens, store: false, reasoningModel: false }
    }).pipe(Layer.provide(provider(call.key, bound)));
    /** How an answer ended, which reports first: a refusal, then a cut-off. */
    const ending = (
      finish: string | undefined,
      refused: boolean,
      usage: ModelUsage
    ): Errors.CallError | undefined =>
      refused || finish === "content-filter"
        ? new Errors.Refused({ usage })
        : finish === "length"
          ? new Errors.OutputTruncated({ maxOutputTokens: call.maxOutputTokens, usage })
          : undefined;
    const refusedIn = (
      parts: ReadonlyArray<{ readonly type: string; readonly metadata?: unknown }>
    ) =>
      parts.some(
        (part) =>
          part.type === "text" &&
          typeof part.metadata === "object" &&
          part.metadata !== null &&
          "openai" in part.metadata &&
          typeof part.metadata.openai === "object" &&
          part.metadata.openai !== null &&
          "refusal" in part.metadata.openai &&
          part.metadata.openai.refusal !== undefined
      );
    const usageOf = (usage: {
      inputTokens: { total?: number };
      outputTokens: { total?: number };
    }) => ({
      inputTokens: tokens(usage.inputTokens.total),
      outputTokens: tokens(usage.outputTokens.total)
    });
    if (schema === undefined) {
      const response = yield* LanguageModel.generateText({ prompt }).pipe(
        Effect.provide(model),
        outbound,
        Effect.mapError((error) => refusal(error, bound))
      );
      const usage = usageOf(response.usage);
      const ended = ending(response.finishReason, refusedIn(response.content), usage);
      if (ended !== undefined) return yield* ended;
      return { text: response.text, usage } satisfies Generated;
    }
    // A failed decode keeps neither the finish reason nor the usage (StructuredOutputError's
    // usage stays empty on 4.1.4), so the telemetry hook sees the answer before it is decoded.
    const seen: { finish?: string; usage?: ModelUsage; refused: boolean } = { refused: false };
    const observe: Telemetry.SpanTransformer = ({ response }) => {
      for (const part of response)
        if (part.type === "finish") {
          seen.finish = part.reason;
          seen.usage = usageOf(part.usage);
        }
      seen.refused = refusedIn(response);
    };
    const response = yield* LanguageModel.generateObject({
      prompt,
      // The root is always an object, so it encodes to a record as a structured output must.
      schema: schema as Schema.Codec<
        Record<string, unknown>,
        Record<string, unknown>,
        never,
        never
      >,
      objectName: "output"
    }).pipe(
      Effect.provide(model),
      Effect.provideService(Telemetry.CurrentSpanTransformer, observe),
      outbound,
      Effect.mapError((error) => {
        if (error.reason._tag !== "StructuredOutputError") return refusal(error, bound);
        const usage = seen.usage ?? { inputTokens: null, outputTokens: null };
        return ending(seen.finish, seen.refused, usage) ?? new Errors.ShapeMismatch({ usage });
      })
    );
    const usage = usageOf(response.usage);
    const ended = ending(response.finishReason, refusedIn(response.content), usage);
    if (ended !== undefined) return yield* ended;
    return { value: response.value as typeof Schema.Json.Type, usage } satisfies Generated;
  });

  /** `generate` through the provider's generated client, reading the Responses answer itself. */
  const generateWithClient = Effect.fn("Models.generateRaw")(function* (call: GenerateCall) {
    const text = inputText(call.input);
    if (text.length > MAX_INPUT_CHARS) return yield* new Errors.InvalidRequest({ reason: "input" });
    const schema = outputOf(call.output);
    if (isInvalidRequest(schema)) return yield* schema;
    const bound: Bound = { exceeded: false };
    const [answer] = yield* Effect.gen(function* () {
      const openai = yield* OpenAiClient.OpenAiClient;
      return yield* openai.createResponse({
        model: call.model,
        input: [
          ...(call.instructions === undefined
            ? []
            : [{ role: "system" as const, content: call.instructions }]),
          { role: "user" as const, content: text }
        ],
        max_output_tokens: call.maxOutputTokens,
        store: false,
        text: {
          format:
            call.output === undefined
              ? { type: "text" }
              : {
                  type: "json_schema",
                  name: "output",
                  // Patchy's own rendering of the descriptor, as agent tools publish it.
                  schema: { ...handlerJsonSchema(call.output, {}) },
                  strict: true
                }
        }
      });
    }).pipe(
      Effect.provide(provider(call.key, bound)),
      outbound,
      Effect.mapError((error) => refusal(error, bound))
    );
    const usage = {
      inputTokens: tokens(answer.usage?.input_tokens),
      outputTokens: tokens(answer.usage?.output_tokens)
    };
    const parts = answer.output.flatMap((item) => (item.type === "message" ? item.content : []));
    if (
      parts.some((part) => part.type === "refusal") ||
      answer.incomplete_details?.reason === "content_filter"
    )
      return yield* new Errors.Refused({ usage });
    if (answer.incomplete_details?.reason === "max_output_tokens")
      return yield* new Errors.OutputTruncated({ maxOutputTokens: call.maxOutputTokens, usage });
    const written = parts
      .flatMap((part) => (part.type === "output_text" ? [part.text] : []))
      .join("");
    if (schema === undefined) return { text: written, usage } satisfies Generated;
    // oxlint-disable-next-line patchy/no-inline-schema-compile -- the output's shape is the call's own.
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(written).pipe(
      Effect.mapError(() => new Errors.ShapeMismatch({ usage }))
    );
    return { value: value as typeof Schema.Json.Type, usage } satisfies Generated;
  });

  return Source.of({
    apiUrl,
    client,
    decide,
    generate: client === "raw" ? generateWithClient : generateWithLanguageModel
  });
});

export const layer = Layer.effect(Source, make);
