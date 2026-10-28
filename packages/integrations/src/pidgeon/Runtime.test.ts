import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv } from "@patchy/auth/testing";
import { Companies, Directory, Users } from "@patchy/companies";
import { sha256 } from "@patchy/core";
import { Limits, OperatingLimits } from "@patchy/limits";
import {
  Binding,
  InvocationCapabilities,
  InvocationLog,
  Runtime,
  RuntimeLog
} from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as CompanyTesting from "../../../company-database/src/testing.js";
import * as MutationTransaction from "../../../primitives/src/MutationTransaction.js";
import * as QuerySnapshot from "../../../primitives/src/QuerySnapshot.js";
import * as TestWakes from "../../../primitives/src/test/wakes.js";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as AttioSource from "../attio/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as PidgeonTest from "../test/pidgeon.js";
import * as RuntimeTest from "../test/runtime.js";
import * as Operations from "./Operations.js";

/**
 * Pidgeon journeys over answers recorded from Pidgeon: the generated tier 1 client over the
 * runtime wire with a signed-in viewer, and a tier 2 action in real workerd through the callback
 * gateway, both from the packed `patchy` package. The same journeys against Pidgeon's test mode
 * are in the live tier (`packages/integrations/live`).
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
/** Text no recent call or log line may ever hold: a body, and search text. */
const SENTINEL = "SENTINEL-7f3a-body-or-search";

const support = { id: "conn_journey_send", handle: "journey-send" };
const invoices = { id: "conn_journey_read", handle: "journey-read" };
const address = { email: `${support.handle}@acme.example`, identityId: `idn-${support.id}` };
const snapshot = <const Access extends "read" | "send">(access: Access, email: string) => ({
  version: 1 as const,
  address: { email, displayName: null, sendPolicy: "reply_only" },
  access,
  test: true,
  labels: [],
  plan: "free"
});
const uses = {
  support: { kind: "pidgeon" as const, ...support, revision: 1 },
  invoices: { kind: "pidgeon" as const, ...invoices, revision: 1 }
};

const page = (data: ReadonlyArray<unknown>, next: string | null = null) => ({
  data,
  has_more: next !== null,
  next_cursor: next
});
const threadRow = {
  id: "thr_1",
  identity: address.email,
  subject: "Cracked chainstay",
  status: "open",
  owner_type: "human",
  message_count: 1,
  folder: "inbox",
  from: "ana@customer.example",
  from_name: "Ana",
  preview: "Hi Lumen team",
  has_attachments: true,
  last_message_at: "2026-10-26T09:00:00.000Z",
  created_at: "2026-10-26T09:00:00.000Z"
};
const messageRow = {
  id: "msg_1",
  thread_id: "thr_1",
  identity_id: address.identityId,
  from: { email: "ana@customer.example", name: "Ana" },
  to: [{ email: address.email, name: null }],
  cc: [],
  subject: "Cracked chainstay",
  text: "Is this covered?",
  html: "<p>Is this covered?</p>",
  test: true,
  is_held: false,
  firewall: { verdict: "clean", signals: [], clean_text: "Is this covered?", version: 3 },
  attachments: [
    {
      id: "att_1",
      filename: "receipt.txt",
      content_type: "text/plain",
      size: 64,
      downloadable: true
    }
  ],
  delivery: null,
  created_at: "2026-10-26T09:00:00.000Z"
};
const answers: ReadonlyArray<PidgeonTest.Recorded> = [
  { match: PidgeonTest.route("GET", "/threads"), body: page([threadRow]) },
  { match: PidgeonTest.route("GET", "/threads/thr_1"), body: { data: threadRow } },
  { match: PidgeonTest.route("GET", "/threads/thr_1/labels"), body: page([]) },
  { match: PidgeonTest.route("GET", "/messages"), body: page([messageRow]) },
  { match: PidgeonTest.route("GET", "/messages/search"), body: page([]) },
  {
    match: PidgeonTest.route("GET", "/attachments/att_1/text"),
    body: {
      data: {
        id: "att_1",
        filename: "receipt.txt",
        content_type: "text/plain",
        size: 64,
        text: "Order LB-20417, paid.",
        truncated: false,
        firewall: { verdict: "clean", signals: [], version: 3 }
      }
    }
  },
  {
    match: PidgeonTest.route("POST", "/messages/msg_1/reply"),
    status: 202,
    body: {
      data: {
        status: "sent",
        id: "msg_2",
        draft_id: null,
        thread_id: "thr_1",
        rejected: [],
        test: true,
        approval: null
      }
    }
  },
  {
    match: PidgeonTest.route("PATCH", "/threads/thr_1"),
    body: { data: { ...threadRow, status: "waiting" } }
  }
];

