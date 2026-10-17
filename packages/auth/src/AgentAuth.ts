/**
 * The MCP door's bearer check. An agent connected through OAuth holds a `use` machine token and
 * acts as the person who connected it; the door opens while that token is live, the person is
 * active and their company's agent access is on. Every other bearer, `build` tokens included,
 * is refused as unknown. Turning agent access off refuses connected agents without revoking
 * them, so turning it back on restores them.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as WideEvents from "@patchy/analytics/wide-events";
import type { Identity } from "@patchy/api";
import { Companies, Users } from "@patchy/companies";
import * as Bearer from "./Bearer.js";
import * as MachineTokens from "./MachineTokens.js";

export class AgentUnauthorized extends Schema.TaggedError<AgentUnauthorized>()(
  "AgentUnauthorized",
  {}
) {
  override get message() {
    return "Missing or invalid agent token.";
  }
}

/** The token is good but its company has agent access off; its admins can turn it on. */
export class AgentsDisabled extends Schema.TaggedError<AgentsDisabled>()("AgentsDisabled", {
  companyName: Schema.String,
  admins: Schema.Array(Schema.Struct({ name: Schema.String, email: Schema.String }))
}) {
  override get message() {
    return `Agent access is off at ${this.companyName}.`;
  }
}

/** Who an agent acts as: the person, their company and role, and the connection as the machine. */
export interface AgentPrincipal {
  readonly identity: Identity;
}

/** The `WWW-Authenticate` value of the door's 401: where an MCP client learns to connect. */
export const wwwAuthenticate = (publicBaseUrl: string) =>
  `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource/mcp"`;

/** The company's active admins, who can turn agent access on. */
export const companyAdmins = Effect.fn("AgentAuth.companyAdmins")(function* (companyId: string) {
  const people = yield* (yield* Users.Users).list(companyId);
  return people
    .filter((user) => user.role === "admin" && user.deactivatedAt === null)
    .map((user) => ({ name: user.name, email: user.email }));
});

export class AgentAuth extends Context.Service<
  AgentAuth,
  {
    /** Reads the request's `Authorization` header as `Bearer.parse` does. */
    readonly authenticate: (
      authorization: string | undefined
    ) => Effect.Effect<AgentPrincipal, AgentUnauthorized | AgentsDisabled>;
  }
>()("@patchy/auth/AgentAuth") {}

export const make = Effect.gen(function* () {
  const tokens = yield* MachineTokens.MachineTokens;
  const companies = yield* Companies.Companies;
  const users = yield* Users.Users;

  const authenticate = Effect.fn("AgentAuth.authenticate")(
    function* (authorization: string | undefined) {
      const credential = Bearer.parse(authorization);
      if (credential.kind !== "bearer") return yield* new AgentUnauthorized({});
      const identity = yield* tokens.authenticate(credential.token, "use");
      if (identity === null) return yield* new AgentUnauthorized({});
      yield* WideEvents.enrich({ viewerId: identity.user.id, companyId: identity.company.id });
      const company = yield* companies.findById(identity.company.id);
      if (company === null) return yield* new AgentUnauthorized({});
      if (!company.agentsEnabled)
        return yield* new AgentsDisabled({
          companyName: company.name,
          admins: yield* companyAdmins(company.id).pipe(Effect.provideService(Users.Users, users))
        });
      return { identity };
    },
    // A database failure is a defect, never an answer that looks like a bad token.
    Effect.catchTags({ SqlError: Effect.die })
  );

  return AgentAuth.of({ authenticate });
});

export const layer = Layer.effect(AgentAuth, make);
