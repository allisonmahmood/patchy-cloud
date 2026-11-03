import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import {
  Authorization,
  CurrentIdentity,
  FileRequest,
  Identity,
  LinkRequest,
  PatchyApi,
  refuse,
  SendFeedback,
  Unauthorized
} from "@patchy/api";
import { NodeCryptography } from "@patchy/core";
import { Limits, OperatingLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Feedback from "./Feedback.js";
import * as FeedbackApi from "./FeedbackApi.js";

/** Bearer `<user id>` acts as that user in their company. Machine tokens are Auth's to test. */
const bearer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return Authorization.of({
      bearer: (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const userId = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
          const [user] = yield* sql<{ email: string; companyId: string }>`
            SELECT email, company_id AS "companyId" FROM users WHERE id = ${userId}`.pipe(
            Effect.orDie
          );
          if (user === undefined)
            return refuse(Unauthorized, { ok: false, error: "Missing or invalid API token." });
          return yield* Effect.provideService(
            httpEffect,
            CurrentIdentity,
            new Identity({
              user: { id: userId, email: user.email, name: userId },
              company: { id: user.companyId, handle: user.companyId, name: user.companyId },
              role: "member",
              machine: { id: `mch_${userId}`, name: "Laptop" }
            })
          );
        })
    });
  })
);

const layer = Layer.mergeAll(FeedbackApi.layer, HttpServer.layerServices).pipe(
  Layer.provideMerge(bearer),
  Layer.provideMerge(Feedback.layer),
  Layer.provideMerge(Layer.mergeAll(Limits.layer, OperatingLimits.layer, Analytics.layerNoop)),
  Layer.provideMerge(Layer.mergeAll(Testing.layer(), NodeFileSystem.layer, NodePath.layer)),
  Layer.provideMerge(Layer.mergeAll(NodeCryptography.layer, NodeCrypto.layer))
);

