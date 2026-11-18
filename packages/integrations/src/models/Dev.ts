/**
 * Model roles' dev binding is the real role (ADR-0013): a fake model would never answer the way
 * the company's does, and a builder's agent tunes questions and instructions against the answers.
 * `patchy dev` sends each call to the instance's dev door as the machine token's person, whichever
 * local viewer asked, with what's left of the local action; the instance keeps the key, calls the
 * company's provider and counts the call against that person's daily allowance. PROTOTYPE.
 */
import { ModelsDecide, ModelsDecided, ModelsGenerate, ModelsGenerated } from "@patchy/api";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as DevDoor from "../DevDoor.js";
import { ConnectionNotDeclared } from "./Errors.js";

const decodeDecided = Schema.decodeUnknownOption(ModelsDecided);
const decodeGenerated = Schema.decodeUnknownOption(ModelsGenerated);
/** Without a deadline from the gateway, a call has an action's whole minute. */
const FALLBACK_MS = 60_000;

/** `models.decide` and `models.generate` for `patchy dev`: the local manifest routes, the instance calls. */
export const handlers = Effect.fn("ModelsDev.handlers")(function* (instance: DevDoor.Instance) {
  const http = yield* HttpClient.HttpClient;
  const call =
    <A>(op: "models.decide" | "models.generate", decode: (value: unknown) => Option.Option<A>) =>
    ({ connection: alias, ...args }: { readonly connection: string }) =>
      Effect.gen(function* () {
        const binding = yield* Binding.Binding;
        const declaration = binding.manifest.uses[alias];
        if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "models")
          return yield* new ConnectionNotDeclared({});
        const now = yield* Clock.currentTimeMillis;
        const deadlineMs = Math.max(
          1,
          Math.min(FALLBACK_MS, Math.round((binding.deadline ?? now + FALLBACK_MS) - now))
        );
        return yield* DevDoor.read(
          instance,
          {
            op,
            connection: { id: declaration.id, handle: declaration.handle },
            args,
            deadlineMs
          },
          decode
        ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      });
  return {
    "models.decide": {
      ...Runtime.handler(
        { kind: "integration", input: ModelsDecide, output: ModelsDecided },
        call("models.decide", decodeDecided)
      ),
      deadline: "attempt" as const
    },
    "models.generate": {
      ...Runtime.handler(
        { kind: "integration", input: ModelsGenerate, output: ModelsGenerated },
        call("models.generate", decodeGenerated)
      ),
      deadline: "attempt" as const
    }
  };
});
