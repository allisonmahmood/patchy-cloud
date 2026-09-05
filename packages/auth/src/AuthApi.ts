/** The bearer-only auth group: the current identity and self-revocation. */
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { CurrentIdentity, LoggedOut, PatchyApi } from "@patchy/api";
import * as MachineTokens from "./MachineTokens.js";

export const layer = HttpApiBuilder.group(PatchyApi, "auth", (handlers) =>
  Effect.gen(function* () {
    const tokens = yield* MachineTokens.MachineTokens;
    return handlers
      .handle("me", () => CurrentIdentity)
      .handle("logout", () =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const result = yield* tokens
            .revoke(identity.machine.id)
            .pipe(Effect.catchTags({ SqlError: Effect.die, MachineTokenNotFound: Effect.die }));
          return new LoggedOut({ ok: true, alreadyRevoked: result.alreadyRevoked });
        })
      );
  })
);
