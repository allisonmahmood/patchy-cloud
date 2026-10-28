import { assert, describe, it } from "@effect/vitest";
import type { attioReads } from "@patchy/api";
import * as Effect from "effect/Effect";
import { objects, snapshot, uuid } from "../test/attioReads.js";
import * as Query from "./Query.js";

type Args = typeof attioReads.listEntries.input.Type;

const deals = Query.objectContainer(snapshot.objects[0]!);
const people = Query.objectContainer(snapshot.objects[2]!);
const companies = Query.objectContainer(snapshot.objects[1]!);
const pipeline = Query.listContainer(snapshot.lists[0]!);
const accounts = Query.listContainer(snapshot.lists[1]!);
const call: Query.Binding = { connectionId: "con_1", operation: "attio.listRecords", revision: 3 };
const noCurrent = { targets: new Map<string, ReadonlyArray<string>>() };

/** Attio's request body for `args` on `container`. */
const sent = (
  args: Omit<Args, "list">,
  container: Parameters<typeof Query.plan>[0] = deals,
  current = noCurrent,
  options = new Map<string, ReadonlyArray<string>>()
) => Effect.map(Query.plan(container, args, call), (plan) => Query.body(plan, current, options));
const filter = (...args: Parameters<typeof sent>) =>
  Effect.map(sent(...args), (body) => body.filter);
/** The details of the `invalid_request` that `args` are refused with. */
const refused = (args: Omit<Args, "list">, container: Parameters<typeof Query.plan>[0] = deals) =>
  Effect.flatMap(Effect.flip(Query.plan(container, args, call)), (error) =>
    error._tag === "AttioInvalidRequest"
      ? Effect.succeed(error.details)
      : Effect.die(`Refused ${error._tag}, not invalid_request.`)
  );

const id = uuid(500);
const id2 = uuid(501);
const id3 = uuid(502);

