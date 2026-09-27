export const MAX_CSV_BYTES = 512 * 1024;
export const MAX_CSV_CONTACTS = 500;

const headers = ["first_name", "last_name", "email", "company", "title", "phone"] as const;

export class CsvError extends Error {
  readonly code: "csv_too_large" | "invalid_csv" | "invalid_csv_header";
  readonly row: number;

  constructor(code: CsvError["code"], row: number, message: string) {
    super(message);
    this.name = "CsvError";
    this.code = code;
    this.row = row;
  }
}

export type CsvContact = {
  row: number;
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  title: string;
  phone: string;
};

// Parse the entire file before any database writes, including rows after valid ones.
export function parseContactsCsv(csv: string): CsvContact[] {
  if (csv.length > MAX_CSV_BYTES || new TextEncoder().encode(csv).byteLength > MAX_CSV_BYTES) {
    throw new CsvError(
      "csv_too_large",
      1,
      "CSV exceeds the 512 KiB limit. Split it into smaller files."
    );
  }

  const records: CsvContact[] = [];
  let headerSeen = false;
  let fields: string[] = [];
  let field = "";
  let state: "start" | "unquoted" | "quoted" | "closed" = "start";
  let line = 1;
  let row = 1;
  let recordStarted = false;

  function finishRecord() {
    if (!recordStarted && fields.length === 0 && field === "") return;
    fields.push(field);
    if (!headerSeen) {
      if (
        fields.length !== headers.length ||
        fields.some((value, i) => value.trim() !== headers[i])
      ) {
        throw new CsvError("invalid_csv_header", row, `Expected header: ${headers.join(",")}`);
      }
      headerSeen = true;
    } else {
      if (fields.length !== headers.length) {
        throw new CsvError("invalid_csv", row, `Expected 6 columns; found ${fields.length}.`);
      }
      if (records.length >= MAX_CSV_CONTACTS) {
        throw new CsvError(
          "csv_too_large",
          row,
          "CSV exceeds the 500-contact limit. Split it into smaller files."
        );
      }
      records.push({
        row,
        firstName: fields[0]!.trim(),
        lastName: fields[1]!.trim(),
        email: fields[2]!.trim().toLowerCase(),
        company: fields[3]!.trim(),
        title: fields[4]!.trim(),
        phone: fields[5]!.trim()
      });
    }
    fields = [];
    field = "";
    state = "start";
    recordStarted = false;
  }

  for (let i = csv.charCodeAt(0) === 0xfeff ? 1 : 0; i < csv.length; i++) {
    const character = csv[i]!;
    if (state === "quoted") {
      if (character === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          state = "closed";
        }
      } else if (character === "\r" || character === "\n") {
        field += character;
        if (character === "\r" && csv[i + 1] === "\n") {
          field += "\n";
          i++;
        }
        line++;
      } else {
        field += character;
      }
      continue;
    }

    if (character === ",") {
      fields.push(field);
      field = "";
      state = "start";
      recordStarted = true;
    } else if (character === "\r" || character === "\n") {
      finishRecord();
      if (character === "\r" && csv[i + 1] === "\n") i++;
      line++;
      row = line;
    } else if (character === '"') {
      if (state !== "start") {
        throw new CsvError("invalid_csv", row, `Unexpected quote on line ${line}.`);
      }
      state = "quoted";
      recordStarted = true;
    } else {
      if (state === "closed") {
        throw new CsvError(
          "invalid_csv",
          row,
          `Unexpected text after a closing quote on line ${line}.`
        );
      }
      field += character;
      state = "unquoted";
      recordStarted = true;
    }
  }

  if (state === "quoted") {
    throw new CsvError("invalid_csv", row, "Quoted field is not closed.");
  }
  finishRecord();
  if (!headerSeen) {
    throw new CsvError(
      "invalid_csv_header",
      1,
      `CSV is empty. Expected header: ${headers.join(",")}`
    );
  }
  return records;
}
