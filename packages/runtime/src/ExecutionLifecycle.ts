import { limitRefusalFields, type GuestProtocol } from "@patchy/api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { ExecutionBinding } from "./Executor.js";

export class LifecycleError extends Schema.TaggedError<LifecycleError>()("LifecycleError", {
  code: Schema.Literals(["busy", "patch_paused", "source_unavailable"]),
  status: Schema.Number,
  retryAfterSeconds: Schema.Number,
  limitId: limitRefusalFields.limitId,
  scope: limitRefusalFields.scope,
  value: limitRefusalFields.value,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return `Execution admission refused: ${this.code}.`;
  }
}

/**
 * Who admitted work runs for. A page's work keeps its company's task on the documents' clock
 * (`execution.company.idle`); a worker agent's keeps it on the agent idle clock
 * (`execution.company.agentIdle`) and never touches the documents'. A prewarm's runs neither
 * clock and is admitted only on the company's live binding: it never claims a task or waits.
 */
export type Caller = "page" | "agent" | "prewarm";

export interface Admission {
  readonly binding: ExecutionBinding;
  readonly release: Effect.Effect<void>;
}

/**
 * What a touch of a loaded version found. The supervisor answers `touched` (its idle clock
 * restarted), `loading` or `absent`; `unsupported` means its release has no touch, and `paused`
 * or `unbound` that none was sent. `failed` covers every refusal and transport failure.
 */
export type TouchOutcome =
  "touched" | "loading" | "absent" | "unsupported" | "paused" | "unbound" | "failed";

/**
 * What a prewarm found: the company's task `bound` already, a `spare` it claimed, or `full`,
 * when taking one would have left no ready spare or no room in the fleet to replace it.
 */
export interface Prewarm {
  readonly found: "bound" | "spare" | "full";
  /** Whether a page's or an agent's work has run either idle clock since the prewarm began. */
  readonly followed: Effect.Effect<boolean>;
}

export interface Touch {
  readonly outcome: TouchOutcome;
  /** The idle window the supervisor reaps by, in milliseconds, whenever it answered. */
  readonly idleMs?: number;
}

/** Absent in no-pool dev. Presence follows the stream scope; admission follows settlement. */
export class ExecutionLifecycle extends Context.Service<
  ExecutionLifecycle,
  {
    readonly connect: (companyId: string) => Effect.Effect<void, LifecycleError, Scope.Scope>;
    /**
     * Holds the company's task for the caller's scope without running either idle clock, so a
     * task nobody uses meanwhile is released at the first pass after the scope closes, and one
     * someone used follows its clocks as before. It never waits: it claims a spare only while
     * another stays ready and the fleet has room to replace it, and is `full` otherwise.
     */
    readonly prewarm: (companyId: string) => Effect.Effect<Prewarm, LifecycleError, Scope.Scope>;
    readonly acquire: (
      companyId: string,
      patchId: string,
      caller: Caller
    ) => Effect.Effect<Admission, LifecycleError>;
    /**
     * Restarts the idle clock of the version's process on the company's current task, unless
     * its patch is paused. It never admits, claims a task or loads a version.
     */
    readonly touch: (version: GuestProtocol.BundleBinding) => Effect.Effect<Touch>;
  }
>()("@patchy/runtime/ExecutionLifecycle") {}
