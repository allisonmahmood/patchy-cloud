import { assert, describe, it } from "@effect/vitest";
import {
  ADDRESS_LIST_BYTES,
  ADDRESSES,
  encodedBytes,
  PAGE_MESSAGES,
  REFERENCES,
  RESULT_BYTES
} from "./Bounds.js";
import { addresses, messageId, references, summarize, type Fetched } from "./Summary.js";

const folder = { connection: "con_invoices", folder: "INBOX", uidValidity: 7 };
const headers = (text: string) => Buffer.from(text, "latin1");
const attachment = {
  type: "multipart/mixed",
  childNodes: [
    { type: "text/plain", size: 10 },
    {
      type: "application/pdf",
      size: 900,
      disposition: "attachment",
      dispositionParameters: { filename: "a.pdf" }
    }
  ]
};

/** What ImapFlow answers for a typical message. */
const fetched: Fetched = {
  uid: 42,
  envelope: {
    date: new Date("2026-10-30T09:15:00.000Z"),
    subject: "Invoice\u{202E} 1182\r\n for October",
    messageId: " <1182@billing.example.com> ",
    inReplyTo: "<1170@billing.example.com> (from the earlier thread)",
    from: [{ name: "Billing", address: "billing@example.com" }],
    to: [
      { name: "", address: "invoices@example.test" },
      { name: "undisclosed-recipients", address: "" }
    ],
    cc: []
  },
  flags: new Set(["\\Seen", "$Forwarded"]),
  internalDate: new Date("2026-10-30T09:16:02.000Z"),
  size: 48_211,
  bodyStructure: attachment,
  headers: headers("References: <1001@billing.example.com>\r\n <1170@billing.example.com>\r\n\r\n")
};

describe("summarize", () => {
  it("shapes ImapFlow's answer as a patch reads it", () => {
    assert.deepStrictEqual(summarize(fetched, folder), {
      ref: { ...folder, uid: 42 },
      from: [{ name: "Billing", address: "billing@example.com" }],
      to: [{ name: null, address: "invoices@example.test" }],
      cc: [],
      recipientsTruncated: false,
      subject: "Invoice 1182 for October",
      date: "2026-10-30T09:15:00.000Z",
      internalDate: "2026-10-30T09:16:02.000Z",
      size: 48_211,
      flags: ["$Forwarded", "\\Seen"],
      messageId: "<1182@billing.example.com>",
      inReplyTo: "<1170@billing.example.com>",
      references: ["<1001@billing.example.com>", "<1170@billing.example.com>"],
      hasAttachments: true
    });
  });

  it("reads what's missing or unreadable as empty", () => {
    assert.deepStrictEqual(
      summarize(
        {
          uid: 3,
          envelope: { date: "not a date", subject: " \u{200B} " },
          internalDate: "garbage",
          size: -1
        },
        folder
      ),
      {
        ref: { ...folder, uid: 3 },
        from: [],
        to: [],
        cc: [],
        recipientsTruncated: false,
        subject: null,
        date: null,
        internalDate: null,
        size: 0,
        flags: [],
        messageId: null,
        inReplyTo: null,
        references: [],
        hasAttachments: false
      }
    );
    assert.isFalse(summarize({ uid: 4, bodyStructure: { type: 7 } }, folder).hasAttachments);
  });

  it("keeps the most a hostile header can make within a page's share of the result bound", () => {
    const name = "名".repeat(10_000);
    const crowd = Array.from({ length: 5_000 }, (_, index) => ({
      name,
      address: `${"é".repeat(300)}${index}@example.com`
    }));
    const ids = Array.from(
      { length: 5_000 },
      (_, index) => `<${"x".repeat(240)}${index}@example.com>`
    ).join(" ");
    const hostile: Fetched = {
      uid: 4_294_967_295,
      envelope: {
        date: new Date(8.64e15),
        subject: "主".repeat(1_000_000),
        messageId: `<${"m".repeat(250)}@example.com>`,
        inReplyTo: `<${"r".repeat(240)}@x.test>`,
        from: crowd,
        to: crowd,
        cc: crowd,
        replyTo: crowd
      },
      flags: new Set(Array.from({ length: 5_000 }, (_, index) => `$${"F".repeat(60)}${index}`)),
      internalDate: new Date(-8.64e15),
      size: 2 ** 40,
      bodyStructure: attachment,
      headers: headers(`References: ${ids}\r\n`)
    };
    const summary = summarize(hostile, { ...folder, folder: "文".repeat(1024) });
    assert.isAtMost(encodedBytes(summary), RESULT_BYTES / PAGE_MESSAGES);
  });
});

