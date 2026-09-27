// Server-only ownership and visibility rules; imported by server/*.ts, never by the page.
import type { QueryTables, Viewer } from "patchy/server";
import type config from "../patchy.config.js";
import { HandlerError } from "../patchy/_generated/server.js";

export type Tables = QueryTables<typeof config>;
type Deal = Awaited<ReturnType<Tables["deals"]["get"]>>;

/** Only a record's owner may edit, hand over or delete it. */
export function assertOwner(
  record: { readonly ownerId: string } | null,
  viewer: Viewer
): asserts record is NonNullable<typeof record> {
  if (record === null) throw new HandlerError("not_found");
  if (record.ownerId !== viewer.user.id) throw new HandlerError("not_owner");
}

/** A private deal exists only for its owner: to anyone else it is indistinguishable from a missing one. */
export const canSee = (deal: NonNullable<Deal>, viewer: Viewer) =>
  !deal.private || deal.ownerId === viewer.user.id;

/** The deal if this viewer may see it, otherwise `not_found`. */
export async function visibleDeal(tables: Tables, viewer: Viewer, id: NonNullable<Deal>["id"]) {
  const deal = await tables.deals.get(id);
  if (deal === null || !canSee(deal, viewer)) throw new HandlerError("not_found");
  return deal;
}

/** The teammate a record is being handed to, as recorded when they last opened the CRM. */
export async function member(tables: Tables, userId: string) {
  const { rows } = await tables.members.list({ index: "byUser", eq: { userId }, limit: 1 });
  if (rows[0] === undefined) throw new HandlerError("unknown_member");
  return rows[0];
}

/** Every row of an unfiltered listing, page by page. For small team tables only. */
export async function all<R>(
  page: (cursor: string | undefined) => Promise<{ rows: readonly R[]; cursor: string | null }>
) {
  const rows: R[] = [];
  let cursor: string | undefined;
  do {
    const next = await page(cursor);
    rows.push(...next.rows);
    cursor = next.cursor ?? undefined;
  } while (cursor !== undefined);
  return rows;
}
