// CSV import preview, template and export for the board.
import { CsvError, records, stringify } from "patchy/csv";
import { checkDeal, type DealFields } from "../helpers/dealInput.js";
import { STAGES, STAGE_LABELS, isStage } from "../helpers/pipeline.js";
import { daysSince, isoDate, parseMoney, DAY } from "./format.js";
import type { Deal, Person } from "./types.js";

type Column =
  "client" | "title" | "service" | "value" | "source" | "ownerEmail" | "nextStep" | "expectedClose";

const HEADERS: Record<Column, string> = {
  client: "Client",
  title: "Project",
  service: "Service",
  value: "Value (USD)",
  source: "Source",
  ownerEmail: "Owner email",
  nextStep: "Next step",
  expectedClose: "Expected close"
};

/** Header spellings we accept, compared lowercase with punctuation and spaces removed. */
const ALIASES: Record<string, Column> = {
  client: "client",
  company: "client",
  clientname: "client",
  project: "title",
  projecttitle: "title",
  title: "title",
  service: "service",
  value: "value",
  valueusd: "value",
  budget: "value",
  fee: "value",
  source: "source",
  leadsource: "source",
  owner: "ownerEmail",
  owneremail: "ownerEmail",
  email: "ownerEmail",
  nextstep: "nextStep",
  expectedclose: "expectedClose",
  closedate: "expectedClose",
  expectedclosedate: "expectedClose"
};

const REQUIRED: readonly Column[] = ["client", "title", "service", "source"];

export interface ImportRow {
  readonly index: number;
  readonly client: string;
  readonly title: string;
  readonly service: string;
  readonly valueText: string;
  readonly ownerEmail: string;
  /** Ready to import, or the reason the row will be skipped. */
  readonly result:
    | { readonly ok: true; readonly fields: DealFields; readonly owner: Person | null }
    | { readonly ok: false; readonly problem: string };
}

export type ImportPreview =
  | {
      readonly ok: true;
      readonly rows: readonly ImportRow[];
      readonly malformed: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/** Reads a leads CSV and checks every row exactly as the server will. */
export function previewImport(
  text: string,
  peopleByEmail: ReadonlyMap<string, Person>
): ImportPreview {
  let parsed;
  try {
    parsed = records(text);
  } catch (error) {
    if (error instanceof CsvError)
      return {
        ok: false,
        error:
          error.code === "limit_exceeded"
            ? "That file is too large to import."
            : `The file couldn't be read${error.line === undefined ? "" : ` (line ${error.line})`}. Check for a stray quote mark.`
      };
    throw error;
  }

  const columns = new Map<Column, string>();
  for (const header of parsed.headers) {
    const column = ALIASES[header.toLowerCase().replace(/[^a-z]/g, "")];
    if (column !== undefined && !columns.has(column)) columns.set(column, header);
  }
  const missing = REQUIRED.filter((column) => !columns.has(column));
  if (parsed.headers.length === 0) return { ok: false, error: "That file is empty." };
  if (missing.length > 0)
    return {
      ok: false,
      error: `The file needs ${missing.map((column) => `"${HEADERS[column]}"`).join(", ")} column${missing.length > 1 ? "s" : ""}. Download the template to start from the right layout.`
    };

  const cell = (record: Record<string, string>, column: Column) => {
    const header = columns.get(column);
    return header === undefined ? "" : (record[header] ?? "").trim();
  };

  const rows = parsed.records
    .filter((record) => Object.values(record).some((value) => value.trim() !== ""))
    .map((record, index): ImportRow => {
      const base = {
        index: index + 1,
        client: cell(record, "client"),
        title: cell(record, "title"),
        service: cell(record, "service"),
        valueText: cell(record, "value"),
        ownerEmail: cell(record, "ownerEmail")
      };
      const value = parseMoney(base.valueText);
      if (value === "invalid")
        return {
          ...base,
          result: { ok: false, problem: "Value must be a whole number of dollars." }
        };
      const owner =
        base.ownerEmail === "" ? null : peopleByEmail.get(base.ownerEmail.toLowerCase());
      if (owner === undefined)
        return {
          ...base,
          result: { ok: false, problem: `No active member uses ${base.ownerEmail}.` }
        };
      const checked = checkDeal({
        client: base.client,
        title: base.title,
        service: base.service,
        value,
        source: cell(record, "source"),
        nextStep: cell(record, "nextStep"),
        expectedClose: cell(record, "expectedClose")
      });
      return {
        ...base,
        result: checked.ok
          ? { ok: true, fields: checked.fields, owner }
          : { ok: false, problem: checked.message }
      };
    });

  const malformed = parsed.errors.map(
    (error) =>
      `Line ${error.line} of the file has ${error.actual} cells instead of ${error.expected}, so it was skipped.`
  );
  return { ok: true, rows, malformed };
}

/** A starter file with the expected columns and two example leads. */
export function templateCsv(now: number) {
  return stringify([
    Object.values(HEADERS),
    [
      "Juniper Architects",
      "Website redesign",
      "Website",
      45000,
      "Referral",
      "",
      "Intro call",
      isoDate(now + 60 * DAY)
    ],
    [
      "Halcyon Tea Co.",
      "Packaging refresh",
      "Brand identity",
      30000,
      "Inbound",
      "",
      "Send our capabilities deck",
      ""
    ]
  ]);
}

/** The board as a spreadsheet, ordered by stage then value. */
export function boardCsv(deals: readonly Deal[], people: ReadonlyMap<string, Person>, now: number) {
  const order = (stage: string) => (isStage(stage) ? STAGES.indexOf(stage) : STAGES.length);
  const sorted = [...deals].sort(
    (a, b) => order(a.stage) - order(b.stage) || (b.value ?? 0) - (a.value ?? 0)
  );
  return stringify([
    [
      "Client",
      "Project",
      "Service",
      "Stage",
      "Value (USD)",
      "Owner",
      "Owner email",
      "Source",
      "Next step",
      "Expected close",
      "Days in stage",
      "Opened"
    ],
    ...sorted.map((deal) => {
      const owner = deal.owner === null ? undefined : people.get(deal.owner);
      return [
        deal.client,
        deal.title,
        deal.service,
        isStage(deal.stage) ? STAGE_LABELS[deal.stage] : deal.stage,
        deal.value ?? "",
        owner?.name ?? "",
        owner?.email ?? "",
        deal.source,
        deal.nextStep ?? "",
        deal.expectedClose ?? "",
        daysSince(deal.stageEnteredAt, now),
        isoDate(Date.parse(deal.openedAt))
      ];
    })
  ]);
}
