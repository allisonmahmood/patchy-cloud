/**
 * `tell_patchy` through the door, a request at a time (`test/door.ts`): what it records and
 * answers, its refusals, and every revision offering it. Feedback's own rules, such as matching
 * and the secret check's shapes, are `packages/feedback`'s tests.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Feedback } from "@patchy/feedback";
import {
  at,
  call,
  company,
  door,
  harness,
  legacy,
  modern,
  objectAt,
  PRODUCTION,
  type Sent
} from "./test/door.js";

const PAGE = `${PRODUCTION}/feedback`;

const Stored = Schema.Struct({
  kind: Schema.String,
  text: Schema.String,
  why: Schema.NullOr(Schema.String),
  userId: Schema.String,
  companyId: Schema.String,
  surface: Schema.String,
  agent: Schema.NullOr(Schema.String)
});
const decodeStored = Schema.decodeUnknownSync(Schema.Array(Stored));
const decodeNames = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })));

/** Everything a person has sent, oldest first, as the store keeps it. */
const storedBy = Effect.fn("storedBy")(function* (userId: string) {
  const sql = yield* SqlClient.SqlClient;
  return decodeStored(
    yield* sql`
      SELECT kind, text, why, user_id AS "userId", company_id AS "companyId", surface, agent
      FROM feedback.submissions WHERE user_id = ${userId} ORDER BY created_at, id`
  );
});

