// @effect-diagnostics nodeBuiltinImport:off -- A delay proxy relays real sockets to Dovecot.
import { Teams } from "@patchy/companies";
import { createHash, randomBytes } from "node:crypto";
import { createServer, connect, type Socket } from "node:net";
import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, imapStageAttachment, WIRE_VERSION } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { NodeCryptography } from "@patchy/core";
import { Binding, FileStaging, Runtime } from "@patchy/runtime/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ImapFlow } from "imapflow";
import { inject } from "vitest";
import * as AttioSource from "../src/attio/Source.js";
import * as ConnectionStore from "../src/ConnectionStore.js";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as ImapNetwork from "../src/imap/Network.js";
import * as Operations from "../src/imap/Operations.js";
import * as Sessions from "../src/imap/Sessions.js";
import * as Source from "../src/imap/Source.js";
import * as PidgeonSource from "../src/pidgeon/Source.js";
import * as PostgresSource from "../src/postgres/Source.js";
import * as PostHogSource from "../src/posthog/Source.js";
import * as SqlConnectionStore from "../src/SqlConnectionStore.js";
import * as ImapTest from "../src/test/imap.js";
import type { LiveServer } from "./imapHarness.js";

/**
 * Staging attachments from real mail servers in Docker (`imapHarness.ts`): every transfer encoding
 * and a forwarded message's part byte for byte, by sha256, on Dovecot (which offers BINARY) and
 * GreenMail (which doesn't); a part of exactly the bound and one byte past it; and a part of the
 * bound behind a proxy adding 100 ms of round trip, within the call's deadline. What staging does
 * with the bytes is Files' own contract, so the staging here keeps them to compare.
 */

