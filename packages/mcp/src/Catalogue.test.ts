/**
 * The catalogue calls through the door: `find_patches` and `open_patch` over patches published
 * into a migrated database. What a person can find is checked against the portal's own list in
 * apps/server's tests; these cover the order, pages, search, cursors, resolution and caps.
 * The door's layer needs no Runtime, so no catalogue call can start a patch.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { agentTools, openPatchAnswer, type HandlerDescriptors } from "@patchy/api";
import { Patches } from "@patchy/patches";
import { at, call, company, door, harness, objectAt, publish, type Person } from "./test/door.js";

/** An agent tool's descriptor: what it does, and one described argument. */
const tool = (kind: "query" | "mutation" | "action", description: string) => ({
  kind,
  description,
  agentTool: true as const,
  args: { deal: { kind: "text" as const, description: "Which deal." } },
  result: { kind: "json" as const }
});

const deals: HandlerDescriptors = {
  "agent.moveDeal": tool("mutation", "Move a deal to another stage."),
  "agent.findDeals": tool("query", "Find open deals."),
  "deals.list": { kind: "query", args: {}, result: { kind: "json" } }
};

/** `count` tools whose descriptions are `size` characters each. */
const wordy = (count: number, size: number): HandlerDescriptors =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `agent.tool${String(index).padStart(2, "0")}`,
      tool("query", `${index} `.padEnd(size, "x"))
    ])
  );

interface Entry {
  readonly name: string;
  readonly description: string;
  readonly owner: string;
  readonly address: string;
  readonly tools: ReadonlyArray<unknown>;
}
interface Found {
  readonly actingFor: unknown;
  readonly total: number;
  readonly patches: ReadonlyArray<Entry>;
  readonly next?: string;
}

/** The decoded cursor, so a test can forge one where it points. */
const decodeCursor = (cursor: string) =>
  JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    after: { tools: boolean; name: string; id: string };
  };
const encodeCursor = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

