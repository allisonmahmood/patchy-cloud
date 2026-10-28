/**
 * PostHog's dev binding is the real connection (ADR-0013): `patchy dev` sends each query to the
 * instance's dev door as the machine token's person, whichever local viewer asked. PostHog can't
 * write, so every operation it has reads live.
 */
import { PostgresRows, PostHogQuery } from "@patchy/api";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as DevDoor from "../DevDoor.js";
import { ConnectionNotDeclared } from "./Operations.js";

const decodeRows = Schema.decodeUnknownOption(PostgresRows);

/** `posthog.query` for `patchy dev`: the local manifest routes, the instance reads. */
export const handlers = Effect.fn("PostHogDev.handlers")(function* (instance: DevDoor.Instance) {
  const http = yield* HttpClient.HttpClient;
  return {
    "posthog.query": Runtime.handler(
      { kind: "integration", input: PostHogQuery, output: PostgresRows },
      Effect.fn("PostHogDev.query")(function* ({ connection: alias, ...args }) {
        const binding = yield* Binding.Binding;
        const declaration = binding.manifest.uses[alias];
        if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "posthog")
          return yield* new ConnectionNotDeclared({});
        return yield* DevDoor.read(
          instance,
          {
            op: "posthog.query",
            connection: { id: declaration.id, handle: declaration.handle },
            args
          },
          decodeRows
        ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      })
    )
  };
});
