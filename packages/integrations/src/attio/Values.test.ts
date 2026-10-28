import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  currentAttributes,
  entry,
  items,
  objects,
  record,
  snapshot,
  uuid
} from "../test/attioReads.js";
import * as Query from "./Query.js";
import * as Values from "./Values.js";

const deals = Query.objectContainer(snapshot.objects[0]!);
const people = Query.objectContainer(snapshot.objects[2]!);
const companies = Query.objectContainer(snapshot.objects[1]!);
const pipeline = Query.listContainer(snapshot.lists[0]!);
const id = uuid(500);
const member = uuid(5);
const at = "2026-01-01T03:00:00.000000000Z";

describe("decoding", () => {
  it.effect("reads every type as a plain value, dropping Attio's metadata", () =>
    Effect.gen(function* () {
      const deal = yield* Values.record(
        deals,
        record("deals", id, {
          record_id: [items.text(id)],
          name: [items.text("Probe deal")],
          stage: [items.status("Won 🎉")],
          owner: [items.actor(member)],
          value: [items.currency(10000)],
          associated_people: [
            items.reference("people", uuid(600)),
            items.reference("people", uuid(601))
          ],
          associated_company: [items.reference("companies", uuid(700))],
          counterparty: [items.reference("people", uuid(600))],
          created_at: [items.timestamp(at)],
          is_hot: [items.checkbox(true)],
          amount: [items.number(4600)],
          score: [items.number(3)],
          close_date: [items.date("2026-02-13")],
          phone: [items.phone("+442079469611")],
          hq_location: [items.location("Austin")],
          segment: [items.select("SMB")],
          tags: [items.select("Tag 01"), items.select("Tag 02")],
          watchers: [items.actor(member), items.actor(uuid(8), "api-token")]
        })
      );
      assert.deepStrictEqual(deal, {
        id,
        url: `https://app.attio.com/lumen-bikes/deals/record/${id}`,
        createdAt: "2026-10-27T23:49:28.945950775Z",
        values: {
          record_id: id,
          name: "Probe deal",
          stage: "Won 🎉",
          owner: { type: "workspace-member", id: member },
          value: { amount: 10000, currency: "USD" },
          associated_people: [
            { object: "people", id: uuid(600) },
            { object: "people", id: uuid(601) }
          ],
          associated_company: { object: "companies", id: uuid(700) },
          counterparty: [{ object: "people", id: uuid(600) }],
          created_at: at,
          is_hot: true,
          amount: 4600,
          score: 3,
          close_date: "2026-02-13",
          phone: "+442079469611",
          hq_location: {
            line1: "788 Probe Street",
            line2: null,
            line3: null,
            line4: null,
            locality: "Austin",
            region: "TX",
            postcode: "P6573",
            countryCode: "US",
            latitude: "30.267153",
            longitude: null
          },
          segment: "SMB",
          tags: ["Tag 01", "Tag 02"],
          watchers: [
            { type: "workspace-member", id: member },
            { type: "api-token", id: uuid(8) }
          ]
        }
      });
      const person = yield* Values.record(
        people,
        record("people", id, {
          name: [items.name("Ada", "Lovelace")],
          email_addresses: [items.email("ada@lumen.example")],
          last_interaction: [items.interaction(at)]
        })
      );
      assert.deepStrictEqual(person.values, {
        record_id: null,
        name: { first: "Ada", last: "Lovelace", full: "Ada Lovelace" },
        email_addresses: ["ada@lumen.example"],
        last_interaction: {
          type: "email",
          at,
          owner: { type: "workspace-member", id: member }
        }
      });
      const company = yield* Values.record(
        companies,
        record("companies", id, { domains: [items.domain("lumen.example")] })
      );
      assert.deepStrictEqual(company.values.domains, ["lumen.example"]);
    })
  );

  it.effect("reads empty as null or [], and an unset checkbox as false", () =>
    Effect.gen(function* () {
      const deal = yield* Values.record(deals, record("deals", id));
      for (const [slug, value] of Object.entries(deal.values))
        if (slug === "is_hot") assert.isFalse(value);
        else assert.isTrue(Values.isEmpty(value), slug);
      assert.deepStrictEqual(deal.values.tags, []);
      assert.isNull(deal.values.stage);
      // Attributes Attio sends that the snapshot doesn't have are dropped.
      const extra = record("deals", id);
      const decoded = yield* Values.record(deals, {
        ...extra,
        values: { ...extra.values, secret_field: [items.text("x")] }
      });
      assert.isFalse(Object.hasOwn(decoded.values, "secret_field"));
    })
  );

  it.effect("keeps a slug such as __proto__ as an ordinary key", () =>
    Effect.gen(function* () {
      const container = {
        where: { object: "odd" },
        attributes: [{ ...snapshot.objects[0]!.attributes[1]!, slug: "__proto__" }]
      };
      const decoded = yield* Values.values(
        container,
        JSON.parse('{"__proto__": [{"value": "x"}]}')
      );
      assert.isTrue(Object.hasOwn(decoded, "__proto__"));
      assert.strictEqual(JSON.stringify(decoded), '{"__proto__":"x"}');
    })
  );

  it.effect("fails shape_mismatch on a value that doesn't read, naming the attribute", () =>
    Effect.gen(function* () {
      const failure = (values: Record<string, ReadonlyArray<unknown>>) =>
        Effect.map(
          Effect.flip(Values.record(deals, record("deals", id, values))),
          (error) => error.details
        );
      assert.deepStrictEqual(yield* failure({ amount: [items.text("500")] }), {
        object: "deals",
        attribute: "amount",
        reason: "value"
      });
      // A single attribute with two values.
      assert.strictEqual(
        (yield* failure({ segment: [items.select("SMB"), items.select("Enterprise")] })).reason,
        "value"
      );
      // A reference to an object the snapshot knows by another slug: its target was renamed.
      assert.deepStrictEqual(
        yield* failure({ associated_company: [items.reference("organisations", uuid(700))] }),
        { object: "deals", attribute: "associated_company", reason: "target" }
      );
      // An attribute Attio left out is gone.
      const missing = record("deals", id);
      delete (missing.values as Record<string, unknown>).amount;
      assert.deepStrictEqual((yield* Effect.flip(Values.record(deals, missing))).details, {
        object: "deals",
        attribute: "amount",
        reason: "missing"
      });
    })
  );

  it.effect("reads an entry on a parent object of the list, and refuses one on another", () =>
    Effect.gen(function* () {
      const read = yield* Values.entry(
        pipeline,
        entry(uuid(800), id, {
          stage: [items.status("Demo")],
          entered_on: [items.date("2026-03-04")]
        })
      );
      assert.deepStrictEqual(read, {
        id: uuid(800),
        parent: { object: "deals", id },
        createdAt: "2026-10-27T23:49:28.945950775Z",
        values: { entry_id: null, stage: "Demo", flagged: false, entered_on: "2026-03-04" }
      });
      const error = yield* Effect.flip(Values.entry(pipeline, entry(uuid(800), id, {}, "people")));
      assert.deepStrictEqual(error.details, { list: "pipeline", reason: "parent" });
    })
  );

  it("reads members with an active flag, never their other fields", () => {
    assert.deepStrictEqual(
      Values.member({
        id: { workspace_member_id: member },
        first_name: "Ada",
        last_name: null,
        email_address: "ada@lumen.example",
        access_level: "suspended"
      }),
      { id: member, name: "Ada", email: "ada@lumen.example", active: false }
    );
  });
});

