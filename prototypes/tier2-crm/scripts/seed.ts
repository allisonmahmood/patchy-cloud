// PROTOTYPE for #315: the journey fixtures' one seed. Contacts, contracts and finance rows all
// derive from COMPANIES and a fixed PRNG, and so do the verifier's truth files, so the data the
// fresh agents import and the answers the verifier checks cannot drift apart.
import { deflateSync } from "node:zlib";

/** A deterministic PRNG (mulberry32); the seed is the ticket number. */
export const random = (seed = 315) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Companies with a contract in the shared store and invoices in finance. */
export const COMPANIES = [
  { name: "Acme Robotics", domain: "acmerobotics.example", color: [214, 93, 58] },
  { name: "Blue Harbor Foods", domain: "blueharbor.example", color: [52, 110, 190] },
  { name: "Cobalt Freight", domain: "cobaltfreight.example", color: [40, 60, 150] },
  { name: "Driftwood Studio", domain: "driftwood.example", color: [150, 110, 70] },
  { name: "Evergreen Clinics", domain: "evergreen.example", color: [46, 139, 87] },
  { name: "Fjord Analytics", domain: "fjord.example", color: [90, 150, 170] }
] as const;
/** Companies that appear only in contacts.csv (created by the import) or only in finance. */
export const CSV_ONLY = [
  { name: "Granite Legal", domain: "granitelegal.example" },
  { name: "Halcyon Travel", domain: "halcyon.example" },
  { name: "Ironwood Builders", domain: "ironwood.example" },
  { name: "Juniper Schools", domain: "juniper.example" }
] as const;
/** Finance covers the contract companies and two of the CSV-only ones. */
export const FINANCE_COMPANIES = [
  ...COMPANIES.map((c) => c.name),
  "Granite Legal",
  "Halcyon Travel"
];

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// --- contracts: one PDF and one PNG thumbnail per company ---------------------------------

export const contractPdf = (company: string, revision = 1): Buffer => {
  const lines = [
    `Master services agreement`,
    `${company}`,
    `Revision ${revision}${revision > 1 ? " (countersigned)" : ""}`,
    `Fixture document for the Patchy reference CRM. Not a real contract.`
  ];
  const stream = lines
    .map(
      (line, index) =>
        `BT /F1 ${index === 0 ? 20 : 12} Tf 72 ${720 - index * 28} Td (${line.replace(/[()\\]/g, "")}) Tj ET`
    )
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Buffer) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
/** A 120×160 thumbnail: the company's colour with a white page and ruled lines. */
export const contractPng = (color: readonly [number, number, number], revision = 1): Buffer => {
  const width = 120;
  const height = 160;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const page = x >= 16 && x < 104 && y >= 16 && y < 144;
      const ruled = page && y >= 40 && y < 136 && (y - 40) % 12 < 2 && x >= 26 && x < 94;
      const mark = page && revision > 1 && x >= 70 && x < 94 && y >= 118 && y < 136;
      const [r, g, b] = mark ? [220, 40, 40] : ruled ? color : page ? [255, 255, 255] : color;
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
};
/** What the contracts store holds: `<slug>.pdf` and `<slug>.png` per company. */
export const contractFiles = (revision = 1) =>
  COMPANIES.flatMap((company) => [
    {
      name: `${slug(company.name)}.pdf`,
      contentType: "application/pdf",
      bytes: contractPdf(company.name, revision),
      company: company.name
    },
    {
      name: `${slug(company.name)}.png`,
      contentType: "image/png",
      bytes: contractPng(company.color, revision),
      company: company.name
    }
  ]);

// --- contacts.csv and its truth -------------------------------------------------------------

const FIRST = [
  "Ada",
  "Ben",
  "Carla",
  "Dev",
  "Elena",
  "Farid",
  "Grace",
  "Hiro",
  "Ines",
  "Jonah",
  "Kira",
  "Luis",
  "Maya",
  "Nils",
  "Olga",
  "Priya",
  "Quinn",
  "Rosa",
  "Sami",
  "Tara",
  "Uma",
  "Vik",
  "Wen",
  "Yara",
  "Zane"
];
const LAST = [
  "Okafor",
  "Lindqvist",
  "Moreau",
  "Tanaka",
  "Silva",
  "Haddad",
  "Novak",
  "Reyes",
  "Kowalski",
  "Brennan",
  "Achebe",
  "Duarte",
  "Ivanova",
  "Park",
  "Mensah",
  "Varga",
  "Oduya",
  "Keller",
  "Nakamura",
  "Rossi"
];
const TITLES = [
  "Head of Operations",
  "Procurement Lead",
  "CFO",
  "Office Manager",
  "CTO",
  "Account Manager",
  "Founder",
  "Finance Director",
  "Sales Engineer",
  "COO"
];