const mail = inject("imap");
const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const MAX = 20 * 1024 * 1024;
const servers = [
  ["Dovecot", mail.dovecot],
  ["GreenMail", mail.greenmail]
] as const;
const route = (server: LiveServer, tls = server.tls) => ({
  host: server.host,
  ports: { 993: tls, 143: server.plain },
  ca: mail.ca
});
const network = ImapNetwork.loopback(() => servers.map(([, server]) => route(server)));
const services = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 9).toString("base64")}`)),
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
  Sessions.layer.pipe(Layer.provideMerge(Source.layer.pipe(Layer.provide(network))))
).pipe(Layer.provideMerge(Testing.layer()), Layer.provideMerge(NodeCryptography.layer));

const viewer = {
  user: { id: who.userId, name: "Dev", email: "dev@example.test" },
  company: { id: who.companyId, handle: "patchy-dev", name: "Patchy Dev" },
  admin: false
};
/** The action's call, which host staging binds an Upload to. */
const binding = Binding.Binding.of({
  companyId: who.companyId,
  patchId: "imapattachlive",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  wireVersion: WIRE_VERSION,
  scope: "company",
  correlationId: "imap-attachments-live",
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

// ---------- mail as a sender's client writes it ----------

interface Part {
  readonly headers: ReadonlyArray<string>;
  readonly body: Buffer;
}
const lines76 = (text: string) => (text.match(/.{1,76}/g) ?? []).join("\r\n");
const base64Part = (type: string, filename: string, bytes: Uint8Array): Part => ({
  headers: [
    `Content-Type: ${type}; name="${filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${filename}"`
  ],
  body: Buffer.from(lines76(Buffer.from(bytes).toString("base64")), "latin1")
});
/** RFC 2045 quoted-printable of any bytes, with CRLF kept as hard line breaks. */
const quotedPrintable = (bytes: Uint8Array) => {
  let out = "";
  let line = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    if (byte === 13 && bytes[index + 1] === 10) {
      out += "\r\n";
      line = 0;
      index++;
      continue;
    }
    const piece =
      (byte >= 33 && byte <= 126 && byte !== 61) || (byte === 32 && bytes[index + 1] !== 13)
        ? String.fromCharCode(byte)
        : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    if (line + piece.length > 75) {
      out += "=\r\n";
      line = 0;
    }
    out += piece;
    line += piece.length;
  }
  return Buffer.from(out, "latin1");
};
const multipart = (boundary: string, parts: ReadonlyArray<Part>) =>
  Buffer.concat([
    ...parts.flatMap((part) => [
      Buffer.from(`--${boundary}\r\n${part.headers.join("\r\n")}\r\n\r\n`, "latin1"),
      part.body,
      Buffer.from("\r\n", "latin1")
    ]),
    Buffer.from(`--${boundary}--\r\n`, "latin1")
  ]);
const message = (subject: string, boundary: string, parts: ReadonlyArray<Part>) =>
  Buffer.concat([
    Buffer.from(
      [
        "From: Billing <billing@example.com>",
        "To: invoices@imap-live.test",
        `Subject: ${subject}`,
        "Date: Mon, 02 Nov 2026 09:00:00 +0000",
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        ""
      ].join("\r\n"),
      "latin1"
    ),
    multipart(boundary, parts)
  ]);
const text = (body: string): Part => ({
  headers: ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"],
  body: Buffer.from(body, "utf8")
});

/** The files one message carries: a PDF, a CSV and a text file, and a PNG in a forward. */
const pdf = randomBytes(150_000);
// The text files end without a line break: GreenMail drops a part's last CRLF from its section,
// Patchy or not, where Dovecot keeps it.
const csv = Buffer.from(
  `${"Rechnung;Betrag\r\n7731;615,00 €\r\n7732;99,50 €\r\n".repeat(400)}Summe;714,50 €`,
  "utf8"
);
const notes = Buffer.from(
  "Zahlung bis zum 30. November.\r\nVielen Dank für Ihr Vertrauen.",
  "utf8"
);
const png = randomBytes(40_000);
const forwarded = message("Fwd: Lieferschein", "inner-boundary", [
  text("Siehe Anhang."),
  base64Part("image/png", "lieferschein.png", png)
]);
const rich = message("Rechnung 7731", "outer-boundary", [
  text("Anbei unsere Rechnung."),
  base64Part("application/pdf", "rechnung-7731.pdf", pdf),
  {
    headers: [
      'Content-Type: text/csv; charset=utf-8; name="posten.csv"',
      "Content-Transfer-Encoding: quoted-printable",
      'Content-Disposition: attachment; filename="posten.csv"'
    ],
    body: quotedPrintable(csv)
  },
  {
    headers: [
      'Content-Type: text/plain; charset=utf-8; name="notiz.txt"',
      "Content-Transfer-Encoding: 8bit",
      'Content-Disposition: attachment; filename="notiz.txt"'
    ],
    body: notes
  },
  {
    headers: [
      "Content-Type: message/rfc822",
      'Content-Disposition: attachment; filename="fwd.eml"'
    ],
    body: forwarded
  }
]);

// ---------- the mailbox and Patchy's stage on it ----------

const owned = <A>(server: LiveServer, use: (owner: ImapFlow) => Promise<A>) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(async () => {
        const opened = new ImapFlow({
          host: "127.0.0.1",
          port: server.tls,
          secure: true,
          servername: server.host,
          tls: { ca: [mail.ca], minVersion: "TLSv1.2" },
          auth: { user: server.username, pass: server.password },
          logger: false
        });
        await opened.connect();
        return opened;
      }),
      (opened) => Effect.promise(() => opened.logout().catch(() => undefined))
    ).pipe(Effect.flatMap((owner) => Effect.promise(() => use(owner))))
  );
/** A fresh folder holding `messages`, and its UIDVALIDITY. */
const seed = (server: LiveServer, folder: string, messages: ReadonlyArray<Buffer>) =>
  owned(server, async (owner) => {
    await owner.mailboxCreate(folder);
    for (const raw of messages)
      await owner.append(folder, raw, [], new Date(Date.UTC(2026, 10, 2)));
    const status = await owner.status(folder, { uidValidity: true });
    if (status === false) throw new Error(`The server refused STATUS for ${folder}.`);
    return Number(status.uidValidity);
  });

const decodeStaged = Schema.decodeUnknownSync(imapStageAttachment.output);
/** A connected mailbox, and a stage on it through `sessions`, as a tier 2 action's viewer. */
const connected = (server: LiveServer, handle: string, sessions?: Sessions.Sessions["Service"]) =>
  Effect.gen(function* () {
    const store = yield* SqlConnectionStore.make.pipe(Effect.provide(Teams.layer));
    const connection = yield* store.connect({
      integration: "imap",
      ...who,
      handle,
      description: "Live mailbox",
      credentials: Source.credentials({
        host: server.host,
        port: 993,
        security: "tls",
        username: server.username,
        password: server.password
      })
    });
    const staging = ImapTest.recordingStaging();
    const pool = sessions ?? (yield* Sessions.Sessions);
    const stage = (folder: string, uidValidity: number, uid: number, part: string) =>
      Operations.stageAttachmentAt(
        {
          companyId: who.companyId,
          connection: { id: connection.id, handle },
          deadline: Date.now() + 15_000,
          recheck: Effect.void as Effect.Effect<void, Runtime.AccessDenied>
        },
        { ref: { connection: connection.id, folder, uidValidity, uid }, part }
      ).pipe(
        Effect.map(decodeStaged),
        Effect.provideService(ConnectionStore.ConnectionStore, store),
        Effect.provideService(Sessions.Sessions, pool),
        Effect.provideService(FileStaging.FileStaging, staging.service),
        Effect.provideService(Binding.Binding, binding)
      );
    return { stage, staged: staging.staged };
  });

/** Bytes the relay has carried, both ways. */
const relayed = { bytes: 0 };
/** A TCP relay that holds every chunk `delay` ms each way, as a far network would. */
const delayed = (target: number, delay: number) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ port: number; close: () => void }>((resolve) => {
          const sockets = new Set<Socket>();
          // Latency, not bandwidth: each chunk leaves `delay` ms after it came, in order, flushed
          // by one timer, so a megabyte answer arrives as fast as it was sent, only later.
          const relay = (from: Socket, to: Socket) => {
            const queue: Array<{ readonly due: number; readonly chunk: Buffer | null }> = [];
            let timer: ReturnType<typeof setTimeout> | undefined;
            const flush = () => {
              timer = undefined;
              const now = Date.now();
              while (queue.length > 0 && queue[0]!.due <= now) {
                const { chunk } = queue.shift()!;
                if (chunk === null) to.end();
                else to.write(chunk);
              }
              if (queue.length > 0) timer = setTimeout(flush, queue[0]!.due - now);
            };
            const push = (chunk: Buffer | null) => {
              if (chunk !== null) relayed.bytes += chunk.byteLength;
              queue.push({ due: Date.now() + delay, chunk });
              timer ??= setTimeout(flush, delay);
            };
            from.on("data", push);
            from.on("end", () => push(null));
            from.on("error", () => to.destroy());
          };
          const server = createServer((inbound) => {
            const outbound = connect({ host: "127.0.0.1", port: target });
            sockets.add(inbound).add(outbound);
            relay(inbound, outbound);
            relay(outbound, inbound);
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve({
              port: typeof address === "object" && address !== null ? address.port : 0,
              close: () => {
                for (const socket of sockets) socket.destroy();
                server.close();
              }
            });
          });
        })
    ),
    (proxy) => Effect.sync(proxy.close)
  );

const run = `${process.pid}`;

it.layer(services, { timeout: "300 seconds", excludeTestServices: true })(
  "IMAP attachments, live",
  (it) => {
    for (const [name, server] of servers)
      it.effect(`${name}: stages every encoding and a forwarded message's part byte for byte`, () =>
        Effect.gen(function* () {
          const folder = `Attachments ${run}`;
          const uidValidity = yield* seed(server, folder, [rich]);
          const { stage, staged } = yield* connected(server, `attach-${name.toLowerCase()}`);
          const parts: ReadonlyArray<readonly [string, Uint8Array, string]> = [
            ["2", pdf, "rechnung-7731.pdf"],
            ["3", csv, "posten.csv"],
            ["4", notes, "notiz.txt"],
            ["5.2", png, "lieferschein.png"]
          ];
          for (const [part, bytes, filename] of parts) {
            // GreenMail can't serve a forwarded message's own parts: it answers NO with a
            // ClassCastException of its own, which Patchy relays as the server refusing.
            if (name === "GreenMail" && part === "5.2") {
              const refused = yield* Effect.flip(stage(folder, uidValidity, 1, part));
              assert.include(refused, { code: "source_unavailable" });
              continue;
            }
            const answer = yield* stage(folder, uidValidity, 1, part);
            assert.deepInclude(
              answer,
              { size: bytes.byteLength, sha256: sha256(bytes), filename },
              part
            );
            assert.strictEqual(sha256(staged.at(-1)!.bytes), sha256(bytes), part);
          }
          // The forward itself is a container, never a file.
          assert.strictEqual(
            (yield* Effect.flip(stage(folder, uidValidity, 1, "5")))._tag,
            "ImapNotAFile"
          );
          // Nothing Patchy sent marked the message read.
          const seen = yield* owned(server, async (owner) => {
            const lock = await owner.getMailboxLock(folder, { readOnly: true });
            try {
              const found = await owner.fetchOne("1", { flags: true }, { uid: true });
              return found === false ? [] : [...(found.flags ?? [])];
            } finally {
              lock.release();
            }
          });
          assert.notInclude(seen, "\\Seen");
        })
      );

    it.effect("Dovecot: stages a part of exactly 20 MiB and refuses one byte more", () =>
      Effect.gen(function* () {
        const folder = `Bound ${run}`;
        const exact = randomBytes(MAX);
        const over = randomBytes(MAX + 1);
        const uidValidity = yield* seed(mail.dovecot, folder, [
          message("Exactly the bound", "exact-boundary", [
            text("Big."),
            base64Part("application/octet-stream", "exact.bin", exact)
          ]),
          message("One byte past", "over-boundary", [
            text("Bigger."),
            base64Part("application/octet-stream", "over.bin", over)
          ])
        ]);
        const { stage, staged } = yield* connected(mail.dovecot, "attach-bound");
        const fits = yield* stage(folder, uidValidity, 1, "2");
        assert.deepInclude(fits, { size: MAX, sha256: sha256(exact) });
        const refused = yield* Effect.flip(stage(folder, uidValidity, 2, "2"));
        assert.include(refused, { code: "too_large", limitId: "files.stage.bytes" });
        assert.lengthOf(staged, 1);
      })
    );

    it.effect("Dovecot behind 100 ms of round trip: stages 20 MiB within the deadline", () =>
      Effect.gen(function* () {
        const folder = `Far ${run}`;
        const bytes = randomBytes(MAX);
        const uidValidity = yield* seed(mail.dovecot, folder, [
          message("Far away", "far-boundary", [
            text("Far."),
            base64Part("application/pdf", "far.pdf", bytes)
          ])
        ]);
        const proxy = yield* delayed(mail.dovecot.tls, 50);
        const far = ImapNetwork.loopback(() => [route(mail.dovecot, proxy.port)]);
        // Fresh: the suite's own Source layer, the same object, would stand in for this one.
        const sessions = yield* Sessions.make.pipe(
          Effect.provide(Layer.fresh(Source.layer).pipe(Layer.provide(far)))
        );
        const { stage } = yield* connected(mail.dovecot, "attach-far", sessions);
        const started = Date.now();
        const answer = yield* stage(folder, uidValidity, 1, "2");
        const took = Date.now() - started;
        assert.deepInclude(answer, { size: MAX, sha256: sha256(bytes) });
        assert.isBelow(took, 15_000);
        // Through the relay, not around it.
        assert.isAbove(relayed.bytes, MAX);
        process.stdout.write(`20 MiB behind 100 ms of round trip staged in ${took} ms\n`);
      }).pipe(Effect.scoped)
    );
  }
);
