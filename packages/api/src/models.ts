/**
 * Model calls: a tier 2 action asks a company's model role to decide or to generate, through the
 * host, on a provider connection an admin connected with the company's own key. A role is a
 * connection of the `models` integration, mapped to a provider connection and a model; a provider
 * connection is a connection of the `openai` integration. Patch code names a role by its alias
 * and never sees the provider, the model or the key. PROTOTYPE: see `packages/integrations/src/models`.
 */
import * as Schema from "effect/Schema";
import { DefinitionName } from "./schemas.js";
import { HandlerSchema } from "./handlers.js";

export * from "./modelsSnapshot.js";

const Instructions = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000));
const Name = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/));
const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Described = Schema.String.check(Schema.isMaxLength(1000));
const between =
  (min: number, max: number) =>
  (size: number): true | string =>
    (size >= min && size <= max) || `Use ${min} to ${max}.`;

/** One fixed question a decision role answers with probabilities, never text. */
export const ModelQuestion = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("choice"),
    instructions: Instructions,
    options: Schema.Record(Name, Described).check(
      Schema.makeFilter((options) => between(2, 50)(Object.keys(options).length))
    )
  }),
  Schema.Struct({
    type: Schema.Literal("scale"),
    instructions: Instructions,
    levels: Schema.Array(Label).check(
      Schema.makeFilter((levels) => between(2, 10)(levels.length)),
      Schema.makeFilter(
        (levels) => new Set(levels).size === levels.length || "Levels must be distinct."
      )
    )
  }),
  Schema.Struct({ type: Schema.Literal("yesNo"), instructions: Instructions })
]);
export type ModelQuestion = typeof ModelQuestion.Type;

const Tokens = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(16000)
);

/** `models.decide`: the input and its questions, at most 20, for the role the alias declares. */
export const ModelsDecide = Schema.Struct({
  connection: DefinitionName,
  input: Schema.Json,
  questions: Schema.Record(Name, ModelQuestion).check(
    Schema.makeFilter((questions) => between(1, 20)(Object.keys(questions).length))
  )
});

/**
 * `models.generate`: instructions and input in, text out, or a value of `output`'s shape. The cap
 * on output length is required; a typed output takes a small subset of handler descriptors.
 */
export const ModelsGenerate = Schema.Struct({
  connection: DefinitionName,
  instructions: Schema.optionalKey(Instructions),
  input: Schema.Json,
  maxOutputTokens: Tokens,
  output: Schema.optionalKey(HandlerSchema)
});

/** What the provider counted, when it said. */
export const ModelUsage = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int)
});
export type ModelUsage = typeof ModelUsage.Type;

const Probabilities = Schema.Record(Schema.String, Schema.Number);
/** One question's answer, in its question's terms; `null` when the model refused that question. */
export const ModelAnswer = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ choice: Schema.String, probabilities: Probabilities }),
    Schema.Struct({ level: Schema.String, score: Schema.Number, probabilities: Probabilities }),
    Schema.Struct({ probability: Schema.Number })
  ])
);
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
