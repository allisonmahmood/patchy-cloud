/**
 * Consent: how a person's answer to an MCP client becomes an agent connection. `check` holds an
 * authorization request to every rule before anything is shown; `approve` records the person's
 * yes as nothing but a short-lived code for their account; `deny` records nothing; and only the
 * client's `exchange` of the code creates the agent connection, once.
 *
 * Approval and the exchange hold the company's agent access until they commit, so neither acts
 * on an on that an off has already replaced, and an off deletes the codes not yet exchanged in
 * its own transaction. Then the code's row, then the person's: a code is made on the database's
 * clock under the person's row lock, the one Disconnect everything and deactivation stamp under,
 * so a code made at or before that stamp is dead and one made after it is never older than it.
 * A code lasts a minute and is exchanged once. An exchanged code's hash stays as long as its
 * connection does, so a second exchange, however late, ends the connection the first made,
 * committed before it is refused.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Companies } from "@patchy/companies";
import { randomToken, sha256 } from "@patchy/core";
import * as AgentConnections from "./AgentConnections.js";
import * as ClientDocuments from "./ClientDocuments.js";
import { UserUnavailable } from "./MachineTokens.js";
import { publicUrlConfig } from "./Session.js";

const CODE_SECONDS = 60;
/** The parameters a request may send only once; a second copy could mean something else. */
const SINGLE = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "state",
  "scope"
] as const;
/** An S256 challenge: an unpadded base64url SHA-256. */
const CHALLENGE = /^[\w-]{43}$/;
/** RFC 7636's verifier: 43 to 128 unreserved characters. */
const VERIFIER = /^[\w.~-]{43,128}$/;

/**
 * The request breaks a rule its client's document doesn't decide, at `parameter`, so nothing
 * goes back to the client and the person sees why: a parameter sent twice, a response type other
 * than `code`, no S256 PKCE challenge, a resource other than Patchy MCP's door, or a redirect the
 * document doesn't list.
 */
export class AuthorizeRequestRefused extends Schema.TaggedError<AuthorizeRequestRefused>()(
  "AuthorizeRequestRefused",
  {
    parameter: Schema.Literals([
      "response_type",
      "client_id",
      "redirect_uri",
      "code_challenge",
      "code_challenge_method",
      "resource",
      "state",
      "scope"
    ])
  }
) {
  override get message() {
    return `The agent's request can't be answered: check its ${this.parameter}.`;
  }
}

/** Agent access is off at the person's company, so consent issues nothing. */
export class AgentAccessOff extends Schema.TaggedError<AgentAccessOff>()("AgentAccessOff", {
  companyId: Schema.String
}) {
  override get message() {
    return "Agent access is off at this company.";
  }
}

/**
 * The token endpoint answers `invalid_grant`. `reason` is diagnostic, for tests and traces:
 * unknown or cancelled, expired, already exchanged (whose connection this refusal ended), issued to another
 * client or redirect, a verifier that doesn't answer its challenge, agent access off, or the
 * person's credentials ended after it was approved.
 */
export class CodeRefused extends Schema.TaggedError<CodeRefused>()("CodeRefused", {
  reason: Schema.Literals([
    "unknown",
    "expired",
    "replayed",
    "client",
    "redirect_uri",
    "verifier",
    "agent_access_off",
    "ended"
  ])
}) {
  override get message() {
    return "This code is unknown, expired, already exchanged, or was issued for another request.";
  }
}

/** A token request names a resource other than Patchy MCP's door: `invalid_target`. */
export class ResourceRefused extends Schema.TaggedError<ResourceRefused>()("ResourceRefused", {}) {
  override get message() {
    return "Patchy's only resource is its MCP door.";
  }
}

const isResourceRefused = Schema.is(ResourceRefused);

/** A request every rule passed: what consent shows, and what an approval binds its code to. */
export interface ConsentRequest {
  readonly client: ClientDocuments.ClientDocument;
  /** The redirect exactly as requested, a loopback one's port included. */
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | undefined;
}

