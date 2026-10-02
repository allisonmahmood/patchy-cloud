import { assert, it } from "@effect/vitest";
import {
  CURRENT_RELEASE,
  MembersPage,
  PublishCreated,
  RuntimeStreamFrame,
  WIRE_VERSION
} from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { answer, publish, send, server } from "./test/server.js";

const decodePublished = Schema.decodeUnknownSync(PublishCreated);
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(RuntimeStreamFrame));
const decodePage = Schema.decodeUnknownSync(MembersPage);
const headers = {
  "x-patchy-wire": String(WIRE_VERSION),
  "x-patchy-principal": JSON.stringify({ userId: DEV_SEED.userId }),
  "sec-fetch-site": "same-origin",
  origin: "https://patchy.example"
};
const manifest = {
  manifestVersion: 1,
  release: CURRENT_RELEASE,
  tier: 1,
  tables: {},
  files: {},
  uses: { members: { kind: "members" } }
};
const layer = Layer.mergeAll(Companies.layer, Users.layer).pipe(
  Layer.provideMerge(server({ NODE_ENV: "test" }))
);

const connect = Effect.fnUntraced(function* (
  document: { patchId: string; versionId: string; documentId: string },
  authenticated: Record<string, string>
) {
  const response = yield* send(
    HttpClientRequest.get("/api/runtime/stream").pipe(
      HttpClientRequest.setUrlParams(document),
      HttpClientRequest.setHeaders(authenticated)
    )
  );
  assert.strictEqual(response.status, 200);
  const received = yield* Queue.unbounded<RuntimeStreamFrame>();
  yield* response.stream.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.startsWith("data: ")),
    Stream.map((line) => decodeFrame(line.slice(6))),
    Stream.runForEach((frame) => Queue.offer(received, frame)),
    Effect.forkScoped
  );
  const next = Effect.fnUntraced(function* (type: RuntimeStreamFrame["type"]) {
    while (true) {
      const frame = yield* Queue.take(received);
      if (frame.type === type) return frame;
      if (frame.type === "error") throw new Error(JSON.stringify(frame));
    }
  });
  const hello = yield* next("hello");
  if (hello.type !== "hello") throw new Error("Expected stream hello");
  return {
    next,
    generation: hello.generation,
    subscribe: (sequence: number, id: string, op: string) =>
      send(
        HttpClientRequest.post("/api/runtime/subscriptions").pipe(
          HttpClientRequest.setHeaders(authenticated),
          HttpClientRequest.bodyJsonUnsafe({
            ...document,
            generation: hello.generation,
            sequence,
            type: "subscribe",
            subscription: { id, op, args: op === "tables.list" ? { table: "rows" } : {} }
          })
        )
      )
  };
});

const call = (
  document: { patchId: string; versionId: string },
  authenticated: Record<string, string>,
  op: string,
  args: Record<string, unknown> = {}
) =>
  send(
    HttpClientRequest.post("/api/runtime/call").pipe(
      HttpClientRequest.setHeaders(authenticated),
      HttpClientRequest.bodyJsonUnsafe({
        patchId: document.patchId,
        versionId: document.versionId,
        wire: WIRE_VERSION,
        principal: JSON.parse(authenticated["x-patchy-principal"]!),
        op,
        args
      })
    )
  ).pipe(Effect.flatMap(answer));