describe("the filter table, one row per type", () => {
  it.effect(
    "text: eq as Attio's case-insensitive match, any-of as $in, contains, null, order",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* filter({ eq: { name: "Acme" } }), { name: "Acme" });
        assert.deepStrictEqual(yield* filter({ eq: { name: ["Acme", "Lumen"] } }), {
          name: { $in: ["Acme", "Lumen"] }
        });
        assert.deepStrictEqual(yield* filter({ contains: { name: "ac" } }), {
          name: { $contains: "ac" }
        });
        assert.deepStrictEqual(yield* filter({ eq: { name: null } }), {
          $not: { name: { $contains: "" } }
        });
        assert.deepStrictEqual((yield* sent({ orderBy: { attribute: "name" } })).sorts, [
          { attribute: "name", direction: "asc" },
          { attribute: "record_id", direction: "asc" }
        ]);
      })
  );

  it.effect("number and rating: eq, any-of as $or, range, null as two $nots, order", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* filter({ eq: { amount: 500 } }), { amount: 500 });
      assert.deepStrictEqual(yield* filter({ eq: { score: [3, 4] } }), {
        $or: [{ score: 3 }, { score: 4 }]
      });
      assert.deepStrictEqual(
        yield* filter({ range: { attribute: "amount", gte: 1000, lt: 3000 } }),
        { amount: { $gte: 1000, $lt: 3000 } }
      );
      assert.deepStrictEqual(yield* filter({ eq: { score: null } }), {
        $and: [{ $not: { score: { $gte: 0 } } }, { $not: { score: { $lt: 0 } } }]
      });
      assert.deepStrictEqual(
        (yield* sent({ orderBy: { attribute: "amount", direction: "desc" } })).sorts,
        [
          { attribute: "amount", direction: "desc" },
          { attribute: "record_id", direction: "asc" }
        ]
      );
    })
  );

  it.effect("checkbox: true and false, false matching unset; no any-of or null", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* filter({ eq: { is_hot: true } }), { is_hot: true });
      assert.deepStrictEqual(yield* filter({ eq: { is_hot: false } }), { is_hot: false });
      assert.deepStrictEqual(yield* refused({ eq: { is_hot: [true, false] } }), {
        object: "deals",
        attribute: "is_hot",
        operator: "eq",
        reason: "unsupported"
      });
      assert.deepStrictEqual(yield* refused({ eq: { is_hot: null } }), {
        object: "deals",
        attribute: "is_hot",
        operator: "eq",
        reason: "unsupported"
      });
      assert.strictEqual((yield* sent({ orderBy: { attribute: "is_hot" } })).sorts.length, 2);
    })
  );

  it.effect("currency: on currency_value for eq, any-of, range, null and order", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* filter({ eq: { value: 5000 } }), {
        value: { currency_value: 5000 }
      });
      assert.deepStrictEqual(yield* filter({ eq: { value: [1, 2] } }), {
        $or: [{ value: { currency_value: 1 } }, { value: { currency_value: 2 } }]
      });
      assert.deepStrictEqual(
        yield* filter({ range: { attribute: "value", gt: 20000, lte: 50000 } }),
        {
          value: { currency_value: { $gt: 20000, $lte: 50000 } }
        }
      );
      assert.deepStrictEqual(yield* filter({ eq: { value: null } }), {
        $and: [
          { $not: { value: { currency_value: { $gte: 0 } } } },
          { $not: { value: { currency_value: { $lt: 0 } } } }
        ]
      });
      assert.deepStrictEqual(
        (yield* sent({ orderBy: { attribute: "value", direction: "desc" } })).sorts[0],
        {
          attribute: "value",
          field: "currency_value",
          direction: "desc"
        }
      );
    })
  );

  it.effect("date: YYYY-MM-DD for eq and range, null as two $nots", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* filter({ eq: { close_date: ["2026-03-04", "2026-03-05"] } }), {
        $or: [{ close_date: "2026-03-04" }, { close_date: "2026-03-05" }]
      });
      assert.deepStrictEqual(
        yield* filter({ range: { attribute: "close_date", gte: "2026-03-01", lt: "2026-04-01" } }),
        { close_date: { $gte: "2026-03-01", $lt: "2026-04-01" } }
      );
      assert.deepStrictEqual(yield* filter({ eq: { close_date: null } }), {
        $and: [
          { $not: { close_date: { $gte: "2000-01-01" } } },
          { $not: { close_date: { $lt: "2000-01-01" } } }
        ]
      });
      assert.strictEqual((yield* refused({ eq: { close_date: "4 March" } })).reason, "value");
    })
  );

  it.effect("timestamp: full ISO only, exact for eq; a date alone is refused", () =>
    Effect.gen(function* () {
      const at = "2026-01-01T03:00:00.000000000Z";
      assert.deepStrictEqual(yield* filter({ eq: { created_at: at } }), { created_at: at });
      assert.deepStrictEqual(
        yield* filter({ range: { attribute: "created_at", gte: "2026-05-01T00:00:00Z" } }),
        { created_at: { $gte: "2026-05-01T00:00:00Z" } }
      );
      assert.deepStrictEqual(yield* filter({ eq: { created_at: null } }), {
        $and: [
          { $not: { created_at: { $gte: "2000-01-01T00:00:00.000000000Z" } } },
          { $not: { created_at: { $lt: "2000-01-01T00:00:00.000000000Z" } } }
        ]
      });
      assert.deepStrictEqual(
        yield* refused({ range: { attribute: "created_at", gte: "2026-05-01" } }),
        { object: "deals", attribute: "created_at", operator: "range", reason: "timestamp" }
      );
      assert.strictEqual(
        (yield* refused({ eq: { created_at: "2026-05-01" } })).reason,
        "timestamp"
      );
    })
  );

  it.effect("select: titles exact, any-of as $or, null over the options read now", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* filter({ eq: { segment: "Enterprise" } }), {
        segment: "Enterprise"
      });
      assert.deepStrictEqual(yield* filter({ eq: { segment: ["Enterprise", "SMB"] } }), {
        $or: [{ segment: "Enterprise" }, { segment: "SMB" }]
      });
      // The options read in the call's check, not the snapshot's hints.
      const options = new Map([["segment", ["SMB", "Enterprise", "Strategic"]]]);
      assert.deepStrictEqual(yield* filter({ eq: { segment: null } }, deals, noCurrent, options), {
        $and: [
          { $not: { segment: "SMB" } },
          { $not: { segment: "Enterprise" } },
          { $not: { segment: "Strategic" } }
        ]
      });
      // No active option: every record reads empty, so nothing is excluded.
      assert.isUndefined(yield* filter({ eq: { segment: null } }, deals, noCurrent, new Map()));
      const plan = yield* Query.plan(deals, { eq: { segment: null } }, call);
      assert.isFalse(Query.independent(plan));
      assert.deepStrictEqual(
        plan.options.map((attribute) => attribute.slug),
        ["segment"]
      );
    })
  );

  it.effect("multiselect: a title means has it, an array has any; no order", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* filter({ eq: { tags: "Tag 01" } }), { tags: "Tag 01" });
      assert.deepStrictEqual(yield* filter({ eq: { tags: ["Tag 01", "Tag 02"] } }), {
        $or: [{ tags: "Tag 01" }, { tags: "Tag 02" }]
      });
      assert.deepStrictEqual(
        yield* filter({ eq: { tags: null } }, deals, noCurrent, new Map([["tags", ["Tag 01"]]])),
        { $not: { tags: "Tag 01" } }
      );
      assert.deepStrictEqual(yield* refused({ orderBy: { attribute: "tags" } }), {
        object: "deals",
        attribute: "tags",
        operator: "orderBy",
        reason: "unsupported"
      });
    })
  );

  it.effect("status: titles with emoji, any-of, null over current statuses, pipeline order", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* filter({ eq: { stage: "Won 🎉" } }), { stage: "Won 🎉" });
      assert.deepStrictEqual(yield* filter({ eq: { stage: ["Lead", "Lost"] } }), {
        $or: [{ stage: "Lead" }, { stage: "Lost" }]
      });
      assert.deepStrictEqual(
        yield* filter(
          { eq: { stage: null } },
          deals,
          noCurrent,
          new Map([["stage", ["Lead", "Lost"]]])
        ),
        { $and: [{ $not: { stage: "Lead" } }, { $not: { stage: "Lost" } }] }
      );
      assert.deepStrictEqual((yield* sent({ orderBy: { attribute: "stage" } })).sorts[0], {
        attribute: "stage",
        direction: "asc"
      });
    })
  );

  it.effect("email: on email_address for eq, any-of, contains and null", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* filter({ eq: { email_addresses: "ada@lumen.example" } }, people),
        {
          email_addresses: { email_address: "ada@lumen.example" }
        }
      );
      assert.deepStrictEqual(
        yield* filter({ eq: { email_addresses: ["a@x.example", "b@x.example"] } }, people),
        {
          $or: [
            { email_addresses: { email_address: "a@x.example" } },
            { email_addresses: { email_address: "b@x.example" } }
          ]
        }
      );
      assert.deepStrictEqual(yield* filter({ contains: { email_addresses: "probe" } }, people), {
        email_addresses: { email_address: { $contains: "probe" } }
      });
      assert.deepStrictEqual(yield* filter({ eq: { email_addresses: null } }, people), {
        $not: { email_addresses: { email_address: { $contains: "" } } }
      });
    })
  );

  it.effect("domain: on domain for eq and contains, null as $not $not_empty", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* filter({ eq: { domains: "lumen.example" } }, companies), {
        domains: { domain: "lumen.example" }
      });
      assert.deepStrictEqual(yield* filter({ contains: { domains: "lumen" } }, companies), {
        domains: { domain: { $contains: "lumen" } }
      });
      assert.deepStrictEqual(yield* filter({ eq: { domains: null } }, companies), {
        $not: { domains: { $not_empty: true } }
      });
    })
  );

  it.effect("phone: on phone_number, null as $not country_code $not_empty", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* filter({ eq: { phone: "+442079469611" } }), {
        phone: { phone_number: "+442079469611" }
      });
      assert.deepStrictEqual(yield* filter({ contains: { phone: "7946" } }), {
        phone: { phone_number: { $contains: "7946" } }
      });
      assert.deepStrictEqual(yield* filter({ eq: { phone: null } }), {
        $not: { phone: { country_code: { $not_empty: true } } }
      });
    })
  );

  it.effect("personal name: full_name for eq and contains, sorted by last_name", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* filter({ eq: { name: "Ada Lovelace" } }, people), {
        name: { full_name: "Ada Lovelace" }
      });
      assert.deepStrictEqual(yield* filter({ contains: { name: "ada" } }, people), {
        name: { full_name: { $contains: "ada" } }
      });
      assert.deepStrictEqual(yield* filter({ eq: { name: null } }, people), {
        $not: { name: { $not_empty: true } }
      });
      assert.deepStrictEqual((yield* sent({ orderBy: { attribute: "name" } }, people)).sorts[0], {
        attribute: "name",
        field: "last_name",
        direction: "asc"
      });
    })
  );

  it.effect("location: the fields given, ANDed; contains on locality; no null", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* filter({ eq: { hq_location: { locality: "Austin", countryCode: "US" } } }),
        { hq_location: { locality: "Austin", country_code: "US" } }
      );
      assert.deepStrictEqual(
        yield* filter({ eq: { hq_location: [{ region: "TX" }, { postcode: "P1" }] } }),
        { $or: [{ hq_location: { region: "TX" } }, { hq_location: { postcode: "P1" } }] }
      );
      assert.deepStrictEqual(yield* filter({ contains: { hq_location: "aus" } }), {
        hq_location: { locality: { $contains: "aus" } }
      });
      assert.strictEqual((yield* refused({ eq: { hq_location: null } })).reason, "unsupported");
      assert.strictEqual((yield* refused({ eq: { hq_location: {} } })).reason, "value");
      assert.deepStrictEqual((yield* sent({ orderBy: { attribute: "hq_location" } })).sorts[0], {
        attribute: "hq_location",
        field: "locality",
        direction: "asc"
      });
    })
  );

  it.effect("record reference: { object, id } or a bare id with one target, grouped any-of", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* filter({ eq: { associated_company: { object: "companies", id } } }),
        { associated_company: { target_object: "companies", target_record_id: id } }
      );
      // A bare id names the attribute's one target.
      assert.deepStrictEqual(yield* filter({ eq: { associated_company: id.toUpperCase() } }), {
        associated_company: { target_object: "companies", target_record_id: id }
      });
      assert.deepStrictEqual(yield* filter({ eq: { associated_company: [id, id2] } }), {
        associated_company: { target_object: "companies", target_record_id: { $in: [id, id2] } }
      });
      assert.deepStrictEqual(
        yield* filter({
          eq: {
            counterparty: [
              { object: "companies", id },
              { object: "people", id: id2 },
              { object: "companies", id: id3 }
            ]
          }
        }),
        {
          $or: [
            { counterparty: { target_object: "companies", target_record_id: { $in: [id, id3] } } },
            { counterparty: { target_object: "people", target_record_id: { $in: [id2] } } }
          ]
        }
      );
      // A bare id where the attribute has several targets is ambiguous.
      assert.deepStrictEqual(yield* refused({ eq: { counterparty: id } }), {
        object: "deals",
        attribute: "counterparty",
        operator: "eq",
        reason: "target"
      });
      assert.strictEqual(
        (yield* refused({ eq: { associated_company: { object: "people", id } } })).reason,
        "target"
      );
      // null excludes every target the check found current, by object id.
      const current = {
        targets: new Map([["counterparty", [objects.companies.id, objects.people.id]]])
      };
      assert.deepStrictEqual(yield* filter({ eq: { counterparty: null } }, deals, current), {
        $and: [
          { $not: { counterparty: { target_object: objects.companies.id } } },
          { $not: { counterparty: { target_object: objects.people.id } } }
        ]
      });
      assert.strictEqual(
        (yield* refused({ orderBy: { attribute: "associated_company" } })).reason,
        "unsupported"
      );
    })
  );

  it.effect("actor reference: a member's id, null over Attio's actor types; no order", () =>
    Effect.gen(function* () {
      const member = uuid(5);
      assert.deepStrictEqual(yield* filter({ eq: { owner: member } }), {
        owner: { referenced_actor_type: "workspace-member", referenced_actor_id: member }
      });
      assert.deepStrictEqual(yield* filter({ eq: { watchers: [member, id] } }), {
        $or: [
          { watchers: { referenced_actor_type: "workspace-member", referenced_actor_id: member } },
          { watchers: { referenced_actor_type: "workspace-member", referenced_actor_id: id } }
        ]
      });
      assert.deepStrictEqual(yield* filter({ eq: { owner: null } }), {
        $and: [
          { $not: { owner: { referenced_actor_type: "workspace-member" } } },
          { $not: { owner: { referenced_actor_type: "api-token" } } },
          { $not: { owner: { referenced_actor_type: "system" } } }
        ]
      });
      assert.strictEqual((yield* refused({ eq: { owner: "ada@lumen.example" } })).reason, "value");
      assert.strictEqual(
        (yield* refused({ orderBy: { attribute: "owner" } })).reason,
        "unsupported"
      );
    })
  );

  it.effect("interaction: range on interacted_at, null on its owner, sorted by when", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* filter(
          { range: { attribute: "last_interaction", gte: "2026-01-01T00:00:00Z" } },
          people
        ),
        { last_interaction: { interacted_at: { $gte: "2026-01-01T00:00:00Z" } } }
      );
      assert.deepStrictEqual(yield* filter({ eq: { last_interaction: null } }, people), {
        $not: { last_interaction: { owner_member_id: { $not_empty: true } } }
      });
      assert.deepStrictEqual(
        (yield* sent({ orderBy: { attribute: "last_interaction" } }, people)).sorts[0],
        { attribute: "last_interaction", field: "interacted_at", direction: "asc" }
      );
      assert.strictEqual(
        (yield* refused({ eq: { last_interaction: "2026-01-01T00:00:00Z" } }, people)).reason,
        "unsupported"
      );
    })
  );
});

