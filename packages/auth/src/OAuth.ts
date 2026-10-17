/**
 * Patchy as the OAuth 2.1 authorization server MCP clients expect: open dynamic client
 * registration (RFC 7591), single-use authorization codes bound to PKCE S256, and the exchange
 * that mints a `use` machine token named for the client. Public clients only, and no refresh
 * tokens: a client whose token lapses connects again. OAuthPages serves it over HTTP.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { newInternalId, randomToken, sha256 } from "@patchy/core";
import * as MachineTokens from "./MachineTokens.js";

const CODE_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_REDIRECT_URIS = 10;
const DEFAULT_CLIENT_NAME = "An MCP client";
const LOOPBACK_HOSTS: ReadonlyArray<string> = ["localhost", "127.0.0.1", "[::1]"];

/** A refusal as the OAuth wire spells it, `{ error, error_description }`; `code` is the RFCs'. */
export class OAuthRefusal extends Schema.TaggedError<OAuthRefusal>()("OAuthRefusal", {
  code: Schema.Literals([
    "invalid_request",
    "invalid_grant",
    "unsupported_grant_type",
    "invalid_redirect_uri",
    "invalid_client_metadata"
  ]),
  description: Schema.String
}) {
  override get message() {
    return `${this.code}: ${this.description}`;
  }
}

/** Where a client may receive codes: https, or plain http back to this computer. */
export const RedirectUri = Schema.String.check(
  Schema.makeFilter(
    (uri) => {
      if (!URL.canParse(uri) || uri.includes("#")) return false;
      const url = new URL(uri);
      return (
        url.username === "" &&
        url.password === "" &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))
      );
    },
    { expected: "an https URI, or http on localhost, 127.0.0.1 or [::1]" }
  )
);
export const isRedirectUri = Schema.is(RedirectUri);

/** A PKCE S256 challenge: base64url SHA-256, unpadded. */
export const isCodeChallenge = Schema.is(Schema.String.check(Schema.isPattern(/^[\w-]{43}$/)));
const isCodeVerifier = Schema.is(Schema.String.check(Schema.isPattern(/^[\w.~-]{43,128}$/)));

export class Client extends Schema.Class<Client>("OAuthClient")({
  id: Schema.String,
  name: Schema.String,
  redirectUris: Schema.Array(Schema.String),
  createdAt: Schema.Date
}) {}

/** The RFC 7591 fields Patchy reads; anything else a client sends is ignored. */
const decodeRegistration = Schema.decodeUnknownEffect(
  Schema.Struct({
    redirect_uris: Schema.NonEmptyArray(Schema.String),
    client_name: Schema.optional(Schema.String),
    token_endpoint_auth_method: Schema.optional(Schema.String)
  })
);

const CodeRow = Schema.Struct({
  clientId: Schema.String,
  clientName: Schema.String,
  userId: Schema.String,
  redirectUri: Schema.String,
  codeChallenge: Schema.String,
  expiresAt: Schema.Date,
  consumed: Schema.Boolean,
  agentsEnabled: Schema.Boolean,
  companyName: Schema.String
});

const encodeRedirectUris = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const insertClient = SqlSchema.findOne({
  Request: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    redirectUris: Schema.String,
    now: Schema.Number
  }),
  Result: Client,
  execute: Effect.fn("OAuth.insertClient")(function* ({ id, name, redirectUris, now }) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`
      INSERT INTO oauth_clients (id, name, redirect_uris, created_at)
      VALUES (${id}, ${name}, ${redirectUris}::jsonb, to_timestamp(${now / 1_000}))
      RETURNING id, name, redirect_uris AS "redirectUris", created_at AS "createdAt"`;
  })
});

const clientById = SqlSchema.findOneOption({
  Request: Schema.String,
  Result: Client,
  execute: Effect.fn("OAuth.clientById")(function* (id) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`
      SELECT id, name, redirect_uris AS "redirectUris", created_at AS "createdAt"
      FROM oauth_clients WHERE id = ${id}`;
  })
});

// The code, its client and the company's switch in one read, locked so one exchange wins.
const lockCode = SqlSchema.findOneOption({
  Request: Schema.String,
  Result: CodeRow,
  execute: Effect.fn("OAuth.lockCode")(function* (hash) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`
      SELECT o.client_id AS "clientId", cl.name AS "clientName", o.user_id AS "userId",
        o.redirect_uri AS "redirectUri", o.code_challenge AS "codeChallenge",
        o.expires_at AS "expiresAt", o.consumed_at IS NOT NULL AS consumed,
        c.agents_enabled AS "agentsEnabled", c.name AS "companyName"
      FROM oauth_codes o
      JOIN oauth_clients cl ON cl.id = o.client_id
      JOIN users u ON u.id = o.user_id
      JOIN companies c ON c.id = u.company_id
      WHERE o.code_hash = ${hash} FOR UPDATE OF o`;
  })
});