it.layer(layer)("hosted member directory", (it) => {
  it.effect("delivers committed joins and deactivation to an open candidate subscription", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const users = yield* Users.Users;
      const response = yield* publish(DEV_SEED.token, {
        html: "<!doctype html><html><head><title>Members</title></head><body>Members</body></html>",
        manifest
      });
      assert.strictEqual(response.status, 201);
      const published = decodePublished(yield* response.json);
      const document = {
        patchId: published.patchId,
        versionId: published.versionId,
        documentId: "member_directory_document"
      };
      const authenticated = {
        ...headers,
        cookie: signedInCookies(signSession({ azp: headers.origin }))
      };
      const stream = yield* send(
        HttpClientRequest.get("/api/runtime/stream").pipe(
          HttpClientRequest.setUrlParams(document),
          HttpClientRequest.setHeaders(authenticated)
        )
      );
      assert.strictEqual(stream.status, 200);
      const received = yield* Queue.unbounded<RuntimeStreamFrame>();
      yield* stream.stream.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("data: ")),
        Stream.map((line) => decodeFrame(line.slice(6))),
        Stream.runForEach((frame) => Queue.offer(received, frame)),
        Effect.forkScoped
      );
      const next = Effect.fnUntraced(function* (type: RuntimeStreamFrame["type"]) {
        while (true) {
          const frame = yield* Queue.take(received);
          if (frame.type === type) return frame;
          if (frame.type === "error") throw new Error(JSON.stringify(frame));
        }
      });
      const hello = yield* next("hello");
      if (hello.type !== "hello") throw new Error("Expected stream hello");
      const subscribed = yield* send(
        HttpClientRequest.post("/api/runtime/subscriptions").pipe(
          HttpClientRequest.setHeaders(authenticated),
          HttpClientRequest.bodyJsonUnsafe({
            ...document,
            generation: hello.generation,
            sequence: 1,
            type: "subscribe",
            subscription: { id: "candidates", op: "members.list", args: {} }
          })
        )
      );
      assert.strictEqual(subscribed.status, 200);
      const initial = yield* next("snapshot");
      if (initial.type !== "snapshot") throw new Error("Expected initial snapshot");
      assert.deepStrictEqual(
        decodePage(initial.result).rows.map((member) => member.id),
        [DEV_SEED.userId]
      );
      const invite = yield* companies.createInvite({
        companyId: DEV_SEED.companyId,
        email: "anna@example.com",
        invitedBy: DEV_SEED.userId
      });
      const anna = yield* companies.consumeInvite({
        inviteId: invite.id,
        clerkUserId: "user_member_anna",
        email: "anna@example.com",
        name: "Anna"
      });
      const joined = yield* next("snapshot");
      if (joined.type !== "snapshot") throw new Error("Expected join snapshot");
      assert.deepStrictEqual(
        decodePage(joined.result).rows.map((member) => member.id),
        [anna.id, DEV_SEED.userId]
      );
      assert.notStrictEqual(
        joined.vector[`members:${DEV_SEED.companyId}`],
        initial.vector[`members:${DEV_SEED.companyId}`]
      );
      yield* users.deactivate({ companyId: DEV_SEED.companyId, userId: anna.id });
      const deactivated = yield* next("snapshot");
      if (deactivated.type !== "snapshot") throw new Error("Expected deactivation snapshot");
      assert.deepStrictEqual(
        decodePage(deactivated.result).rows.map((member) => member.id),
        [DEV_SEED.userId]
      );
    }).pipe(Effect.scoped)
  );

  it.effect("authenticates public directory calls without exposing identity through me", () =>
    Effect.gen(function* () {
      const response = yield* publish(DEV_SEED.token, {
        html: "<!doctype html><html><head><title>Public members</title></head><body>Members</body></html>",
        manifest,
        scope: "public"
      });
      assert.strictEqual(response.status, 201);
      const published = decodePublished(yield* response.json);
      const authenticated = {
        ...headers,
        cookie: signedInCookies(signSession({ azp: headers.origin }))
      };
      const bootstrap = { ...authenticated, "x-patchy-principal": "null" };
      assert.deepStrictEqual(yield* call(published, bootstrap, "me"), {
        status: 200,
        body: { ok: true, value: null }
      });
      assert.deepStrictEqual(yield* call(published, bootstrap, "principal"), {
        status: 200,
        body: { ok: true, value: { userId: DEV_SEED.userId } }
      });
      const crossOrigin = yield* call(
        published,
        { ...bootstrap, origin: "https://outside.example" },
        "principal"
      );
      assert.deepInclude(crossOrigin.body, { code: "access_denied" });
      const stale = yield* call(
        published,
        {
          ...bootstrap,
          cookie: signedInCookies(signSession({ azp: headers.origin, iat: 1, nbf: 1, exp: 2 }))
        },
        "principal"
      );
      assert.deepInclude(stale.body, { code: "session_refresh_required" });
      for (const [op, args] of [
        ["members.list", {}],
        ["members.search", { text: DEV_SEED.email }],
        ["members.get", { id: DEV_SEED.userId }],
        ["members.getMany", { ids: [DEV_SEED.userId] }]
      ] as const) {
        const result = yield* call(published, authenticated, op, args);
        assert.strictEqual(result.status, 200);
        assert.deepInclude(result.body, { ok: true });
        assert.include(JSON.stringify(result.body), DEV_SEED.userId);
      }
      const unbound = yield* call(published, bootstrap, "members.list");
      assert.deepInclude(unbound.body, { code: "principal_changed" });
      const switched = yield* call(
        published,
        { ...authenticated, "x-patchy-principal": '{"userId":"another_viewer"}' },
        "members.list"
      );
      assert.deepInclude(switched.body, { code: "principal_changed" });
      for (const op of ["tables.list", "files.list", "postgres.query", "members.unknown"]) {
        const result = yield* call(published, authenticated, op);
        assert.strictEqual(result.status, 403);
        assert.deepInclude(result.body, { code: "not_available_on_public" });
      }
    })
  );

  it.effect("refuses anonymous, foreign and deactivated public directory readers and streams", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const users = yield* Users.Users;
      const outsider = yield* companies.create({
        handle: "members-outsider",
        name: "Outsider",
        clerkUserId: "user_member_outsider",
        email: "outsider@example.com",
        userName: "Outsider"
      });
      const invite = yield* companies.createInvite({
        companyId: DEV_SEED.companyId,
        email: "inactive@example.com",
        invitedBy: DEV_SEED.userId
      });
      const inactive = yield* companies.consumeInvite({
        inviteId: invite.id,
        clerkUserId: "user_member_inactive",
        email: "inactive@example.com",
        name: "Inactive"
      });
      yield* users.deactivate({ companyId: DEV_SEED.companyId, userId: inactive.id });
      const response = yield* publish(DEV_SEED.token, {
        html: "<!doctype html><html><head><title>Public members</title></head><body>Members</body></html>",
        manifest,
        scope: "public"
      });
      const published = decodePublished(yield* response.json);
      for (const [userId, sub, email, code] of [
        [null, null, null, "session_expired"],
        [outsider.user.id, "user_member_outsider", "outsider@example.com", "access_denied"],
        [inactive.id, "user_member_inactive", "inactive@example.com", "access_denied"]
      ] as const) {
        const authenticated = {
          ...headers,
          "x-patchy-principal": JSON.stringify(userId === null ? null : { userId }),
          ...(sub === null
            ? {}
            : { cookie: signedInCookies(signSession({ azp: headers.origin, sub, email })) })
        };
        for (const op of ["principal", "members.list"]) {
          const result = yield* call(published, authenticated, op);
          assert.deepInclude(result.body, { ok: false, code });
        }
        const stream = yield* send(
          HttpClientRequest.get("/api/runtime/stream").pipe(
            HttpClientRequest.setUrlParams({
              patchId: published.patchId,
              versionId: published.versionId,
              documentId: "refused_member_document"
            }),
            HttpClientRequest.setHeaders(authenticated)
          )
        );
        assert.deepInclude(yield* stream.json, { ok: false, code });
      }
    })
  );

  it.effect("reauthorizes public member subscriptions on reconnect and live deactivation", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const users = yield* Users.Users;
      const invite = yield* companies.createInvite({
        companyId: DEV_SEED.companyId,
        email: "subscriber@example.com",
        invitedBy: DEV_SEED.userId
      });
      const viewer = yield* companies.consumeInvite({
        inviteId: invite.id,
        clerkUserId: "user_member_subscriber",
        email: "subscriber@example.com",
        name: "Subscriber"
      });
      const authenticated = {
        ...headers,
        "x-patchy-principal": JSON.stringify({ userId: viewer.id }),
        cookie: signedInCookies(
          signSession({
            azp: headers.origin,
            sub: "user_member_subscriber",
            email: "subscriber@example.com"
          })
        )
      };
      const response = yield* publish(DEV_SEED.token, {
        html: "<!doctype html><html><head><title>Public members</title></head><body>Members</body></html>",
        manifest,
        scope: "public"
      });
      const published = decodePublished(yield* response.json);
      const document = {
        patchId: published.patchId,
        versionId: published.versionId,
        documentId: "public_member_document"
      };
      const initial = yield* connect(document, authenticated);
      assert.strictEqual((yield* initial.subscribe(1, "members", "members.list")).status, 200);
      const snapshot = yield* initial.next("snapshot");
      if (snapshot.type !== "snapshot") throw new Error("Expected members snapshot");
      assert.include(
        decodePage(snapshot.result).rows.map((member) => member.id),
        viewer.id
      );
      assert.strictEqual((yield* initial.subscribe(2, "table", "tables.list")).status, 200);
      const refused = yield* initial.next("error");
      if (refused.type !== "error") throw new Error("Expected public table refusal");
      assert.strictEqual(refused.id, "table");
      assert.deepInclude(refused.error, { ok: false, code: "not_available_on_public" });
      const reconnected = yield* connect(document, {
        ...authenticated,
        "x-patchy-generation": initial.generation
      });
      assert.notStrictEqual(reconnected.generation, initial.generation);
      assert.strictEqual((yield* reconnected.subscribe(1, "members", "members.list")).status, 200);
      const resumed = yield* reconnected.next("snapshot");
      if (resumed.type !== "snapshot") throw new Error("Expected resumed snapshot");
      assert.include(
        decodePage(resumed.result).rows.map((member) => member.id),
        viewer.id
      );
      yield* users.deactivate({ companyId: DEV_SEED.companyId, userId: viewer.id });
      assert.deepStrictEqual(yield* reconnected.next("access_denied"), { type: "access_denied" });
      const denied = yield* send(
        HttpClientRequest.get("/api/runtime/stream").pipe(
          HttpClientRequest.setUrlParams(document),
          HttpClientRequest.setHeaders({
            ...authenticated,
            "x-patchy-generation": reconnected.generation
          })
        )
      );
      assert.strictEqual(denied.status, 403);
      assert.deepInclude(yield* denied.json, { code: "access_denied" });
    }).pipe(Effect.scoped)
  );
});
