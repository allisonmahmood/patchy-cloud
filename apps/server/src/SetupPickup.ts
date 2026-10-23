import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { SetupLinks } from "@patchy/auth";
import { Limits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import { FrontDoor } from "@patchy/sdk";

/**
 * The front door's setup-line hook, from Auth's setup links: a live line's fetch stamps "picked
 * up" and its first one is reported. Each address gets a minute's bucket of fetches before any
 * reach the database; past it, and on any failure, the answer is false, so llms.txt stays the plain
 * page.
 */
export const layer = Layer.effect(
  FrontDoor.SetupPickup,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const analytics = yield* Analytics.Analytics;
    const limits = yield* Limits.Limits;
    return FrontDoor.SetupPickup.of({
      pickUp: Effect.fn("SetupPickup.pickUp")(
        function* (value, clientAddress) {
          const link = SetupLinks.parse(value);
          if (link === null) return false;
          const admitted = yield* limits.consume({
            key: `setup-pickup:${Option.getOrElse(clientAddress, () => "")}`,
            limit: registry["rate.setupPickup.perMinute"].default,
            window: "1 minute"
          });
          if (!admitted.allowed) return false;
          const found = yield* SetupLinks.pickUp(link).pipe(
            Effect.provideService(SqlClient.SqlClient, sql)
          );
          if (Option.isSome(found) && found.value.first) {
            yield* analytics.track({
              name: "setup.picked_up",
              principalId: found.value.userId,
              companyId: found.value.companyId,
              properties: { setupId: found.value.setupId }
            });
          }
          return Option.isSome(found);
        },
        Effect.catchCause(() => Effect.succeed(false))
      )
    });
  })
);
