import { createHash, randomBytes } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as WideEvents from "@patchy/analytics/wide-events";
import { DEV_SEED } from "@patchy/auth/seed";
import { NodeCryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import { CURRENT_RELEASE, imapStageAttachment, WIRE_VERSION } from "@patchy/api";
import { Binding, FileStaging, Runtime } from "@patchy/runtime/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as AttioSource from "../attio/Source.js";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as ImapTest from "../test/imap.js";
import * as Operations from "./Operations.js";
import * as Sessions from "./Sessions.js";
import * as Source from "./Source.js";

/**
 * Staging attachments offline, over a scripted mail server through the network seam: the bytes
 * that reach staging under every transfer encoding and with BINARY, the commands a download sends,
 * the bound and one byte past it, the refusals that send nothing, and the session an abandoned or
 * oversized download destroys. What staging does with the bytes is Files' own contract.
 */

const host = "mail.example.test";
const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
class Certs extends Context.Service<Certs, ImapTest.Certificates>()("test/imap/AttachmentCerts") {}
const fixture = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 5).toString("base64")}`)),
  RuntimeLog.layer,
  // Never called: these connections reach no database, PostHog project, Pidgeon address or Attio.
  Layer.succeed(
    PostgresSource.Source,
    PostgresSource.Source.of({
      test: () => Effect.die("no Postgres here"),
      inspect: () => Effect.die("no Postgres here")
    })
  ),
  PostHogSource.layer,
  PidgeonSource.layer,
  AttioSource.layer,
  Layer.effect(Certs, ImapTest.certificates([host]))
).pipe(Layer.provideMerge(Testing.layer()), Layer.provideMerge(NodeCryptography.layer));

const viewer = {
  user: { id: who.userId, name: "Dev", email: "dev@example.test" },
  company: { id: who.companyId, handle: "patchy-dev", name: "Patchy Dev" },
  admin: false
};
/** The action's call, which host staging binds an Upload to. */
const binding = Binding.Binding.of({
  companyId: who.companyId,
  patchId: "imapstage",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  wireVersion: WIRE_VERSION,
  scope: "company",
  correlationId: "imap-stage",
  principal: { userId: who.userId },
  identity: viewer,
  reauthorize: Effect.succeed(viewer),
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: {}
  }
});
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** INBOX with one message: a text body, `attachment` as part 2, a forwarded message as part 3. */
const inbox = (attachment: ImapTest.ScriptedAttachment): ImapTest.ScriptedFolder => ({
  path: "INBOX",
  uidValidity: 9,
  messages: [
    {
      uid: 1,
      day: "2026-10-02",
      subject: "Invoice",
      from: "billing@example.com",
      text: "Attached.\n",
      attachment,
      forwarded: true
    }
  ]
});
const pdf = (content: Uint8Array, encoding?: ImapTest.ScriptedAttachment["encoding"]) => ({
  filename: "invoice.pdf",
  bytes: content.byteLength,
  content,
  ...(encoding === undefined ? {} : { encoding })
});

interface Setup {
  readonly capabilities?: ReadonlyArray<string>;
  readonly before?: ImapTest.Script["before"];
  readonly limits?: Partial<Record<Parameters<typeof ContractLimits.get>[0], number>>;
  readonly refuse?: (at: "admits" | "stage") => Runtime.RuntimeError | undefined;
}
/** A connected mailbox on a scripted server, and a stage on it through recording host staging. */
const setup = (handle: string, attachment: ImapTest.ScriptedAttachment, options: Setup = {}) =>
  Effect.gen(function* () {
    const certs = yield* Certs;
    const served = yield* ImapTest.serve(certs, {
      capabilities: options.capabilities ?? ["IMAP4rev1", "AUTH=PLAIN", "ID", "NAMESPACE"],
      mailboxes: [inbox(attachment)],
      ...(options.before === undefined ? {} : { before: options.before })
    });
    const source = Source.layer.pipe(Layer.provide(ImapTest.network(served, certs)));
    const store = yield* SqlConnectionStore.make.pipe(Effect.provide(source));
    const connection = yield* store.connect({
      integration: "imap",
      ...who,
      handle,
      description: "Supplier invoices",
      credentials: Source.credentials({
        host,
        port: 993,
        security: "tls",
        username: "invoices@example.test",
        password: "the-right-password"
      })
    });
    const limits = options.limits ?? {};
    const sessions = yield* Sessions.make.pipe(
      Effect.provide(source),
      Effect.provideService(ContractLimits.overrides, limits)
    );
    const staging = ImapTest.recordingStaging(options.refuse);
    const ref = { connection: connection.id, folder: "INBOX", uidValidity: 9, uid: 1 };
    const stage = (
      part: string,
      over: { readonly deadline?: number; readonly ref?: typeof ref } = {}
    ) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Operations.stageAttachmentAt(
          {
            companyId: who.companyId,
            connection: { id: connection.id, handle },
            deadline: over.deadline ?? now + 15_000,
            recheck: Effect.void as Effect.Effect<void, Runtime.AccessDenied>
          },
          { ref: over.ref ?? ref, part }
        )
      ).pipe(
        Effect.provideService(ConnectionStore.ConnectionStore, store),
        Effect.provideService(Sessions.Sessions, sessions),
        Effect.provideService(FileStaging.FileStaging, staging.service),
        Effect.provideService(Binding.Binding, binding),
        Effect.provideService(ContractLimits.overrides, limits)
      );
    const logins = () => served.commands.filter((line) => line.startsWith("AUTH")).length;
    return { served, stage, staged: staging.staged, logins, ref };
  });

/** Every byte value, a few times over, so a chunk boundary falls mid-run. */
const content = Uint8Array.from({ length: 10_000 }, (_, index) => (index * 7) % 256);

it.layer(fixture)("IMAP attachments", (it) => {
  it.effect(
    "stages a part's exact bytes under each transfer encoding, with BINARY or not",
    () =>
      Effect.gen(function* () {
        for (const binary of [false, true])
          for (const encoding of ["base64", "quoted-printable", "8bit"] as const) {
            const { served, stage, staged } = yield* setup(
              `stage-${encoding}-${binary}`,
              pdf(content, encoding),
              {
                capabilities: ["IMAP4rev1", "AUTH=PLAIN", "ID", ...(binary ? ["BINARY"] : [])],
                limits: { "imap.download.chunk": 4_096 }
              }
            );
            const answer = yield* stage("2");
            assert.deepInclude(answer, {
              ok: true,
              size: content.byteLength,
              sha256: sha256(content),
              contentType: "application/pdf",
              filename: "invoice.pdf"
            });
            assert.deepStrictEqual(
              staged.map((each) => each.token),
              [answer.upload.token]
            );
            assert.deepStrictEqual(staged[0]!.bytes, content);
            // In chunks of `imap.download.chunk`, peeking, with BINARY only where it's offered.
            const fetches = served.lines.filter((line) => /\[2\]</.test(line));
            assert.isAtLeast(fetches.length, 2, encoding);
            for (const line of fetches) {
              assert.match(
                line,
                binary ? /BINARY\.PEEK\[2\]<\d+\.4096>/ : /BODY\.PEEK\[2\]<\d+\.4096>/
              );
              assert.notMatch(line, binary ? /BODY\.PEEK\[2\]</ : /BINARY/);
            }
          }
      }),
    // Six scripted servers and connections, one for each encoding with BINARY and without.
    60_000
  );

  it.effect("stages exactly the bound, and destroys the session past it with nothing staged", () =>
    Effect.gen(function* () {
      const bound = 5_000;
      const limits = { "files.stage.bytes": bound, "imap.download.chunk": 2_048 };
      const exact = yield* setup("bound-exact", pdf(randomBytes(bound)), { limits });
      assert.strictEqual((yield* exact.stage("2")).size, bound);
      const { stage, staged, logins } = yield* setup("bound-over", pdf(randomBytes(bound + 1)), {
        limits
      });
      const before = logins();
      const over = yield* Effect.flip(stage("2"));
      assert.strictEqual(over._tag, "ImapAttachmentTooLarge");
      assert.include(over, { code: "too_large", limitId: "files.stage.bytes", value: bound });
      assert.deepStrictEqual("details" in over ? over.details : undefined, { part: "2" });
      assert.lengthOf(staged, 0);
      // A chunk may have been on its way: the next call can't have that session.
      yield* Effect.flip(stage("2"));
      assert.strictEqual(logins() - before, 2);
    })
  );

  it.effect(
    "refuses a container, a part it lacks and another connection's ref, staging nothing",
    () =>
      Effect.gen(function* () {
        const { served, stage, staged, ref, logins } = yield* setup("refusals", pdf(content));
        const before = logins();
        const container = yield* Effect.flip(stage("3"));
        assert.include(container, { _tag: "ImapNotAFile", code: "invalid_request" });
        const missing = yield* Effect.flip(stage("4"));
        assert.include(missing, { _tag: "ImapPartNotFound", code: "not_found" });
        assert.deepStrictEqual("details" in missing ? missing.details : undefined, { part: "4" });
        const gone = yield* Effect.flip(stage("2", { ref: { ...ref, uid: 2 } }));
        assert.include(gone, { _tag: "ImapMessageNotFound", code: "not_found" });
        const dials = served.dials.length;
        const foreign = yield* Effect.flip(
          stage("2", { ref: { ...ref, connection: "conn_other" } })
        );
        assert.include(foreign, { _tag: "ImapForeignRef", code: "invalid_request" });
        assert.strictEqual(served.dials.length, dials);
        assert.lengthOf(staged, 0);
        // Never a raw section: the wire takes numbered parts only.
        const isInput = Schema.is(imapStageAttachment.input);
        for (const part of ["HEADER", "TEXT", "2.MIME", "1.HEADER", "0", "2.", ""])
          assert.isFalse(isInput({ ref, part }), part);
        assert.isTrue(isInput({ ref, part: "3.1" }));
        // Refusals found before a download leave the session clean: one login served them all.
        assert.strictEqual(logins() - before, 1);
      })
  );

  it.effect("destroys the session when a download is abandoned midway", () =>
    Effect.gen(function* () {
      let release: () => void = () => {};
      let hold = true;
      const { stage, staged, logins } = yield* setup("abandoned", pdf(content), {
        limits: { "imap.download.chunk": 4_096 },
        before: (line) =>
          hold && /BODY\.PEEK\[2\]<4096\./.test(line)
            ? new Promise<void>((resolve) => {
                release = resolve;
              })
            : undefined
      });
      const before = logins();
      const running = yield* Effect.forkChild(stage("2"));
      yield* TestClock.withLive(Effect.sleep("500 millis"));
      yield* Fiber.interrupt(running);
      hold = false;
      release();
      assert.lengthOf(staged, 0);
      yield* stage("2");
      assert.strictEqual(logins() - before, 2);
      assert.lengthOf(staged, 1);
    })
  );

  it.effect("waits for one of the process's attachment places, and is refused busy past them", () =>
    Effect.gen(function* () {
      const releases: Array<() => void> = [];
      const { served, stage } = yield* setup("places", pdf(content), {
        limits: { "imap.attachments.concurrent": 1, "imap.download.chunk": 4_096 },
        before: (line) =>
          /BODY\.PEEK\[2\]<4096\./.test(line)
            ? new Promise<void>((resolve) => releases.push(resolve))
            : undefined
      });
      const first = yield* Effect.forkChild(stage("2"));
      yield* TestClock.withLive(Effect.sleep("500 millis"));
      const dials = served.dials.length;
      const waiting = yield* Effect.forkChild(
        Effect.flip(stage("2", { deadline: (yield* Clock.currentTimeMillis) + 1_500 }))
      );
      yield* TestClock.withLive(Effect.sleep("100 millis"));
      yield* TestClock.adjust("1 second");
      const busy = yield* Fiber.join(waiting);
      assert.include(busy, {
        _tag: "ImapBusy",
        code: "busy",
        limitId: "imap.attachments.concurrent"
      });
      assert.strictEqual(served.dials.length, dials);
      for (const release of releases) release();
      yield* Fiber.join(first);
    })
  );

  it.effect("sums the request's staged bytes on its wide event; a refused stage adds none", () =>
    Effect.gen(function* () {
      let full = false;
      const { stage } = yield* setup("summed", pdf(content), {
        refuse: () =>
          full
            ? new Runtime.LimitExceeded({
                limitId: "files.stage.count",
                value: registry["files.stage.count"].default
              })
            : undefined
      });
      const recorded: WideEvents.WideEvent[] = [];
      const events = yield* WideEvents.make.pipe(
        Effect.provideService(WideEvents.Sink, {
          write: (event) => Effect.sync(() => void recorded.push(event))
        })
      );
      yield* events.withEvent(
        { type: "request" },
        Effect.gen(function* () {
          yield* stage("2");
          yield* stage("2");
          full = true;
          yield* Effect.flip(stage("2"));
        })
      );
      yield* Effect.yieldNow;
      assert.lengthOf(recorded, 1);
      assert.include(JSON.stringify(recorded[0]), `"stagedBytes":${2 * content.byteLength}`);
    })
  );

  it.effect("refuses at a full quota before it downloads: no session, no FETCH", () =>
    Effect.gen(function* () {
      const { served, stage, staged } = yield* setup("quota-full", pdf(content), {
        refuse: () =>
          new Runtime.LimitExceeded({
            limitId: "files.stage.count",
            value: registry["files.stage.count"].default
          })
      });
      const dials = served.dials.length;
      const refused = yield* Effect.flip(stage("2"));
      assert.include(refused, { code: "limit_exceeded", limitId: "files.stage.count" });
      assert.strictEqual(served.dials.length, dials);
      assert.notInclude(served.commands.join("\n"), "FETCH");
      assert.lengthOf(staged, 0);
    })
  );

  it.effect(
    "hands on a quota refusal staging finds after the download, and keeps the session",
    () =>
      Effect.gen(function* () {
        let full = true;
        const { stage, logins } = yield* setup("quota", pdf(content), {
          // Others filled the quota while this call downloaded.
          refuse: (at) =>
            full && at === "stage"
              ? new Runtime.LimitExceeded({
                  limitId: "files.stage.count",
                  value: registry["files.stage.count"].default
                })
              : undefined
        });
        const before = logins();
        const refused = yield* Effect.flip(stage("2"));
        assert.include(refused, { code: "limit_exceeded", limitId: "files.stage.count" });
        full = false;
        yield* stage("2");
        assert.strictEqual(logins() - before, 1);
      })
  );
});

it.effect("an attachment download's chunk fits within the parser's literal bound", () =>
  Effect.sync(() => {
    const chunk = registry["imap.download.chunk"].default;
    assert.isAtLeast(chunk, 1024 * 1024);
    assert.isAtMost(chunk, registry["imap.parser.literal"].default);
  })
);
