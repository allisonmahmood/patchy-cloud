import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Identity, RuntimeStreamFrame, bodyTooLarge, toolRefusal } from "@patchy/api";
import { switcherRelay } from "@patchy/core";
import { registry } from "@patchy/limits/registry";
import {
  brokerScript,
  brokerSrc,
  SHELL_SECURITY_POLICY,
  withSwitcherRelay
} from "@patchy/serving/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import * as DevServer from "./devServer.js";
import * as DirectoryWatch from "./DirectoryWatch.js";
import { readRecord } from "./devState.js";
import type { Prepared } from "./devPreparation.js";
import { RELEASE, MANIFEST_VERSION, WIRE_VERSION } from "./release.js";
import toolchain from "./toolchain.json" with { type: "json" };
import { NodeCryptography } from "@patchy/core";
import { stalledUpload } from "../../../test/socket.js";

const identity = new Identity({
  user: { id: "local-user", email: "local@example.test", name: "Local" },
  company: { id: "local-company", handle: "local", name: "Local" },
  role: "admin",
  machine: { id: "local-machine", name: "Local machine" }
});

const decodeStreamFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeStreamFrame));

it.live(
  "serves and synchronizes local documents, refuses foreign admission, and swaps completed builds",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Beneath the workspace so Vite resolves from the actual installed toolchain.
      const root = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".dev-runtime-test-"
      });
      const stateDir = path.join(root, ".patchy", "dev");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(root, "package.json"), '{"type":"module"}');
      yield* fs.makeDirectory(path.join(root, "node_modules"));
      yield* fs.symlink(
        path.join(process.cwd(), "packages/patchy"),
        path.join(root, "node_modules/patchy")
      );
      const document = (title: string) =>
        `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;
      yield* fs.writeFileString(path.join(root, "index.html"), document("First local build"));
      const prepared: Prepared = {
        patchId: "localdev0000",
        manifest: {
          release: RELEASE,
          manifestVersion: MANIFEST_VERSION,
          tier: 1,
          tables: {
            notes: {
              description: "Notes identified by id.",
              columns: { title: { kind: "text" } },
              indexes: {}
            }
          },
          files: {},
          uses: {}
        },
        identity,
        metadata: { postgres: {}, posthog: {}, pidgeon: {}, attio: {}, imap: {}, shared: {} }
      };
      const server = yield* DevServer.serve(
        prepared,
        stateDir,
        {
          root,
          instance: "https://metadata.example.test",
          nonce: "local-test",
          release: RELEASE,
          identity: prepared.identity,
          pid: process.pid,
          birth: "starting"
        },
        toolchain,
        Option.none()
      ).pipe(Effect.forkScoped);
      yield* Effect.gen(function* () {
        while (!(yield* Effect.promise(() => readRecord(stateDir)))?.url)
          yield* Effect.sleep("25 millis");
      }).pipe(Effect.raceFirst(Fiber.join(server)), Effect.timeout("15 seconds"));
      const origin = yield* HttpServer.addressFormattedWith(Effect.succeed);
      const record = yield* Effect.promise(() => readRecord(stateDir));
      assert.isString(record?.colleagueUrl);
      const colleagueOrigin = new URL(record!.colleagueUrl!).origin;
      assert.notStrictEqual(colleagueOrigin, origin);
      const client = yield* HttpClient.HttpClient;
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(origin))
      );
      const base = `/dev/${prepared.patchId}`;
      const content = `/~content/${prepared.patchId}/ver_000000000000000000000000`;
      const shell = yield* http.get(base);
      assert.strictEqual(shell.status, 200);
      assert.strictEqual(shell.headers["content-security-policy"], SHELL_SECURITY_POLICY);
      const shellHtml = yield* shell.text;
      assert.include(shellHtml, content);
      // The local server answers the hosted shell's versioned broker URL, uncached.
      assert.include(shellHtml, `src="${brokerSrc}"`);
      const broker = yield* http.get(brokerSrc);
      assert.strictEqual(broker.headers["cache-control"], "private, no-store");
      assert.strictEqual(yield* broker.text, brokerScript);
      const initial = yield* http.get(content);
      assert.include(initial.headers["content-security-policy"]!, "connect-src 'none'");
      const initialHtml = yield* initial.text;
      assert.include(initialHtml, "First local build");
      // As the cloud serves it: the relay that claims Patchy's switcher key leads its head.
      assert.include(shellHtml, switcherRelay);
      assert.strictEqual(withSwitcherRelay(initialHtml.replace(switcherRelay, "")), initialHtml);

      // Each mount's person keeps their own single-key shortcut setting, which names its frame,
      // and the shell's dialog saves it through the route Patchy serves.
      const named = Effect.fn(function* (target: string) {
        const html = yield* (yield* client.get(`${target}${base}`)).text;
        return html.match(/ name="(patchy:shortcuts=(?:on|off))"/)?.[1];
      });
      const setShortcuts = (value: string, from = origin, target = origin) =>
        client.execute(
          HttpClientRequest.post(`${target}/api/me/shortcuts`).pipe(
            HttpClientRequest.setHeaders({ origin: from, accept: "application/json" }),
            HttpClientRequest.bodyUrlParams({ value })
          )
        );
      assert.strictEqual(yield* named(origin), "patchy:shortcuts=on");
      assert.strictEqual((yield* setShortcuts("off", "https://foreign.example.test")).status, 403);
      assert.strictEqual((yield* setShortcuts("sideways")).status, 400);
      const off = yield* setShortcuts("off");
      assert.strictEqual(off.status, 200);
      assert.deepStrictEqual(yield* off.json, { value: "off" });
      assert.strictEqual(yield* named(origin), "patchy:shortcuts=off");
      assert.strictEqual(yield* named(colleagueOrigin), "patchy:shortcuts=on");
      const stored = path.join(stateDir, "shortcuts.json");
      assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(stored)), {
        [identity.user.id]: false
      });
      // A save whose write fails is refused and changes nothing a shell shows.
      yield* fs.remove(stored);
      yield* fs.makeDirectory(stored);
      assert.strictEqual((yield* setShortcuts("on")).status, 503);
      assert.strictEqual(yield* named(origin), "patchy:shortcuts=off");
      yield* fs.remove(stored, { recursive: true });

      const call = (
        op: string,
        args: unknown,
        from = origin,
        viewerId = prepared.identity.user.id,
        target = origin
      ) =>
        client.execute(
          HttpClientRequest.post(`${target}/api/runtime/call`).pipe(
            HttpClientRequest.setHeaders({
              origin: from,
              "x-patchy-wire": String(WIRE_VERSION),
              "x-patchy-principal": JSON.stringify({ userId: viewerId })
            }),
            HttpClientRequest.bodyJsonUnsafe({
              patchId: prepared.patchId,
              versionId: "ver_000000000000000000000000",
              wire: WIRE_VERSION,
              principal: { userId: viewerId },
              op,
              args
            })
          )
        );
      const colleague = yield* call(
        "me",
        {},
        colleagueOrigin,
        "usr_dev_colleague",
        colleagueOrigin
      );
      const colleagueClaims = yield* colleague.json;
      assert.nestedPropertyVal(colleagueClaims, "value.user.id", "usr_dev_colleague");
      assert.nestedPropertyVal(colleagueClaims, "value.admin", false);
      // The guest mount is the patch's guest, in its company, with no agent door.
      const guestOrigin = new URL(record!.guestUrl!).origin;
      assert.notInclude([origin, colleagueOrigin], guestOrigin);
      const guest = yield* (yield* call("me", {}, guestOrigin, "usr_dev_guest", guestOrigin)).json;
      assert.deepNestedInclude(guest, {
        "value.user.id": "usr_dev_guest",
        "value.company": prepared.identity.company,
        "value.admin": false,
        "value.guest": true
      });
      const agentDoor = (target: string) =>
        client.execute(
          HttpClientRequest.post(`${target}/~dev/agent`).pipe(
            HttpClientRequest.setHeader("x-patchy-dev", record!.nonce),
            HttpClientRequest.bodyJsonUnsafe({})
          )
        );
      assert.strictEqual((yield* agentDoor(colleagueOrigin)).status, 200);
      assert.strictEqual((yield* agentDoor(guestOrigin)).status, 404);
      // The agent door reads a call as Patchy MCP does, and the shortcuts form as Patchy does:
      // one byte past either cap, streamed or declared, is refused without the rest, and closes.
      // The agent door's refusal is the door's own: such a body is refused unread, so nothing ran.
      const tooLarge = {
        ok: true,
        person: identity.user.name,
        // This patch is tier 1, so no server build has answered yet.
        build: 0,
        rebuildFailed: false,
        answer: toolRefusal(bodyTooLarge)
      };
      const { host, port } = new URL(origin);
      for (const [head, maxBytes, status, refusal] of [
        [
          `POST /~dev/agent HTTP/1.1\nhost: ${host}\nx-patchy-dev: ${record!.nonce}\ncontent-type: application/json`,
          registry["mcp.body.bytes"].default,
          200,
          tooLarge
        ],
        [
          `POST /api/me/shortcuts HTTP/1.1\nhost: ${host}\norigin: ${origin}\ncontent-type: application/x-www-form-urlencoded`,
          4_096,
          400,
          "Send value=on or value=off."
        ]
      ] as const) {
        for (const body of [{ chunked: maxBytes + 1 }, { declared: maxBytes + 1 }]) {
          const label = `${head.split("\n")[0]} ${JSON.stringify(body)}`;
          const answer = yield* Effect.promise(() => stalledUpload(Number(port), head, body));
          assert.strictEqual(answer.status, status, label);
          assert.deepStrictEqual(
            status === 200 ? JSON.parse(answer.body) : answer.body,
            refusal,
            label
          );
          assert.isDefined(answer.closedAfterMs, label);
        }
      }
      // The CLI's own client, sending a call past the cap as `patchy dev agent` does, reads that
      // refusal though the server answers before reading the body; a malformed call within the
      // cap stays a bad request.
      const agentCall = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          const response = yield* (yield* HttpClient.HttpClient).execute(
            request.pipe(HttpClientRequest.setHeader("x-patchy-dev", record!.nonce))
          );
          return { status: response.status, text: yield* response.text };
        }).pipe(Effect.provide(NodeHttpClient.layerUndici));
      const overCap = yield* agentCall(
        HttpClientRequest.post(`${origin}/~dev/agent`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            call: { tool: "addNote", args: { text: "x".repeat(1_114_112) } }
          })
        )
      );
      assert.strictEqual(overCap.status, 200);
      assert.deepStrictEqual(JSON.parse(overCap.text), tooLarge);
      const malformed = yield* agentCall(
        HttpClientRequest.post(`${origin}/~dev/agent`).pipe(
          HttpClientRequest.bodyText("{", "application/json")
        )
      );
      assert.deepStrictEqual(malformed, { status: 400, text: "Bad request" });
      // Dev holds the page to its own patch as production does: the directory is a handler's.
      for (const [target, viewerId] of [
        [origin, identity.user.id],
        [colleagueOrigin, "usr_dev_colleague"]
      ]) {
        const listed = yield* call("members.list", {}, target, viewerId, target);
        assert.strictEqual(listed.status, 403);
        assert.deepInclude(yield* listed.json, { code: "server_required" });
      }
      const impersonation = yield* call(
        "tables.insert",
        { table: "notes", row: { title: "Wrong viewer" } },
        colleagueOrigin,
        prepared.identity.user.id,
        colleagueOrigin
      );
      assert.strictEqual(impersonation.status, 409);
      const refused = yield* call(
        "tables.insert",
        { table: "notes", row: { title: "Forbidden" } },
        "https://foreign.example.test"
      );
      assert.strictEqual(refused.status, 403);
      const invalid = yield* call("tables.insert", { table: "notes", row: { title: 42 } });
      const failure = yield* invalid.json;
      assert.propertyVal(failure, "code", "invalid_row");
      assert.notProperty(failure, "correlationId");
      const subscribe = Effect.fn(function* (documentId: string) {
        const frames = yield* Queue.make<RuntimeStreamFrame>();
        const query = new URLSearchParams({
          patchId: prepared.patchId,
          versionId: "ver_000000000000000000000000",
          documentId
        });
        const stream = yield* http.execute(
          HttpClientRequest.get(`/api/runtime/stream?${query}`).pipe(
            HttpClientRequest.setHeaders({
              origin,
              "sec-fetch-site": "same-origin",
              "x-patchy-wire": String(WIRE_VERSION),
              "x-patchy-principal": JSON.stringify({ userId: prepared.identity.user.id })
            })
          )
        );
        assert.strictEqual(stream.status, 200);
        yield* stream.stream.pipe(
          Stream.decodeText,
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.mapEffect((event) => decodeStreamFrame(event.data)),
          Stream.runForEach((frame) => Queue.offer(frames, frame)),
          Effect.forkScoped
        );
        const hello = yield* Queue.take(frames).pipe(Effect.timeout("5 seconds"));
        if (hello.type !== "hello") return yield* Effect.die("The local stream needs a hello.");
        const response = yield* http.execute(
          HttpClientRequest.post("/api/runtime/subscriptions").pipe(
            HttpClientRequest.setHeaders({
              origin,
              "sec-fetch-site": "same-origin",
              "x-patchy-wire": String(WIRE_VERSION),
              "x-patchy-principal": JSON.stringify({ userId: prepared.identity.user.id })
            }),
            HttpClientRequest.bodyJsonUnsafe({
              patchId: prepared.patchId,
              versionId: "ver_000000000000000000000000",
              documentId,
              generation: hello.generation,
              sequence: 0,
              type: "replace",
              subscriptions: [{ id: "notes", op: "tables.list", args: { table: "notes" } }]
            })
          )
        );
        assert.strictEqual(response.status, 200);
        yield* response.text;
        return Effect.gen(function* () {
          while (true) {
            const frame = yield* Queue.take(frames);
            if (frame.type === "snapshot") return frame.result;
            assert.notStrictEqual(frame.type, "error");
          }
        }).pipe(Effect.timeout("5 seconds"));
      });
      const firstDocument = yield* subscribe("local-document-first");
      const secondDocument = yield* subscribe("local-document-second");
      assert.deepStrictEqual(yield* firstDocument, { rows: [], cursor: null });
      assert.deepStrictEqual(yield* secondDocument, { rows: [], cursor: null });
      const inserted = yield* call(
        "tables.insert",
        { table: "notes", row: { title: "Local persisted note" } },
        colleagueOrigin,
        "usr_dev_colleague",
        colleagueOrigin
      );
      assert.strictEqual(inserted.status, 200);
      assert.nestedPropertyVal(yield* inserted.json, "value.title", "Local persisted note");
      for (const next of [firstDocument, secondDocument]) {
        const snapshot = yield* next;
        assert.nestedPropertyVal(snapshot, "rows[0].title", "Local persisted note");
        assert.nestedPropertyVal(snapshot, "rows.length", 1);
      }
      const listed = yield* call("tables.list", { table: "notes", limit: 10 });
      const result = yield* listed.json;
      assert.nestedPropertyVal(result, "value.rows[0].title", "Local persisted note");
      assert.nestedPropertyVal(result, "value.rows.length", 1);

      yield* fs.writeFileString(path.join(root, "index.html"), document("Second local build"));
      yield* Effect.gen(function* () {
        while ((yield* (yield* http.get("/~dev/build")).text) === "1")
          yield* Effect.sleep("25 millis");
      }).pipe(Effect.raceFirst(Fiber.join(server)), Effect.timeout("10 seconds"));
      assert.include(yield* (yield* http.get(content)).text, "Second local build");
      assert.strictEqual((yield* http.get(`${base}/notes/7`)).status, 200);
    }).pipe(
      Effect.provide(NodeHttpClient.layerNodeHttp),
      Effect.provide(NodeHttpServer.layerTest),
      Effect.provide([NodeServices.layer, NodeCryptography.layer, DirectoryWatch.layer])
    ),
  { timeout: 30_000 }
);