it.layer(harness)("tell_patchy", (it) => {
  it.effect(
    "sends a request as the person via the connection's client, answering its matches and their page",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO feedback.general_requests (title, status, note)
          VALUES ('Calendar sync for patches', 'shipped', 'Connect Google Calendar on Integrations.')`;
        const acme = yield* company("tell-request", [["Ada Admin", "admin"]]);
        const ada = acme.people[0]!;
        const send = yield* door(PRODUCTION, "203.0.113.40");

        const response = yield* send(
          call(ada.token, "tell_patchy", {
            kind: "request",
            text: "Calendar sync for our booking patch",
            why: "The team books rooms twice a day"
          })
        );
        assert.strictEqual(response.status, 200);
        assert.isUndefined(at(response.json, "result.isError"));
        const answer = objectAt(response.json, "result.structuredContent");
        assert.deepStrictEqual(Object.keys(answer), ["id", "similar", "next", "url"]);
        assert.match(String(answer["id"]), /^req_[a-z0-9]{24}$/u);
        assert.deepStrictEqual(answer["similar"], [
          {
            id: at(answer, "similar.0.id"),
            title: "Calendar sync for patches",
            status: "shipped",
            note: "Connect Google Calendar on Integrations."
          }
        ]);
        assert.strictEqual(answer["url"], PAGE);
        assert.strictEqual(
          answer["next"],
          `Patchy's team has this request, sent as the person you act for. A similar request has shipped: tell the person, using its note. They can see or withdraw it at ${PAGE}.`
        );
        assert.deepStrictEqual(JSON.parse(String(at(response.json, "result.content.0.text"))), {
          ...answer
        });
        assert.include(response.event, {
          mcpTool: "tell_patchy",
          submissionId: String(answer["id"])
        });

        assert.deepStrictEqual(yield* storedBy(ada.id), [
          {
            kind: "request",
            text: "Calendar sync for our booking patch",
            why: "The team books rooms twice a day",
            userId: ada.id,
            companyId: acme.id,
            surface: "mcp",
            agent: "Claude Code"
          }
        ]);
      })
  );

  it.effect("sends feedback as the person, answering its id and their page, where both show", () =>
    Effect.gen(function* () {
      const acme = yield* company("tell-feedback", [
        ["Ben Member", "member"],
        ["Bea Admin", "admin"]
      ]);
      const ben = acme.people[0]!;
      const send = yield* door(PRODUCTION, "203.0.113.41");

      const request = objectAt(
        (yield* send(
          call(ben.token, "tell_patchy", { kind: "request", text: "Quarterly zebra reports" })
        )).json,
        "result.structuredContent"
      );
      // No match has shipped, so there is nothing to tell the person about.
      assert.deepStrictEqual(request["similar"], []);
      assert.notInclude(String(request["next"]), "shipped");

      const response = yield* send(
        call(ben.token, "tell_patchy", {
          kind: "feedback",
          text: "open_patch said the patch changed, but nothing had been published.",
          why: " "
        })
      );
      const answer = objectAt(response.json, "result.structuredContent");
      assert.deepStrictEqual(Object.keys(answer), ["id", "next", "url"]);
      assert.match(String(answer["id"]), /^fbk_[a-z0-9]{24}$/u);
      assert.strictEqual(
        answer["next"],
        `Patchy's team has this feedback, sent as the person you act for. They can see or withdraw it at ${PAGE}.`
      );
      assert.strictEqual(answer["url"], PAGE);

      // The person's own list, which their page shows, has both, through this connection's client.
      const page = yield* (yield* Feedback.Feedback).list({
        person: { userId: ben.id, companyId: acme.id }
      });
      assert.deepStrictEqual(
        page.submissions.map(({ kind, id, surface, agent }) => ({ kind, id, surface, agent })),
        [
          { kind: "feedback", id: String(answer["id"]), surface: "mcp", agent: "Claude Code" },
          { kind: "request", id: String(request["id"]), surface: "mcp", agent: "Claude Code" }
        ]
      );
    })
  );

  it.effect("refuses with the service's codes, saying what to rewrite, and stores nothing", () =>
    Effect.gen(function* () {
      const acme = yield* company("tell-refused", [["Cleo Admin", "admin"]]);
      const cleo = acme.people[0]!;
      const send = yield* door(PRODUCTION, "203.0.113.42");
      const refusal = (args: unknown) =>
        send(call(cleo.token, "tell_patchy", args)).pipe(
          Effect.map((response) => {
            assert.strictEqual(response.status, 200);
            assert.strictEqual(at(response.json, "result.isError"), true);
            const error = objectAt(response.json, "result.structuredContent.error");
            assert.include(response.event, {
              mcpTool: "tell_patchy",
              code: String(error["code"]),
              outcome: "refused"
            });
            return error;
          })
        );
      const token = `ghp_${"a1B2".repeat(9)}`;

      const secret = yield* refusal({ kind: "feedback", text: `publish failed with ${token}` });
      assert.deepStrictEqual(secret, {
        code: "contains_secret",
        from: "patchy",
        message:
          "Nothing was stored: `text` holds a GitHub token. Remove it, or replace it with <token>, and send it again.",
        details: { secrets: [{ field: "text", kind: "github_token" }] }
      });

      assert.deepStrictEqual(
        yield* refusal({ kind: "request", text: "Gmail ".repeat(40), why: "Sales lives there" }),
        {
          code: "invalid_text",
          from: "patchy",
          message:
            "Nothing was stored: `text` must be 3–200 characters, with no control characters. A request's text is its title, one line saying what Patchy should do; put the rest in why and send it again.",
          details: { field: "text" }
        }
      );

      // A why on feedback is refused, not dropped; so is anything outside the schema.
      for (const args of [
        { kind: "feedback", text: "The publish check was confusing", why: "It named no file" },
        { kind: "bug", text: "Something broke" },
        { kind: "request", text: "Gmail integration", link: "req_x" }
      ])
        assert.include(yield* refusal(args), { code: "invalid_args", from: "patchy" });
      assert.match(
        String(
          (yield* refusal({ kind: "feedback", text: "Confusing", why: "Because" }))["message"]
        ),
        /why is for requests only\. Nothing was stored\. Put the reason in text/u
      );
      assert.deepStrictEqual(yield* storedBy(cleo.id), []);

      // Ten sends a minute, across kinds; the eleventh waits.
      for (const n of Array.from({ length: 10 }, (_, index) => index))
        assert.isUndefined(
          at(
            (yield* send(call(cleo.token, "tell_patchy", { kind: "feedback", text: `Note ${n}` })))
              .json,
            "result.isError"
          )
        );
      const limited = yield* refusal({ kind: "request", text: "Gmail integration" });
      assert.include(limited, { code: "rate_limited", from: "patchy" });
      assert.isAbove(Number(limited["retryAfterSeconds"]), 0);
      assert.match(String(limited["message"]), /^Nothing was stored: .* Send it again in \d+/u);
      assert.lengthOf(yield* storedBy(cleo.id), 10);
    })
  );

  it.effect("is listed and called on every revision the door serves", () =>
    Effect.gen(function* () {
      const acme = yield* company("tell-revisions", [["Dev Admin", "admin"]]);
      const dev = acme.people[0]!;
      const send = yield* door(PRODUCTION, "203.0.113.43");
      const args = { kind: "feedback", text: "Revision check" };
      for (const revision of ["2026-07-28", "2025-11-25", "2025-06-18"]) {
        const [list, tell]: ReadonlyArray<Sent> =
          revision === "2026-07-28"
            ? [modern(dev.token, "tools/list"), call(dev.token, "tell_patchy", args)]
            : [
                legacy(dev.token, "tools/list"),
                legacy(dev.token, "tools/call", { name: "tell_patchy", arguments: args })
              ].map((sent) => ({ ...sent, headers: { "mcp-protocol-version": revision } }));
        const listed = yield* send(list!);
        assert.include(
          decodeNames(at(listed.json, "result.tools")).map((tool) => tool.name),
          "tell_patchy",
          revision
        );
        const told = yield* send(tell!);
        assert.match(
          String(at(told.json, "result.structuredContent.id")),
          /^fbk_/u,
          `${revision}: ${told.text}`
        );
        assert.include(told.event, {
          protocolEra: revision === "2026-07-28" ? "modern" : "legacy",
          protocolVersion: revision
        });
      }
      assert.lengthOf(yield* storedBy(dev.id), 3);
    })
  );
});
