import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RuntimeMe, RuntimePrincipal } from "@patchy/api";
import type { LoadedVersion } from "./LoadedVersions.js";
import type { RuntimeError } from "./Runtime.js";

/** Only admission constructs a binding; handlers acquire it from the environment. */
export class Binding extends Context.Service<
  Binding,
  LoadedVersion & {
    readonly principal: typeof RuntimePrincipal.Type;
    readonly identity: typeof RuntimeMe.Type;
    /**
     * The door's own check of `identity`, asked again: the viewer now, or the refusal a call
     * should end with. A guest's answers whether their grant still stands. A binding without a
     * viewer refuses.
     */
    readonly reauthorize: Effect.Effect<NonNullable<typeof RuntimeMe.Type>, RuntimeError>;
    readonly correlationId: string;
    /** Invocation callbacks retain the viewer but act as the patch for owned resources. */
    readonly effectivePrincipal?: string;
    readonly invocationId?: string;
    /**
     * The worker agent this operation runs for, set only by Patchy's own agent callers and never
     * from a request. Absent, it is a page's operation, which no agent tool admits.
     */
    readonly agent?: { readonly name: string };
    /**
     * Told when a mutation answers with its key's outcome stored by an earlier invocation, so
     * nothing ran now. Only Patchy's agent callers listen, to say a retried change replayed.
     */
    readonly onReplay?: Effect.Effect<void>;
    /**
     * Run as each run of the call's work is dispatched, nested ones included, its result once
     * that run settles, however it ends and whether or not the caller still waits. Only
     * Patchy's agent callers pass one, to hold the person's in-flight slot until all of it ends.
     */
    readonly retain?: Effect.Effect<Effect.Effect<void>>;
    /**
     * When the caller's deadline for this operation fires, in epoch milliseconds. An integration
     * that queues for a slot stops waiting before it, so a refused wait is never a timeout.
     */
    readonly deadline?: number;
  }
>()("@patchy/runtime/Binding") {}
