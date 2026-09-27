import { HandlerError } from "../patchy/_generated/server.js";

export { STAGES, OPEN_STAGES, type Stage } from "./stages.js";

/** Lower-cased, trimmed key used for unique lookups of emails and company names. */
export const keyOf = (value: string) => value.trim().toLowerCase();

/** A plausible address: one @, no spaces, and a dotted domain. */
export const isEmail = (value: string) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);

/** Throws `not_owner` unless the viewer owns the record. The only edit/delete gate. */
export function requireOwner(row: { readonly ownerId: string }, viewerId: string) {
  if (row.ownerId !== viewerId) throw new HandlerError("not_owner");
}

/** A private deal exists only for its owner; everyone else gets the same answer as for a missing deal. */
export const canSee = (
  deal: { readonly private: boolean; readonly ownerId: string },
  viewerId: string
) => !deal.private || deal.ownerId === viewerId;
