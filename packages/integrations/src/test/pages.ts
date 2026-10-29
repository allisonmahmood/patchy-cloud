import { assert } from "@effect/vitest";
import { Analytics } from "@patchy/analytics";
import { Session } from "@patchy/auth";
import { clerkEnv, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as ConnectionPages from "../ConnectionPages.js";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import type * as PidgeonSource from "../pidgeon/Source.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as AttioSource from "../attio/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import { NodeCryptography } from "@patchy/core";

/**
 * The connections pages as a signed-in person sees them, over a migrated database and `pidgeon`:
 * the canned transport offline, or Pidgeon's test mode in the live tier.
 */

const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const origin = new URL(base).origin;

/** Every business event the pages report, newest last. */
export const events: Analytics.AnalyticsEvent[] = [];

export const services = (
  pidgeon: Layer.Layer<PidgeonSource.Source>,
  attio: Layer.Layer<AttioSource.Source> = AttioSource.layer
) =>
  Layer.mergeAll(
    Session.layer,
    Companies.layer,
    Users.layer,
    HttpServer.layerServices,
    SqlConnectionStore.layer,
    Layer.succeed(
      Analytics.Analytics,
      Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
    )
  ).pipe(
    Layer.provideMerge(RuntimeLog.layer),
    Layer.provideMerge(
      Layer.succeed(
        PostgresSource.Source,
        PostgresSource.Source.of({
          test: () => Effect.die("no Postgres here"),
          inspect: () => Effect.die("no Postgres here")
        })
      )
    ),
    Layer.provideMerge(PostHogSource.layer),
    Layer.provideMerge(attio),
    Layer.provideMerge(pidgeon),
    Layer.provideMerge(
      CredentialKeys.layerFromKeys(
        Redacted.make("test:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=")
      )
    ),
    Layer.provideMerge(Testing.layer()),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Layer.provideMerge(NodeCryptography.layer)
  );

export const cookie = (user: Users.User) =>
  signedInCookies(signSession({ sub: user.clerkUserId, email: user.email, name: user.name }));
export const post = (user: Users.User, fields: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { cookie: cookie(user), origin },
  body: new URLSearchParams(fields)
});
export const send = Effect.fn(function* (path: string, options: RequestInit = {}) {
  const app = yield* HttpRouter.toHttpEffect(ConnectionPages.layer);
  return HttpServerResponse.toWeb(
    yield* app.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(new URL(path, base), options))
      )
    )
  );
});
export const read = Effect.fn(function* (path: string, user: Users.User) {
  const response = yield* send(path, { headers: { cookie: cookie(user) } });
  return { status: response.status, html: yield* Effect.promise(() => response.text()), response };
});
export const follow = Effect.fn(function* (response: Response, user: Users.User) {
  assert.strictEqual(response.status, 303);
  return yield* read(response.headers.get("location")!, user);
});
export const createCompany = Effect.fn(function* (handle: string) {
  return yield* (yield* Companies.Companies).create({
    handle,
    name: handle,
    clerkUserId: `user_${handle}_admin`,
    email: `${handle}-admin@example.com`,
    userName: `${handle} Admin`
  });
});
export const addMember = Effect.fn(function* (owner: {
  readonly company: Companies.Company;
  readonly user: Users.User;
}) {
  const companies = yield* Companies.Companies;
  const email = `${owner.company.handle}-member@example.com`;
  const invite = yield* companies.createInvite({
    companyId: owner.company.id,
    invitedBy: owner.user.id,
    email,
    role: "member"
  });
  return yield* companies.consumeInvite({
    inviteId: invite.id,
    clerkUserId: `user_${owner.company.handle}_member`,
    email,
    name: "Member"
  });
});
export const connectPath = "/company/connections/connect/pidgeon";
/** The company's Pidgeon connection by its handle. */
export const connectedId = Effect.fn(function* (companyId: string, handle: string) {
  const connections = yield* (yield* ConnectionStore.ConnectionStore).list(companyId);
  return connections.find((item) => item.integration === "pidgeon" && item.handle === handle)!;
});
