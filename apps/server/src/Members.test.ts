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
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
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

  it.effect("refuses directory access to a signed-out reader of a public tier 1 patch", () =>
    Effect.gen(function* () {
      const response = yield* publish(DEV_SEED.token, {
        html: "<!doctype html><html><head><title>Public members</title></head><body>Members</body></html>",
        manifest,
        scope: "public"
      });
      assert.strictEqual(response.status, 201);
      const published = decodePublished(yield* response.json);
      const result = yield* answer(
        yield* send(
          HttpClientRequest.post("/api/runtime/call").pipe(
            HttpClientRequest.setHeaders({ ...headers, "x-patchy-principal": "null" }),
            HttpClientRequest.bodyJsonUnsafe({
              patchId: published.patchId,
              versionId: published.versionId,
              wire: WIRE_VERSION,
              principal: null,
              op: "members.list",
              args: {}
            })
          )
        )
      );
      assert.strictEqual(result.status, 403);
      assert.deepInclude(result.body, { ok: false, code: "not_available_on_public" });
    })
  );
});
