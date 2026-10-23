import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { SetupLinks } from "@patchy/auth";
import { FrontDoor } from "@patchy/sdk";

/**
 * The front door's setup-line hook, from Auth's setup links: a live line's fetch stamps "picked
 * up" and its first one is reported. Any failure answers false, so llms.txt stays the plain page.
 */
export const layer = Layer.effect(
  FrontDoor.SetupPickup,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const analytics = yield* Analytics.Analytics;
    return FrontDoor.SetupPickup.of({
      pickUp: (value) => {
        const link = SetupLinks.parse(value);
        if (link === null) return Effect.succeed(false);
        return SetupLinks.pickUp(link).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.tap((found) =>
            Option.isSome(found) && found.value.first
              ? analytics.track({
                  name: "setup.picked_up",
                  principalId: found.value.userId,
                  companyId: found.value.companyId,
                  properties: { setupId: found.value.setupId }
                })
              : Effect.void
          ),
          Effect.map(Option.isSome),
          Effect.catchCause(() => Effect.succeed(false))
        );
      }
    });
  })
);
