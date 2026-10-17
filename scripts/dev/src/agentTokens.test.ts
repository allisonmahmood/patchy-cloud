import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MachineTokens } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import * as Testing from "@patchy/sql/testing";
import { mintAgentToken } from "./agentTokens.js";

it.layer(MachineTokens.layer.pipe(Layer.provideMerge(Testing.layer())))("mcp-token", (it) => {
  it.effect("mints a use token named for the client that replaces its earlier one", () =>
    Effect.gen(function* () {
      const tokens = yield* MachineTokens.MachineTokens;
      const first = yield* mintAgentToken(DEV_SEED.userId, "Codex");
      const second = yield* mintAgentToken(DEV_SEED.userId, "Codex");

      const identity = yield* tokens.authenticate(second.token, "use");
      assert.strictEqual(identity?.machine.name, "Codex");
      assert.strictEqual(identity?.user.id, DEV_SEED.userId);
      assert.isNull(yield* tokens.authenticate(second.token), "a use token opens no build door");
      assert.isNull(yield* tokens.authenticate(first.token, "use"), "reconnecting replaces it");
    })
  );
});
