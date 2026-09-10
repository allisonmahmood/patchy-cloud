import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { RuntimeGroup, RuntimeFileParams, WIRE_VERSION } from "@patchy/api";
import { Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { ContentStore } from "@patchy/content-store";
import { Limits } from "@patchy/limits";
import { LoadedVersions, Runtime, RuntimeApi, RuntimeLog, me } from "@patchy/runtime";
import * as Files from "./Files.js";
import { companyId, manifest, services, setup, versionId } from "./test/files.js";

const patchId = "filehttptest";
const publicVersionId = "ver_bbbbbbbbbbbbbbbbbbbbbbbb";
const omittedVersionId = "ver_cccccccccccccccccccccccc";
const versions = Layer.succeed(LoadedVersions.LoadedVersions, {
  find: (patch, version = versionId) =>
    Effect.succeed(
      patch !== patchId || ![versionId, publicVersionId, omittedVersionId].includes(version)
        ? Option.none()
        : Option.some({
            patchId,
            versionId: version,
            companyId,
            wireVersion: WIRE_VERSION,
            scope: version === publicVersionId ? ("public" as const) : ("company" as const),
            manifest: version === omittedVersionId ? { ...manifest, files: {} } : manifest
          })
    )
});
const dependencies = Layer.mergeAll(
  versions,
  Limits.layer,
  RuntimeLog.layer,
  Session.layer,
  Users.layer,
  Companies.layer
).pipe(Layer.provideMerge(services));
const runtime = Layer.unwrap(
  Effect.map(Files.make, (files) => Runtime.layer({ me, ...files }))
).pipe(Layer.provideMerge(dependencies));
const apiDefinition = HttpApi.make("patchy").add(RuntimeGroup);
const apiLayer = RuntimeApi.layer.pipe(Layer.provideMerge(runtime));
const settings = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    ...clerkEnv(),
    PATCHY_RUNTIME_FILE_BYTES: "1024"
  })
);
const socket = HttpRouter.serve(HttpApiBuilder.layer(apiDefinition).pipe(Layer.provide(apiLayer)), {
  disableLogger: true,
  disableListenLog: true
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(runtime),
  Layer.provide(settings)
);
const fileUrl = ({ patchId, versionId, store, name }: typeof RuntimeFileParams.Type) =>
  RuntimeGroup.endpoints.getFile.path
    .replace(":patchId", encodeURIComponent(patchId))
    .replace(":versionId", encodeURIComponent(versionId))
    .replace(":store", encodeURIComponent(store))
    .replace("*", name.split("/").map(encodeURIComponent).join("/"));
const headers = () => ({
  "x-patchy-wire": String(WIRE_VERSION),
  "x-patchy-principal": JSON.stringify({ userId: "usr_dev" }),
  cookie: signedInCookies()
});

it.layer(socket)("Files HTTP / real operations", (it) => {
  it.effect(
    "authorizes raw active content live, returns no-store, and logs only admitted mutations",
    () =>
      Effect.gen(function* () {
        yield* setup(patchId);
        const client = yield* HttpClient.HttpClient;
        const api = yield* HttpApiClient.makeWith(apiDefinition, { httpClient: client });
        const sql = yield* SqlClient.SqlClient;
        const params = { patchId, versionId, store: "docs", name: "folder/active.svg" };
        const bytes = new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        );
        const denied = yield* client.put(fileUrl(params), {
          body: HttpBody.uint8Array(bytes),
          headers: { ...headers(), origin: "https://foreign.invalid" }
        });
        assert.strictEqual(denied.status, 403);
        assert.include(yield* denied.json, { code: "access_denied" });
        assert.deepStrictEqual(yield* sql`SELECT id FROM runtime_calls`, []);
        const uploaded = yield* client.put(fileUrl(params), {
          body: HttpBody.uint8Array(bytes, "image/svg+xml"),
          headers: { ...headers(), origin: PUBLIC_BASE_URL }
        });
        assert.strictEqual(uploaded.status, 200);
        assert.deepStrictEqual(yield* uploaded.json, { ok: true, value: null });
        assert.strictEqual(uploaded.headers["cache-control"], "no-store");
        const read = yield* client.get(fileUrl(params), {
          headers: { ...headers(), "sec-fetch-site": "same-origin" }
        });
        assert.strictEqual(read.status, 200);
        assert.deepStrictEqual(new Uint8Array(yield* read.arrayBuffer), bytes);
        assert.strictEqual(read.headers["content-type"], "image/svg+xml");
        assert.strictEqual(read.headers["cache-control"], "no-store");
        assert.strictEqual(read.headers["x-content-type-options"], "nosniff");
        assert.strictEqual(read.headers["content-disposition"], "attachment");
        const companies = yield* Companies.Companies;
        const { user: outsider } = yield* companies.create({
          name: "Files outsider",
          handle: "files-outsider",
          clerkUserId: "user_files_outsider",
          email: "files-outsider@example.com",
          userName: "Files outsider"
        });
        for (const [claims, principal] of [
          [{ sub: outsider.clerkUserId, email: outsider.email }, { userId: outsider.id }],
          [{ sub: "user_files_unenrolled", email: "files-unenrolled@example.com" }, null]
        ] as const) {
          const response = yield* client.get(fileUrl(params), {
            headers: {
              ...headers(),
              cookie: signedInCookies(signSession(claims)),
              "x-patchy-principal": JSON.stringify(principal),
              "sec-fetch-site": "same-origin"
            }
          });
          assert.strictEqual(response.status, 403);
          const body = yield* response.json;
          assert.include(body, { ok: false, code: "access_denied" });
          assert.notProperty(body, "correlationId");
          assert.strictEqual(response.headers["cache-control"], "no-store");
        }
        for (const [version, requestHeaders, code] of [
          [
            versionId,
            { ...headers(), cookie: "", "sec-fetch-site": "same-origin" },
            "session_expired"
          ],
          [versionId, { ...headers(), "sec-fetch-site": "cross-site" }, "access_denied"],
          [
            versionId,
            {
              ...headers(),
              "sec-fetch-site": "same-origin",
              "x-patchy-principal": '{"userId":"changed"}'
            },
            "principal_changed"
          ],
          [
            publicVersionId,
            { ...headers(), "sec-fetch-site": "same-origin" },
            "not_available_on_public"
          ],
          [omittedVersionId, { ...headers(), "sec-fetch-site": "same-origin" }, "invalid_request"]
        ] as const) {
          const response = yield* client.get(fileUrl({ ...params, versionId: version }), {
            headers: requestHeaders
          });
          assert.include(yield* response.json, { code });
          assert.strictEqual(response.headers["cache-control"], "no-store");
        }
        assert.deepStrictEqual(
          yield* sql`SELECT op, resource, outcome, user_id AS "userId" FROM runtime_calls`,
          [
            {
              op: "files.put",
              resource: "docs/folder/active.svg",
              outcome: "success",
              userId: "usr_dev"
            }
          ]
        );
        const missing = yield* client.get(fileUrl({ ...params, name: "missing" }), {
          headers: { ...headers(), "sec-fetch-site": "same-origin" }
        });
        assert.include(yield* missing.json, { code: "invalid_request" });
        assert.notProperty(yield* missing.json, "correlationId");
        const old = yield* client.get(fileUrl(params), {
          headers: { ...headers(), "sec-fetch-site": "same-origin" }
        });
        assert.deepStrictEqual(new Uint8Array(yield* old.arrayBuffer), bytes);
        for (const op of ["files.get", "files.put"] as const) {
          const response = yield* api.call({
            payload: {
              patchId,
              versionId,
              wire: WIRE_VERSION,
              principal: { userId: "usr_dev" },
              op,
              args:
                op === "files.put"
                  ? { store: "docs", name: "folder/active.svg", contentType: "image/svg+xml" }
                  : { store: "docs", name: "folder/active.svg" }
            },
            headers: { ...headers(), origin: PUBLIC_BASE_URL },
            responseMode: "response-only"
          });
          assert.strictEqual(response.status, 400);
          assert.include(yield* response.json, { code: "invalid_request" });
        }
      }),
    60_000
  );
});

