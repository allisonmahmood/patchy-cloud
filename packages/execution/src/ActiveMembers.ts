import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

/**
 * How many active members a company has: its users not deactivated, never a guest, whose user
 * row belongs to their own company. A claim reads it once, under its company's claim lock and
 * on its own transaction, to size the box. Companies provides it on the platform database.
 */
export class ActiveMembers extends Context.Service<
  ActiveMembers,
  {
    readonly count: (companyId: string) => Effect.Effect<number, SqlError>;
  }
>()("@patchy/execution/ActiveMembers") {}
