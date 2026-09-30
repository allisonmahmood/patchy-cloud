import { csvLimits } from "@patchy/api/csv-config";
import Papa from "papaparse";

export type CsvErrorCode =
  "unterminated_quote" | "invalid_quotes" | "duplicate_header" | "limit_exceeded";

export class CsvError extends Error {
  override readonly name = "CsvError";
  readonly line?: number;
  readonly limitId?: "csv.characters" | "csv.cells";
  readonly value?: number;

  constructor(
    readonly code: CsvErrorCode,
    message: string,
    details: Pick<CsvError, "line" | "limitId" | "value"> = {}
  ) {
    super(message);
    Object.assign(this, details);
  }
}

export interface CsvRowError {
  readonly line: number;
  readonly expected: number;
  readonly actual: number;
}

export interface CsvRecords {
  headers: string[];
  records: Record<string, string>[];
  errors: CsvRowError[];
}

const readRows = (text: string, row: (fields: string[], line: number) => void): void => {
  if (text.length > csvLimits.characters)
    throw new CsvError("limit_exceeded", "CSV input exceeds the character limit.", {
      limitId: "csv.characters",
      value: csvLimits.characters
    });
  // A BOM is an encoding marker only at the start of the input, not of every row.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let rowStart = 0;
  let rowLine = 1;
  let line = 1;
  let quoteLine = 1;
  let cells = 0;
  let fieldStart = true;
  let quoted = false;
  let afterQuote = false;
  const parser = new Papa.Parser({ delimiter: ",", newline: "\n", fastMode: false });
  const cell = () => {
    if (++cells > csvLimits.cells)
      throw new CsvError("limit_exceeded", `CSV input exceeds the cell limit at line ${rowLine}.`, {
        line: rowLine,
        limitId: "csv.cells",
        value: csvLimits.cells
      });
  };
  const emit = (end: number) => {
    if (rowStart === end) return;
    const result = parser.parse(text.slice(rowStart, end), 0, false) as Papa.ParseResult<string[]>;
    const error = result.errors.find((error) => error.code === "MissingQuotes") ?? result.errors[0];
    if (error) {
      const code = error.code === "MissingQuotes" ? "unterminated_quote" : "invalid_quotes";
      throw new CsvError(code, `Invalid CSV quoted field at line ${quoteLine}.`, {
        line: quoteLine
      });
    }
    row(result.data[0]!, rowLine);
  };
  // Frame logical rows before asking Papa to materialize their cells. A step callback
  // alone runs too late to bound one very wide row. This scan also keeps physical lines
  // and mixed LF/CRLF separators without rewriting newlines inside quoted fields.
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const newline = char === "\r" || char === "\n";
    if (index === rowStart && !newline) cell();
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          index++;
          continue;
        }
        quoted = false;
        afterQuote = true;
      }
    } else if (newline) {
      emit(index);
      fieldStart = true;
      afterQuote = false;
    } else if (char === ",") {
      cell();
      fieldStart = true;
      afterQuote = false;
    } else if (fieldStart && char === '"') {
      quoted = true;
      quoteLine = line;
      fieldStart = false;
    } else {
      if (afterQuote && char !== " " && char !== "\t")
        throw new CsvError("invalid_quotes", `Invalid CSV quoted field at line ${quoteLine}.`, {
          line: quoteLine
        });
      fieldStart = false;
    }
    if (newline) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      line++;
      if (!quoted) {
        rowStart = index + 1;
        rowLine = line;
      }
    }
  }
  if (quoted)
    throw new CsvError(
      "unterminated_quote",
      `Unterminated CSV quoted field at line ${quoteLine}.`,
      {
        line: quoteLine
      }
    );
  emit(text.length);
};

/** Parse comma-separated text without trimming or converting cells. Empty physical lines are skipped. */
export const parse = (text: string): string[][] => {
  const rows: string[][] = [];
  readRows(text, (fields) => rows.push(fields));
  return rows;
};

/** Read the first nonempty physical row as headers; omit and report rows with the wrong width. */
export const records = (text: string): CsvRecords => {
  const result: CsvRecords = { headers: [], records: [], errors: [] };
  let headers: string[] | undefined;
  readRows(text, (fields, line) => {
    if (headers === undefined) {
      const seen = new Set<string>();
      for (const header of fields) {
        if (seen.has(header))
          throw new CsvError(
            "duplicate_header",
            `Duplicate CSV header ${JSON.stringify(header)} at line ${line}.`,
            { line }
          );
        seen.add(header);
      }
      headers = fields;
      result.headers = fields;
    } else if (fields.length !== headers.length) {
      result.errors.push({ line, expected: headers.length, actual: fields.length });
    } else {
      const record: Record<string, string> = {};
      for (let index = 0; index < headers.length; index++) {
        // Headers such as __proto__ are data, not inherited setters.
        Object.defineProperty(record, headers[index]!, {
          value: fields[index]!,
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
      result.records.push(record);
    }
  });
  return result;
};

/** Write CRLF-separated CSV. Formula protection changes text cells and is not lossless. */
export const stringify = (
  rows: readonly (readonly (string | number)[])[],
  options: { formulaProtection?: boolean } = {}
): string =>
  Papa.unparse(rows as (string | number)[][], {
    delimiter: ",",
    newline: "\r\n",
    // Preserve a one-cell empty row rather than writing a skipped physical line.
    quotes: (value) => value === "",
    escapeFormulae: options.formulaProtection === false ? false : /^[=+\-@\t\r]/
  });
