import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContactsCsv, CsvError, MAX_CSV_CONTACTS, MAX_CSV_BYTES } from "../lib/csv.ts";

const header = "first_name,last_name,email,company,title,phone";

test("quoted delimiters, escaped quotes and CRLF preserve values and source lines", () => {
  const rows = parseContactsCsv(
    `\ufeff${header}\r\n"Ada, A",Lovelace,ADA@EXAMPLE.COM,"Research, Inc","Account\r\nlead",123\r\n"Grace ""G""",Hopper,grace@example.com,Navy,Admiral,456`
  );
  assert.deepEqual(rows, [
    {
      row: 2,
      firstName: "Ada, A",
      lastName: "Lovelace",
      email: "ada@example.com",
      company: "Research, Inc",
      title: "Account\r\nlead",
      phone: "123"
    },
    {
      row: 4,
      firstName: 'Grace "G"',
      lastName: "Hopper",
      email: "grace@example.com",
      company: "Navy",
      title: "Admiral",
      phone: "456"
    }
  ]);
});

test("blank physical lines do not shift reported source row numbers", () => {
  const rows = parseContactsCsv(
    `\n${header}\n\nAda,Lovelace,ada@example.com,Analytical,Engineer,\n`
  );
  assert.equal(rows[0].row, 4);
  assert.equal(rows[0].phone, "");
});

test("malformed input after a valid record rejects the whole parse", () => {
  for (const suffix of [
    '"unclosed',
    'bad"quote,x,x,x,x,x',
    '"closed"extra,x,x,x,x,x',
    "one,two,three"
  ]) {
    assert.throws(
      () =>
        parseContactsCsv(
          `${header}\nAda,Lovelace,ada@example.com,Analytical,Engineer,123\n${suffix}`
        ),
      (error) => error instanceof CsvError && error.code === "invalid_csv" && error.row === 3
    );
  }
});

test("headers cannot silently move data into another column", () => {
  assert.throws(
    () =>
      parseContactsCsv("email,first_name,last_name,company,title,phone\na@example.com,A,B,C,D,E"),
    (error) => error instanceof CsvError && error.code === "invalid_csv_header"
  );
});

test("contact and UTF-8 byte limits fail before returning partial rows", () => {
  const line = "Ada,Lovelace,ada@example.com,Analytical,Engineer,123\n";
  assert.equal(
    parseContactsCsv(`${header}\n${line.repeat(MAX_CSV_CONTACTS)}`).length,
    MAX_CSV_CONTACTS
  );
  assert.throws(
    () => parseContactsCsv(`${header}\n${line.repeat(MAX_CSV_CONTACTS + 1)}`),
    (error) => error instanceof CsvError && error.code === "csv_too_large"
  );
  assert.throws(
    () => parseContactsCsv(`${header}\n${"é".repeat(MAX_CSV_BYTES / 2)}`),
    (error) => error instanceof CsvError && error.code === "csv_too_large"
  );
});
