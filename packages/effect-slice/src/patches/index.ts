/** The patches capability: find a draft's current version, record a visit. */
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

export { patchMigrations } from "./migrations.js";

export class ServedDraft extends Schema.Class<ServedDraft>("ServedDraft")({
  draftId: Schema.String,
  title: Schema.String,
  versionNumber: Schema.Int,
  objectKey: Schema.String
}) {}

export class Patches extends Context.Service<
  Patches,
  {
    findCurrent(draftId: string): Effect.Effect<Option.Option<ServedDraft>, SqlError>;
    recordVisit(draftId: string): Effect.Effect<void, SqlError>;
  }
>()("@patchy/effect-slice/patches/index/Patches") {
  static readonly layer = Layer.effect(
    Patches,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findCurrent = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: ServedDraft,
        execute: (draftId) => sql`
          SELECT d.id AS "draftId", d.title, v.version_number AS "versionNumber", v.object_key AS "objectKey"
          FROM drafts d JOIN draft_versions v ON v.id = d.current_version_id
          WHERE d.id = ${draftId}`
      });

      // Reads the Effect clock, so TestClock drives the stored timestamp.
      const recordVisit = Effect.fn("Patches.recordVisit")(function* (draftId: string) {
        const now = yield* DateTime.now;
        yield* sql`UPDATE drafts SET last_visited_at = ${DateTime.toDate(now)} WHERE id = ${draftId}`;
      });

      return Patches.of({
        findCurrent: (draftId) =>
          findCurrent(draftId).pipe(Effect.catchTags({ SchemaError: Effect.die })),
        recordVisit
      });
    })
  );
}
