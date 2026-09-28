import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Binding from "./Binding.js";
import type * as Runtime from "./Runtime.js";

export interface Input {
  readonly op: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly binding: Binding.Binding["Service"];
  /** Called before access checks, including attempts which fail. */
  readonly onDependency?: (key: string) => void;
}

/** Primitives supplies tier 1 reads without Runtime importing its storage adapter. */
export class SubscriptionReads extends Context.Service<
  SubscriptionReads,
  {
    readonly admit: (input: Input) => Effect.Effect<readonly string[], Runtime.RuntimeError>;
    readonly read: (
      input: Input
    ) => Effect.Effect<
      { readonly result: unknown; readonly vector: Readonly<Record<string, string>> },
      Runtime.RuntimeError
    >;
    readonly revisions: (
      companyId: string,
      keys: readonly string[]
    ) => Effect.Effect<Readonly<Record<string, string>>, Runtime.RuntimeError>;
  }
>()("@patchy/runtime/SubscriptionReads") {}
