export const CSV_MAX_BYTES = 256 * 1024;
export const CSV_MAX_ROWS = 250;

export class CsvError extends Error {
  constructor(
    message: string,
    readonly row?: number
  ) {
    super(row === undefined ? message : `CSV row ${row}: ${message}`);
    this.name = "CsvError";
  }
}

export type CsvRecord = { row: number; cells: string[] };
export type ContactCsvRow = {
  row: number;
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  title: string;
  phone: string;
};

/** Row numbers count CSV records, including the header, not embedded newlines. */
export function parseCsv(input: string): CsvRecord[] {
  if (input.length > CSV_MAX_BYTES || new TextEncoder().encode(input).byteLength > CSV_MAX_BYTES) {
    throw new CsvError("The file exceeds 256 KiB. Split it into smaller files before importing.");
  }

  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let state: "plain" | "quoted" | "closed" = "plain";
  let started = false;

  const finishRecord = () => {
    cells.push(field);
    records.push({ row: records.length + 1, cells });
    if (records.length > CSV_MAX_ROWS + 1) {
      throw new CsvError(
        `The file exceeds ${CSV_MAX_ROWS} contact rows. Split it into smaller files before importing.`
      );
    }
    cells = [];
    field = "";
    state = "plain";
    started = false;
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (state === "quoted") {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          state = "closed";
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === ",") {
      cells.push(field);
      field = "";
      state = "plain";
      started = true;
    } else if (char === "\r" || char === "\n") {
      finishRecord();
      if (char === "\r" && text[index + 1] === "\n") index++;
    } else if (state === "closed") {
      throw new CsvError("Only a comma or newline may follow a closing quote.", records.length + 1);
    } else if (char === '"') {
      if (field !== "") {
        throw new CsvError(
          "A quote must begin a field. Escape quotes inside quoted fields as two quotes.",
          records.length + 1
        );
      }
      state = "quoted";
      started = true;
    } else {
      field += char;
      started = true;
    }
  }

  if (state === "quoted") throw new CsvError("The quoted field is not closed.", records.length + 1);
  if (started || cells.length > 0) finishRecord();
  return records;
}

const columns = ["first_name", "last_name", "email", "company", "title", "phone"] as const;

export function parseContactsCsv(input: string): ContactCsvRow[] {
  const records = parseCsv(input);
  if (records.length === 0)
    throw new CsvError("The file is empty. Include a header and at least one contact row.");
  const header = records[0].cells.map((cell) => cell.trim().toLowerCase());
  if (
    header.length !== columns.length ||
    columns.some((column) => header.filter((cell) => cell === column).length !== 1)
  ) {
    throw new CsvError(
      `The header must contain each of these columns once: ${columns.join(", ")}.`,
      1
    );
  }
  if (records.length === 1) throw new CsvError("The file has a header but no contact rows.");

  const positions = columns.map((column) => header.indexOf(column));
  return records.slice(1).map(({ row, cells }) => {
    if (cells.length !== header.length) {
      throw new CsvError(
        `Expected ${header.length} fields but found ${cells.length}. Quote fields containing commas or newlines.`,
        row
      );
    }
    return {
      row,
      firstName: cells[positions[0]],
      lastName: cells[positions[1]],
      email: cells[positions[2]],
      company: cells[positions[3]],
      title: cells[positions[4]],
      phone: cells[positions[5]]
    };
  });
}
