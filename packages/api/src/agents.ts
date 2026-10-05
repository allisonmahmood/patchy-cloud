/** Local personal-agent prototype: current handler descriptors, never resource access. */
import * as Schema from "effect/Schema";
import { HandlerDescriptors } from "./handlers.js";
import { ServerCall } from "./runtime.js";

export const AgentIdentity = Schema.Struct({ id: Schema.String, name: Schema.String });
export type AgentIdentity = typeof AgentIdentity.Type;
export const AgentMode = Schema.Literals(["read-only", "actions"]);
export const AgentPatch = Schema.Struct({
  patchId: Schema.String,
  versionId: Schema.String,
  mode: AgentMode,
  handlers: HandlerDescriptors
});
export const AgentCall = Schema.Struct({ versionId: Schema.String, ...ServerCall.fields });

/** Development seed, held by Cloud. Grants follow the patch's current mode. */
export const AgentConnections = Schema.Struct({
  patches: Schema.Array(
    Schema.Struct({
      patchId: Schema.String,
      mode: AgentMode,
      handlers: Schema.Array(Schema.String)
    })
  ),
  grants: Schema.Array(Schema.Struct({ machineId: Schema.String, patchId: Schema.String }))
});
