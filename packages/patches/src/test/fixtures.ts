/**
 * Users and machines added to the seeded template. Production Patches never
 * imports Auth: handlers receive identities from the bearer middleware.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { Authorization, CurrentIdentity, Identity } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import * as Testing from "@patchy/sql/testing";

const company = {
  id: DEV_SEED.companyId,
  handle: DEV_SEED.companyHandle,
  name: DEV_SEED.companyName
};

/** The identities the tests act as; two machines may act as the same user. */
export const identities = {
  admin: new Identity({
    user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
    company,
    role: DEV_SEED.role,
    machine: { id: DEV_SEED.tokenId, name: DEV_SEED.tokenName }
  }),
  uploader: new Identity({
    user: { id: "usr_uploader", email: "uploader@patchy.local", name: "Uploader" },
    company,
    role: "member",
    machine: { id: "tok_uploader", name: "Upload machine" }
  }),
  sibling: new Identity({
    user: { id: "usr_uploader", email: "uploader@patchy.local", name: "Uploader" },
    company,
    role: "member",
    machine: { id: "tok_sibling", name: "Sibling machine" }
  }),
  reader: new Identity({
    user: { id: "usr_reader", email: "reader@patchy.local", name: "Reader" },
    company,
    role: "member",
    machine: { id: "tok_reader", name: "Reader machine" }
  }),
  quota: new Identity({
    user: { id: "usr_quota", email: "quota@patchy.local", name: "Quota" },
    company,
    role: "member",
    machine: { id: "tok_quota", name: "Quota machine" }
  }),
  quotaSibling: new Identity({
    user: { id: "usr_quota", email: "quota@patchy.local", name: "Quota" },
    company,
    role: "member",
    machine: { id: "tok_quota_sibling", name: "Second quota machine" }
  })
} as const;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const identity of Object.values(identities)) {
    if (identity.machine.id === DEV_SEED.tokenId) continue;
    yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES (${identity.user.id}, ${`clerk_${identity.user.id}`}, ${identity.company.id},
              ${identity.user.email}, ${identity.user.name}, ${identity.role})
      ON CONFLICT (id) DO NOTHING`;
    yield* sql`INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
      VALUES (${identity.machine.id}, ${identity.user.id}, ${identity.machine.name},
              ${`hash:${identity.machine.id}`}, now(), now() + interval '90 days', now())`;
  }
});

/** The seeded template with the additional users and machines above. */
export const database = Layer.effectDiscard(seed).pipe(Layer.provideMerge(Testing.layer()));

/** Revokes a fixture machine, as Auth's MachineTokens service would. */
export const revoke = (machineTokenId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`UPDATE machine_tokens SET revoked_at = now() WHERE id = ${machineTokenId}`
  );

/** The server side of the bearer middleware: the credential is the machine's id. */
export const authorization = Layer.succeed(
  Authorization,
  Authorization.of({
    bearer: (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        const identity = Object.values(identities).find((it) => it.machine.id === token);
        if (identity === undefined) {
          return yield* Effect.fail({
            ok: false as const,
            error: "Missing or invalid API token." as const
          });
        }
        return yield* Effect.provideService(httpEffect, CurrentIdentity, identity);
      })
  })
);

/** The client side: present this identity's credential on every request. */
export const as = (identity: Identity) =>
  HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, identity.machine.id))
  );
