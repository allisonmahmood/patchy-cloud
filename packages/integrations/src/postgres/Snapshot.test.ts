import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Snapshot } from "./Snapshot.js";

const isSnapshot = Schema.is(Snapshot);
const text = {
  schema: "pg_catalog",
  name: "text",
  sql: "text",
  baseSchema: "pg_catalog",
  baseName: "text",
  kind: "base" as const
};
const relation = {
  schema: "public",
  name: "accounts",
  kind: "table" as const,
  columns: [{ name: "id", type: text, nullable: false }],
  primaryKey: { name: "accounts_pkey", columns: ["id"] },
  foreignKeys: []
};
const snapshot = { version: 1 as const, relations: [relation], enums: [], exclusions: [] };

it("requires usable keys and named enum references in a whole snapshot", () => {
  assert.isTrue(isSnapshot(snapshot));
  assert.isFalse(
    isSnapshot({
      ...snapshot,
      relations: [{ ...relation, primaryKey: { name: "broken", columns: ["missing"] } }]
    })
  );
  const enumRelation = {
    ...relation,
    columns: [
      {
        name: "id",
        nullable: false,
        type: {
          schema: "public",
          name: "status",
          sql: "status",
          baseSchema: "public",
          baseName: "status",
          kind: "enum"
        }
      }
    ]
  };
  assert.isFalse(isSnapshot({ ...snapshot, relations: [enumRelation] }));
  assert.isTrue(
    isSnapshot({
      ...snapshot,
      relations: [enumRelation],
      enums: [{ schema: "public", name: "status", labels: ["new", "done"] }]
    })
  );
});

it("rejects dangling in-snapshot foreign keys and non-nullable view columns", () => {
  const foreignKey = {
    name: "owner",
    columns: ["id"],
    target: { schema: "public", relation: "accounts", columns: ["missing"] }
  };
  assert.isFalse(
    isSnapshot({
      ...snapshot,
      relations: [relation, { ...relation, name: "orders", foreignKeys: [foreignKey] }]
    })
  );
  assert.isFalse(isSnapshot({ ...snapshot, relations: [{ ...relation, kind: "view" }] }));
  assert.isTrue(
    isSnapshot({
      ...snapshot,
      relations: [
        { ...relation, kind: "view", columns: [{ name: "id", type: text, nullable: true }] }
      ]
    })
  );
});
