// Rules shared by the server handlers and the page. Keep this file free of browser or server-only imports.

export const STAGES = ["Lead", "Qualified", "Proposal", "Won", "Lost"] as const;
export type Stage = (typeof STAGES)[number];
export const OPEN_STAGES = ["Lead", "Qualified", "Proposal"] as const satisfies readonly Stage[];

/** Emails are compared trimmed and lower-case, so " A@B.example " and "a@b.example" are the same person. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** One local part, one @, a dotted domain, no spaces. */
export const isValidEmail = (email: string) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);

/** Company names match case-insensitively and ignoring surrounding and repeated spaces. */
export const companyKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** The contracts tool's file slug: "Acme Robotics" -> "acme-robotics". */
export const companySlug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const formatDollars = (cents: number) =>
  (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2
  });

/**
 * RFC 4180 CSV: quoted fields may hold commas, doubled quotes and newlines. Returns each record
 * with the 1-based line it started on, so import problems can point at the file.
 */
export function parseCsv(text: string): { line: number; fields: string[] }[] {
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const endRecord = () => {
    fields.push(field);
    if (fields.length > 1 || fields[0] !== "") records.push({ line: start, fields });
    fields = [];
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((field += '"'), i++);
      else if (c === '"') quoted = false;
      else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"') quoted = true;
    else if (c === ",") (fields.push(field), (field = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      start = ++line;
    } else field += c;
  }
  if (field !== "" || fields.length > 0) endRecord();
  return records;
}
