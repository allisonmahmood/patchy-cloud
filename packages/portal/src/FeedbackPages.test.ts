import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import * as Testing from "@patchy/company-database/testing";
import { htmlPage, NodeCryptography, WhatsNew } from "@patchy/core";
import { Feedback } from "@patchy/feedback";
import { Limits, OperatingLimits } from "@patchy/limits";
import * as FeedbackPages from "./FeedbackPages.js";

const services = Layer.mergeAll(Session.layer, Companies.layer, Users.layer, Feedback.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Limits.layer, OperatingLimits.layer, Analytics.layerNoop)),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(Testing.resourceChangesLayer),
  Layer.provideMerge(Layer.mergeAll(NodeCryptography.layer, NodeCrypto.layer)),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);
const layer = HttpRouter.serve(FeedbackPages.layer, {
  disableLogger: true,
  disableListenLog: true
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(services),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
);

let counter = 0;
/** A member of a company of their own, and how they send through the CLI and Patchy MCP. */
const person = Effect.fn("FeedbackPagesTest.person")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const key = `feedback_pages_${++counter}`;
  const [userId, companyId] = [`usr_${key}`, `cmp_${key}`];
  yield* sql`INSERT INTO companies (id, handle, name) VALUES (${companyId}, ${`feedback-pages-${counter}`}, 'Northwind')`;
  yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
    VALUES (${userId}, ${`clerk_${key}`}, ${companyId}, ${`${key}@patchy.local`}, 'Ada Park', 'member')`;
  return { userId, companyId, clerkUserId: `clerk_${key}`, email: `${key}@patchy.local` };
});
type Person = Effect.Success<ReturnType<typeof person>>;

const request = Effect.fn("FeedbackPagesTest.request")(function* (
  who: Person,
  input: HttpClientRequest.HttpClientRequest
) {
  const cookie = signedInCookies(
    signSession({ sub: who.clerkUserId, email: who.email, name: "Ada Park" })
  );
  return yield* (yield* HttpClient.HttpClient).execute(
    input.pipe(HttpClientRequest.setHeaders({ cookie }))
  );
});

/** A form as the browser posts it; `panel` as the Tell Patchy panel's script sends it. */
const post = (path: string, fields: Record<string, string>, panel = true) =>
  HttpClientRequest.post(path).pipe(
    HttpClientRequest.bodyText(
      new URLSearchParams(fields).toString(),
      "application/x-www-form-urlencoded"
    ),
    HttpClientRequest.setHeaders({
      origin: PUBLIC_BASE_URL,
      ...(panel ? { "patchy-panel": "tell" } : {})
    })
  );

const submissions = (who: Person) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      id: string;
      kind: string;
      text: string;
      why: string | null;
      surface: string;
      agent: string | null;
      linkGeneralId: string | null;
    }>`
      SELECT id, kind, text, why, surface, agent, link_general_id AS "linkGeneralId"
      FROM feedback.submissions WHERE user_id = ${who.userId} ORDER BY created_at`
  );

describe("a dashboard request's title and why", () => {
  const { TITLE_MAX, TEXT_MAX } = Feedback;
  /** Words "w0 w1 w2 …" running to at least `length` characters. */
  const words = (length: number) => {
    let text = "w0";
    for (let index = 1; text.length < length; index++) text += ` w${index}`;
    return text;
  };

  it("keeps text that fits a title as the title alone, on one line", () => {
    assert.deepStrictEqual(FeedbackPages.requestOf("  Gmail\n  integration "), {
      title: "Gmail integration",
      why: null
    });
    const full = "x".repeat(TITLE_MAX);
    assert.deepStrictEqual(FeedbackPages.requestOf(full), { title: full, why: null });
    // Too short is the store's to refuse.
    assert.deepStrictEqual(FeedbackPages.requestOf("Hi"), { title: "Hi", why: null });
  });

  it("takes a long text's first line as its title when it fits, and all of the text as its why", () => {
    const paragraph = `Gmail integration for the sales inbox\n\n${words(400)}`;
    assert.deepStrictEqual(FeedbackPages.requestOf(`${paragraph}\n`), {
      title: "Gmail integration for the sales inbox",
      why: paragraph
    });
    const longest = "y".repeat(TITLE_MAX);
    assert.strictEqual(FeedbackPages.requestOf(`${longest}\n${words(50)}`).title, longest);
    // A first line too short or too long gives way to the text's opening words.
    assert.strictEqual(FeedbackPages.requestOf(`Hi\n${words(400)}`).title.slice(0, 6), "Hi w0 ");
    assert.isTrue(
      FeedbackPages.requestOf(`${"z".repeat(TITLE_MAX + 1)}\nmore`).title.endsWith("…")
    );
  });

  it("cuts one long line at its last word boundary before the limit", () => {
    const line = words(400);
    const { title, why } = FeedbackPages.requestOf(line);
    assert.strictEqual(why, line);
    assert.isAtMost([...title].length, TITLE_MAX);
    assert.isTrue(title.endsWith("…"));
    const kept = title.slice(0, -1);
    assert.isTrue(line.startsWith(`${kept} `), title);
    assert.isAbove([...kept].length, TITLE_MAX - 8);
    // A word ending exactly at the room left for "…" is kept whole.
    const exact = `${"a".repeat(TITLE_MAX - 1)} bcd`;
    assert.strictEqual(FeedbackPages.requestOf(exact).title, `${"a".repeat(TITLE_MAX - 1)}…`);
    // With no word boundary, it cuts mid-word, counting characters rather than UTF-16 units.
    const unbroken = FeedbackPages.requestOf("🙂".repeat(TITLE_MAX + 50)).title;
    assert.strictEqual(unbroken, `${"🙂".repeat(TITLE_MAX - 1)}…`);
  });

  it("caps the panel's field at the longest text the store keeps", () => {
    const shell = htmlPage({
      title: "Home",
      body: "",
      app: {
        viewer: {
          user: { name: "Ada Park", email: "ada@acme.example" },
          company: { name: "Acme Co" },
          whatsNewSeen: WhatsNew.latestRelease
        },
        section: "home"
      }
    });
    assert.include(shell, `name="text" maxlength="${TEXT_MAX}"`);
  });
});

it.layer(layer)("Feedback pages", (it) => {
  it.effect(
    "sends a request from the panel as the dashboard, shows similar requests, then links and unlinks one",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ada = yield* person();
        const [general] = yield* sql<{ id: string }>`
          INSERT INTO feedback.general_requests (title, status, note)
          VALUES ('Postgres encryption options', 'shipped', 'Pick Verify full on the connect page.')
          RETURNING id`;

        const sent = yield* request(
          ada,
          post("/feedback", { kind: "request", text: "Postgres connection  encrypted with RSA" })
        );
        assert.strictEqual(sent.status, 200);
        assert.strictEqual(sent.headers["patchy-panel"], "tell");
        const html = yield* sent.text;
        assert.include(
          html,
          '<strong class="note-title">Request sent</strong>Postgres connection encrypted with RSA'
        );
        assert.include(html, "<strong>Postgres encryption options</strong>");
        assert.include(html, '<span class="pill pill-done">Shipped</span>');
        assert.include(html, "Pick Verify full on the connect page.");

        const [stored] = yield* submissions(ada);
        assert.deepInclude(stored, {
          kind: "request",
          surface: "dashboard",
          agent: null,
          linkGeneralId: null
        });
        const id = stored!.id;
        assert.include(html, `action="/feedback/${id}/link"`);
        assert.include(html, `name="to" value="${general!.id}"`);

        const linked = yield* request(ada, post(`/feedback/${id}/link`, { to: general!.id }));
        assert.strictEqual(linked.status, 200);
        assert.strictEqual((yield* submissions(ada))[0]?.linkGeneralId, general!.id);
        const listed = yield* (yield* request(ada, HttpClientRequest.get("/feedback"))).text;
        assert.include(listed, "Same need as Postgres encryption options");
        assert.include(listed, `action="/feedback/${id}/unlink"`);

        // From What you sent's row menu, without the panel: back to the list with a receipt.
        const unlinked = yield* request(ada, post(`/feedback/${id}/unlink`, {}, false));
        assert.strictEqual(unlinked.status, 303);
        assert.strictEqual(unlinked.headers.location, "/feedback");
        assert.isNull((yield* submissions(ada))[0]?.linkGeneralId);
      })
  );

  it.effect(
    "files a pasted paragraph as a title and a why, refusing only too short or past the field's cap",
    () =>
      Effect.gen(function* () {
        const ada = yield* person();
        const paragraph = `Gmail integration for the sales inbox\n\n${"Leads land in the shared inbox and someone copies each one into the CRM by hand. ".repeat(6)}`;
        const sent = yield* request(ada, post("/feedback", { kind: "request", text: paragraph }));
        assert.strictEqual(sent.status, 200);
        assert.include(
          yield* sent.text,
          '<strong class="note-title">Request sent</strong>Gmail integration for the sales inbox</p>'
        );
        assert.deepInclude((yield* submissions(ada))[0], {
          text: "Gmail integration for the sales inbox",
          why: paragraph.trim()
        });

        for (const [text, refusal] of [
          ["Hi", "A request is at least 3 characters"],
          ["x".repeat(Feedback.TEXT_MAX + 1), "Your request is longer than 4,000 characters"]
        ] as const) {
          const refused = yield* request(ada, post("/feedback", { kind: "request", text }));
          assert.strictEqual(refused.status, 422);
          assert.include(yield* refused.text, refusal);
        }
        assert.lengthOf(yield* submissions(ada), 1);
      })
  );

  it.effect("refuses a secret without saving it or sending the draft back", () =>
    Effect.gen(function* () {
      const ada = yield* person();
      const key = `AIza${"x".repeat(35)}`;
      const text = `Gmail integration for the sales inbox. Our key is ${key} if it helps.`;
      for (const panel of [true, false]) {
        const refused = yield* request(ada, post("/feedback", { kind: "request", text }, panel));
        assert.strictEqual(refused.status, 422);
        const body = yield* refused.text;
        assert.include(body, "Your request has a Google API key in it");
        assert.include(body, "Nothing was saved.");
        assert.notInclude(body, key);
        assert.notInclude(body, "sales inbox");
        assert.notInclude(refused.headers.location ?? "", "AIza");
      }
      assert.deepStrictEqual(yield* submissions(ada), []);
    })
  );

  it.effect("lists what agents sent beside the person's own, and withdraws one", () =>
    Effect.gen(function* () {
      const ada = yield* person();
      const feedback = yield* Feedback.Feedback;
      const me = { userId: ada.userId, companyId: ada.companyId };
      const filed = yield* feedback.sendRequest({
        sender: {
          ...me,
          surface: "cli",
          agent: "claude-code",
          cliVersion: "0.36.0",
          patchId: null
        },
        text: "Gmail integration for the sales inbox"
      });
      yield* feedback.sendFeedback({
        sender: { ...me, surface: "mcp", agent: "ChatGPT" },
        text: "The refusal didn't say which file broke the rule"
      });
      yield* feedback.sendRequest({
        sender: { ...me, surface: "cli", agent: "unknown", cliVersion: null, patchId: null },
        text: "Host patches on our own servers"
      });
      assert.strictEqual(
        (yield* request(ada, post("/feedback", { kind: "feedback", text: "Lovely" }, false)))
          .status,
        303
      );

      const listed = yield* request(ada, HttpClientRequest.get("/feedback"));
      assert.strictEqual(listed.status, 200);
      const html = yield* listed.text;
      // Newest first: the person's own feedback, then their agents', each named with its surface.
      const order = [
        '<strong>You</strong><span class="supporting-text">Dashboard</span>',
        '<strong>Unknown agent</strong><span class="supporting-text">CLI</span>',
        '<strong>ChatGPT</strong><span class="supporting-text">Patchy MCP</span>',
        '<strong>Claude Code</strong><span class="supporting-text">CLI</span>'
      ].map((from) => html.indexOf(from));
      assert.notInclude(order, -1);
      assert.deepStrictEqual(
        order,
        [...order].sort((a, b) => a - b)
      );
      assert.include(html, "<strong>Gmail integration for the sales inbox</strong>");
      assert.notInclude(html, "which file broke the rule");
      assert.notInclude(html, "Lovely");

      const asked = yield* request(ada, HttpClientRequest.get(`/feedback/${filed.id}/withdraw`));
      assert.strictEqual(asked.status, 200);
      const confirm = yield* asked.text;
      assert.include(confirm, "Withdraw “Gmail integration for the sales inbox”?");
      assert.include(
        confirm,
        "Patchy deletes it and everything Claude Code sent with it. You can’t undo this."
      );
      assert.include(
        confirm,
        '<button class="btn btn-danger" type="submit">Withdraw request</button>'
      );

      const done = yield* request(ada, post(`/feedback/${filed.id}/withdraw`, {}, false));
      assert.strictEqual(done.status, 303);
      assert.strictEqual(done.headers.location, "/feedback");
      assert.notInclude(
        (yield* submissions(ada)).map(({ id }) => id),
        filed.id
      );
      // Someone else's id, or one already withdrawn, is not theirs to see.
      const other = yield* person();
      assert.strictEqual(
        (yield* request(other, HttpClientRequest.get(`/feedback/${filed.id}/withdraw`))).status,
        404
      );
    })
  );
});