/** A person at their own company, with a client that names its CLI as `header` says. */
const person = Effect.fn("person")(function* (key: string, header?: string) {
  const sql = yield* SqlClient.SqlClient;
  const userId = `usr_${key}`;
  yield* sql`INSERT INTO companies (id, handle, name) VALUES (${`cmp_${key}`}, ${key}, ${key})`;
  yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
    VALUES (${userId}, ${`clerk_${key}`}, ${`cmp_${key}`}, ${`${key}@example.com`}, ${key}, 'member')`;
  const api = yield* HttpApiTest.groups(PatchyApi, ["feedback"]).pipe(
    Effect.provide(
      HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
        next(
          request.pipe(
            HttpClientRequest.bearerToken(userId),
            header === undefined
              ? (same) => same
              : HttpClientRequest.setHeader("patchy-cli", header)
          )
        )
      )
    )
  );
  return { userId, api };
});

const stored = (id: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ agent: string; cliVersion: string | null }>`
      SELECT agent, cli_version AS "cliVersion" FROM feedback.submissions WHERE id = ${id}`
  );

/** A response's status, `Retry-After` and JSON body, for a refusal compared whole. */
const answer = Effect.fn("answer")(function* (
  response: Effect.Effect<
    {
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly json: Effect.Effect<unknown, unknown>;
    },
    unknown
  >
) {
  const received = yield* Effect.orDie(response);
  return {
    status: received.status,
    retryAfter: received.headers["retry-after"],
    body: yield* Effect.orDie(received.json)
  };
});

it.layer(layer)("the feedback group", (it) => {
  it.effect(
    "files, links, lists, unlinks and withdraws as the token's person through the CLI",
    () =>
      Effect.gen(function* () {
        const ada = yield* person("routes", "0.34.0 publish codex");
        const filed = yield* ada.api.fileRequest({
          payload: new FileRequest({ text: "Gmail integration", why: "Sales lives in Gmail" })
        });
        assert.deepInclude(filed, { ok: true, similar: [] });
        const second = yield* ada.api.fileRequest({
          payload: new FileRequest({ text: "Gmail integration, please" })
        });
        assert.deepStrictEqual(second.similar, [
          { id: filed.id, title: "Gmail integration", status: "open" }
        ]);
        const linked = yield* ada.api.linkRequest({
          params: { id: second.id },
          payload: new LinkRequest({ to: filed.id, why: "Same need" })
        });
        assert.deepStrictEqual(
          { ...linked },
          {
            ok: true,
            id: second.id,
            link: { id: filed.id, title: "Gmail integration", status: "open" }
          }
        );
        const sent = yield* ada.api.sendFeedback({
          payload: new SendFeedback({ text: "Odd refusal" })
        });
        assert.deepStrictEqual(yield* stored(sent.id), [{ agent: "codex", cliVersion: "0.34.0" }]);

        const response = yield* ada.api.listSubmissions({
          query: {},
          responseMode: "response-only"
        });
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
        const page = yield* ada.api.listSubmissions({ query: { kind: "request" } });
        assert.deepStrictEqual(
          page.submissions.map(({ id, kind, surface, agent }) => ({ id, kind, surface, agent })),
          [
            { id: second.id, kind: "request", surface: "cli", agent: "codex" },
            { id: filed.id, kind: "request", surface: "cli", agent: "codex" }
          ]
        );
        assert.match(page.submissions[0]!.createdAt, /^\d{4}-\d\d-\d\dT.*Z$/);
        assert.notInclude(JSON.stringify(page), "Sales lives in Gmail");
        assert.notInclude(JSON.stringify(page), "Same need");

        assert.deepStrictEqual(
          { ...(yield* ada.api.unlinkRequest({ params: { id: second.id } })) },
          { ok: true, id: second.id, link: null }
        );
        assert.deepStrictEqual(
          { ...(yield* ada.api.withdraw({ params: { id: sent.id } })) },
          { ok: true, id: sent.id }
        );

        // Without the header the agent is unknown, which doesn't prove a person sent it.
        const bare = yield* person("bare");
        const unknown = yield* bare.api.fileRequest({
          payload: new FileRequest({ text: "Webhooks" })
        });
        assert.deepStrictEqual(yield* stored(unknown.id), [{ agent: "unknown", cliVersion: null }]);
      })
  );

  it.effect("refuses with the wire's stable codes", () =>
    Effect.gen(function* () {
      const ben = yield* person("refusals");
      const other = yield* person("refusals-elsewhere");
      const theirs = yield* other.api.fileRequest({
        payload: new FileRequest({ text: "Webhooks" })
      });
      const token = ["gh", "p_", "a1B2".repeat(9)].join("");
      const file = (text: string, why?: string) =>
        answer(
          ben.api.fileRequest({
            payload: new FileRequest({ text, ...(why === undefined ? {} : { why }) }),
            responseMode: "response-only"
          })
        );

      const secret = yield* file("Webhooks", `Mine is ${token}`);
      assert.deepStrictEqual(secret, {
        status: 422,
        retryAfter: undefined,
        body: {
          ok: false,
          code: "contains_secret",
          error:
            "Nothing was stored: `why` holds a GitHub token. Remove it, or replace it with <token>, and send it again.",
          secrets: [{ field: "why", kind: "github_token" }]
        }
      });
      assert.deepInclude((yield* file("ab")).body, { code: "invalid_text", field: "text" });
      assert.strictEqual((yield* file("x".repeat(70_000))).status, 413);

      const mine = yield* ben.api.fileRequest({ payload: new FileRequest({ text: "Webhooks" }) });
      assert.deepStrictEqual(
        yield* answer(
          ben.api.linkRequest({
            params: { id: mine.id },
            payload: new LinkRequest({ to: theirs.id }),
            responseMode: "response-only"
          })
        ),
        {
          status: 422,
          retryAfter: undefined,
          body: {
            ok: false,
            code: "invalid_link",
            error:
              "Nothing changed: a request links only to another request of your company or to a general request, by the id a match or list gave."
          }
        }
      );
      for (const withdrawn of [
        ben.api.withdraw({ params: { id: theirs.id }, responseMode: "response-only" }),
        ben.api.withdraw({ params: { id: "req_missing" }, responseMode: "response-only" })
      ])
        assert.deepInclude(yield* answer(withdrawn), { status: 404 });
      assert.deepInclude(
        (yield* answer(
          ben.api.unlinkRequest({ params: { id: theirs.id }, responseMode: "response-only" })
        )).body,
        { code: "not_found", error: `You sent no request or feedback with id ${theirs.id}.` }
      );
      assert.strictEqual(
        (yield* answer(
          ben.api.listSubmissions({ query: { cursor: "nope" }, responseMode: "response-only" })
        )).status,
        400
      );

      for (let sent = 1; sent < 10; sent++)
        yield* ben.api.sendFeedback({ payload: new SendFeedback({ text: `Note ${sent}` }) });
      const limited = yield* answer(
        ben.api.sendFeedback({
          payload: new SendFeedback({ text: "One more" }),
          responseMode: "response-only"
        })
      );
      assert.deepInclude(limited, { status: 429, retryAfter: "60" });
      assert.deepInclude(limited.body, { code: "rate_limited", retryAfterSeconds: 60 });
    })
  );
});