describe("addresses", () => {
  it("leaves out group names, blank and overlong addresses, and cleans names", () => {
    assert.deepStrictEqual(
      addresses([
        { name: "Team", address: "" },
        { name: "  Ada\r\n Lovelace\u{2066} ", address: " ada@example.com " },
        { address: `${"a".repeat(310)}@example.com` },
        { name: "Spaced", address: "two words@example.com" }
      ]),
      { kept: [{ name: "Ada Lovelace", address: "ada@example.com" }], cut: false }
    );
  });

  it("keeps at most ADDRESSES entries and ADDRESS_LIST_BYTES encoded, and says it cut", () => {
    const many = Array.from({ length: 500 }, (_, index) => ({ address: `p${index}@example.com` }));
    const counted = addresses(many);
    assert.lengthOf(counted.kept, ADDRESSES);
    assert.isTrue(counted.cut);
    assert.isFalse(addresses(many.slice(0, ADDRESSES)).cut);
    const long = Array.from({ length: 500 }, (_, index) => ({
      name: "n".repeat(255),
      address: `p${index}@example.com`
    }));
    const sized = addresses(long);
    assert.isBelow(sized.kept.length, ADDRESSES);
    assert.isAtMost(encodedBytes(sized.kept), ADDRESS_LIST_BYTES);
    assert.isTrue(sized.cut);
    assert.deepStrictEqual(sized.kept[0], long[0]);
  });

  it("marks a summary whose From, To, Cc or Reply-To list was cut", () => {
    const crowd = Array.from({ length: ADDRESSES + 1 }, (_, index) => ({
      address: `p${index}@example.com`
    }));
    for (const field of ["from", "to", "cc", "replyTo"] as const)
      assert.isTrue(
        summarize({ uid: 1, envelope: { [field]: crowd } }, folder).recipientsTruncated,
        field
      );
  });
});

describe("Message-IDs", () => {
  it("takes the first bracketed id, and never a cut or overlong one", () => {
    assert.strictEqual(messageId("<a@example.com> <b@example.com>"), "<a@example.com>");
    assert.isNull(messageId("a@example.com"));
    assert.isNull(messageId(`<${"x".repeat(300)}@example.com>`));
    assert.isNull(messageId("<cut@exam"));
    assert.isNull(messageId(undefined));
  });

  it("reads References across folded lines and repeated headers, each id once", () => {
    const answer = headers(
      "References: <1@example.com>\r\n\t<2@example.com> <1@example.com>\r\nreferences:<3@example.com>\r\n\r\n"
    );
    assert.deepStrictEqual(references(answer), [
      "<1@example.com>",
      "<2@example.com>",
      "<3@example.com>"
    ]);
    assert.deepStrictEqual(references(headers("\r\n")), []);
    assert.deepStrictEqual(references(undefined), []);
  });

  it("keeps the thread's first id and its latest past REFERENCES", () => {
    const ids = Array.from({ length: 80 }, (_, index) => `<${index}@example.com>`);
    const kept = references(headers(`References: ${ids.join(" ")}\r\n`));
    assert.lengthOf(kept, REFERENCES);
    assert.strictEqual(kept[0], "<0@example.com>");
    assert.deepStrictEqual(kept.slice(1), ids.slice(80 - REFERENCES + 1));
  });
});
