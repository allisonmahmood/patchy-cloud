import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Fake from "../pidgeon/Fake.js";
import * as Keys from "../pidgeon/Keys.js";
import * as Source from "../pidgeon/Source.js";

/**
 * Pidgeon for tests: the production Pidgeon source over an injected HTTP client that answers from
 * the fake account. Hosts, redirects, body caps, classification and the address gate stay
 * production code; nothing reaches the network, so the fetch guard holds. Faults stand in for a
 * network that loses, refuses or holds what passes through it.
 */

/** What can go wrong between Patchy and Pidgeon, for one matching request. */
export type Fault =
  /** The request never arrives. */
  | { readonly kind: "fail" }
  /** Pidgeon does what was asked, and its answer never arrives. */
  | { readonly kind: "lose" }
  /** The answer never arrives now, and Pidgeon does it when the test calls `late()`. */
  | { readonly kind: "late" }
  /** The request waits until `release` completes, then goes through. */
  | { readonly kind: "hold"; readonly release: Deferred.Deferred<void> }
  /** Pidgeon answers this instead, doing nothing. */
  | { readonly kind: "answer"; readonly answer: Fake.Answer };

/** The live admin key over the whole test account. */
export const ADMIN_KEY = "pgn_live_testadmin00000000000000";

/** A small account: two addresses on the workspace's own domain, one without an inbox. */
export const seed: Fake.Seed = {
  adminToken: ADMIN_KEY,
  plan: "free",
  inboxes: 3,
  inboxless: 1,
  domains: ["acme.example"],
  addresses: [
    {
      email: "help@acme.example",
      displayName: "Acme Help",
      sendPolicy: "reply_only",
      labels: [{ name: "Billing", colour: "amber" }, { name: "Bugs" }]
    },
    { email: "alerts@acme.example", displayName: "Alerts", inbox: false }
  ],
  takenElsewhere: ["taken@pidgeon.email"]
};

export const make = (account: Fake.Seed = seed, at = 0) => {
  const fake = Fake.make(account, at);
  const requests: Fake.Request[] = [];
  const faults: Array<{
    readonly match: (request: Fake.Request) => boolean;
    readonly fault: Fault;
    times: number;
  }> = [];
  const pending: Fake.Request[] = [];
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const read = Fake.read(request, url);
      requests.push(read);
      const index = faults.findIndex((item) => item.match(read));
      const found = index === -1 ? undefined : faults[index]!;
      if (found !== undefined && --found.times === 0) faults.splice(index, 1);
      const lost = (description: string) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description })
        });
      switch (found?.fault.kind) {
        case "fail":
          return yield* lost("the request never arrived");
        case "lose":
          fake.respond(read, yield* Clock.currentTimeMillis);
          return yield* lost("the answer never arrived");
        case "late":
          pending.push(read);
          return yield* lost("the answer never arrived");
        case "hold":
          yield* Deferred.await(found.fault.release);
          break;
        case "answer":
          return HttpClientResponse.fromWeb(request, Fake.response(found.fault.answer));
      }
      return HttpClientResponse.fromWeb(
        request,
        Fake.response(fake.respond(read, yield* Clock.currentTimeMillis))
      );
    })
  );
  return {
    fake,
    /** Every request the source sent, in order. */
    requests,
    /** Applies `fault` to the next `times` requests that match. */
    fault: (match: (request: Fake.Request) => boolean, fault: Fault, times = 1) => {
      faults.push({ match, fault, times });
    },
    /** Pidgeon does what `late` faults held back, at `at`. */
    late: (at: number) => {
      for (const request of pending.splice(0)) fake.respond(request, at);
    },
    layer: Layer.effect(Source.Source, Source.make).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http))
    )
  };
};

/** Matches requests by method and path, such as `POST /api-keys`. */
export const route =
  (method: string, path: string | RegExp) =>
  (request: Fake.Request): boolean =>
    request.method === method &&
    (typeof path === "string" ? request.path === path : path.test(request.path));

/** The admin's connect request for `address`, as the connect form sends it. */
export const connectRequest = (
  address: Keys.Choice,
  access: Keys.Access = "send",
  adminKey = ADMIN_KEY,
  attempt = "attempt00001"
) => Keys.connectSecret({ adminKey, attempt, address, access });

export const replaceRequest = (
  access: Keys.Access = "send",
  adminKey = ADMIN_KEY,
  attempt = "attempt00002"
) => Keys.replaceSecret({ adminKey, attempt, access });

/** A key as Pidgeon lists it, revoked or live, for checking what connect left behind. */
export const liveKeys = (fake: Fake.Workspace, at = 0) =>
  fake.keys(at).filter((key) => key.revoked_at === null && key.token !== ADMIN_KEY);

export const token = (value: string) => Redacted.make(value);
