// Pipeline vocabulary and stage rules shared by the page and the server handlers.
// Browser-safe: no server imports.

export const STAGES = ["lead", "discovery", "proposal", "negotiation", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];

/** The board's left-to-right columns; Lost sits apart as a secondary column. */
export const BOARD_STAGES = ["lead", "discovery", "proposal", "negotiation", "won"] as const;
export const OPEN_STAGES = ["lead", "discovery", "proposal", "negotiation"] as const;

export const STAGE_LABELS: Record<Stage, string> = {
  lead: "Lead",
  discovery: "Discovery",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost"
};

/** Win probability per open stage, used for the weighted forecast. */
export const STAGE_ODDS: Record<OpenStage, number> = {
  lead: 0.1,
  discovery: 0.25,
  proposal: 0.5,
  negotiation: 0.75
};

export const SERVICES = [
  "Brand identity",
  "Website",
  "Campaign",
  "Content",
  "Product design"
] as const;
export type Service = (typeof SERVICES)[number];

export const SOURCES = ["Referral", "Inbound", "Outbound", "Existing client"] as const;
export type Source = (typeof SOURCES)[number];

export type OpenStage = (typeof OPEN_STAGES)[number];

export const isStage = (value: string): value is Stage =>
  (STAGES as readonly string[]).includes(value);
export const isOpen = (stage: string): stage is OpenStage =>
  (OPEN_STAGES as readonly string[]).includes(stage);
export const isClosed = (stage: string) => stage === "won" || stage === "lost";

/** Rule 1: these stages need a value above zero and an owner before a deal may enter them. */
export const COMMITTED_STAGES: readonly Stage[] = ["proposal", "negotiation", "won"];

export type Requirement = "value" | "owner";

/** What a deal still lacks before it may sit in `stage` (empty when nothing is missing). */
export function missingFor(
  stage: string,
  deal: { readonly value: number | null; readonly owner: string | null }
): Requirement[] {
  if (!COMMITTED_STAGES.includes(stage as Stage)) return [];
  const missing: Requirement[] = [];
  if (deal.value === null || deal.value <= 0) missing.push("value");
  if (deal.owner === null) missing.push("owner");
  return missing;
}

/** Rule 2: entering or leaving Won/Lost is reserved for the owner or a company admin. */
export const needsOwnerOrAdmin = (from: string, to: string) => isClosed(from) || isClosed(to);

/** Rule 3: marking a deal lost needs one of these reasons; it shows on the card and timeline. */
export const LOST_REASONS = [
  "Budget",
  "Timing",
  "Chose another agency",
  "No response",
  "Other"
] as const;
export type LostReason = (typeof LOST_REASONS)[number];

/** Expected close dates are stored as calendar dates. */
export const isIsoDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

export const MAX_TEXT = 200;
export const MAX_NOTE = 2000;
export const MAX_VALUE = 100_000_000;
export const MAX_IMPORT_ROWS = 500;
