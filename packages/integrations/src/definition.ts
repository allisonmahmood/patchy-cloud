import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";

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
  const Modes extends ReadonlyArray<"company" | "personal">,
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
  readonly dev: (
    metadata: NoInfer<Metadata["Type"]>,
    fixture: Fixture
  ) => Layer.Layer<Dev, DevError, DevRequirements>;
}) => definition;
