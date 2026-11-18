import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv } from "@patchy/auth/testing";
import { Companies, Directory, Users, Teams } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { sha256 } from "../../../../test/crypto.js";
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
import * as ImapTest from "../test/imap.js";
import * as GithubTest from "../test/github.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as PidgeonTest from "../test/pidgeon.js";
import * as RuntimeTest from "../test/runtime.js";
import * as Operations from "./Operations.js";

/**
 * Pidgeon journeys over the scripted double of its API: the generated client calling back through
 * the gateway as a tier 2 action's viewer, and a tier 2 action in real workerd doing the same,
 * both from the packed `patchy` package. The same journeys against Pidgeon's test mode are in
 * the live tier (`packages/integrations/live`).
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
/** Text no recent call or log line may ever hold: a body, and search text. */
const SENTINEL = "SENTINEL-7f3a-body-or-search";

const support = { id: "conn_journey_send", handle: "journey-send" };
const invoices = { id: "conn_journey_read", handle: "journey-read" };
const email = `${support.handle}@acme.example`;
const invoicesEmail = `${invoices.handle}@acme.example`;
const snapshot = <const Access extends "read" | "send">(access: Access, address: string) => ({
  version: 2 as const,
  address: { email: address, displayName: null },
  access,
  test: true,
  labels: []
});
const uses = {
  support: { kind: "pidgeon" as const, ...support, revision: 1 },
  invoices: { kind: "pidgeon" as const, ...invoices, revision: 1 }
};

/**
 * The Pidgeon handlers as the server builds them, over a double holding two inboxes of one
 * account, each with a customer's mail, and one key that reaches both, as a dashboard key does:
 * `support` sends from the first, and `invoices` reads the second.
 */
const handlers = Effect.gen(function* () {
  const pidgeon = PidgeonTest.double();
  const inbox = pidgeon.inbox(email);
  const other = pidgeon.inbox(invoicesEmail);
  const mail = pidgeon.deliver(inbox, {
    from: "ana@customer.example",
    name: "Ana",
    subject: "Cracked chainstay",
    text: "Is this covered?",
    attachments: [{ filename: "receipt.pdf", size: 64 }]
  });
  const invoice = pidgeon.deliver(other, {
    from: "billing@supplier.example",
    subject: "Invoice 88",
    text: "Due in 30 days."
  });
  const key = pidgeon.key("send");
  const store = yield* SqlConnectionStore.make.pipe(Effect.provide([pidgeon.layer, Teams.layer]));
  yield* PidgeonTest.seed({ ...who, ...support, inboxId: inbox, email, key, test: true });
  yield* PidgeonTest.seed({
    ...who,
    ...invoices,
    access: "read",
    inboxId: other,
    email: invoicesEmail,
    key,
    test: true
  });
  const built = yield* Operations.makeHandlers.pipe(
    Effect.provide(Layer.merge(pidgeon.layer, Directory.layer)),
    Effect.provideService(ConnectionStore.ConnectionStore, store)
  );
  return { handlers: built, pidgeon, inbox, mail, invoice };
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
  AttioSource.layer,
  ImapTest.offline,
  GithubTest.unconfigured
);

const patchId = "pidgeoncallb";
const versionId = "ver_aaaaaaaaaaaaaaaaaaaaaaaa";
const tier1 = Layer.mergeAll(
  Session.layer,
  WideEvents.layerNoop,
  Companies.layer,
  Users.layer,
  Limits.layer,
  OperatingLimits.layer,
  RuntimeLog.layer,
  credentials,
  RuntimeTest.versions(patchId, versionId, () => uses)
)
  .pipe(
    Layer.provideMerge(Testing.layer()),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
  )
  .pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCryptography.layer));

