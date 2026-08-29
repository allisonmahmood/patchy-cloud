/**
 * What the patches tests need from the auth schema: its tables (the
 * `patches` rows reference them) and a few principals and tokens to hold
 * patches. The package itself never imports `@patchy/auth`; the tests seed
 * rows with plain SQL and present identities through a stand-in bearer
 * middleware, which is exactly how the handlers meet a principal in production.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { Authorization, CurrentIdentity, Identity } from "@patchy/api";
import { migrations as authMigrations } from "@patchy/auth";
import * as Testing from "@patchy/sql/testing";
import { migrations } from "../migrations.js";

/** The identities the tests act as; each token is its own bearer credential. */
export const identities = {
  admin: new Identity({
    accountId: "acct_admin",
    accountName: "Admin",
    apiTokenId: "tok_admin",
    apiTokenName: "Admin token",
    scopes: ["admin", "upload"]
  }),
  uploader: new Identity({
    accountId: "acct_uploader",
    accountName: "Uploader",
    apiTokenId: "tok_uploader",
    apiTokenName: "Upload token",
    scopes: ["upload"]
  }),
  /** A second token on the uploader's principal. */
  sibling: new Identity({
    accountId: "acct_uploader",
    accountName: "Uploader",
    apiTokenId: "tok_sibling",
    apiTokenName: "Sibling token",
    scopes: ["upload"]
  }),
  reader: new Identity({
    accountId: "acct_reader",
    accountName: "Reader",
    apiTokenId: "tok_reader",
    apiTokenName: "Read token",
    scopes: ["read"]
  })
} as const;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const identity of Object.values(identities)) {
    yield* sql`INSERT INTO accounts (id, name) VALUES (${identity.accountId}, ${identity.accountName})
      ON CONFLICT (id) DO NOTHING`;
    yield* sql`INSERT INTO api_tokens (id, account_id, name, token_hash, scopes)
      VALUES (${identity.apiTokenId}, ${identity.accountId}, ${identity.apiTokenName},
              ${`hash:${identity.apiTokenId}`}, ${JSON.stringify(identity.scopes)}::jsonb)`;
  }
});

/** A migrated database with both capabilities' tables and the fixtures above. */
export const database = Layer.effectDiscard(seed).pipe(
  Layer.provideMerge(Testing.layer({ ...authMigrations, ...migrations }))
);

/** Revokes a seeded token, as auth's `Tokens.revoke` would. */
export const revoke = (apiTokenId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`UPDATE api_tokens SET revoked_at = now() WHERE id = ${apiTokenId}`
  );

/** The server side of the bearer middleware: the token is the identity's own id. */
export const authorization = Layer.succeed(
  Authorization,
  Authorization.of({
    bearer: (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        const identity = Object.values(identities).find((it) => it.apiTokenId === token);
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

/** The client side: present this identity's token on every request. */
export const as = (identity: Identity) =>
  HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, identity.apiTokenId))
  );