it.layer(harness)("the catalogue", (it) => {
  /** A find's answer, checked to carry its document twice and to fit the read cap. */
  const found = (response: { readonly json: unknown; readonly text: string }) => {
    const result = objectAt(response.json, "result");
    assert.isUndefined(result["isError"], JSON.stringify(result["structuredContent"]));
    const text = String(at(result, "content.0.text"));
    assert.isAtMost(text.length, 100_000);
    assert.deepStrictEqual(JSON.parse(text), result["structuredContent"]);
    return result["structuredContent"] as Found;
  };
  const names = (answer: Found) => answer.patches.map((entry) => entry.name);

  it.effect(
    "lists the live patches the person can open, those with tools first, then by name",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("list", [
          ["Priya Shah", "admin"],
          ["Ben Okafor", "member"]
        ]);
        const [priya, ben] = acme.people as [Person, Person];
        const patches = yield* Patches.Patches;
        yield* publish(acme.id, priya, "zeta-board", { handlers: deals, description: "Deals." });
        yield* publish(acme.id, ben, "alpha-notes", { description: "Team notes." });
        yield* publish(acme.id, ben, "beta-crm", { handlers: deals });
        yield* publish(acme.id, priya, "gamma-page", { scope: "public" });
        const retired = yield* publish(acme.id, ben, "retired-one");
        yield* patches.retire(retired.patchId, { userId: ben.id, admin: false });
        const deleted = yield* publish(acme.id, ben, "deleted-one");
        yield* patches.delete(deleted.patchId, { userId: ben.id, admin: false });
        const takenDown = yield* publish(acme.id, ben, "taken-down", { handlers: deals });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE patches SET disabled_at = now(), disabled_reason = 'test'
        WHERE id = ${takenDown.patchId}`;
        const elsewhere = yield* company("list-elsewhere", [["Cleo Admin", "admin"]]);
        yield* publish(elsewhere.id, elsewhere.people[0]!, "alpha-elsewhere", { handlers: deals });

        const send = yield* door("https://cloud.example", "203.0.113.30");
        for (const person of [ben, priya]) {
          const response = yield* send(call(person.token, "find_patches"));
          assert.strictEqual(response.status, 200);
          const answer = found(response);
          assert.deepStrictEqual(answer.actingFor, { person: person.name, company: "Door list" });
          assert.strictEqual(answer.total, 4);
          assert.isUndefined(answer.next);
          assert.deepStrictEqual(names(answer), [
            "beta-crm",
            "zeta-board",
            "alpha-notes",
            "gamma-page"
          ]);
          assert.deepStrictEqual(answer.patches[1], {
            name: "zeta-board",
            description: "Deals.",
            owner: "Priya Shah",
            address: "https://cloud.example/door-list/zeta-board",
            tools: ["findDeals", "moveDeal"]
          });
          assert.deepStrictEqual(answer.patches[2]!.tools, []);
          assert.include(response.event, {
            mcpTool: "find_patches",
            catalogueTotal: 4,
            catalogueListed: 4,
            catalogueEndedEarly: false,
            catalogueSearched: false,
            catalogueDetail: false,
            catalogueContinued: false,
            resultBytes: Buffer.byteLength(String(at(response.json, "result.content.0.text")))
          });
        }
      })
  );

  it.effect("pages 50 at a time through a cursor that walks the rest in a stable order", () =>
    Effect.gen(function* () {
      const acme = yield* company("pages", [["Priya Shah", "admin"]]);
      const priya = acme.people[0]!;
      const expected: string[] = ["tools-a", "tools-b"];
      for (const name of ["tools-b", "tools-a"])
        yield* publish(acme.id, priya, name, { handlers: deals, description: "Has tools." });
      for (let index = 53; index >= 1; index--) {
        const name = `page-${String(index).padStart(3, "0")}`;
        yield* publish(acme.id, priya, name, { description: `Weekly page ${index}.` });
      }
      for (let index = 1; index <= 53; index++)
        expected.push(`page-${String(index).padStart(3, "0")}`);
      const send = yield* door("https://cloud.example", "203.0.113.31");

      const first = found(yield* send(call(priya.token, "find_patches")));
      assert.strictEqual(first.total, 55);
      assert.deepStrictEqual(names(first), expected.slice(0, 50));
      assert.isString(first.next);

      // A patch that sorts before the cursor and one retired after it change nothing already seen.
      yield* publish(acme.id, priya, "page-000", { description: "Weekly page zero." });
      const patches = yield* Patches.Patches;
      const [gone] = yield* patches.read({
        companyId: acme.id,
        userId: priya.id,
        canOpen: () => true,
        state: "live",
        patchRef: "page-051"
      });
      yield* patches.retire(gone!.patch.id, { userId: priya.id, admin: true });
      const continued = yield* send(call(priya.token, "find_patches", { cursor: first.next }));
      const second = found(continued);
      assert.strictEqual(second.total, 55);
      assert.deepStrictEqual(names(second), ["page-049", "page-050", "page-052", "page-053"]);
      assert.isUndefined(second.next);
      assert.include(continued.event, { catalogueContinued: true, catalogueListed: 4 });

      // A cursor carries its search: the cursor alone continues it, and so does the same search.
      const weekly = found(yield* send(call(priya.token, "find_patches", { search: "weekly" })));
      assert.strictEqual(weekly.total, 53);
      assert.deepStrictEqual(names(weekly), [
        "page-000",
        ...expected.slice(2, 51).filter((name) => name !== "page-051")
      ]);
      for (const args of [{ cursor: weekly.next }, { cursor: weekly.next, search: " Weekly " }]) {
        const rest = found(yield* send(call(priya.token, "find_patches", args)));
        assert.strictEqual(rest.total, 53);
        assert.deepStrictEqual(names(rest), ["page-050", "page-052", "page-053"]);
      }
      for (const args of [
        { cursor: weekly.next, search: "other" },
        { cursor: weekly.next, detail: "tools" }
      ]) {
        const refused = yield* send(call(priya.token, "find_patches", args));
        assert.include(objectAt(refused.json, "result.structuredContent.error"), {
          code: "invalid_args",
          from: "patchy",
          message:
            "That cursor continues a find with its own search and detail. Send the cursor alone to go on, or leave it out to start a new find."
        });
      }
    })
  );

  it.effect("refuses a cursor it never gave, and a forged one finds nothing more", () =>
    Effect.gen(function* () {
      const acme = yield* company("forged", [["Priya Shah", "admin"]]);
      const priya = acme.people[0]!;
      for (let index = 1; index <= 51; index++)
        yield* publish(acme.id, priya, `item-${String(index).padStart(3, "0")}`);
      const hidden = yield* publish(acme.id, priya, "item-010x");
      const patches = yield* Patches.Patches;
      yield* patches.retire(hidden.patchId, { userId: priya.id, admin: true });
      const elsewhere = yield* company("forged-elsewhere", [["Cleo Admin", "admin"]]);
      const theirs = yield* publish(elsewhere.id, elsewhere.people[0]!, "item-010y");
      const send = yield* door("https://cloud.example", "203.0.113.32");
      const first = found(yield* send(call(priya.token, "find_patches")));
      const cursor = decodeCursor(first.next!);

      for (const bad of [
        "nope",
        encodeCursor("not a cursor"),
        encodeCursor({ after: { tools: "no", name: 1 } }),
        Buffer.from("{", "utf8").toString("base64url"),
        "x".repeat(5000)
      ]) {
        const refused = yield* send(call(priya.token, "find_patches", { cursor: bad }));
        assert.strictEqual(refused.status, 200);
        assert.include(objectAt(refused.json, "result.structuredContent.error"), {
          code: "invalid_args",
          from: "patchy"
        });
      }

      // Pointing a cursor at a patch the person can't open, at another company's or at no patch
      // at all lands in the same place in their own list.
      const after = (name: string, id: string) =>
        encodeCursor({ ...cursor, after: { tools: false, name, id } });
      const answers = [];
      for (const [name, id] of [
        ["item-010x", hidden.patchId],
        ["item-010y", theirs.patchId],
        ["item-010z", "pd_nobody"]
      ] as const)
        answers.push(
          found(yield* send(call(priya.token, "find_patches", { cursor: after(name, id) })))
        );
      for (const answer of answers) {
        assert.deepStrictEqual(answer, answers[0]);
        assert.strictEqual(answer.total, 51);
        assert.strictEqual(answer.patches[0]!.name, "item-011");
        assert.isFalse(names(answer).includes("item-010x"));
      }
    })
  );

  it.effect(
    "ends a page early under the read cap, and detail adds each tool's kind and words",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("cap", [["Priya Shah", "admin"]]);
        const priya = acme.people[0]!;
        for (const name of ["wordy-a", "wordy-b", "wordy-c", "wordy-d", "wordy-e", "wordy-f"])
          yield* publish(acme.id, priya, name, { handlers: wordy(10, 1_900) });
        const send = yield* door("https://cloud.example", "203.0.113.33");

        const brief = found(yield* send(call(priya.token, "find_patches")));
        assert.strictEqual(brief.patches.length, 6);
        assert.strictEqual(brief.patches[0]!.tools[0], "tool00");

        const first = yield* send(call(priya.token, "find_patches", { detail: "tools" }));
        const pages = [found(first)];
        assert.isBelow(pages[0]!.patches.length, 6);
        assert.include(first.event, { catalogueEndedEarly: true, catalogueDetail: true });
        // The cursor keeps the detail, so the cursor alone walks the rest with it.
        while (pages.at(-1)!.next !== undefined)
          pages.push(
            found(yield* send(call(priya.token, "find_patches", { cursor: pages.at(-1)!.next })))
          );
        const entries = pages.flatMap((page) => page.patches);
        assert.deepStrictEqual(
          entries.map((entry) => entry.name),
          ["wordy-a", "wordy-b", "wordy-c", "wordy-d", "wordy-e", "wordy-f"]
        );
        for (const entry of entries) {
          assert.strictEqual(entry.tools.length, 10);
          assert.deepStrictEqual(entry.tools[3], {
            name: "tool03",
            kind: "read",
            description: "3 ".padEnd(1_900, "x")
          });
        }
      })
  );

  it.effect("searches every word in the name, title, description or owner, ignoring case", () =>
    Effect.gen(function* () {
      const acme = yield* company("search", [
        ["Priya Shah", "admin"],
        ["Ben Okafor", "member"]
      ]);
      const [priya, ben] = acme.people as [Person, Person];
      yield* publish(acme.id, priya, "deal-desk", { description: "Track enterprise renewals." });
      yield* publish(acme.id, ben, "hiring", {
        title: "Hiring Pipeline",
        description: "Candidates and interviews."
      });
      yield* publish(acme.id, priya, "renewals", { title: "Q3 Board", description: "Numbers." });
      const secret = yield* publish(acme.id, priya, "secret-plans", {
        description: "The acquisition."
      });
      yield* (yield* Patches.Patches).retire(secret.patchId, { userId: priya.id, admin: true });
      const send = yield* door("https://cloud.example", "203.0.113.34");
      const search = (words: string) =>
        Effect.map(send(call(ben.token, "find_patches", { search: words })), found);

      for (const [words, matches] of [
        ["renewals", ["deal-desk", "renewals"]],
        ["PRIYA board", ["renewals"]],
        ["pipeline", ["hiring"]],
        ["okafor  INTERVIEWS", ["hiring"]],
        ["desk renewals enterprise", ["deal-desk"]],
        ["   ", ["deal-desk", "hiring", "renewals"]],
        ["acquisition", []],
        ["secret", []],
        ["nothing-matches", []]
      ] as const) {
        const answer = yield* search(words);
        assert.deepStrictEqual(names(answer), [...matches], words);
        assert.strictEqual(answer.total, matches.length, words);
      }
      const event = (yield* send(call(ben.token, "find_patches", { search: "acquisition" }))).event;
      assert.include(event, { catalogueSearched: true, catalogueTotal: 0 });
      assert.notInclude(JSON.stringify(event), "acquisition");
    })
  );

  it.effect("answers bad arguments as tool results the agent can correct", () =>
    Effect.gen(function* () {
      const acme = yield* company("args", [["Priya Shah", "admin"]]);
      const priya = acme.people[0]!;
      const send = yield* door("https://cloud.example", "203.0.113.35");
      for (const [name, args] of [
        ["find_patches", { detail: "everything" }],
        ["find_patches", { search: 5 }],
        ["find_patches", { limit: 10 }],
        ["find_patches", { search: "x".repeat(201) }],
        ["find_patches", "everything"],
        ["open_patch", {}],
        ["open_patch", { patch: 7 }],
        ["open_patch", { patch: "" }],
        ["open_patch", { patch: "deals", tool: "listDeals" }]
      ] as const) {
        const response = yield* send(call(priya.token, name, args));
        assert.strictEqual(response.status, 200, JSON.stringify(args));
        const result = objectAt(response.json, "result");
        assert.isTrue(result["isError"]);
        const error = objectAt(result, "structuredContent.error");
        assert.include(error, { code: "invalid_args", from: "patchy" });
        assert.match(
          String(error["message"]),
          new RegExp(`^${name}'s arguments don't fit its schema: `)
        );
        assert.include(response.event, { mcpTool: name, code: "invalid_args", outcome: "refused" });
      }
      // Arguments left out are none.
      assert.isUndefined(
        at((yield* send(call(priya.token, "find_patches"))).json, "result.isError")
      );
    })
  );

  it.effect(
    "opens a patch by its name, id or address, in its own document through the shaper",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("open", [
          ["Priya Shah", "admin"],
          ["Ben Okafor", "member"]
        ]);
        const [priya, ben] = acme.people as [Person, Person];
        const business = yield* publish(acme.id, priya, "old-business", {
          handlers: deals,
          description: "Leads and deals."
        });
        // Renamed, it keeps its former name as a redirect, as its address does.
        yield* publish(acme.id, priya, "new-business", {
          handlers: deals,
          description: "Leads and deals.",
          patchId: business.patchId,
          update: true
        });
        yield* publish(acme.id, ben, "kickoff", { description: "The brief." });
        const patches = yield* Patches.Patches;
        const served = Option.getOrThrow(yield* patches.find(business.patchId));
        const document = openPatchAnswer(
          {
            name: "new-business",
            description: "Leads and deals.",
            owner: "Priya Shah",
            address: "https://cloud.example/door-open/new-business"
          },
          agentTools(served.version.manifest)
        );
        const send = yield* door("https://cloud.example", "203.0.113.36");
        for (const [patch, by] of [
          ["new-business", "name"],
          [" new-business ", "name"],
          ["old-business", "name"],
          [business.patchId, "id"],
          ["https://cloud.example/door-open/new-business", "address"],
          ["https://Cloud.Example:443/door-open/new-business/", "address"],
          ["https://cloud.example/door-open/new-business/board?stage=won#top", "address"],
          ["https://cloud.example/door-open/old-business", "address"]
        ] as const) {
          const response = yield* send(call(ben.token, "open_patch", { patch }));
          const result = objectAt(response.json, "result");
          assert.isUndefined(result["isError"], patch);
          assert.deepStrictEqual(result["structuredContent"], document, patch);
          assert.strictEqual(at(result, "content.0.text"), JSON.stringify(document));
          assert.include(response.event, {
            mcpTool: "open_patch",
            patchRef: by,
            patchId: business.patchId,
            versionId: served.version.id,
            resultBytes: Buffer.byteLength(JSON.stringify(document))
          });
        }
        assert.deepStrictEqual(
          at(
            (yield* send(call(ben.token, "open_patch", { patch: "kickoff" }))).json,
            "result.structuredContent"
          ),
          {
            name: "kickoff",
            description: "The brief.",
            owner: "Ben Okafor",
            address: "https://cloud.example/door-open/kickoff",
            tools: []
          }
        );
      })
  );

  it.effect("never finds a patch the person can't open, nor a namesake for another's address", () =>
    Effect.gen(function* () {
      const here = yield* company("here", [["Priya Shah", "admin"]]);
      const priya = here.people[0]!;
      const own = yield* publish(here.id, priya, "deals");
      const patches = yield* Patches.Patches;
      const retired = yield* publish(here.id, priya, "retired-deals");
      yield* patches.retire(retired.patchId, { userId: priya.id, admin: true });
      const deleted = yield* publish(here.id, priya, "deleted-deals");
      yield* patches.delete(deleted.patchId, { userId: priya.id, admin: true });
      const takenDown = yield* publish(here.id, priya, "taken-down");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patches SET disabled_at = now(), disabled_reason = 'test'
        WHERE id = ${takenDown.patchId}`;
      const there = yield* company("there", [["Cleo Admin", "admin"]]);
      const theirs = yield* publish(there.id, there.people[0]!, "deals");
      const only = yield* publish(there.id, there.people[0]!, "only-there");
      const send = yield* door("https://cloud.example", "203.0.113.37");
      const open = (patch: string) => send(call(priya.token, "open_patch", { patch }));

      const refusals = [];
      for (const patch of [
        "https://other.example/door-here/deals",
        "http://cloud.example/door-here/deals",
        "https://cloud.example:8443/door-here/deals",
        "https://cloud.example/door-there/deals",
        "https://cloud.example/door-there/only-there",
        "https://cloud.example/door-here",
        "https://cloud.example/deals",
        theirs.patchId,
        only.patchId,
        "only-there",
        "retired-deals",
        retired.patchId,
        "deleted-deals",
        deleted.patchId,
        "taken-down",
        takenDown.patchId,
        "https://cloud.example/door-here/taken-down",
        "unknown",
        "Deals"
      ]) {
        const response = yield* open(patch);
        assert.strictEqual(response.status, 200, patch);
        assert.include(response.event, { code: "not_found", outcome: "refused" }, patch);
        // The revision's own `_meta` aside.
        refusals.push(
          Object.fromEntries(
            Object.entries(objectAt(response.json, "result")).filter(([key]) => key !== "_meta")
          )
        );
      }
      // One refusal, word for word, however the patch was missing.
      for (const refusal of refusals) assert.deepStrictEqual(refusal, refusals[0]);
      assert.deepStrictEqual(refusals[0], {
        content: [
          {
            type: "text",
            text: "No patch you can open at Door here goes by that. Call find_patches to see the ones you can, and open one by the name it lists."
          }
        ],
        structuredContent: {
          error: {
            code: "not_found",
            from: "patchy",
            message:
              "No patch you can open at Door here goes by that. Call find_patches to see the ones you can, and open one by the name it lists."
          }
        },
        isError: true,
        resultType: "complete"
      });
      const opened = yield* open("https://cloud.example/door-here/deals");
      assert.strictEqual(at(opened.json, "result.structuredContent.name"), "deals");
      assert.include(opened.event, { patchId: own.patchId });
    })
  );

  it.effect("refuses to answer a patch over 64 KiB rather than send it", () =>
    Effect.gen(function* () {
      const acme = yield* company("large", [["Priya Shah", "admin"]]);
      const priya = acme.people[0]!;
      // Recorded straight to the database: the publish check would refuse these tools.
      yield* publish(acme.id, priya, "too-wordy", { handlers: wordy(40, 2_000) });
      const send = yield* door("https://cloud.example", "203.0.113.38");
      const response = yield* send(call(priya.token, "open_patch", { patch: "too-wordy" }));
      assert.deepStrictEqual(objectAt(response.json, "result.structuredContent.error"), {
        code: "too_large",
        from: "patchy",
        message:
          "too-wordy's agent tools are more than the 64 KiB an agent reads in one answer, so it can't be opened. Tell the person its owner, Priya Shah, can shorten their descriptions."
      });
      assert.isBelow(response.text.length, 1_000);
      // Finding it still works.
      assert.deepStrictEqual(names(found(yield* send(call(priya.token, "find_patches")))), [
        "too-wordy"
      ]);
    })
  );

  it.effect("keeps every find under the read cap, whatever the names and tools it lists", () =>
    Effect.gen(function* () {
      const acme = yield* company("bounded", [["P".repeat(100_000), "admin"]], {
        name: "C".repeat(100_000)
      });
      const person = acme.people[0]!;
      // Recorded straight to the database: tools no publish would let through, alone over the cap.
      yield* publish(acme.id, person, "huge-tools", { handlers: wordy(60, 2_000) });
      yield* publish(acme.id, person, "small-page");
      const send = yield* door("https://cloud.example", "203.0.113.39");
      // `found` checks each page against the cap.
      const answer = found(yield* send(call(person.token, "find_patches", { detail: "tools" })));
      assert.deepStrictEqual(answer.actingFor, {
        person: "P".repeat(200),
        company: "C".repeat(200)
      });
      assert.deepStrictEqual(names(answer), ["huge-tools", "small-page"]);
      // Too large to list with its words, the patch is listed with its tools' names.
      assert.strictEqual(answer.patches[0]!.tools.length, 60);
      assert.strictEqual(answer.patches[0]!.tools[0], "tool00");
    })
  );

  it.effect("finds and opens only what the person's openability rule lets them open", () =>
    Effect.gen(function* () {
      const acme = yield* company("narrower", [["Priya Shah", "admin"]]);
      const priya = acme.people[0]!;
      yield* publish(acme.id, priya, "open-board", { handlers: deals });
      const closed = yield* publish(acme.id, priya, "closed-board", { handlers: deals });
      const send = yield* door("https://cloud.example", "203.0.113.40");
      // The portal's rule, narrowed as a credential's reach would narrow it.
      const narrowed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(
          effect,
          Patches.Openability,
          (patch) => patch.name !== "closed-board"
        );
      const answer = found(yield* narrowed(send(call(priya.token, "find_patches"))));
      assert.deepStrictEqual(names(answer), ["open-board"]);
      assert.strictEqual(answer.total, 1);
      for (const patch of [
        "closed-board",
        closed.patchId,
        "https://cloud.example/door-narrower/closed-board"
      ]) {
        const refused = yield* narrowed(send(call(priya.token, "open_patch", { patch })));
        assert.strictEqual(
          at(refused.json, "result.structuredContent.error.code"),
          "not_found",
          patch
        );
      }
      // Without the narrowing, the same person opens it.
      assert.isUndefined(
        at(
          (yield* send(call(priya.token, "open_patch", { patch: "closed-board" }))).json,
          "result.isError"
        )
      );
    })
  );
});