export class Consents extends Context.Service<
  Consents,
  {
    /**
     * The authorization request in `params`, held to every rule: its own parameters first, then
     * its client's document, fetched only now, and the redirect that document lists. A requested
     * scope is ignored, since `patches` is the only one.
     */
    readonly check: (
      params: URLSearchParams
    ) => Effect.Effect<
      ConsentRequest,
      | AuthorizeRequestRefused
      | ClientDocuments.ClientDocumentRefused
      | ClientDocuments.ClientDocumentUnavailable
      | ClientDocuments.ClientDocumentsBusy
    >;
    /**
     * The person's yes, for the account the page showed: a code for that account, valid for a
     * minute, and where the answer goes with it. Refused while agent access is off.
     */
    readonly approve: (input: {
      readonly request: ConsentRequest;
      readonly userId: string;
      readonly companyId: string;
    }) => Effect.Effect<string, AgentAccessOff | UserUnavailable | SqlError>;
    /** The person's no: where the client hears `access_denied`. Nothing is recorded. */
    readonly deny: (request: ConsentRequest) => string;
    /**
     * The client's code exchange: checks the code, PKCE, the client and `resource`, and the
     * redirect when sent, then connects the client as the code's person.
     */
    readonly exchange: (input: {
      readonly code: string;
      readonly codeVerifier: string;
      readonly clientId: string;
      readonly redirectUri?: string | undefined;
      readonly resource?: string | undefined;
    }) => Effect.Effect<AgentConnections.Connected, CodeRefused | ResourceRefused | SqlError>;
    /** Whether `resource`, when a client names one, is Patchy MCP's door. */
    readonly resourceAllowed: (resource: string) => boolean;
  }
>()("@patchy/auth/Consents") {}