/** Registers a public client; its name defaults and is cut to what a machine name holds. */
export const register = Effect.fn("OAuth.register")(function* (metadata: unknown) {
  const request = yield* decodeRegistration(metadata).pipe(
    Effect.catchTags({
      SchemaError: () =>
        Effect.fail(
          new OAuthRefusal({
            code: "invalid_client_metadata",
            description: "Send redirect_uris as a non-empty array of strings."
          })
        )
    })
  );
  if (
    request.redirect_uris.length > MAX_REDIRECT_URIS ||
    !request.redirect_uris.every(isRedirectUri)
  )
    return yield* new OAuthRefusal({
      code: "invalid_redirect_uri",
      description: `Each redirect URI must be https, or http on localhost, 127.0.0.1 or [::1]; up to ${MAX_REDIRECT_URIS}.`
    });
  const method = request.token_endpoint_auth_method;
  if (method !== undefined && method !== "none")
    return yield* new OAuthRefusal({
      code: "invalid_client_metadata",
      description: "Only public clients register here: token_endpoint_auth_method is none."
    });
  const name = Array.from(request.client_name?.trim() ?? "")
    .slice(0, 64)
    .join("")
    .trim();
  return yield* insertClient({
    id: newInternalId("ocl"),
    name: name === "" ? DEFAULT_CLIENT_NAME : name,
    redirectUris: encodeRedirectUris(request.redirect_uris),
    now: yield* Clock.currentTimeMillis
  }).pipe(Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die }));
});

export const findClient = Effect.fn("OAuth.findClient")((clientId: string) =>
  clientById(clientId).pipe(
    Effect.catchTags({ SchemaError: Effect.die }),
    Effect.map(Option.getOrNull)
  )
);

/** Records an approved request and answers the code the client exchanges; only its hash is kept. */
export const issueCode = Effect.fn("OAuth.issueCode")(function* (input: {
  readonly clientId: string;
  readonly userId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const code = randomToken(32);
  yield* sql`DELETE FROM oauth_codes WHERE expires_at <= to_timestamp(${now / 1_000})`;
  yield* sql`
    INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource,
      expires_at, created_at)
    VALUES (${sha256(code)}, ${input.clientId}, ${input.userId}, ${input.redirectUri},
      ${input.codeChallenge}, ${input.resource}, to_timestamp(${(now + CODE_LIFETIME_MS) / 1_000}),
      to_timestamp(${now / 1_000}))`;
  return code;
});

/**
 * Exchanges a code for a `use` token: the code is unexpired and unused, issued to this client
 * for this redirect URI, the verifier answers its challenge, and the company's agent access is
 * still on. A refusal leaves the code as it was; success consumes it with the mint.
 */
export const redeem = Effect.fn("OAuth.redeem")(function* (input: {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const tokens = yield* MachineTokens.MachineTokens;
  const invalid = (description: string) => new OAuthRefusal({ code: "invalid_grant", description });
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const found = yield* lockCode(sha256(input.code)).pipe(
        Effect.catchTags({ SchemaError: Effect.die })
      );
      if (Option.isNone(found) || found.value.consumed || found.value.expiresAt.getTime() <= now)
        return yield* invalid("The code is unknown, used or expired.");
      const row = found.value;
      if (row.clientId !== input.clientId || row.redirectUri !== input.redirectUri)
        return yield* invalid("The code was issued to another client or redirect URI.");
      const answer = isCodeVerifier(input.codeVerifier)
        ? Buffer.from(sha256(input.codeVerifier), "hex").toString("base64url")
        : null;
      if (answer !== row.codeChallenge)
        return yield* invalid("The code verifier does not match the code challenge.");
      if (!row.agentsEnabled) return yield* invalid(`Agent access is off at ${row.companyName}.`);
      yield* sql`
        UPDATE oauth_codes SET consumed_at = to_timestamp(${now / 1_000})
        WHERE code_hash = ${sha256(input.code)}`;
      const minted = yield* tokens
        .mint({ userId: row.userId, name: row.clientName, oauthClientId: row.clientId })
        .pipe(
          Effect.catchTags({
            UserUnavailable: () =>
              Effect.fail(invalid("The person who approved it is deactivated.")),
            InvalidMachineName: Effect.die
          })
        );
      return {
        token: minted.token,
        expiresInSeconds: Math.floor(
          (DateTime.toEpochMillis(DateTime.makeUnsafe(minted.expiresAt)) - now) / 1_000
        )
      };
    })
  );
});