it.layer(socket)("Files HTTP / deletion", (it) => {
  it.effect(
    "deletes through api.call idempotently, logs each success, and retains the stored bytes",
    () =>
      Effect.gen(function* () {
        const { put } = yield* setup(patchId);
        const name = "folder/remove.bin";
        const bytes = new Uint8Array([0, 255, 128, 9]);
        yield* put(name, bytes);
        const client = yield* HttpClient.HttpClient;
        const api = yield* HttpApiClient.makeWith(apiDefinition, { httpClient: client });
        const content = yield* ContentStore.ContentStore;
        const objects = yield* content.list(`files/${patchId}/docs/`).pipe(Stream.runCollect);
        assert.lengthOf(objects, 1);
        const params = { patchId, versionId, store: "docs", name };
        const requestHeaders = { ...headers(), origin: PUBLIC_BASE_URL };
        const payload = {
          patchId,
          versionId,
          wire: WIRE_VERSION,
          principal: { userId: "usr_dev" }
        };
        const before = yield* client.get(fileUrl(params), {
          headers: { ...headers(), "sec-fetch-site": "same-origin" }
        });
        assert.strictEqual(before.status, 200);
        assert.deepStrictEqual(new Uint8Array(yield* before.arrayBuffer), bytes);
        for (let attempt = 0; attempt < 2; attempt++) {
          const deleted = yield* api.call({
            payload: { ...payload, op: "files.delete", args: { store: "docs", name } },
            headers: requestHeaders,
            responseMode: "response-only"
          });
          assert.strictEqual(deleted.status, 200);
          assert.deepStrictEqual(yield* deleted.json, { ok: true, value: null });
          assert.strictEqual(deleted.headers["cache-control"], "no-store");
          const missing = yield* client.get(fileUrl(params), {
            headers: { ...headers(), "sec-fetch-site": "same-origin" }
          });
          assert.strictEqual(missing.status, 400);
          const body = yield* missing.json;
          assert.include(body, { ok: false, code: "invalid_request" });
          assert.notProperty(body, "correlationId");
          assert.strictEqual(missing.headers["cache-control"], "no-store");
          assert.deepStrictEqual(yield* content.getBytes(objects[0]!.key), bytes);
        }
        const listed = yield* api.call({
          payload: { ...payload, op: "files.list", args: { store: "docs" } },
          headers: requestHeaders,
          responseMode: "response-only"
        });
        assert.strictEqual(listed.status, 200);
        assert.deepStrictEqual(yield* listed.json, {
          ok: true,
          value: { files: [], cursor: null }
        });
        assert.strictEqual(listed.headers["cache-control"], "no-store");
        const sql = yield* SqlClient.SqlClient;
        const calls = yield* sql`
          SELECT op, resource, outcome, user_id AS "userId", correlation_id AS "correlationId"
          FROM runtime_calls`;
        assert.deepStrictEqual(
          calls.map(({ correlationId, ...call }) => {
            assert.isString(correlationId);
            return call;
          }),
          [
            {
              op: "files.delete",
              resource: "docs/folder/remove.bin",
              outcome: "success",
              userId: "usr_dev"
            },
            {
              op: "files.delete",
              resource: "docs/folder/remove.bin",
              outcome: "success",
              userId: "usr_dev"
            }
          ]
        );
        assert.notStrictEqual(calls[0]!.correlationId, calls[1]!.correlationId);
      }),
    60_000
  );
});

