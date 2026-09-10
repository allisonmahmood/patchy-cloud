import { assert, it } from "@effect/vitest";
import { expectTypeOf } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { defineIntegration, operation } from "../definition.js";
import { postgres, PostgresOperationsUnavailable } from "./index.js";

const Input = Schema.Struct({ id: Schema.String });
const Output = Schema.Struct({ count: Schema.Number });
const Failure = Schema.Struct({ code: Schema.Literal("not_found") });
class Counter extends Context.Service<Counter, { readonly count: number }>()(
  "@patchy/integrations/postgres/definition.test/Counter"
) {}

it.effect("retains schema-inferred handler values, failures and execution dependency", () =>
  Effect.gen(function* () {
    const read = operation({
      input: Input,
      output: Output,
      errors: Failure,
      run: Effect.fn(function* (input) {
        expectTypeOf(input).toEqualTypeOf<typeof Input.Type>();
        const counter = yield* Counter;
        if (input.id === "missing") return yield* Effect.fail({ code: "not_found" as const });
        return { count: counter.count };
      })
    });
    expectTypeOf(read.run).returns.toEqualTypeOf<
      Effect.Effect<typeof Output.Type, typeof Failure.Type, Counter>
    >();
    assert.deepStrictEqual(
      yield* read.run({ id: "known" }).pipe(Effect.provideService(Counter, { count: 7 })),
      { count: 7 }
    );
    assert.deepStrictEqual(
      yield* read
        .run({ id: "missing" })
        .pipe(Effect.provideService(Counter, { count: 7 }), Effect.flip),
      { code: "not_found" }
    );
  })
);

it("rejects mismatched handlers at the schema boundary", () => {
  operation({
    input: Input,
    output: Output,
    errors: Failure,
    // @ts-expect-error Handler success must satisfy the output schema, not widen it.
    run: () => Effect.succeed({ count: "wrong" })
  });
  expectTypeOf<() => Effect.Effect<never, { readonly code: "other" }>>().not.toExtend<
    Parameters<typeof operation<typeof Input, typeof Output, typeof Failure, never>>[0]["run"]
  >();
  operation({
    input: Input,
    output: Output,
    errors: Failure,
    // @ts-expect-error The input schema determines the handler argument.
    run: (input: { id: number }) => Effect.succeed({ count: input.id })
  });
  defineIntegration({
    name: "typed",
    modes: ["company"],
    credentials: Schema.Redacted(Schema.String),
    metadata: {
      schema: Output,
      // @ts-expect-error Discovery consumes the integration's redacted credentials.
      discover: (credentials: string) => Effect.succeed({ count: credentials.length })
    },
    operations: {},
    generate: (_declaration: string, metadata: typeof Output.Type) => metadata.count,
    dev: () => Layer.empty
  });
  defineIntegration({
    name: "typed",
    modes: ["company"],
    credentials: Schema.Redacted(Schema.String),
    metadata: {
      schema: Output,
      discover: (credentials: Redacted.Redacted<string>) =>
        Effect.succeed({ count: Redacted.value(credentials).length })
    },
    operations: {},
    generate: (_declaration: string, metadata: typeof Output.Type) => metadata.count,
    // @ts-expect-error A local binding supplies a Layer, not an arbitrary successful effect.
    dev: () => Effect.succeed({})
  });
});

it.effect("declares no operations and refuses generation and fixtures explicitly", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(postgres.operations, {});
    const metadata = { version: 1 as const, relations: [], enums: [], exclusions: [] };
    const generated = postgres.generate(
      { kind: "postgres", handle: "warehouse", id: "connection", revision: 1 },
      metadata
    );
    assert.isTrue(Result.isFailure(generated));
    const failure = yield* Effect.void.pipe(
      Effect.provide(postgres.dev(metadata, "")),
      Effect.flip
    );
    assert.instanceOf(failure, PostgresOperationsUnavailable);
  })
);