export interface CsvRow {
  readonly line: number;
  readonly first_name: string;
  readonly last_name: string;
  readonly email: string;
  readonly company: string;
  readonly title: string;
  readonly phone: string;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 152 data rows: 140 distinct valid, 4 invalid emails, 3 missing companies, 5 duplicates. */
export const contactsCsv = () => {
  const next = random(315);
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  const companies = [...COMPANIES, ...CSV_ONLY];
  const rows: Array<Omit<CsvRow, "line">> = [];
  const used = new Set<string>();
  while (rows.length < 140) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const company = companies[rows.length % companies.length]!;
    const email = `${first}.${last}@${company.domain}`.toLowerCase();
    if (used.has(email)) continue;
    used.add(email);
    rows.push({
      first_name: first,
      last_name: last,
      email,
      company: company.name,
      title: pick(TITLES),
      phone: `+1 555 ${String(100 + Math.floor(next() * 900))} ${String(1000 + Math.floor(next() * 9000))}`
    });
  }
  const bad = [
    {
      first_name: "Noel",
      last_name: "Brandt",
      email: "noel.brandt@",
      company: "Cobalt Freight",
      title: "CFO",
      phone: "+1 555 201 3000"
    },
    {
      first_name: "Iris",
      last_name: "Vale",
      email: "iris.vale.acmerobotics.example",
      company: "Acme Robotics",
      title: "COO",
      phone: "+1 555 202 3000"
    },
    {
      first_name: "Otto",
      last_name: "Kranz",
      email: "otto kranz@fjord.example",
      company: "Fjord Analytics",
      title: "Founder",
      phone: "+1 555 203 3000"
    },
    {
      first_name: "Lena",
      last_name: "Park",
      email: "lena@park",
      company: "Granite Legal",
      title: "Sales Engineer",
      phone: "+1 555 204 3000"
    }
  ];
  const missing = [
    {
      first_name: "Tom",
      last_name: "Adler",
      email: "tom.adler@nowhere.example",
      company: "",
      title: "Founder",
      phone: "+1 555 301 3000"
    },
    {
      first_name: "Sofia",
      last_name: "Berg",
      email: "sofia.berg@nowhere.example",
      company: "  ",
      title: "CTO",
      phone: "+1 555 302 3000"
    },
    {
      first_name: "Ravi",
      last_name: "Iyer",
      email: "ravi.iyer@nowhere.example",
      company: "",
      title: "COO",
      phone: "+1 555 303 3000"
    }
  ];
  // Duplicates of earlier rows: exact, different case, and surrounding whitespace.
  const duplicates = [3, 17, 42, 77, 120].map((index, n) => {
    const original = rows[index]!;
    const email =
      n === 1 ? original.email.toUpperCase() : n === 2 ? ` ${original.email} ` : original.email;
    return { ...original, email, title: "Duplicate entry", first_name: original.first_name };
  });
  // Interleave the malformed rows at fixed places so they are not all at the end.
  const all = [...rows];
  const inserts: Array<[number, Omit<CsvRow, "line">]> = [
    [10, bad[0]!],
    [35, missing[0]!],
    [50, duplicates[0]!],
    [60, bad[1]!],
    [80, duplicates[1]!],
    [95, missing[1]!],
    [100, bad[2]!],
    [110, duplicates[2]!],
    [125, duplicates[3]!],
    [130, bad[3]!],
    [140, missing[2]!],
    [150, duplicates[4]!]
  ];
  for (const [at, row] of inserts) all.splice(at, 0, row);
  const header = "first_name,last_name,email,company,title,phone";
  const quote = (value: string) =>
    /[",\n]/.test(value) || value !== value.trim() ? `"${value.replaceAll('"', '""')}"` : value;
  const csv =
    [
      header,
      ...all.map((row) =>
        [row.first_name, row.last_name, row.email, row.company, row.title, row.phone]
          .map(quote)
          .join(",")
      )
    ].join("\n") + "\n";
  // Truth, under the rules the ticket states.
  const valid: CsvRow[] = [];
  const rejected: Array<{
    line: number;
    email: string;
    company: string;
    reason: "invalid_email" | "missing_company";
  }> = [];
  const skipped: Array<{ line: number; email: string; duplicateOfLine: number }> = [];
  const seen = new Map<string, number>();
  all.forEach((row, index) => {
    const line = index + 2; // the header is line 1
    const email = row.email.trim().toLowerCase();
    if (!EMAIL.test(email))
      return rejected.push({
        line,
        email: row.email,
        company: row.company,
        reason: "invalid_email"
      });
    if (row.company.trim() === "")
      return rejected.push({
        line,
        email: row.email,
        company: row.company,
        reason: "missing_company"
      });
    const first = seen.get(email);
    if (first !== undefined)
      return skipped.push({ line, email: row.email, duplicateOfLine: first });
    seen.set(email, line);
    valid.push({ line, ...row, email });
  });
  const companiesInFile = [...new Set(valid.map((row) => row.company))].sort();
  return {
    csv,
    truth: {
      rules: {
        email: "trimmed and lower-cased, then must match local@domain.tld with no spaces",
        company:
          "required after trimming; a company the CRM does not have is created, owned by the importer",
        duplicates:
          "the same normalised email earlier in the file, or already on an existing contact, is skipped (not an error)",
        owner: "every imported contact and created company is owned by the importer"
      },
      dataRows: all.length,
      valid: valid.length,
      rejectedCount: rejected.length,
      skippedCount: skipped.length,
      rejected,
      skipped,
      companiesInFile,
      companiesCreatedOnEmptyCrm: companiesInFile,
      rows: valid,
      againstExisting:
        "Importing the same file a second time skips all valid rows as duplicates of existing contacts and rejects the same rows again."
    }
  };
};

// --- finance -------------------------------------------------------------------------------

export interface Invoice {
  readonly invoice_number: string;
  readonly company_name: string;
  readonly issued_on: string;
  readonly due_on: string;
  readonly amount_cents: number;
}
export interface Payment {
  readonly invoice_number: string;
  readonly paid_on: string;
  readonly amount_cents: number;
}
export const finance = () => {
  const next = random(2026);
  const invoices: Invoice[] = [];
  const payments: Payment[] = [];
  let number = 1000;
  for (const company of FINANCE_COMPANIES) {
    const count = 3 + Math.floor(next() * 5);
    for (let i = 0; i < count; i++) {
      const month = 1 + ((i * 2 + Math.floor(next() * 2)) % 9);
      const issued = `2026-${String(month).padStart(2, "0")}-${String(1 + Math.floor(next() * 27)).padStart(2, "0")}`;
      const due = `2026-${String(month + 1).padStart(2, "0")}-${issued.slice(8)}`;
      const amount = (500 + Math.floor(next() * 9500)) * 100 + Math.floor(next() * 100);
      const invoice = {
        invoice_number: `INV-${++number}`,
        company_name: company,
        issued_on: issued,
        due_on: due,
        amount_cents: amount
      };
      invoices.push(invoice);
      const roll = next();
      if (roll < 0.55)
        payments.push({
          invoice_number: invoice.invoice_number,
          paid_on: due,
          amount_cents: amount
        });
      else if (roll < 0.8) {
        const first = Math.floor(amount * (0.3 + next() * 0.4));
        payments.push({
          invoice_number: invoice.invoice_number,
          paid_on: due,
          amount_cents: first
        });
      }
    }
  }
  const totals = Object.fromEntries(
    [
      ...FINANCE_COMPANIES,
      ...CSV_ONLY.map((c) => c.name).filter((name) => !FINANCE_COMPANIES.includes(name))
    ].map((company) => {
      const own = invoices.filter((invoice) => invoice.company_name === company);
      const invoiced = own.reduce((sum, invoice) => sum + invoice.amount_cents, 0);
      const paid = payments
        .filter((payment) =>
          own.some((invoice) => invoice.invoice_number === payment.invoice_number)
        )
        .reduce((sum, payment) => sum + payment.amount_cents, 0);
      return [
        company,
        {
          invoices: own.length,
          invoicedCents: invoiced,
          paidCents: paid,
          outstandingCents: invoiced - paid
        }
      ];
    })
  );
  return { invoices, payments, truth: { currency: "USD", unit: "cents", byCompany: totals } };
};
