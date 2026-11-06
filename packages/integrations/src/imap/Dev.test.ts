// @effect-diagnostics nodeBuiltinImport:off -- A stub instance answers on a real socket.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, DEV_ATTACHMENT_HEADER, WIRE_VERSION } from "@patchy/api";
import { NodeCryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import { Binding } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ImapTest from "../test/imap.js";
import * as ImapDev from "./Dev.js";

/**
 * The dev daemon's side of an attachment: what a stub instance answers over the door's byte
 * transport, and what the daemon stages of it. A transfer stages only whole and matching; one
 * that ends short, differs or runs past the bound stages nothing. The instance's own side is the
 * dev door's suite.
 */

const viewer = {
  user: { id: "usr_dev", name: "Dev", email: "dev@example.test" },
  company: { id: "cmp_dev", handle: "dev", name: "Dev" },
  admin: false
};
const binding = Binding.Binding.of({
  patchId: "localdev0000",
  versionId: "ver_000000000000000000000000",
  companyId: viewer.company.id,
  scope: "company",
  wireVersion: WIRE_VERSION,
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: { mail: { kind: "imap", id: "conn_mail", handle: "invoices", revision: 1 } }
  },
  identity: viewer,
  reauthorize: Effect.succeed(viewer),
  principal: { userId: viewer.user.id },
  correlationId: "local-dev-call"
});
const ref = { connection: "conn_mail", folder: "INBOX", uidValidity: 9, uid: 1 };
const content = Uint8Array.from({ length: 6_000 }, (_, index) => (index * 13) % 256);
const meta = (bytes: Uint8Array, over: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentType: "application/pdf",
      filename: "invoice.pdf",
      ...over
    })
  ).toString("base64url");

/** A stub instance whose door answers each request as `answer` says, and what it was sent. */
const instance = (answer: (request: IncomingMessage, response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ apiUrl: string; bodies: unknown[]; close: () => void }>((resolve) => {
          const bodies: unknown[] = [];
          const server = createServer((request, response) => {
            let body = "";
            request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
            request.on("end", () => {
              bodies.push({
                url: request.url,
                authorization: request.headers.authorization,
                body: JSON.parse(body) as unknown
              });
              answer(request, response);
            });
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            resolve({
              apiUrl: `http://127.0.0.1:${port}`,
              bodies,
              close: () => server.close()
            });
          });
        })
    ),
    (stub) => Effect.sync(stub.close)
  );

/** A stage through the dev binding against `apiUrl`, with recording local staging. */
const stage = (apiUrl: string, limits: Partial<Record<"files.stage.bytes", number>> = {}) =>
  Effect.gen(function* () {
    const staging = ImapTest.recordingStaging();
    const handlers = yield* ImapDev.handlers(
      { apiUrl, token: Option.some(Redacted.make("pat_machine_key")) },
      staging.service
    );
    const result = yield* handlers["imap.stageAttachment"]
      .run({ connection: "mail", ref, part: "2" })
      .pipe(
        Effect.provideService(Binding.Binding, binding),
        Effect.provideService(ContractLimits.overrides, limits),
        Effect.result
      );
    return { result, staged: staging.staged };
  }).pipe(Effect.provide([FetchHttpClient.layer, NodeCryptography.layer]));

it.effect("stages a whole transfer locally, as the instance stated it", () =>
  Effect.gen(function* () {
    const stub = yield* instance((_, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        [DEV_ATTACHMENT_HEADER]: meta(content)
      });
      response.end(content);
    });
    const { result, staged } = yield* stage(stub.apiUrl);
    assert.strictEqual(result._tag, "Success");
    if (result._tag === "Success")
      assert.deepInclude(result.success as object, {
        ok: true,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        filename: "invoice.pdf"
      });
    assert.lengthOf(staged, 1);
    assert.deepStrictEqual(staged[0]!.bytes, content);
    // The door heard the declared connection's id and handle, the arguments and the machine key.
    assert.deepStrictEqual(stub.bodies, [
      {
        url: "/api/connections/dev-attachment",
        authorization: "Bearer pat_machine_key",
        body: {
          op: "imap.stageAttachment",
          connection: { id: "conn_mail", handle: "invoices" },
          args: { ref, part: "2" }
        }
      }
    ]);
  }).pipe(Effect.scoped)
);

it.effect("stages nothing of a transfer that ends short or differs", () =>
  Effect.gen(function* () {
    const short = yield* instance((_, response) => {
      response.writeHead(200, { [DEV_ATTACHMENT_HEADER]: meta(content) });
      // The connection drops partway through what the instance said it would send.
      response.write(content.subarray(0, 2_000), () => response.destroy());
    });
    const differs = yield* instance((_, response) => {
      response.writeHead(200, { [DEV_ATTACHMENT_HEADER]: meta(content) });
      response.end(content.map((byte) => byte ^ 1));
    });
    for (const stub of [short, differs]) {
      const { result, staged } = yield* stage(stub.apiUrl);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.propertyVal(result.failure, "_tag", "DevDoorInstanceUnavailable");
        assert.propertyVal(result.failure, "code", "source_unavailable");
      }
      assert.lengthOf(staged, 0);
    }
  }).pipe(Effect.scoped)
);

it.effect("refuses a transfer past the bound, stated or sent, staging nothing", () =>
  Effect.gen(function* () {
    const stated = yield* instance((_, response) => {
      response.writeHead(200, { [DEV_ATTACHMENT_HEADER]: meta(content) });
      response.end(content);
    });
    // States what fits, then sends more.
    const sent = yield* instance((_, response) => {
      response.writeHead(200, {
        [DEV_ATTACHMENT_HEADER]: meta(content.subarray(0, 4_000))
      });
      response.end(content);
    });
    for (const stub of [stated, sent]) {
      const { result, staged } = yield* stage(stub.apiUrl, { "files.stage.bytes": 5_000 });
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.include(result.failure, { code: "too_large", limitId: "files.stage.bytes" });
      assert.lengthOf(staged, 0);
    }
  }).pipe(Effect.scoped)
);

it.effect("hands on the instance's refusal as it sent it", () =>
  Effect.gen(function* () {
    const stub = yield* instance((_, response) => {
      response.writeHead(413, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          source: "patchy",
          code: "too_large",
          error: "Part 2 is past the 20971520 bytes one staged file holds.",
          limitId: "files.stage.bytes",
          operation: "imap.stageAttachment",
          details: { part: "2" }
        })
      );
    });
    const { result, staged } = yield* stage(stub.apiUrl);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.propertyVal(result.failure, "_tag", "DevDoorRefused");
      assert.propertyVal(result.failure, "code", "too_large");
    }
    assert.lengthOf(staged, 0);
  }).pipe(Effect.scoped)
);
