/**
 * The server side of the `Authorization` middleware `packages/api` declares:
 * one token lookup per request, providing the current identity to the
 * handler, or the one 401 the wire knows. A missing credential and a bad one
 * are indistinguishable from here on.
 *
 * The header is read through `Bearer.parse` rather than the credential the
 * security scheme decodes: Effect's decoder takes exactly one space and keeps
 * trailing whitespace, and the contract (`CONTEXT.md`) is the parser's, so
 * every path that authenticates reads the header the same way.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { Authorization, CurrentIdentity } from "@patchy/api";
import * as Bearer from "./Bearer.js";
import * as Tokens from "./Tokens.js";

export const make = Effect.gen(function* () {
  const tokens = yield* Tokens.Tokens;
  return Authorization.of({
    bearer: Effect.fn("Authorization.bearer")(function* (httpEffect) {
      const unauthorized = { ok: false as const, error: "Missing or invalid API token." as const };
      const request = yield* HttpServerRequest.HttpServerRequest;
      const credential = Bearer.parse(request.headers.authorization);
      if (credential.kind !== "bearer") return yield* Effect.fail(unauthorized);
      // A database failure is a 500, not a 401: it must never look like a bad token.
      const identity = yield* tokens
        .authenticate(credential.token)
        .pipe(Effect.catchTags({ SqlError: Effect.die }));
      if (Option.isNone(identity)) return yield* Effect.fail(unauthorized);
      return yield* Effect.provideService(httpEffect, CurrentIdentity, identity.value);
    })
  });
});

export const layer = Layer.effect(Authorization, make);