it.layer(socket)("Files HTTP / streamed bytes", (it) => {
  it.effect(
    "counts chunked overflow after admission, correlates its log, and preserves the old file",
    () =>
      Effect.gen(function* () {
        const { put, get } = yield* setup(patchId);
        const original = new Uint8Array([0, 255, 128]);
        yield* put("chunked.bin", original);
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag !== "TcpAddress") return assert.fail("Expected a TCP listener");
        const url = `http://127.0.0.1:${server.address.port}${fileUrl({ patchId, versionId, store: "docs", name: "chunked.bin" })}`;
        const response = yield* Effect.tryPromise(async () => {
          const options: RequestInit & { duplex: "half" } = {
            method: "PUT",
            headers: {
              ...headers(),
              origin: PUBLIC_BASE_URL,
              "content-type": "application/octet-stream"
            },
            duplex: "half",
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(1024));
                controller.enqueue(new Uint8Array([1]));
                controller.close();
              }
            })
          };
          const result = await fetch(url, options);
          return {
            status: result.status,
            cache: result.headers.get("cache-control"),
            body: (await result.json()) as { code: string; correlationId: string }
          };
        });
        assert.strictEqual(response.status, 413);
        assert.strictEqual(response.cache, "no-store");
        assert.strictEqual(response.body.code, "too_large");
        assert.isString(response.body.correlationId);
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT op, resource, outcome FROM runtime_calls WHERE correlation_id = ${response.body.correlationId}`,
          [
            {
              op: "files.put",
              resource: "docs/chunked.bin",
              outcome: "failure"
            }
          ]
        );
        assert.deepStrictEqual((yield* get("chunked.bin")).bytes, original);
        // An oversized declaration cannot move the body limit ahead of browser admission.
        const denied = yield* Effect.tryPromise(async () => {
          const result = await fetch(url, {
            method: "PUT",
            headers: { ...headers(), cookie: "", origin: PUBLIC_BASE_URL },
            body: new Uint8Array(1025)
          });
          return { status: result.status, body: (await result.json()) as { code: string } };
        });
        assert.strictEqual(denied.status, 401);
        assert.strictEqual(denied.body.code, "session_expired");
        assert.deepStrictEqual(yield* sql`SELECT op FROM runtime_calls`, [{ op: "files.put" }]);
      }),
    60_000
  );
});
