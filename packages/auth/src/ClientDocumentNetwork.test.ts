// @effect-diagnostics nodeBuiltinImport:off -- A real TLS server shows what the production connection pins and verifies.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ClientDocumentNetwork from "./ClientDocumentNetwork.js";

/** A self-signed certificate for `name`, which no client trusts. */
const selfSigned = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), "patchy-cimd-"));
  try {
    execFileSync(
      "openssl",
      [
        ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1"],
        ...["-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`],
        ...["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")]
      ],
      { stdio: "ignore" }
    );
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

it.effect(
  "connects only to the checked address, names the host, and refuses an untrusted certificate",
  () =>
    Effect.gen(function* () {
      // `.invalid` never resolves, so reaching the server proves the name wasn't looked up.
      const hostname = "client.invalid";
      const servernames: Array<string> = [];
      const server = createServer({
        ...selfSigned(hostname),
        SNICallback: (servername, callback) => {
          servernames.push(servername);
          callback(null);
        }
      });
      const port = yield* Effect.acquireRelease(
        Effect.callback<number>((resume) => {
          server.listen(0, "127.0.0.1", () =>
            resume(Effect.succeed((server.address() as AddressInfo).port))
          );
        }),
        () => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void)))
      );
      const network = yield* ClientDocumentNetwork.ClientDocumentNetwork.pipe(
        Effect.provide(ClientDocumentNetwork.layer)
      );
      const socket = yield* network.connect({
        hostname,
        port,
        addresses: [{ address: "127.0.0.1", family: 4 }]
      });
      const error = yield* Effect.callback<NodeJS.ErrnoException>((resume) => {
        socket.once("error", (cause) => resume(Effect.succeed(cause)));
      });
      assert.strictEqual(error.code, "DEPTH_ZERO_SELF_SIGNED_CERT");
      assert.deepStrictEqual(servernames, [hostname]);
    })
);
