import { assert, it } from "@effect/vitest";
import { inject } from "vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Analytics } from "@patchy/analytics";
import { Companies, InviteMail, Users } from "@patchy/companies";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AuthPages from "../src/AuthPages.js";
import * as DeviceLogins from "../src/DeviceLogins.js";
import * as MachineTokens from "../src/MachineTokens.js";
import * as Session from "../src/Session.js";
import { liveClient } from "./fixtures.js";

const settings = inject("clerk");
const client = liveClient(settings);
// Closed configuration: even an ambient CLERK_JWT_KEY cannot bypass JWKS.
const env = {
  CLERK_SECRET_KEY: settings.secretKey,
  CLERK_PUBLISHABLE_KEY: settings.publishableKey,
  PATCHY_PUBLIC_BASE_URL: settings.publicBaseUrl,
  CLERK_AUTHORIZED_PARTIES: settings.authorizedParty
};
const services = Layer.mergeAll(
  HttpServer.layerServices,
  Session.layer,
  Companies.layer,
  Users.layer,
  InviteMail.layer
).pipe(
  Layer.provideMerge(DeviceLogins.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provideMerge(Layer.mergeAll(Limits.layer, Analytics.layerNoop)),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
);
const decodeClaims = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ azp: Schema.optional(Schema.Null), iat: Schema.Number }))
);

it.layer(services, { timeout: "60 seconds" })("live Clerk", (it) => {
  it.effect(
    "admits a Clerk-signed session to /company using JWKS without an authorized party",
    () =>
      Effect.gen(function* () {
        const user = yield* Effect.promise(() =>
          client.users.createUser({
            emailAddress: [settings.email],
            firstName: "Clerk",
            lastName: "Live",
            skipPasswordRequirement: true,
            skipLegalChecks: true
          })
        );
        yield* (yield* Companies.Companies).create({
          handle: "clerk-live",
          name: "Clerk Live Company",
          clerkUserId: user.id,
          email: settings.email,
          userName: "Clerk Live"
        });
        const session = yield* Effect.promise(() =>
          client.sessions.createSession({ userId: user.id })
        );
        const token = yield* Effect.promise(() => client.sessions.getToken(session.id));
        const claims = decodeClaims(Buffer.from(token.jwt.split(".")[1]!, "base64url").toString());
        assert.isNull(claims.azp ?? null);
        const app = yield* HttpRouter.toHttpEffect(AuthPages.layer);
        const response = yield* app.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(new URL("/company", settings.publicBaseUrl), {
                headers: {
                  cookie: `__session=${token.jwt}; __client_uat=${claims.iat}; __clerk_db_jwt=live-test`
                }
              })
            )
          )
        );
        const web = HttpServerResponse.toWeb(response);
        assert.strictEqual(web.status, 200);
        assert.strictEqual(web.headers.get("cache-control"), "private, no-store");
        const html = yield* Effect.promise(() => web.text());
        assert.include(html, "Clerk Live Company");
        assert.include(html, settings.email);
      })
  );

  it.effect("creates, lists, revokes and re-invites through live InviteMail", () =>
    Effect.gen(function* () {
      const mail = yield* InviteMail.InviteMail;
      const first = yield* mail.create(settings.inviteEmail);
      const created = yield* Effect.promise(() =>
        client.invitations.getInvitationList({ query: settings.inviteEmail, status: "pending" })
      );
      assert.deepStrictEqual(
        created.data.map(({ id, emailAddress, status }) => ({ id, emailAddress, status })),
        [{ id: first, emailAddress: settings.inviteEmail, status: "pending" }]
      );
      yield* mail.revoke(first);
      const revoked = yield* Effect.promise(() =>
        client.invitations.getInvitationList({ query: settings.inviteEmail, status: "revoked" })
      );
      assert.isTrue(revoked.data.some((invitation) => invitation.id === first));
      const second = yield* mail.create(settings.inviteEmail);
      assert.notStrictEqual(second, first);
      const resent = yield* Effect.promise(() =>
        client.invitations.getInvitationList({ query: settings.inviteEmail, status: "pending" })
      );
      assert.deepStrictEqual(
        resent.data.map(({ id, emailAddress, status }) => ({ id, emailAddress, status })),
        [{ id: second, emailAddress: settings.inviteEmail, status: "pending" }]
      );
      yield* mail.revoke(second);
    })
  );
});
