import type { Runtime } from "@patchy/runtime/core";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import type * as ConnectionStore from "./ConnectionStore.js";

/** Which connection a call goes to and until when, for a caller its door already admitted. */
export interface Target<E = never> {
  readonly companyId: string;
  readonly connection: { readonly id: string; readonly handle: string };
  /** When the caller stops waiting, in epoch milliseconds; a queued call gives up before it. */
  readonly deadline: number;
  /** The caller, checked again once the call holds a slot and before anything is sent. */
  readonly recheck: Effect.Effect<void, E>;
}

/**
 * A `live` operation as the instance's dev door runs it (ADR-0013): its arguments arrive without
 * the repo's alias and are decoded here, the caller is the door's, never a loaded version's, and
 * the door's refusal of that caller and the connection's absence come back as they are, for the
 * door to say. `R` is the integration's source, which the door shares with published patches.
 */
export interface DevRead<R> {
  readonly resource: (args: unknown) => string | null;
  readonly rowCount: (value: unknown) => number | null;
  readonly sql?: (args: unknown) => string | undefined;
  readonly run: <E extends Runtime.RuntimeError>(
    target: Target<E>,
    args: unknown
  ) => Effect.Effect<
    unknown,
    | Runtime.RuntimeError
    | ConnectionStore.ConnectionNotFound
    | ConnectionStore.ConnectionNotConnected
    | E,
    R | ConnectionStore.ConnectionStore
  >;
}

/** Schemas determine the handler contract, never the other way around. */
export const operation = <
  Input extends Schema.Top,
  Output extends Schema.Top,
  Errors extends Schema.Top,
  R
>(definition: {
  readonly input: Input;
  readonly output: Output;
  readonly errors: Errors;
  readonly run: (
    input: NoInfer<Input["Type"]>
  ) => Effect.Effect<NoInfer<Output["Type"]>, NoInfer<Errors["Type"]>, R>;
}) => definition;

/** An integration keeps its source, pure generation and local binding together. */
export const defineIntegration = <
  const Name extends string,
  const Modes extends ReadonlyArray<"company">,
  Credentials extends Schema.Top,
  Metadata extends Schema.Top,
  DiscoverError,
  DiscoverRequirements,
  Operations extends Readonly<
    Record<
      string,
      {
        readonly input: Schema.Top;
        readonly output: Schema.Top;
        readonly errors: Schema.Top;
        readonly run: (...args: never[]) => Effect.Effect<unknown, unknown, unknown>;
      }
    >
  >,
  Declaration,
  Generated,
  Fixture,
  Dev,
  DevError,
  DevRequirements
>(definition: {
  readonly name: Name;
  readonly modes: Modes;
  readonly credentials: Credentials;
  readonly metadata?: {
    readonly schema: Metadata;
    readonly discover: (
      credentials: NoInfer<Credentials["Type"]>
    ) => Effect.Effect<NoInfer<Metadata["Type"]>, DiscoverError, DiscoverRequirements>;
  };
  readonly operations: Operations;
  readonly generate: (declaration: Declaration, metadata: NoInfer<Metadata["Type"]>) => Generated;
  /**
   * The local binding over fixtures: how dev runs an integration by default (ADR-0013). Absent
   * when dev reads the real connection instead, through `live`.
   */
  readonly dev?: (
    metadata: NoInfer<Metadata["Type"]>,
    fixture: Fixture
  ) => Layer.Layer<Dev, DevError, DevRequirements>;
  /**
   * The operations `patchy dev` runs on the real connection, through the instance's dev door as
   * the machine token's person (ADR-0013). Only reads, and only for an integration whose fixtures
   * wouldn't resemble production: PostHog's events can't be known ahead, and mail a builder's
   * agent invents never resembles a company's. Writes never run live in dev; the door runs
   * nothing else.
   */
  readonly live?: ReadonlyArray<keyof Operations & string>;
}) => definition;
