import type { Config, DescriptorOf, Json, SchemaInput } from "./config.js";
import type { InferDescriptor } from "./server.js";
import { decodeError } from "./clientError.js";

/**
 * A company model role's client, in a tier 2 action only. A patch asks for a role, never a model:
 * an admin maps each role to a provider connection and a model, and can change the model without
 * the patch changing. A decision role's client has only `decide`; a text role's only `generate`.
 * Patchy makes one call to the provider for each call here and never retries. These types mirror
 * `packages/api/src/models.ts`, the wire they decode. PROTOTYPE.
 */

/** One fixed question for a decision role. Its answer is probabilities, never text. */
export type ModelQuestion =
  | {
      readonly type: "choice";
      readonly instructions: string;
      /** Two to 50 options, each its key and what it means. */
      readonly options: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "scale";
      readonly instructions: string;
      /** Two to 10 levels, lowest first. */
      readonly levels: readonly [string, string, ...string[]];
    }
  | { readonly type: "yesNo"; readonly instructions: string };

/** What the provider counted, when it said. */
export interface ModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** One question's answer, in its own question's terms. */
export type ModelAnswer<Q> = Q extends { readonly type: "choice"; readonly options: infer O }
  ? {
      /** The likeliest option. */
      readonly choice: keyof O & string;
      /** Each option's probability; they sum to 1. */
      readonly probabilities: { readonly [K in keyof O & string]: number };
    }
  : Q extends { readonly type: "scale"; readonly levels: infer L extends readonly string[] }
    ? {
        /** The likeliest level. */
        readonly level: L[number];
        /** The probability-weighted level, from 0 (the first) to the number of levels less one. */
        readonly score: number;
        readonly probabilities: { readonly [K in L[number]]: number };
      }
    : {
        /** How likely the statement holds, from 0 to 1. */
        readonly probability: number;
      };

export interface ModelDecided<Q extends Readonly<Record<string, ModelQuestion>>> {
  /** Each question's answer, or `null` when the model refused that question. */
  readonly answers: { readonly [K in keyof Q]: ModelAnswer<Q[K]> | null };
  readonly usage: ModelUsage;
}

/** A decision role: input and fixed questions in, probabilities out. */
export interface DecisionRole {
  decide<const Q extends Readonly<Record<string, ModelQuestion>>>(request: {
    /** What to decide about: a string, or JSON. */
    readonly input: Json;
    /** One to 20 questions, by a name of your own. */
    readonly questions: Q;
  }): Promise<ModelDecided<Q>>;
}

/** The descriptors a typed output takes: every field required, no nulls, rows or files. */
export type ModelOutput =
  | {
      readonly kind: "text" | "integer" | "number" | "boolean";
      readonly optional?: never;
      readonly description?: string;
    }
  | {
      readonly kind: "enum";
      readonly values: readonly string[];
      readonly optional?: never;
      readonly description?: string;
    }
  | {
      readonly kind: "array";
      readonly element: ModelOutput;
      readonly optional?: never;
      readonly description?: string;
    }
  | ModelOutputObject;
export interface ModelOutputObject {
  readonly kind: "object";
  readonly fields: Readonly<Record<string, ModelOutput>>;
  readonly optional?: never;
  readonly description?: string;
}
/** A `t.object(...)` whose fields are all of `ModelOutput`'s kinds. */
export type ModelOutputSchema = SchemaInput & { toJSON(): ModelOutputObject };

export interface GenerateRequest {
  /** What the model is to do; the input is what it works on. */
  readonly instructions?: string;
  /** A string, or JSON. */
  readonly input: Json;
  /** The most the model may write, required. Reaching it fails `output_truncated`. */
  readonly maxOutputTokens: number;
}

/** A text role: text out, or a value of the shape `output` describes. */
export interface TextRole {
  generate<const S extends ModelOutputSchema>(
    request: GenerateRequest & { readonly output: S }
  ): Promise<{
    readonly value: InferDescriptor<DescriptorOf<S>, Config>;
    readonly usage: ModelUsage;
  }>;
  generate(
    request: GenerateRequest
  ): Promise<{ readonly text: string; readonly usage: ModelUsage }>;
}

type Call = (
  op: "models.decide" | "models.generate",
  args: Readonly<Record<string, unknown>>
) => Promise<unknown>;

/**
 * Both calls on one alias; the generated client narrows it to the role's kind, and the host
 * refuses the other one `invalid_request`.
 */
export function createModelsClient(connection: string, call: Call): DecisionRole & TextRole {
  const invoke = async <A>(
    op: "models.decide" | "models.generate",
    args: Readonly<Record<string, unknown>>
  ): Promise<A> => {
    let value: unknown;
    try {
      value = await call(op, { connection, ...args });
    } catch (error) {
      throw decodeError(error, op) ?? error;
    }
    const error = decodeError(value, op);
    if (error) throw error;
    // The host encodes each result through its own wire schema.
    return value as A;
  };
  return {
    decide: ({ input, questions }) => invoke("models.decide", { input, questions }),
    generate: ({
      instructions,
      input,
      maxOutputTokens,
      ...rest
    }: GenerateRequest & {
      readonly output?: ModelOutputSchema;
    }) =>
      invoke("models.generate", {
        ...(instructions === undefined ? {} : { instructions }),
        input,
        maxOutputTokens,
        ...(rest.output === undefined ? {} : { output: rest.output.toJSON() })
      })
  } as DecisionRole & TextRole;
}
