import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Binding from "../Binding.js";
import * as InvocationCapabilities from "../InvocationCapabilities.js";
import type { Resource } from "../QuerySnapshot.js";

/** Gateway-only fixtures have no SQL resources; snapshot semantics have their own suite. */
export const snapshot: Resource = {
  run: (effect) => effect,
  watermark: {},
  cancel: Effect.void,
  settled: Effect.void,
  destroy: () => {}
};

export const identity = {
  user: { id: "usr_viewer", email: "viewer@example.com", name: "Viewer" },
  company: { id: "cmp_callbacks", handle: "callbacks", name: "Callbacks" },
  admin: false
};
export const binding = Binding.Binding.of({
  companyId: identity.company.id,
  patchId: "callbacktest",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: {},
    handlers: {}
  },
  wireVersion: WIRE_VERSION,
  scope: "company",
  principal: { userId: identity.user.id },
  identity,
  correlationId: "call_initiating"
});
export const issue = Effect.fnUntraced(function* (
  capabilities: InvocationCapabilities.InvocationCapabilities["Service"],
  options: Partial<InvocationCapabilities.Issue> = {}
) {
  const capability = yield* capabilities.issue({
    binding,
    kind: "query",
    attempt: {
      invocationId: "inv_test",
      attemptId: "attempt_one",
      processGeneration: 1,
      deadline: (yield* Clock.currentTimeMillis) + 60_000
    },
    reauthorize: Effect.succeed(identity),
    ...options
  });
  capability.snapshot.value = snapshot;
  return capability;
});