/** Whether `verifier` answers an S256 `challenge`. */
const answers = (verifier: string, challenge: string) =>
  VERIFIER.test(verifier) &&
  Buffer.from(sha256(verifier), "hex").toString("base64url") === challenge;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const companies = yield* Companies.Companies;
  const documents = yield* ClientDocuments.ClientDocuments;
  const connections = yield* AgentConnections.AgentConnections;
  const publicUrl = yield* publicUrlConfig;
  const issuer = publicUrl.origin;
  const door = new URL("/mcp", publicUrl).href;

  const resourceAllowed = (resource: string) => {
    const url = URL.parse(resource);
    return (
      url !== null &&
      url.search === "" &&
      !resource.includes("#") &&
      url.href.replace(/(?<=.)\/$/, "") === door
    );
  };

  const check = Effect.fn("Consents.check")(function* (params: URLSearchParams) {
    const twice = SINGLE.find((name) => params.getAll(name).length > 1);
    if (twice !== undefined) return yield* new AuthorizeRequestRefused({ parameter: twice });
    if (params.get("response_type") !== "code")
      return yield* new AuthorizeRequestRefused({ parameter: "response_type" });
    const codeChallenge = params.get("code_challenge") ?? "";
    if (!CHALLENGE.test(codeChallenge))
      return yield* new AuthorizeRequestRefused({ parameter: "code_challenge" });
    if (params.get("code_challenge_method") !== "S256")
      return yield* new AuthorizeRequestRefused({ parameter: "code_challenge_method" });
    const resource = params.get("resource");
    if (resource !== null && !resourceAllowed(resource))
      return yield* new AuthorizeRequestRefused({ parameter: "resource" });
    const client = yield* documents.load(params.get("client_id") ?? "");
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!ClientDocuments.redirectAllowed(client, redirectUri))
      return yield* new AuthorizeRequestRefused({ parameter: "redirect_uri" });
    return {
      client,
      redirectUri,
      codeChallenge,
      state: params.get("state") ?? undefined
    } satisfies ConsentRequest;
  });

  /** Where an answer goes: the redirect with `params`, the request's state and the issuer. */
  const answer = (request: ConsentRequest, params: Readonly<Record<string, string>>) => {
    const url = new URL(request.redirectUri);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    if (request.state !== undefined) url.searchParams.set("state", request.state);
    url.searchParams.set("iss", issuer);
    return url.href;
  };

  const approve = Effect.fn("Consents.approve")(function* (input: {
    readonly request: ConsentRequest;
    readonly userId: string;
    readonly companyId: string;
  }) {
    const code = `pwc_${randomToken(32)}`;
    // On its own, before any lock is held: an expired code is dead whether or not this runs.
    // An exchanged one stays with its connection, so a replay at any time ends it.
    yield* sql`
      DELETE FROM agent_consents
      WHERE connection_id IS NULL AND expires_at <= clock_timestamp()`;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const on = yield* companies
          .holdAgentAccess(input.companyId)
          .pipe(Effect.catchTags({ CompanyNotFound: Effect.die }));
        if (!on) return yield* new AgentAccessOff({ companyId: input.companyId });
        const users = yield* sql`
          SELECT id FROM users
          WHERE id = ${input.userId} AND company_id = ${input.companyId} AND deactivated_at IS NULL
          FOR SHARE`;
        if (users.length === 0) return yield* new UserUnavailable({ userId: input.userId });
        const { request } = input;
        yield* sql`
          INSERT INTO agent_consents (code_hash, user_id, client_id, client_name, redirect_uri,
            code_challenge, created_at, expires_at)
          VALUES (${sha256(code)}, ${input.userId}, ${request.client.clientId},
            ${request.client.name}, ${request.redirectUri}, ${request.codeChallenge},
            clock_timestamp(), clock_timestamp() + make_interval(secs => ${CODE_SECONDS}))`;
      })
    );
    return answer(input.request, { code });
  });

  const deny = (request: ConsentRequest) =>
    answer(request, {
      error: "access_denied",
      error_description: "The person declined to connect."
    });

  // Unlocked: only the company is needed, to take its lock before the code's.
  const codeCompany = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ companyId: Schema.String }),
    execute: (codeHash) => sql`
      SELECT u.company_id AS "companyId"
      FROM agent_consents c JOIN users u ON u.id = c.user_id WHERE c.code_hash = ${codeHash}`
  });

  const lockCode = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      userId: Schema.String,
      clientId: Schema.String,
      clientName: Schema.String,
      redirectUri: Schema.String,
      codeChallenge: Schema.String,
      connectionId: Schema.NullOr(Schema.String),
      expired: Schema.Boolean
    }),
    execute: (codeHash) => sql`
      SELECT user_id AS "userId", client_id AS "clientId", client_name AS "clientName",
        redirect_uri AS "redirectUri", code_challenge AS "codeChallenge",
        connection_id AS "connectionId", expires_at <= clock_timestamp() AS expired
      FROM agent_consents WHERE code_hash = ${codeHash} FOR UPDATE`
  });

  // Under the person's row lock: whether they are active and their credentials last ended
  // before this code was made, compared on the database's clock at its precision.
  const personLive = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ live: Schema.Boolean }),
    execute: (codeHash) => sql`
      SELECT (u.deactivated_at IS NULL
        AND (u.credentials_ended_at IS NULL OR u.credentials_ended_at < c.created_at)) AS live
      FROM agent_consents c JOIN users u ON u.id = c.user_id
      WHERE c.code_hash = ${codeHash} FOR SHARE OF u`
  });

  const exchange = Effect.fn("Consents.exchange")(function* (input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly clientId: string;
    readonly redirectUri?: string | undefined;
    readonly resource?: string | undefined;
  }) {
    const codeHash = sha256(input.code);
    // A refusal is a value until the transaction commits, so a replay's ending lands first.
    const outcome = yield* sql.withTransaction(
      Effect.gen(function* (): Effect.fn.Return<
        | {
            readonly connected: AgentConnections.Connected;
            readonly userId: string;
            readonly companyId: string;
          }
        | CodeRefused["reason"]
        | ResourceRefused,
        SqlError
      > {
        const company = yield* codeCompany(codeHash).pipe(
          Effect.catchTags({ SchemaError: Effect.die })
        );
        if (Option.isNone(company)) return "unknown";
        const on = yield* companies
          .holdAgentAccess(company.value.companyId)
          .pipe(Effect.catchTags({ CompanyNotFound: Effect.die }));
        const found = yield* lockCode(codeHash).pipe(Effect.catchTags({ SchemaError: Effect.die }));
        // Agent access off deleted it while this waited for the company's lock.
        if (Option.isNone(found)) return "unknown";
        const code = found.value;
        if (code.connectionId !== null) {
          yield* connections
            .disconnect({ id: code.connectionId, userId: code.userId })
            .pipe(Effect.catchTags({ AgentConnectionNotFound: Effect.die }));
          return "replayed";
        }
        if (code.expired) return "expired";
        if (input.clientId !== code.clientId) return "client";
        if (input.redirectUri !== undefined && input.redirectUri !== code.redirectUri)
          return "redirect_uri";
        if (input.resource !== undefined && !resourceAllowed(input.resource))
          return new ResourceRefused();
        if (!answers(input.codeVerifier, code.codeChallenge)) return "verifier";
        if (!on) return "agent_access_off";
        const person = yield* personLive(codeHash).pipe(
          Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die })
        );
        if (!person.live) return "ended";
        const connected = yield* connections
          .create({ userId: code.userId, clientId: code.clientId, clientName: code.clientName })
          .pipe(Effect.catchTags({ UserUnavailable: Effect.die }));
        yield* sql`
          UPDATE agent_consents SET connection_id = ${connected.connection.id}
          WHERE code_hash = ${codeHash}`;
        return { connected, userId: code.userId, companyId: company.value.companyId };
      })
    );
    if (typeof outcome === "string") return yield* new CodeRefused({ reason: outcome });
    if (isResourceRefused(outcome)) return yield* outcome;
    yield* WideEvents.enrich({ viewerId: outcome.userId, companyId: outcome.companyId });
    return outcome.connected;
  });

  return Consents.of({ check, approve, deny, exchange, resourceAllowed });
});

export const layer = Layer.effect(Consents, make);
