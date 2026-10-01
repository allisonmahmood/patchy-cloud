// Spend rules and vocabulary shared by the page and the server handlers.
// Browser-safe: no server imports here.

export const categories = [
  "Software",
  "Freelancer",
  "Travel",
  "Production",
  "Equipment",
  "Other"
] as const;
export type Category = (typeof categories)[number];

export const statuses = ["submitted", "approved", "rejected", "paid"] as const;
export type Status = (typeof statuses)[number];

export const eventKinds = ["submitted", "approved", "rejected", "paid", "note"] as const;
export type EventKind = (typeof eventKinds)[number];

/** Requests at or above this amount must carry a receipt or quote. */
export const receiptRequiredCents = 500_00;
/** Requests at or above this amount can only be approved by a company admin. */
export const adminApprovalCents = 2_500_00;
/** Upper bound for a single request, mostly to catch typos. */
export const maxAmountCents = 1_000_000_00;

export const receiptTypes = {
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPG",
  "image/webp": "WEBP"
} as const;
export const maxReceiptBytes = 10 * 1024 * 1024;

export const projectSuggestions = [
  "Studio",
  "Atlas Outdoor Co.",
  "Fieldnote Press",
  "Harbor & Pine Coffee",
  "Kestrel Health",
  "Lumen Labs",
  "Mosaic Credit Union",
  "Northline Bikes",
  "Parkside Dental Group",
  "Saltwater Hotels",
  "Verdant Grocers"
] as const;

/** Every refusal a handler can send, with the words the person sees. */
export const refusals = {
  missing_title: "Give the request a short title.",
  missing_project: "Say which client or project this is for, or choose Studio.",
  invalid_amount: "Enter an amount above $0 and below $1,000,000.",
  receipt_required: "Attach a receipt or quote for requests of $500 or more.",
  receipt_type: "Receipts must be a PDF, PNG, JPG or WEBP file.",
  receipt_too_large: "That file is over 10 MB. Attach a smaller copy.",
  receipt_unavailable: "That receipt can't be used. Attach the file again.",
  not_saved: "Your receipt was uploaded, but the request wasn't saved.",
  request_missing: "This request no longer exists.",
  own_approval: "You can't approve your own request.",
  own_rejection: "You can't reject your own request. Ask a teammate to review it.",
  admin_required: "Requests of $2,500 or more need an admin to approve.",
  note_required: "Add a note explaining why you're rejecting this request.",
  note_too_long: "Keep notes under 1,000 characters.",
  empty_note: "Write something before posting a note.",
  admins_only: "Only admins can mark requests as paid.",
  not_submitted: "This request has already been decided.",
  not_approved: "Only approved requests can be marked as paid.",
  not_empty: "Sample data can only be loaded into an empty tool."
} as const;
export type Refusal = keyof typeof refusals;

export interface RequestInput {
  readonly title: string;
  readonly project: string;
  readonly amountCents: number;
}

/** The first rule a new request breaks, or null when it may be submitted. */
export function checkRequest(input: RequestInput, hasReceipt: boolean): Refusal | null {
  const title = input.title.trim();
  if (title.length < 3 || title.length > 120) return "missing_title";
  const project = input.project.trim();
  if (project.length < 1 || project.length > 80) return "missing_project";
  if (
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    input.amountCents >= maxAmountCents
  )
    return "invalid_amount";
  if (input.amountCents >= receiptRequiredCents && !hasReceipt) return "receipt_required";
  return null;
}

/** Reasons a receipt file is refused before it is stored, by claimed type and measured size. */
export function checkReceipt(contentType: string, size: number): Refusal | null {
  if (!(contentType in receiptTypes)) return "receipt_type";
  if (size > maxReceiptBytes) return "receipt_too_large";
  return null;
}

/** A store-safe version of a person's file name: one segment, no dot segments. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[/\\]+/g, "-")
    .replace(/[^\p{L}\p{N} ._()&-]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-120);
  return cleaned === "" || /^\.+$/.test(cleaned) ? "receipt" : cleaned;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

/** "$1,264.80" — exact amounts for tables, receipts and exports. */
export const formatMoney = (cents: number) => usd.format(cents / 100);
/** "$12,480" — rounded totals for summary tiles. */
export const formatMoneyWhole = (cents: number) => usdWhole.format(Math.round(cents / 100));