/** The Pidgeon handlers as the server builds them, over the recorded answers, and two connections. */
const handlers = Effect.gen(function* () {
  const recorded = PidgeonTest.recorded(answers);
  const store = yield* SqlConnectionStore.make.pipe(Effect.provide(recorded.layer));
  yield* PidgeonTest.seed({ ...who, ...support });
  yield* PidgeonTest.seed({ ...who, ...invoices, access: "read" });
  const built = yield* Operations.makeHandlers.pipe(
    Effect.provide(Layer.merge(recorded.layer, Directory.layer)),
    Effect.provideService(ConnectionStore.ConnectionStore, store)
  );
  return { handlers: built, requests: recorded.requests };
});

/** Every recent call and log line, as text, for the sentinel to be looked for in. */
const everything = Effect.fn("PidgeonJourney.everything")(function* (logs: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly row: string;
  }>`SELECT row_to_json(c)::text AS row FROM runtime_calls c WHERE company_id = ${who.companyId}`;
  return { rows: rows.length, text: [...rows.map((row) => row.row), ...logs].join("\n") };
});

const credentials = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 7).toString("base64")}`)),
  // Never called: these connections reach no database or PostHog project.
  Layer.succeed(
    PostgresSource.Source,
    PostgresSource.Source.of({
      test: () => Effect.die("no Postgres here"),
      inspect: () => Effect.die("no Postgres here")
    })
  ),
  PostHogSource.layer,
  AttioSource.layer
);

const patchId = "pidgeontier1";
const versionId = "ver_aaaaaaaaaaaaaaaaaaaaaaaa";
const tier1 = Layer.mergeAll(
  Session.layer,
  WideEvents.layerNoop,
  Companies.layer,
  Users.layer,
  Limits.layer,
  OperatingLimits.layer,
  RuntimeLog.layer,
  NodeServices.layer,
  credentials,
  RuntimeTest.versions(patchId, versionId, () => uses)
).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);

it.layer(tier1)("Pidgeon in a tier 1 page", (it) => {
  it.effect(
    "the generated client reads, replies and triages as the viewer, and records no body",
    () => {
      const logs: string[] = [];
      return Effect.gen(function* () {
        const { handlers: built, requests } = yield* handlers;
        const call = yield* RuntimeTest.page(built, patchId, versionId);
        const inbox = yield* RuntimeTest.pidgeonClient(
          "support",
          support,
          snapshot("send", address.email),
          call
        );
        const readOnly = yield* RuntimeTest.pidgeonClient(
          "invoices",
          invoices,
          snapshot("read", `${invoices.handle}@acme.example`),
          call
        );

        // An option left undefined is dropped before the call, so the runtime never sees it.
        const { threads } = yield* Effect.promise(() =>
          inbox.threads.list({ status: "open", cursor: undefined })
        );
        assert.deepStrictEqual(
          threads.map((thread) => thread.id),
          ["thr_1"]
        );
        assert.strictEqual(
          (yield* Effect.promise(() => inbox.threads.get("thr_1"))).nextCursor,
          null
        );
        assert.strictEqual(
          (yield* Effect.promise(() => inbox.attachments.text("att_1"))).text,
          "Order LB-20417, paid."
        );
        yield* Effect.promise(() => inbox.messages.search({ text: SENTINEL }));
        const draft = "journey-draft-0001";
        const sent = yield* Effect.promise(() =>
          inbox.messages.reply("msg_1", { text: `${SENTINEL} reply`, idempotencyKey: draft })
        );
        assert.deepInclude(sent, { status: "sent", replayed: false });
        assert.strictEqual(
          (yield* Effect.promise(() => inbox.threads.update("thr_1", { status: "waiting" })))
            .status,
          "waiting"
        );
        const reply = requests.find(PidgeonTest.route("POST", "/messages/msg_1/reply"))!;
        assert.deepStrictEqual(reply.body, { text: `${SENTINEL} reply` });
        assert.strictEqual(
          reply.idempotencyKey,
          sha256(JSON.stringify(["pidgeon.send", support.id, patchId, draft]))
        );

        // A read connection's client has no write methods; one made by hand is refused unsent.
        assert.notProperty(readOnly.messages, "reply");
        const before = requests.length;
        assert.include(
          yield* Effect.promise(() =>
            call("pidgeon.write", {
              connection: "invoices",
              operation: "messages.reply",
              input: { id: "msg_1", text: "Hi", idempotencyKey: "journey-draft-0002" }
            })
          ),
          { code: "access_denied" }
        );
        // 100,000 characters at the cap, however they encode, reach Pidgeon; past it, nothing does.
        for (const text of ["\u0001".repeat(100_000), "😀".repeat(50_000)])
          assert.deepInclude(
            yield* Effect.promise(() =>
              inbox.messages.reply("msg_1", { text, idempotencyKey: "journey-draft-0003" })
            ),
            { status: "sent" }
          );
        assert.deepInclude(
          yield* Effect.promise(() =>
            call("pidgeon.write", {
              connection: "support",
              operation: "messages.reply",
              input: { id: "msg_1", text: "\u0001".repeat(200_000), idempotencyKey: "journey-big1" }
            })
          ),
          { code: "too_large", limitId: "runtime.pidgeon.bytes" }
        );
        assert.strictEqual(requests.length, before + 2);

        // Recent calls name each call; neither they nor a log line hold a body or search text.
        const log = yield* RuntimeLog.RuntimeLog;
        const calls = yield* log.recent({ companyId: who.companyId, connectionId: support.id });
        assert.includeMembers(
          calls.map((recent) => recent.resource),
          [
            "threads.list",
            "threads.get thr_1",
            "attachments.text att_1",
            "messages.search",
            "messages.reply msg_1",
            "threads.update thr_1 waiting"
          ]
        );
        const seen = yield* everything(logs);
        assert.isAbove(seen.rows, 6);
        assert.notInclude(seen.text, SENTINEL);
      }).pipe(
        Effect.provide(
          Logger.layer([Logger.make((event) => void logs.push(JSON.stringify(event.message)))], {
            mergeWithExisting: true
          })
        ),
        Effect.scoped
      );
    },
    60_000
  );
});

const tier2 = Layer.mergeAll(
  RuntimeLog.layer,
  InvocationLog.layer,
  OperatingLimits.layer,
  QuerySnapshot.layer,
  MutationTransaction.layer,
  credentials
).pipe(
  Layer.provideMerge(InvocationCapabilities.layer),
  Layer.provideMerge(CompanyTesting.layer()),
  Layer.provideMerge(TestWakes.layer),
  Layer.provideMerge(FetchHttpClient.layer)
);

it.layer(tier2, { excludeTestServices: true, timeout: 60_000 })(
  "Pidgeon in a tier 2 action",
  (it) => {
    it.effect(
      "an action in workerd reads, replies with the page's draft key and triages, as its viewer",
      () =>
        Effect.gen(function* () {
          const { handlers: built, requests } = yield* handlers;
          const binding = Binding.Binding.of({
            companyId: who.companyId,
            patchId: "pidgeontier2",
            versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
            wireVersion: WIRE_VERSION,
            scope: "company",
            correlationId: "pidgeon-tier2",
            principal: { userId: who.userId },
            identity: {
              user: { id: who.userId, name: "Dev", email: "dev@patchy.local" },
              company: { id: who.companyId, name: "Patchy Dev", handle: "patchy-dev" },
              admin: false
            },
            manifest: {
              manifestVersion: 1,
              release: CURRENT_RELEASE,
              tier: 2,
              tables: {},
              files: {},
              uses,
              handlers: PidgeonTest.desk.handlers
            }
          });
          const invoke = yield* RuntimeTest.invoker(built, binding, PidgeonTest.desk.source);
          assert.deepStrictEqual(
            yield* invoke("desk.answer", {
              subject: "Cracked chainstay",
              draft: "tier2-draft-0001",
              text: "Covered: a new chainstay ships today."
            }),
            {
              ok: true,
              value: {
                found: true,
                threadId: "thr_1",
                messages: 1,
                receipt: "Order LB-20417, paid.",
                repliedTo: "msg_1",
                sent: {
                  status: "sent",
                  messageId: "msg_2",
                  threadId: "thr_1",
                  rejected: [],
                  replayed: false,
                  test: true
                },
                status: "waiting"
              }
            }
          );
          const reply = requests.find(PidgeonTest.route("POST", "/messages/msg_1/reply"))!;
          assert.strictEqual(
            reply.idempotencyKey,
            sha256(JSON.stringify(["pidgeon.send", support.id, "pidgeontier2", "tier2-draft-0001"]))
          );
          const sentBefore = requests.length;
          for (const handler of ["desk.forced", "desk.peek"])
            assert.include(Runtime.toFailure(yield* invoke(handler).pipe(Effect.flip)), {
              code: "access_denied"
            });
          assert.strictEqual(requests.length, sentBefore);
        }),
      60_000
    );
  }
);
