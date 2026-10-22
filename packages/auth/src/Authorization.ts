/**
 * The server side of the `Authorization` middleware `packages/api` declares:
 * one token lookup per request, providing the current identity to the
 * handler and naming its user and company on the request's wide event, or
 * the one 401 the wire knows. A missing credential and a bad one
 * are indistinguishable from here on.
 *
 * The header is read through `Bearer.parse` rather than the credential the
 * security scheme decodes: Effect's decoder takes exactly one space and keeps
 * trailing whitespace, and the contract (`GLOSSARY.md`) is the parser's, so
 * every path that authenticates reads the header the same way. `identify` is
 * that path on its own, for the server's guard over the requests the router
 * never matches and for Patchy MCP's door, each naming the purpose it opens for.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type { SqlError } from "effect/sql/SqlError";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Authorization, CurrentIdentity, type Identity, refuse, Unauthorized } from "@patchy/api";
import * as AgentConnections from "./AgentConnections.js";
import * as Bearer from "./Bearer.js";
import * as MachineTokens from "./MachineTokens.js";

/**
 * What a credential is for: `build` is a machine token's and opens the CLI's API, `work` an
 * agent connection's and opens only Patchy MCP. Each lives in its own store, so a credential
 * checked for the other purpose is unknown there, on any release.
 */
export type Purpose = "build" | "work";

interface Bearers {
  readonly build: { readonly identity: Identity; readonly store: MachineTokens.MachineTokens };
  readonly work: {
    readonly identity: AgentConnections.AgentIdentity;
    readonly store: AgentConnections.AgentConnections;
  };
}

const checks: {
  readonly [P in Purpose]: (
    token: string
  ) => Effect.Effect<Bearers[P]["identity"] | null, SqlError, Bearers[P]["store"]>;
} = {
  build: (token) => MachineTokens.MachineTokens.use((tokens) => tokens.authenticate(token)),
  work: (token) =>
    AgentConnections.AgentConnections.use((connections) => connections.authenticate(token))
};

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
 * The identity the current request's bearer token resolves to for `purpose`, or `None` for a
 * missing, malformed, unknown, revoked, expired, idle or deactivated one, or one for the other
 * purpose. A database failure is a defect, not a `None`: it must never look like a bad token.
 */
export const identify = <P extends Purpose>(
  purpose: P
): Effect.Effect<
  Option.Option<Bearers[P]["identity"]>,
  never,
  HttpServerRequest.HttpServerRequest | Bearers[P]["store"]
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const credential = Bearer.parse(request.headers.authorization);
    if (credential.kind !== "bearer") return Option.none();
    const identity = yield* checks[purpose](credential.token).pipe(
      Effect.map(Option.fromNullishOr),
      Effect.catchTags({ SqlError: Effect.die })
    );
    // The request event's principal is the user; the credential is provenance.
    if (Option.isSome(identity))
      yield* WideEvents.enrich({
        viewerId: identity.value.user.id,
        companyId: identity.value.company.id
      });
    return identity;
  });

export const make = Effect.gen(function* () {
  const tokens = yield* MachineTokens.MachineTokens;
  return Authorization.of({
    bearer: Effect.fn("Authorization.bearer")(function* (httpEffect) {
      const identity = yield* identify("build").pipe(
        Effect.provideService(MachineTokens.MachineTokens, tokens)
      );
      if (Option.isNone(identity)) return unauthorized;
      return yield* Effect.provideService(httpEffect, CurrentIdentity, identity.value);
    })
  });
});

export const layer = Layer.effect(Authorization, make);
