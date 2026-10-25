import * as Schema from "effect/Schema";
import { CommunityIdentifier, DefinitionName } from "./schemas.js";

/** Credentials, company ids and provider connection ids are never operation arguments. */
export const CommunityCall = Schema.Struct({
  connection: DefinitionName,
  action: CommunityIdentifier,
  inputs: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(4096)))
});
export const CommunityResult = Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json });
export const communityOperations = {
  "community.call": {
    request: Schema.Struct({ op: Schema.Literal("community.call"), args: CommunityCall }),
    response: CommunityResult,
    kind: "integration"
  }
} as const;