it.layer(tier1)("Pidgeon from a tier 2 action's callbacks", (it) => {
  it.effect(
    "the generated client reads, replies and triages as the viewer, and records no body",
    () => {
      const logs: string[] = [];
      return Effect.gen(function* () {
        const { handlers: built, pidgeon, inbox: inboxId, mail, invoice } = yield* handlers;
        const requests = pidgeon.requests;
        const call = yield* RuntimeTest.page(built, patchId, versionId);
        const inbox = yield* RuntimeTest.pidgeonClient(
          "support",
          support,
          snapshot("send", email),
          call
        );
        const readOnly = yield* RuntimeTest.pidgeonClient(
          "invoices",
          invoices,
          snapshot("read", invoicesEmail),
          call
        );

        // An option left undefined is dropped before the call, so the runtime never sees it.
        const { threads } = yield* Effect.promise(() =>
          inbox.threads.list({ status: "open", cursor: undefined })
        );
        assert.deepStrictEqual(
          threads.map((thread) => thread.id),
          [mail.threadId]
        );
        // The key reaches both inboxes; each connection shows its own, and the other's mail by
        // id isn't there, as an unknown id isn't.
        assert.deepStrictEqual(
          (yield* Effect.promise(() => readOnly.threads.list({}))).threads.map(
            (thread) => thread.id
          ),
          [invoice.threadId]
        );
        for (const [operation, id] of [
          ["threads.get", invoice.threadId],
          ["messages.get", invoice.messageId]
        ] as const)
          assert.include(
            yield* Effect.promise(() =>
              call("pidgeon.read", { connection: "support", operation, input: { id } })
            ),
            { code: "not_found" },
            operation
          );
        const read = yield* Effect.promise(() => inbox.threads.get(mail.threadId));
        assert.strictEqual(read.nextCursor, null);
        assert.deepStrictEqual(
          read.messages[0]!.attachments.map((file) => file.filename),
          ["receipt.pdf"]
        );
        yield* Effect.promise(() => inbox.messages.search({ text: SENTINEL }));
        const draft = "journey-draft-0001";
        const sent = yield* Effect.promise(() =>
          inbox.messages.reply(mail.messageId, { text: `${SENTINEL} reply`, idempotencyKey: draft })
        );
        assert.deepInclude(sent, { status: "sent", replayed: false });
        assert.strictEqual(
          (yield* Effect.promise(() => inbox.threads.update(mail.threadId, { status: "waiting" })))
            .status,
          "waiting"
        );
        const written = requests.find(
          PidgeonTest.route("POST", `/email/inboxes/${inboxId}/drafts`)
        )!;
        assert.deepStrictEqual(written.body, {
          to: ["ana@customer.example"],
          subject: "Re: Cracked chainstay",
          text: `${SENTINEL} reply`,
          reply_to: mail.messageId
        });
        // The draft key never leaves Patchy: its ledger keeps a hash of it.
        assert.notInclude(JSON.stringify(requests), draft);
        const sql = yield* SqlClient.SqlClient;
        const ledger = yield* sql<{ readonly draft: string }>`SELECT draft FROM pidgeon_drafts
          WHERE connection_id = ${support.id}`;
        assert.deepStrictEqual(
          ledger.map((row) => row.draft),
          [sha256(JSON.stringify(["pidgeon.send", support.id, patchId, draft]))]
        );

        // A read connection's client has no write methods; one made by hand is refused unsent.
        assert.notProperty(readOnly.messages, "reply");
        const before = requests.length;
        assert.include(
          yield* Effect.promise(() =>
            call("pidgeon.write", {
              connection: "invoices",
              operation: "messages.reply",
              input: { id: mail.messageId, text: "Hi", idempotencyKey: "journey-draft-0002" }
            })
          ),
          { code: "access_denied" }
        );
        // 100,000 characters at the cap, however they encode, reach Pidgeon; past it, nothing does.
        for (const [index, text] of ["\u0001".repeat(100_000), "😀".repeat(50_000)].entries())
          assert.deepInclude(
            yield* Effect.promise(() =>
              inbox.messages.reply(mail.messageId, {
                text,
                idempotencyKey: `journey-draft-000${3 + index}`
              })
            ),
            { status: "sent" }
          );
        assert.deepInclude(
          yield* Effect.promise(() =>
            call("pidgeon.write", {
              connection: "support",
              operation: "messages.reply",
              input: {
                id: mail.messageId,
                text: "\u0001".repeat(200_000),
                idempotencyKey: "journey-big1"
              }
            })
          ),
          { code: "too_large", limitId: "runtime.pidgeon.bytes" }
        );
        // Each reply reads its target, writes its draft and sends it once.
        assert.strictEqual(requests.length, before + 6);
        // A reply to the other inbox's mail is refused as a reply to an unknown id is, unwritten.
        assert.include(
          yield* Effect.promise(() =>
            call("pidgeon.write", {
              connection: "support",
              operation: "messages.reply",
              input: { id: invoice.messageId, text: "Paid.", idempotencyKey: "journey-foreign-01" }
            })
          ),
          { code: "not_found" }
        );
        assert.strictEqual(pidgeon.sentFrom(inboxId).length, 3);
        assert.deepStrictEqual(pidgeon.drafts(), []);

        // Recent calls name each call; neither they nor a log line hold a body or search text.
        const log = yield* RuntimeLog.RuntimeLog;
        const calls = yield* log.recent({
          companyId: who.companyId,
          connectionId: support.id,
          patchIds: [patchId]
        });
        assert.includeMembers(
          calls.map((recent) => recent.resource),
          [
            "threads.list",
            `threads.get ${mail.threadId}`,
            "messages.search",
            `messages.reply ${mail.messageId}`,
            `threads.update ${mail.threadId} waiting`
          ]
        );
        const seen = yield* everything(logs);
        assert.isAbove(seen.rows, 5);
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
          const { handlers: built, pidgeon, mail } = yield* handlers;
          const requests = pidgeon.requests;
          const viewer = {
            user: { id: who.userId, name: "Dev", email: "dev@patchy.local" },
            company: { id: who.companyId, name: "Patchy Dev", handle: "patchy-dev" },
            admin: false
          };
          const binding = Binding.Binding.of({
            companyId: who.companyId,
            patchId: "pidgeontier2",
            versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
            wireVersion: WIRE_VERSION,
            scope: "company",
            correlationId: "pidgeon-tier2",
            principal: { userId: who.userId },
            identity: viewer,
            reauthorize: Effect.succeed(viewer),
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
          const answered = yield* invoke("desk.answer", {
            subject: "Cracked chainstay",
            draft: "tier2-draft-0001",
            text: "Covered: a new chainstay ships today."
          });
          const sent = pidgeon.sentFrom(pidgeon.message(mail.messageId)!.inbox_id);
          assert.strictEqual(sent.length, 1);
          assert.deepStrictEqual(answered, {
            ok: true,
            value: {
              found: true,
              threadId: mail.threadId,
              messages: 1,
              files: ["receipt.pdf"],
              repliedTo: mail.messageId,
              sent: {
                status: "sent",
                messageId: sent[0]!.id,
                threadId: mail.threadId,
                replayed: false
              },
              status: "waiting"
            }
          });
          assert.notInclude(JSON.stringify(requests), "tier2-draft-0001");
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
