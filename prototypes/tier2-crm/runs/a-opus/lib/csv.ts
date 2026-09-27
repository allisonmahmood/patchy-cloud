/**
 * Parses RFC 4180-style CSV: quoted fields, doubled quotes, commas and newlines inside quotes,
 * CRLF or LF line ends. Returns every record as an array of raw (untrimmed) fields; blank lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  record.push(field);
  if (record.some((value) => value !== "")) records.push(record);
  return records;
}
