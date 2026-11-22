import type { Config, DescriptorOf, Json, SchemaInput } from "./config.js";
import { PatchyError } from "./clientError.js";
import type { InferDescriptor } from "./server.js";

/**
 * A model role's client in a tier 2 action: `decide` on a decision role, `generate` on a text
 * role, never both. Patchy makes one request to the provider the role is mapped to and never
 * retries it; a refusal says in `details.sent` whether a request went out, and a retry after one
 * that went out, or after a reply lost on its way back (no `sent`), can charge again. These types
 * mirror `packages/api/src/models.ts`, the wire they decode.
 */

/** One fixed question a decision role answers with probabilities. */
export type ModelQuestion =
  | {
      readonly type: "choice";
      readonly instructions: string;
      /** Each option's name and what it means, 2 to 50. */
      readonly options: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "scale";
      readonly instructions: string;
      /** 2 to 10 distinct levels, lowest first. */
      readonly levels: readonly string[];
    }
  | { readonly type: "yesNo"; readonly instructions: string };

/** What the provider counted, where it said. */
export interface ModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** One question's answer, or `null` when the model refused that question. */
export type ModelAnswer =
  | { readonly choice: string; readonly probabilities: Readonly<Record<string, number>> }
  | {
      readonly level: string;
      /** The probability-weighted level, 0 for the lowest. */
      readonly score: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly probability: number }
  | null;

export interface DecisionClient {
  decide(request: {
    readonly input: Json;
    readonly questions: Readonly<Record<string, ModelQuestion>>;
  }): Promise<{
    readonly answers: Readonly<Record<string, ModelAnswer>>;
    readonly usage: ModelUsage;
  }>;
}

interface TextRequest {
  readonly instructions?: string;
  readonly input: Json;
  /** Required: 16 to `models.generate.maxOutputTokens`. */
  readonly maxOutputTokens: number;
}
/** A typed output's schema: a `t.object(...)`, whose root is always an object. */
type ObjectSchema = SchemaInput & { toJSON(): { readonly kind: "object" } };
export interface TextClient {
  /**
   * A value of `output`'s shape: a `t.object(...)` of text, integer, number, boolean, enum,
   * nullable, object and array fields, all required. First, so a typed request held in a
   * variable is never taken for a text one.
   */
  generate<const S extends ObjectSchema>(
    request: TextRequest & { readonly output: S }
  ): Promise<{
    readonly value: InferDescriptor<DescriptorOf<S>, Config>;
    readonly usage: ModelUsage;
  }>;
  /** Text, at most `maxOutputTokens` long. */
  generate(
    request: TextRequest & { readonly output?: never }
  ): Promise<{ readonly text: string; readonly usage: ModelUsage }>;
}

type Call = (op: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>;

/** `models.calls.inFlight` and `models.calls.perAction`, which a test holds to the registry. */
export const IN_FLIGHT = 4;
export const PER_ACTION = 200;

/**
 * One invocation's model calls, across every role alias. At most four run at once; the rest wait
 * here as they were asked, not yet serialized and with no request open, so `Promise.all` over
 * rows works four at a time. The queue holds at most what is left of the action's 200 calls, and
 * `end` clears it when the action ends.
 */
export const createModelScheduler = (call: Call) => {
  let running = 0;
  let attempts = 0;
  let ended = false;
  const waiting: Array<{ readonly start: () => void; readonly reject: (error: Error) => void }> =
    [];
  const next = () => {
    while (running < IN_FLIGHT && waiting.length > 0) waiting.shift()!.start();
  };
  const run = (op: string, args: Readonly<Record<string, unknown>>) =>
    new Promise<unknown>((resolve, reject) => {
      if (ended) return reject(new Error("The invocation has ended."));
      if (++attempts > PER_ACTION)
        return reject(
          new PatchyError(
            "limit_exceeded",
            "This action made the model calls it may, so nothing was sent.",
            { sent: false },
            undefined,
            { scope: "viewer", limitId: "models.calls.perAction", value: PER_ACTION, operation: op }
          )
        );
      const start = () => {
        running++;
        call(op, args)
          .then(resolve, reject)
          .finally(() => {
            running--;
            next();
          });
      };
      if (running < IN_FLIGHT) start();
      else waiting.push({ start, reject });
    });
  return {
    run,
    /** The action ended: nothing waiting is sent. */
    end: () => {
      ended = true;
      for (const entry of waiting.splice(0)) entry.reject(new Error("The invocation has ended."));
    }
  };
};
export type ModelScheduler = ReturnType<typeof createModelScheduler>;

/** The client a role alias gets: by its kind, only `decide` or only `generate`. */
export function createModelsClient(
  connection: string,
  kind: "decision" | "text",
  scheduler: ModelScheduler
): DecisionClient | TextClient {
  return kind === "decision"
    ? {
        decide: async (request) =>
          (await scheduler.run("models.decide", {
            connection,
            input: request.input,
            questions: request.questions
          })) as Awaited<ReturnType<DecisionClient["decide"]>>
      }
    : // One implementation answers both overloads: the host's answer has the shape asked for.
      ({
        generate: (request: TextRequest & { readonly output?: SchemaInput }) =>
          scheduler.run("models.generate", {
            connection,
            ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
            input: request.input,
            maxOutputTokens: request.maxOutputTokens,
            // A schema crosses the wire as its descriptor.
            ...(request.output === undefined ? {} : { output: request.output.toJSON() })
          })
      } as TextClient);
}
