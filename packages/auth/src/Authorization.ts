/**
 * The server side of the `Authorization` middleware `packages/api` declares:
 * one token lookup per request, providing the current identity to the
 * handler, or the one 401 the wire knows. A missing credential and a bad one
 * are indistinguishable from here on.
 *
 * The header is read through `Bearer.parse` rather than the credential the
 * security scheme decodes: Effect's decoder takes exactly one space and keeps
 * trailing whitespace, and the contract (`CONTEXT.md`) is the parser's, so
 * every path that authenticates reads the header the same way. `identify` is
 * that path on its own, for the server's guard over the requests the router
 * never matches.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { Authorization, CurrentIdentity, type Identity, refuse, Unauthorized } from "@patchy/api";
import * as Bearer from "./Bearer.js";
import * as Tokens from "./Tokens.js";

/**
 * The one 401, as the wire spells it. Answered as a response rather than
 * failed as a value: the body is `{ ok, error }` like a 400's, and an
 * endpoint's error union would encode the value as whichever came first.
 */
export const unauthorized = refuse(Unauthorized, {
  ok: false,
  error: "Missing or invalid API token."
});

/**
 * The identity the current request's bearer token resolves to, or `None` for
 * a missing, malformed, unknown or revoked one. A database failure is a
 * defect, not a `None`: it must never look like a bad token.
 */
export const identify: Effect.Effect<
  Option.Option<Identity>,
  never,
  HttpServerRequest.HttpServerRequest | Tokens.Tokens
> = Effect.gen(function* () {
  const tokens = yield* Tokens.Tokens;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const credential = Bearer.parse(request.headers.authorization);
  if (credential.kind !== "bearer") return Option.none();
  return yield* tokens
    .authenticate(credential.token)
    .pipe(Effect.catchTags({ SqlError: Effect.die }));
});

export const make = Effect.gen(function* () {
  const tokens = yield* Tokens.Tokens;
  return Authorization.of({
    bearer: Effect.fn("Authorization.bearer")(function* (httpEffect) {
      const identity = yield* identify.pipe(Effect.provideService(Tokens.Tokens, tokens));
      if (Option.isNone(identity)) return unauthorized;
      return yield* Effect.provideService(httpEffect, CurrentIdentity, identity.value);
    })
  });
});

export const layer = Layer.effect(Authorization, make);
