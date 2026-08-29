/**
 * The server side of the `Authorization` middleware `packages/api` declares:
 * one token lookup per request, providing the current identity to the
 * handler, or the one 401 the wire knows. A missing credential and a bad one
 * are indistinguishable from here on.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Authorization, CurrentIdentity } from "@patchy/api";
import * as Tokens from "./Tokens.js";

export const make = Effect.gen(function* () {
  const tokens = yield* Tokens.Tokens;
  return Authorization.of({
    bearer: Effect.fn("Authorization.bearer")(function* (httpEffect, { credential }) {
      // A database failure is a 500, not a 401: it must never look like a bad token.
      const identity = yield* tokens
        .authenticate(Redacted.value(credential))
        .pipe(Effect.catchTags({ SqlError: Effect.die }));
      if (Option.isNone(identity)) {
        return yield* Effect.fail({
          ok: false as const,
          error: "Missing or invalid API token." as const
        });
      }
      return yield* Effect.provideService(httpEffect, CurrentIdentity, identity.value);
    })
  });
});

export const layer = Layer.effect(Authorization, make);