describe("the call's schema check", () => {
  const attributes = currentAttributes(snapshot.objects[0]!.attributes);
  const amount = attributes.findIndex((item) => item.api_slug === "amount");
  const changed = (change: (item: (typeof attributes)[number]) => object) =>
    attributes.map((item, index) => (index === amount ? { ...item, ...change(item) } : item));
  const reason = (current: ReadonlyArray<Values.RawAttribute>) =>
    Effect.map(Effect.flip(Values.check(deals, current)), (error) => error.details);

  it.effect("passes the workspace as the snapshot saw it, and gives the current targets", () =>
    Effect.gen(function* () {
      const current = yield* Values.check(deals, attributes);
      assert.deepStrictEqual(current.targets.get("counterparty"), [
        objects.companies.id,
        objects.people.id
      ]);
    })
  );

  it.effect("names a gone, archived, renamed, retyped or single/multi-changed attribute", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* reason(attributes.filter((_, index) => index !== amount)), {
        object: "deals",
        attribute: "amount",
        reason: "missing"
      });
      assert.strictEqual(
        (yield* reason(changed(() => ({ is_archived: true })))).reason,
        "archived"
      );
      assert.deepStrictEqual(yield* reason(changed(() => ({ api_slug: "deal_amount" }))), {
        object: "deals",
        attribute: "amount",
        reason: "renamed",
        renamedTo: "deal_amount"
      });
      assert.strictEqual((yield* reason(changed(() => ({ type: "text" })))).reason, "type");
      assert.strictEqual(
        (yield* reason(changed(() => ({ is_multiselect: true })))).reason,
        "multiselect"
      );
    })
  );

  it.effect("reads a slug another attribute took under it, if its type and cardinality match", () =>
    Effect.gen(function* () {
      const reused = changed((item) => ({
        id: { ...item.id, attribute_id: uuid(999) }
      }));
      yield* Values.check(deals, reused);
      // The original, renamed away, is beside it.
      yield* Values.check(deals, [...reused, { ...attributes[amount]!, api_slug: "old_amount" }]);
      assert.strictEqual(
        (yield* reason(
          changed((item) => ({ id: { ...item.id, attribute_id: uuid(999) }, type: "text" }))
        )).reason,
        "type"
      );
    })
  );

  it.effect("refuses a reference that no longer allows a snapshot target", () =>
    Effect.gen(function* () {
      const counterparty = attributes.findIndex((item) => item.api_slug === "counterparty");
      const current = attributes.map((item, index) =>
        index === counterparty
          ? {
              ...item,
              config: {
                ...item.config,
                record_reference: { allowed_object_ids: [objects.people.id] }
              }
            }
          : item
      );
      assert.deepStrictEqual(yield* reason(current), {
        object: "deals",
        attribute: "counterparty",
        reason: "targets"
      });
      // A target added since passes, and is excluded by null.
      const added = attributes.map((item, index) =>
        index === counterparty
          ? {
              ...item,
              config: {
                ...item.config,
                record_reference: {
                  allowed_object_ids: [objects.companies.id, objects.people.id, uuid(4)]
                }
              }
            }
          : item
      );
      assert.lengthOf((yield* Values.check(deals, added)).targets.get("counterparty")!, 3);
    })
  );

  it("reads Attio's answers, refusing ones that aren't", () => {
    assert.lengthOf(Values.answers.attributes({ data: attributes })!.data, attributes.length);
    assert.isUndefined(Values.answers.records({ data: [{ id: "x" }] }));
    assert.isUndefined(Values.answers.records("<html>"));
    assert.deepStrictEqual(
      Values.titles(
        Values.answers.options({
          data: [
            { title: "SMB", is_archived: false },
            { title: "Old", is_archived: true }
          ]
        })!.data
      ),
      ["SMB"]
    );
  });
});