describe("a whole request", () => {
  it.effect(
    "ANDs every attribute, always sends a limit one past the page, and the unique key",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* sent({
            eq: { stage: "Lead", owner: uuid(5) },
            orderBy: { attribute: "value", direction: "desc" },
            limit: 50
          }),
          {
            filter: {
              $and: [
                { stage: "Lead" },
                {
                  owner: { referenced_actor_type: "workspace-member", referenced_actor_id: uuid(5) }
                }
              ]
            },
            sorts: [
              { attribute: "value", field: "currency_value", direction: "desc" },
              { attribute: "record_id", direction: "asc" }
            ],
            limit: 51,
            offset: 0
          }
        );
        assert.deepStrictEqual(yield* sent({}), {
          sorts: [{ attribute: "record_id", direction: "asc" }],
          limit: Query.DEFAULT_LIMIT + 1,
          offset: 0
        });
        assert.deepStrictEqual((yield* sent({}, pipeline)).sorts, [
          { attribute: "entry_id", direction: "asc" }
        ]);
      })
  );

  it.effect("pages by a cursor bound to the call, refusing one from another", () =>
    Effect.gen(function* () {
      const args = { eq: { stage: "Lead" }, limit: 2 };
      const first = yield* Query.plan(deals, args, call);
      assert.isNull(Query.next(first, 2));
      const cursor = Query.next(first, 3)!;
      const second = yield* Query.plan(deals, { ...args, cursor }, call);
      assert.strictEqual(second.offset, 2);
      assert.strictEqual(Query.body(second, noCurrent, new Map()).offset, 2);
      // A changed limit keeps the offset; anything the cursor binds refuses it.
      assert.strictEqual((yield* Query.plan(deals, { ...args, limit: 5, cursor }, call)).offset, 2);
      for (const [container, other, binding] of [
        [deals, { eq: { stage: "Lost" }, limit: 2 }, call],
        [deals, { ...args, orderBy: { attribute: "name" } }, call],
        [deals, args, { ...call, revision: 4 }],
        [deals, args, { ...call, connectionId: "con_2" }],
        [deals, args, { ...call, operation: "attio.listEntries" }],
        [people, {}, call]
      ] as const) {
        const error = yield* Effect.flip(Query.plan(container, { ...other, cursor }, binding));
        assert.strictEqual(error._tag, "AttioInvalidCursor");
      }
      for (const broken of ["not a cursor!", Buffer.from("{}").toString("base64url")]) {
        const error = yield* Effect.flip(Query.plan(deals, { ...args, cursor: broken }, call));
        assert.strictEqual(error._tag, "AttioInvalidCursor");
      }
    })
  );

  it.effect("filters a list's entries to one parent", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* filter({ parent: id }, pipeline), {
        parent_record: { target_record_id: id }
      });
      assert.deepStrictEqual(yield* filter({ parent: { object: "deals", id } }, pipeline), {
        parent_record: { target_record_id: id }
      });
      // With several parent objects the object goes too, and a bare id is ambiguous.
      assert.deepStrictEqual(yield* filter({ parent: { object: "people", id } }, accounts), {
        parent_record: { target_object: "people", target_record_id: id }
      });
      assert.deepStrictEqual(yield* refused({ parent: id }, accounts), {
        list: "accounts",
        operator: "parent",
        reason: "parent"
      });
      assert.strictEqual(
        (yield* refused({ parent: { object: "companies", id } }, pipeline)).reason,
        "parent"
      );
    })
  );

  it.effect("refuses before Attio: unknown slugs, unsupported operators and bad bounds", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* refused({ eq: { nope: "x" } }), {
        object: "deals",
        attribute: "nope",
        operator: "eq",
        reason: "unknown"
      });
      // An inherited name is no attribute.
      assert.strictEqual((yield* refused({ eq: { constructor: "x" } })).reason, "unknown");
      assert.strictEqual((yield* refused({ orderBy: { attribute: "nope" } })).reason, "unknown");
      assert.strictEqual((yield* refused({ contains: { amount: "5" } })).reason, "unsupported");
      assert.strictEqual(
        (yield* refused({ range: { attribute: "name", gte: "a" } })).reason,
        "unsupported"
      );
      for (const range of [
        { attribute: "amount" },
        { attribute: "amount", gt: 1, gte: 1 },
        { attribute: "amount", lt: 1, lte: 1 }
      ])
        assert.strictEqual((yield* refused({ range })).reason, "bounds");
      assert.strictEqual(
        (yield* refused({ range: { attribute: "amount", gte: "1" } })).reason,
        "value"
      );
      assert.strictEqual((yield* refused({ eq: { amount: "500" } })).reason, "value");
      assert.strictEqual((yield* refused({ eq: { name: 5 } })).reason, "value");
      assert.strictEqual((yield* refused({ eq: { name: ["a", 5] } })).reason, "value");
    })
  );
});

describe("getMany", () => {
  it("sends the distinct ids, at most 100 to an $in, with an explicit limit", () => {
    assert.deepStrictEqual(Query.many([id, id2.toUpperCase(), id]), {
      distinct: 2,
      body: { filter: { record_id: { $in: [id, id2] } }, limit: 2 }
    });
    const ids = Array.from({ length: 250 }, (_, n) => uuid(1000 + n));
    const { distinct, body } = Query.many(ids);
    assert.strictEqual(distinct, 250);
    const chunks = (body.filter as { $or: Array<{ record_id: { $in: string[] } }> }).$or;
    assert.deepStrictEqual(
      chunks.map((chunk) => chunk.record_id.$in.length),
      [100, 100, 50]
    );
    assert.deepStrictEqual(
      chunks.flatMap((chunk) => chunk.record_id.$in),
      ids
    );
    assert.strictEqual(body.limit, 250);
  });
});
