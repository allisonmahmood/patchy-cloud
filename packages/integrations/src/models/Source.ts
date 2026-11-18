// @effect-diagnostics schemaInFunctionBody:off -- A typed output's schema is the call's own, so it is built per call.
import type { HandlerSchema, ModelQuestion, ModelsDecided, ModelUsage } from "@patchy/api";
import { ModelRoleKind } from "@patchy/api";
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel";
import type * as AiError from "effect/ai/AiError";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Telemetry from "effect/ai/Telemetry";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Errors from "./Errors.js";

/**
 * Model providers, called through Effect's AI module with the company's key. The hosting server
 * makes every call, only to the provider's API (`https://api.openai.com/v1`), never following a
 * redirect and without trace context. One request per call, never retried. A dev instance may
 * point the provider at a loopback fake instead (`PATCHY_DEV_MODELS_URL`), which the server
 * refuses outside development. PROTOTYPE.
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

/** The provider's error, in Patchy's codes; the provider's own words stay in the cause. */
const refusal = (error: AiError.AiError): Errors.CallError => {
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
type ProviderAnswer = Effect.Success<
  ReturnType<OpenAiClient.OpenAiClient["Service"]["createDecisions"]>
>["answers"][number];

/** Rounded probabilities may drift from 1 by half a hundredth each; more than that isn't read. */
const distribution = (
  labels: ReadonlyArray<string>,
  raw: ReadonlyMap<string, number>
): Record<string, number> | undefined => {
  const probabilities: Record<string, number> = {};
  let total = 0;
  for (const label of labels) {
    const value = raw.get(label);
    if (value === undefined || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
    probabilities[label] = value;
    total += value;
  }
  if (total === 0 || Math.abs(total - 1) > labels.length * 0.005 + 1e-6) return undefined;
  for (const label of labels) probabilities[label] = probabilities[label]! / total;
  return probabilities;
};

/** One answer in its question's terms, `null` when refused, or undefined when it doesn't read. */
const answerOf = (question: ModelQuestion, answer: ProviderAnswer): Answer | undefined => {
  if (answer.type === "refusal") return null;
  switch (question.type) {
    case "choice": {
      if (answer.type !== "choice") return undefined;
      const labels = Object.keys(question.options);
      if (!labels.includes(answer.choice)) return undefined;
      const probabilities = distribution(
        labels,
        new Map(answer.probabilities.map((entry) => [entry.value, entry.probability]))
      );
      return probabilities === undefined ? undefined : { choice: answer.choice, probabilities };
    }
    case "scale": {
      if (answer.type !== "score") return undefined;
      const levels = question.levels;
      if (!(answer.score >= 0 && answer.score <= levels.length - 1)) return undefined;
      const probabilities = distribution(
        levels,
        new Map(
          answer.probabilities.flatMap((entry) => {
            const level = levels[entry.value];
            return level === undefined ? [] : [[level, entry.probability] as const];
          })
        )
      );
      if (probabilities === undefined) return undefined;
      // The likeliest level, the first on a tie.
      const level = levels.reduce((best, next) =>
        probabilities[next]! > probabilities[best]! ? next : best
      );
      return { level, score: answer.score, probabilities };
    }
    case "yesNo":
      return answer.type === "predicate" && answer.probability >= 0 && answer.probability <= 1
        ? { probability: answer.probability }
        : undefined;
  }
};

const question = (name: string, value: ModelQuestion) => {
  switch (value.type) {
    case "choice":
      return {
        type: "choice" as const,
        name,
        instructions: value.instructions,
        choices: Object.entries(value.options).map(([option, description]) => ({
          value: option,
          description
        }))
      };
    case "scale":
      return {
        type: "score" as const,
        name,
        instructions: value.instructions,
        levels: value.levels.map((label) => ({ label, description: label }))
      };
    case "yesNo":
      return { type: "predicate" as const, name, instructions: value.instructions };
  }
};

const tokens = (value: number | undefined): number | null =>
  value === undefined || !Number.isFinite(value) ? null : value;

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

  /** The provider's client with this key, over fetch, built for the one call. */
  const client = (key: Redacted.Redacted<string>) =>
    OpenAiClient.layer({ apiUrl, apiKey: key }).pipe(Layer.provide(FetchHttpClient.layer));
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
    // Effect's DecisionModel fails the whole call when any question is refused, so its client is
    // called directly here, and a refused question answers null beside the others.
    const response = yield* Effect.gen(function* () {
      const openai = yield* OpenAiClient.OpenAiClient;
      return yield* openai.createDecisions({
        model: call.model,
        input: text,
        questions: entries.map(([name, value]) => question(name, value))
      });
    }).pipe(Effect.provide(client(call.key)), outbound, Effect.mapError(refusal));
    const byName = new Map(response.answers.map((answer) => [answer.name, answer]));
    const answers: Record<string, Answer> = {};
    for (const [name, value] of entries) {
      const found = byName.get(name);
      const answer = found === undefined ? undefined : answerOf(value, found);
      if (answer === undefined) return yield* new Errors.Unavailable({ reason: "answer" });
      answers[name] = answer;
    }
    return {
      answers,
      usage: {
        inputTokens: tokens(response.usage?.input_tokens),
        outputTokens: tokens(response.usage?.output_tokens)
      }
    } satisfies ModelsDecided;
  });

  const generate = Effect.fn("Models.generate")(function* (call: GenerateCall) {
    const text = inputText(call.input);
    if (text.length > MAX_INPUT_CHARS) return yield* new Errors.InvalidRequest({ reason: "input" });
    const schema =
      call.output === undefined
        ? undefined
        : call.output.kind === "object"
          ? outputSchema(call.output, "")
          : new Errors.InvalidRequest({ reason: "output", path: "output" });
    if (isInvalidRequest(schema)) return yield* schema;
    const prompt = [
      ...(call.instructions === undefined
        ? []
        : [{ role: "system" as const, content: call.instructions }]),
      { role: "user" as const, content: text }
    ];
    // What the model's last answer said, seen before LanguageModel decodes a typed output, which
    // keeps neither the finish reason nor the usage when the decode fails.
    const seen: { finish?: string; usage?: ModelUsage; refused: boolean } = { refused: false };
    const observe: Telemetry.SpanTransformer = ({ response }) => {
      for (const part of response) {
        if (part.type === "finish") {
          seen.finish = part.reason;
          seen.usage = {
            inputTokens: tokens(part.usage.inputTokens.total),
            outputTokens: tokens(part.usage.outputTokens.total)
          };
        }
        if (part.type === "text" && part.metadata?.openai?.refusal !== undefined)
          seen.refused = true;
      }
    };
    const model = OpenAiLanguageModel.layer({
      model: call.model,
      config: { max_output_tokens: call.maxOutputTokens, store: false }
    }).pipe(Layer.provide(client(call.key)));
    const run = <A>(effect: Effect.Effect<A, AiError.AiError, LanguageModel.LanguageModel>) =>
      effect.pipe(
        Effect.provide(model),
        Effect.provideService(Telemetry.CurrentSpanTransformer, observe),
        outbound
      );
    const usage = () => seen.usage ?? { inputTokens: null, outputTokens: null };
    /** Whatever the decode said, a refusal or a cut-off answer is what to report. */
    const ending = (): Errors.CallError | undefined =>
      seen.refused || seen.finish === "content-filter"
        ? new Errors.Refused({ usage: usage() })
        : // @effect/ai-openai 4.0.5 maps no `max_output_tokens` finish to "length", so a cut-off
          // Responses answer reads "unknown": the provider's count at the cap says it instead.
          seen.finish === "length" || (seen.usage?.outputTokens ?? 0) >= call.maxOutputTokens
          ? new Errors.OutputTruncated({ maxOutputTokens: call.maxOutputTokens, usage: usage() })
          : undefined;
    if (schema === undefined) {
      const response = yield* run(LanguageModel.generateText({ prompt })).pipe(
        Effect.mapError(refusal)
      );
      const ended = ending();
      if (ended !== undefined) return yield* ended;
      return { text: response.text, usage: usage() } satisfies Generated;
    }
    const response = yield* run(
      LanguageModel.generateObject({
        prompt,
        // The root is always an object, so it encodes to a record as a structured output must.
        schema: schema as Schema.Codec<
          Record<string, unknown>,
          Record<string, unknown>,
          never,
          never
        >,
        objectName: "output"
      })
    ).pipe(
      Effect.mapError((error) =>
        error.reason._tag === "StructuredOutputError"
          ? (ending() ?? new Errors.ShapeMismatch({ usage: usage() }))
          : refusal(error)
      )
    );
    const ended = ending();
    if (ended !== undefined) return yield* ended;
    return { value: response.value as typeof Schema.Json.Type, usage: usage() } satisfies Generated;
  });

  return Source.of({ apiUrl, decide, generate });
});

export const layer = Layer.effect(Source, make);
