/**
 * Auth's own `work` check, run on an instance's database: whether each agent connection's
 * access token still acts as its person. The rollback rehearsal asks it of HEAD's code after the
 * live release has ended credentials, since no route of HEAD's server need take the token.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AgentConnections } from "@patchy/auth";
import { NodeCryptography } from "@patchy/core";
import { layerFromUrl } from "@patchy/sql";

export const agentTokensWork = (databaseUrl: string, tokens: ReadonlyArray<string>) =>
  Effect.forEach(tokens, (token) =>
    AgentConnections.AgentConnections.use((connections) => connections.authenticate(token)).pipe(
      Effect.map((identity) => identity !== null)
    )
  ).pipe(
    Effect.provide(
      AgentConnections.layer.pipe(
        Layer.provide(NodeCryptography.layer),
        Layer.provideMerge(layerFromUrl(Redacted.make(databaseUrl)))
      )
    )
  );
