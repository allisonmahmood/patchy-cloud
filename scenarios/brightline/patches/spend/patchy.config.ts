import { defineConfig, files, members, table, t } from "patchy/config";

export default defineConfig({
  name: "spend",
  tier: 2,
  tables: {
    requests: table(
      "One spend request per id. requester asked for the money; approver decided it; paidBy marked it paid. amountCents is integer USD cents. status is submitted, approved, rejected or paid. project is a client name or Studio for internal spend. receipt is the object key in the receipts store. submittedAt, decidedAt and paidAt are when those steps happened.",
      {
        title: t.text(),
        project: t.text(),
        category: t.text(),
        amountCents: t.integer(),
        status: t.text(),
        requester: t.member(),
        approver: t.member().optional(),
        paidBy: t.member().optional(),
        decisionNote: t.text().optional(),
        receipt: t.text().optional(),
        submittedAt: t.timestamp(),
        decidedAt: t.timestamp().optional(),
        paidAt: t.timestamp().optional()
      },
      { indexes: { bySubmitted: ["submittedAt"] } }
    ),
    events: table(
      "One audit-trail entry per id for a spend request. request links the request; kind is submitted, approved, rejected, paid or note; actor is the member who acted; at is when it happened.",
      {
        request: t.ref("requests"),
        kind: t.text(),
        actor: t.member(),
        note: t.text().optional(),
        at: t.timestamp()
      }
    ),
    receiptFiles: table(
      "One receipt or quote adopted by the submit action, before a request uses it. name is its key in the receipts store; uploader attached it; request links the request that claimed it, null until then.",
      {
        name: t.text(),
        uploader: t.member(),
        request: t.ref("requests").optional()
      },
      { indexes: { byName: { columns: ["name"], unique: true } } }
    )
  },
  files: {
    receipts: files(
      "Receipts and quotes for spend requests, keyed by <uploader id>/<random id>/<original file name> (samples/<name>.svg for sample data). PDF, PNG, JPEG or WEBP up to 10 MB; sample receipts are SVG."
    )
  },
  uses: { members: members() }
});
