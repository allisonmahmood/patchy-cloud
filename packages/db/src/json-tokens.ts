/**
 * `@patchy/auth`'s `Tokens` service over the JSON driver's own token store —
 * the seam that lets the auth capability's handlers run on an instance that
 * has no Postgres. Imperative underneath by nature: the JSON driver is
 * Promise code, and both go with the `patches` port.
 */
import { Tokens } from "@patchy/auth";
import { Identity } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { JsonFilePatchyDb } from "./json-db.js";

export const jsonTokensLayer = (db: JsonFilePatchyDb) =>
  Layer.succeed(
    Tokens.Tokens,
    Tokens.Tokens.of({
      authenticate: (token) =>
        Effect.map(
          Effect.promise(() => db.findApiTokenByToken(token)),
          (auth) =>
            Option.fromNullOr(auth).pipe(
              Option.map(
                (auth) =>
                  new Identity({
                    accountId: auth.accountId,
                    accountName: auth.accountName,
                    apiTokenId: auth.id,
                    apiTokenName: auth.name,
                    scopes: auth.scopes
                  })
              )
            )
        ),
      create: (input) =>
        Effect.promise(() =>
          db.createApiToken({
            accountId: input.accountId,
            name: input.name,
            token: input.token,
            scopes: [...input.scopes]
          })
        ),
      mint: (input) =>
        Effect.gen(function* () {
          const recent = yield* Effect.promise(() =>
            db.countSelfServiceMintsBySourceIp(input.sourceIp)
          );
          if (recent >= input.quota) {
            return yield* new Tokens.MintQuotaExceeded({
              sourceIp: input.sourceIp,
              quota: input.quota
            });
          }
          const minted = yield* Effect.promise(() =>
            db.mintSelfServiceToken({
              token: input.token,
              name: input.name,
              sourceIp: input.sourceIp
            })
          );
          return { accountId: minted.accountId, apiTokenId: minted.apiTokenId };
        }),
      revoke: (apiTokenId) =>
        Effect.map(
          Effect.promise(() => db.revokeApiToken(apiTokenId)),
          Option.fromNullOr
        )
    })
  );
