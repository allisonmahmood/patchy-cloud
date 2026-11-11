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
import { NodeCryptography } from "@patchy/core";
import { SUBMISSION_TEXT_MAX, SUBMISSION_TITLE_MAX } from "@patchy/api";
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
  const TITLE_MAX = SUBMISSION_TITLE_MAX;
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
        // Success is quiet: a receipt naming what was sent, then the matches with their status.
        assert.match(
          html,
          /^<p class="receipt" role="status"><svg[^]*?<\/svg><span>Request sent: Postgres connection encrypted with RSA<\/span><\/p>/
        );
        assert.include(html, '<span class="row-name">Postgres encryption options</span>');
        assert.include(html, '<span class="badge badge-success">Shipped</span>');
        assert.include(html, '<span class="row-desc">Pick Verify full on the connect page.</span>');
        assert.include(html, 'data-tell="done"');

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
    "without the panel's script, a sent request has its own address, where Same need and Unlink come back to it; only its sender sees it",
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
          post(
            "/feedback",
            { kind: "request", text: "Postgres connection encrypted with RSA" },
            false
          )
        );
        assert.strictEqual(sent.status, 303);
        const [stored] = yield* submissions(ada);
        const id = stored!.id;
        const at = `/feedback/${id}/sent`;
        assert.strictEqual(sent.headers.location, at);

        const form = (html: string, act: "link" | "unlink") =>
          html.match(
            new RegExp(
              `<form method="post" action="/feedback/${id}/${act}" data-tell="${act}" data-match="0"( hidden)?>`
            )
          )?.[1] === undefined
            ? "shown"
            : "hidden";
        const linkedReceipt = (html: string) =>
          html.includes('<div data-tell="linked" data-match="0"><p class="receipt"')
            ? "shown"
            : "hidden";
        // A dialog over What you sent: the receipt, the match with its status, note and Same need.
        const page = yield* (yield* request(ada, HttpClientRequest.get(at))).text;
        assert.include(page, 'role="dialog" aria-modal="true" aria-labelledby="sent-title"');
        assert.include(page, "<span>Request sent: Postgres connection encrypted with RSA</span>");
        assert.include(page, '<span class="badge badge-success">Shipped</span>');
        assert.include(page, "Pick Verify full on the connect page.");
        assert.include(page, `name="to" value="${general!.id}"`);
        assert.deepStrictEqual(
          [form(page, "link"), form(page, "unlink"), linkedReceipt(page)],
          ["shown", "hidden", "hidden"]
        );
        assert.include(page, '<a class="btn btn-primary" href="/feedback">Done</a>');
        assert.include(page, '<table class="table" aria-label="What you sent">');

        // Same need posts and comes back to it, linked; Unlink from it comes back unlinked.
        const linked = yield* request(
          ada,
          post(`/feedback/${id}/link`, { to: general!.id }, false)
        );
        assert.strictEqual(linked.status, 303);
        assert.strictEqual(linked.headers.location, at);
        assert.strictEqual((yield* submissions(ada))[0]?.linkGeneralId, general!.id);
        const after = yield* (yield* request(ada, HttpClientRequest.get(at))).text;
        assert.deepStrictEqual(
          [form(after, "link"), form(after, "unlink"), linkedReceipt(after)],
          ["hidden", "shown", "shown"]
        );
        assert.include(after, "<span>Linked to Postgres encryption options</span>");
        const unlinked = yield* request(
          ada,
          post(`/feedback/${id}/unlink`, { from: "sent" }, false)
        );
        assert.strictEqual(unlinked.status, 303);
        assert.strictEqual(unlinked.headers.location, at);
        assert.isNull((yield* submissions(ada))[0]?.linkGeneralId);
        const back = yield* (yield* request(ada, HttpClientRequest.get(at))).text;
        assert.strictEqual(form(back, "link"), "shown");

        // Someone else's request, or feedback, which has no matches, isn't there for them.
        const other = yield* person();
        assert.strictEqual((yield* request(other, HttpClientRequest.get(at))).status, 404);
        assert.strictEqual(
          (yield* request(ada, post("/feedback", { kind: "feedback", text: "Lovely" }, false)))
            .headers.location,
          "/feedback"
        );
        const note = (yield* submissions(ada)).find(({ kind }) => kind === "feedback")!;
        assert.strictEqual(
          (yield* request(ada, HttpClientRequest.get(`/feedback/${note.id}/sent`))).status,
          404
        );
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
          "<span>Request sent: Gmail integration for the sales inbox</span></p>"
        );
        assert.deepInclude((yield* submissions(ada))[0], {
          text: "Gmail integration for the sales inbox",
          why: paragraph.trim()
        });

        // The cap counts characters, as the store does: an emoji is one, though it is two UTF-16 units.
        const longest = `${"x".repeat(SUBMISSION_TEXT_MAX - 1)}🙂`;
        for (const kind of ["request", "feedback"] as const)
          assert.strictEqual(
            (yield* request(ada, post("/feedback", { kind, text: longest }))).status,
            200,
            kind
          );
        assert.deepInclude((yield* submissions(ada))[1], { why: longest });
        assert.deepInclude((yield* submissions(ada))[2], { text: longest });

        for (const [kind, text, refusal] of [
          ["request", "Hi", "A request is at least 3 characters"],
          ["request", `x${longest}`, "Your request is longer than 4,000 characters"],
          ["feedback", `x${longest}`, "Your feedback is longer than 4,000 characters"]
        ] as const) {
          const refused = yield* request(ada, post("/feedback", { kind, text }));
          assert.strictEqual(refused.status, 422);
          assert.include(yield* refused.text, refusal);
        }
        assert.lengthOf(yield* submissions(ada), 3);
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
        if (panel) {
          // The panel's form, drawn again with the field's error and an empty field: the draft
          // stays in the person's own textarea, client-side.
          assert.strictEqual(refused.headers["patchy-panel"], "tell");
          assert.include(body, '<p class="field-error" id="tell-patchy-text-error">');
          assert.include(body, 'aria-invalid="true"');
          assert.match(body, /<textarea[^>]*name="text"[^>]*><\/textarea>/);
        } else assert.include(body, '<div class="notice notice-danger" role="alert">');
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
        '<span class="strong">You</span><br><span class="meta">Dashboard</span>',
        '<span class="strong">Unknown agent</span><br><span class="meta">CLI</span>',
        '<span class="strong">ChatGPT</span><br><span class="meta">Patchy MCP</span>',
        '<span class="strong">Claude Code</span><br><span class="meta">CLI</span>'
      ].map((from) => html.indexOf(from));
      assert.notInclude(order, -1);
      assert.deepStrictEqual(
        order,
        [...order].sort((a, b) => a - b)
      );
      assert.include(html, '<span class="row-name">Gmail integration for the sales inbox</span>');
      assert.include(html, '<table class="table" aria-label="What you sent">');
      assert.notInclude(html, "which file broke the rule");
      assert.notInclude(html, "Lovely");

      // Someone else can't see, withdraw, link or unlink it while it stands.
      const other = yield* person();
      for (const [method, act, panel] of [
        ["GET", "withdraw", false],
        ["POST", "withdraw", false],
        ["POST", "link", true],
        ["POST", "unlink", true]
      ] as const) {
        const path = `/feedback/${filed.id}/${act}`;
        const tried = yield* request(
          other,
          method === "GET" ? HttpClientRequest.get(path) : post(path, { to: filed.id }, panel)
        );
        assert.strictEqual(tried.status, 404, `${method} ${act}`);
      }
      assert.include(
        (yield* submissions(ada)).map(({ id }) => id),
        filed.id
      );

      const asked = yield* request(ada, HttpClientRequest.get(`/feedback/${filed.id}/withdraw`));
      assert.strictEqual(asked.status, 200);
      const confirm = yield* asked.text;
      // A dialog over What you sent, its Cancel first and focused, then the act it names.
      assert.include(confirm, 'role="dialog" aria-modal="true"');
      assert.include(confirm, ">Withdraw “Gmail integration for the sales inbox”?</h2>");
      assert.include(
        confirm,
        "Patchy deletes it and everything Claude Code sent with it. You can’t undo this."
      );
      assert.include(confirm, `<form method="post" action="/feedback/${filed.id}/withdraw"`);
      assert.match(
        confirm,
        /href="\/feedback" autofocus>Cancel<\/a><button class="btn btn-danger-solid" type="submit">Withdraw request<\/button>/
      );
      assert.include(confirm, '<table class="table" aria-label="What you sent">');

      const done = yield* request(ada, post(`/feedback/${filed.id}/withdraw`, {}, false));
      assert.strictEqual(done.status, 303);
      assert.strictEqual(done.headers.location, "/feedback");
      assert.notInclude(
        (yield* submissions(ada)).map(({ id }) => id),
        filed.id
      );
      // Once withdrawn, it is gone for its sender too.
      assert.strictEqual(
        (yield* request(ada, HttpClientRequest.get(`/feedback/${filed.id}/withdraw`))).status,
        404
      );
    })
  );
});
