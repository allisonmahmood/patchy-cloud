// Compile-only public contract checks: included in the package typecheck, never in its build entries.
import { defineConfig, files, postgres, sharedTable, t, table } from "./config.js";
import type { Id, Insert, Row, Update } from "./config.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const config = defineConfig({
  name: "inference",
  tier: 1,
  tables: {
    notes: table(
      {
        title: t.text(),
        titleOptional: t.text().optional(),
        titleDefault: t.text().default("untitled"),
        count: t.integer(),
        countOptional: t.integer().optional(),
        countDefault: t.integer().default(0),
        score: t.number(),
        scoreOptional: t.number().optional(),
        scoreDefault: t.number().default(0.5),
        active: t.boolean(),
        activeOptional: t.boolean().optional(),
        activeDefault: t.boolean().default(false),
        at: t.timestamp(),
        atOptional: t.timestamp().optional(),
        atDefault: t.timestamp().default("now"),
        data: t.json(),
        dataOptional: t.json().optional(),
        dataDefault: t.json().default({ nested: [null, 1] }),
        parent: t.ref("notes"),
        parentOptional: t.ref("notes").optional(),
        parentDefault: t.ref("notes").default("note-id" as Id<"notes">),
        customer: t.ref("abcdefghijkl/customers").optional()
      },
      {
        indexes: { byTitle: ["title"], byCount: { columns: ["count", "title"], unique: true } },
        shared: true
      }
    ),
    users: table({ name: t.text() })
  },
  files: { attachments: files() },
  uses: { sales: postgres("warehouse"), customers: sharedTable("abcdefghijkl", "customers") }
});
type Note = Row<typeof config, "notes">;
export type ConfigAssertions = [
  Assert<Equal<Note["title"], string>>,
  Assert<Equal<Note["titleOptional"], string | null>>,
  Assert<Equal<Note["titleDefault"], string>>,
  Assert<Equal<Note["count"], number>>,
  Assert<Equal<Note["countOptional"], number | null>>,
  Assert<Equal<Note["countDefault"], number>>,
  Assert<Equal<Note["score"], number>>,
  Assert<Equal<Note["scoreOptional"], number | null>>,
  Assert<Equal<Note["scoreDefault"], number>>,
  Assert<Equal<Note["active"], boolean>>,
  Assert<Equal<Note["activeOptional"], boolean | null>>,
  Assert<Equal<Note["activeDefault"], boolean>>,
  Assert<Equal<Note["at"], string>>,
  Assert<Equal<Note["atOptional"], string | null>>,
  Assert<Equal<Note["atDefault"], string>>,
  Assert<Equal<Note["data"], unknown>>,
  Assert<Equal<Note["dataOptional"], unknown>>,
  Assert<Equal<Note["dataDefault"], unknown>>,
  Assert<Equal<Note["parent"], Id<"notes">>>,
  Assert<Equal<Note["parentOptional"], Id<"notes"> | null>>,
  Assert<Equal<Note["parentDefault"], Id<"notes">>>,
  Assert<Equal<Note["customer"], Id<"abcdefghijkl/customers"> | null>>,
  Assert<Equal<Note["id"], Id<"notes">>>,
  Assert<Equal<Note["createdAt"] | Note["updatedAt"], string>>,
  Assert<Equal<typeof config.tables.notes.indexes.byTitle.columns, readonly ["title"]>>,
  Assert<Equal<typeof config.tables.notes.indexes.byCount.unique, true>>,
  Assert<Equal<typeof config.uses.sales.handle, "warehouse">>
];

// The function is never called: these are assignment checks, not runtime fixtures.
const boundaries = (noteId: Id<"notes">, userId: Id<"users">) => {
  const insert: Insert<typeof config, "notes"> = {
    title: "note",
    count: 1,
    score: 1.5,
    active: true,
    at: "2026-09-11T00:00:00Z",
    data: {},
    parent: noteId
  };
  const update: Update<typeof config, "notes"> = {
    titleOptional: null,
    parentOptional: null,
    activeDefault: true
  };
  // @ts-expect-error required fields remain required on insert
  const missing: Insert<typeof config, "notes"> = {};
  // @ts-expect-error a system id is never writable, even through a non-literal object
  const systemId: Insert<typeof config, "notes"> = { ...insert, id: noteId };
  // @ts-expect-error creation timestamp is not writable
  const created: Update<typeof config, "notes"> = { createdAt: "2026-09-11T00:00:00Z" };
  // @ts-expect-error update timestamp is not writable
  const updated: Insert<typeof config, "notes"> = { ...insert, updatedAt: "2026-09-11T00:00:00Z" };
  // @ts-expect-error null is not an insert value for a defaulted column
  const nullDefaultInsert: Insert<typeof config, "notes"> = { ...insert, countDefault: null };
  // @ts-expect-error null is not an update value for a defaulted column
  const nullDefault: Update<typeof config, "notes"> = { titleDefault: null };
  // @ts-expect-error required values cannot be cleared
  const nullRequired: Update<typeof config, "notes"> = { title: null };
  // @ts-expect-error references are branded by their target
  const wrongReference: Update<typeof config, "notes"> = { parent: userId };
  // @ts-expect-error raw strings are not table ids
  const rawReference: Update<typeof config, "notes"> = { parent: "raw" };
  // @ts-expect-error unknown columns are refused
  const unknownColumn: Update<typeof config, "notes"> = { absent: true };
  // @ts-expect-error defaulted columns cannot be optional
  t.text().default("x").optional();
  // @ts-expect-error optional columns cannot be defaulted
  t.text().optional().default("x");
  // @ts-expect-error a default cannot be null
  t.text().default(null);
  // @ts-expect-error a JSON default cannot be null
  t.json().default(null);
  // @ts-expect-error a default must match its kind
  t.boolean().default(1);
  // @ts-expect-error reference defaults must name the right target
  t.ref("notes").default(userId);
  // @ts-expect-error system columns are reserved
  table({ id: t.text() });
  // @ts-expect-error indexes can only name known or system columns
  table({ title: t.text() }, { indexes: { bad: ["absent"] } });
  return {
    insert,
    update,
    missing,
    systemId,
    created,
    updated,
    nullDefaultInsert,
    nullDefault,
    nullRequired,
    wrongReference,
    rawReference,
    unknownColumn
  };
};
void boundaries;
void config;
