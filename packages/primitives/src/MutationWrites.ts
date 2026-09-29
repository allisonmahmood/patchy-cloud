import * as Context from "effect/Context";

/** Only the invocation transaction owner publishes these resources after commit. */
export class MutationWrites extends Context.Service<
  MutationWrites,
  {
    readonly resources: Set<string>;
  }
>()("@patchy/primitives/MutationWrites") {}
