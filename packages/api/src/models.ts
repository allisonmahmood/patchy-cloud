/**
 * Model calls: a tier 2 action asks a company's model role to decide or to generate, through the
 * host, on the provider an admin mapped the role to, with the company's own key. Patch code names
 * a role by its alias and never sees the provider, the model or the key. A decision call sends
 * fixed questions and answers probabilities, never text; a text call answers a short text, or a
 * value of a typed output's shape. The host makes one provider request per call and never
 * retries it.
 */
import * as Schema from "effect/Schema";
import { registry } from "@patchy/limits/registry";
import { HandlerSchema } from "./handlers.js";
import { DefinitionName } from "./schemas.js";

/** The words a question or a text call gives the model; never kept by Patchy. */
const Instructions = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000));
/** A question's name and a choice's option: what the answer names, so plain identifiers. */
const Name = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/));
const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Described = Schema.String.check(Schema.isMaxLength(1000));
const between =
  (min: number, max: number, what: string) =>
  (size: number): true | string =>
    (size >= min && size <= max) || `Give ${min} to ${max} ${what}.`;

/**
 * One fixed question a decision role answers with probabilities. `choice` picks one of its
 * options, each described for the model; `scale` rates on ordered levels, lowest first; `yesNo`
 * says how likely its statement is true.
 */
export const ModelQuestion = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("choice"),
    instructions: Instructions,
    options: Schema.Record(Name, Described).check(
      Schema.makeFilter((options) => between(2, 50, "options")(Object.keys(options).length))
    )
  }),
  Schema.Struct({
    type: Schema.Literal("scale"),
    instructions: Instructions,
    levels: Schema.Array(Label).check(
      Schema.makeFilter((levels) => between(2, 10, "levels")(levels.length)),
      Schema.makeFilter(
        (levels) => new Set(levels).size === levels.length || "Levels must be distinct."
      )
    )
  }),
  Schema.Struct({ type: Schema.Literal("yesNo"), instructions: Instructions })
]);
export type ModelQuestion = typeof ModelQuestion.Type;

/** `models.decide`'s arguments past the alias: the evidence and 1 to 20 named questions. */
export const ModelsDecideArgs = Schema.Struct({
  input: Schema.Json,
  questions: Schema.Record(Name, ModelQuestion).check(
    Schema.makeFilter((questions) => between(1, 20, "questions")(Object.keys(questions).length))
  )
});
export const ModelsDecide = Schema.Struct({
  connection: DefinitionName,
  ...ModelsDecideArgs.fields
});

/**
 * How many tokens a text call may ask for: at least 16, OpenAI's smallest `max_output_tokens`,
 * and at most `models.generate.maxOutputTokens`.
 */
export const ModelOutputTokens = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(16),
  Schema.isLessThanOrEqualTo(registry["models.generate.maxOutputTokens"].default)
);

/**
 * `models.generate`'s arguments past the alias. `instructions` and `input` travel to the model
 * in separate positions; `maxOutputTokens` is required and enforced by the provider. With
 * `output`, a handler descriptor whose root is an object, the answer is a value of that shape,
 * checked by the host.
 */
export const ModelsGenerateArgs = Schema.Struct({
  instructions: Schema.optionalKey(Instructions),
  input: Schema.Json,
  maxOutputTokens: ModelOutputTokens,
  output: Schema.optionalKey(HandlerSchema)
});
export const ModelsGenerate = Schema.Struct({
  connection: DefinitionName,
  ...ModelsGenerateArgs.fields
});

/** What the provider counted for the call, where it said; null where it didn't. */
export const ModelUsage = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int)
});
export type ModelUsage = typeof ModelUsage.Type;

const Probabilities = Schema.Record(Schema.String, Schema.Number);
/**
 * One question's answer in its question's terms: the choice and each option's probability, the
 * likeliest level with the probability-weighted score (0 for the lowest level) and each level's
 * probability, or the probability a yes/no statement is true. `null` when the model refused that
 * question; the other questions still answer.
 */
export const ModelAnswer = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ choice: Schema.String, probabilities: Probabilities }),
    Schema.Struct({ level: Schema.String, score: Schema.Number, probabilities: Probabilities }),
    Schema.Struct({ probability: Schema.Number })
  ])
);
export type ModelAnswer = typeof ModelAnswer.Type;
export const ModelsDecided = Schema.Struct({
  answers: Schema.Record(Schema.String, ModelAnswer),
  usage: ModelUsage
});
export type ModelsDecided = typeof ModelsDecided.Type;

export const ModelsGenerated = Schema.Union([
  Schema.Struct({ text: Schema.String, usage: ModelUsage }),
  Schema.Struct({ value: Schema.Json, usage: ModelUsage })
]);
export type ModelsGenerated = typeof ModelsGenerated.Type;

const operation = <const Op extends string, Args extends Schema.Top, Output extends Schema.Top>(
  op: Op,
  args: Args,
  response: Output
) =>
  ({
    request: Schema.Struct({ op: Schema.Literal(op), args }),
    response,
    kind: "integration"
  }) as const;

/**
 * The two runtime operations. Only a tier 2 action's callbacks reach them; a page's call to
 * either is refused `server_required`, as every operation off the page's list is.
 */
export const modelsOperations = {
  "models.decide": operation("models.decide", ModelsDecide, ModelsDecided),
  "models.generate": operation("models.generate", ModelsGenerate, ModelsGenerated)
} as const;
export type ModelsOperation = keyof typeof modelsOperations;
