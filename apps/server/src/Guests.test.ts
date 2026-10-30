/**
 * A patch's guest over the whole server: someone from another company opens the patch shared
 * with them and uses its own data as themselves, until the grant ends and after it's restored.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import {
  CURRENT_RELEASE,
  MANIFEST_VERSION,
  PublishCreated,
  PublishUpdated,
  RuntimeStreamFrame,
  TablePage,
  WIRE_VERSION
} from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { GuestGrants } from "@patchy/patches";
import { answer, html, publish, send, server } from "./test/server.js";

const origin = "https://patchy.example";
const decodeCreated = Schema.decodeUnknownSync(PublishCreated);
const decodeUpdated = Schema.decodeUnknownSync(PublishUpdated);
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(RuntimeStreamFrame));
const decodeRows = Schema.decodeUnknownSync(
  Schema.Struct({ ok: Schema.Literal(true), value: TablePage })
);
const manifest = {
  manifestVersion: MANIFEST_VERSION,
  release: CURRENT_RELEASE,
  tier: 1,
  tables: { notes: { description: "Notes.", columns: { title: { kind: "text" } }, indexes: {} } },
  files: {},
  uses: {}
};
const layer = Layer.mergeAll(Companies.layer, GuestGrants.layer).pipe(
  Layer.provideMerge(server()),
  Layer.provideMerge(NodeCryptography.layer)
);

/** A person from another company, an admin there, with their browser's session cookie. */
const outsider = Effect.fn("GuestsTest.outsider")(function* (handle: string) {
  const { user, company } = yield* (yield* Companies.Companies).create({
    handle,
    name: `Company ${handle}`,
    clerkUserId: `user_${handle}_gina`,
    email: `gina@${handle}.example`,
    userName: "Gina"
  });
  const cookie = signedInCookies(
    signSession({ sub: user.clerkUserId, email: user.email, name: user.name, azp: origin })
  );
  return { user, company, cookie };
});

const call = (
  version: { readonly patchId: string; readonly versionId: string },
  person: { readonly user: { readonly id: string }; readonly cookie: string },
  op: string,
  args: Record<string, unknown> = {}
) =>
  send(
    HttpClientRequest.post("/api/runtime/call").pipe(
      HttpClientRequest.setHeaders({
        "x-patchy-wire": String(WIRE_VERSION),
        "x-patchy-principal": JSON.stringify({ userId: person.user.id }),
        origin,
        cookie: person.cookie
      }),
      HttpClientRequest.bodyJsonUnsafe({
        patchId: version.patchId,
        versionId: version.versionId,
        wire: WIRE_VERSION,
        principal: { userId: person.user.id },
        op,
        args
      })
    )
  ).pipe(Effect.flatMap(answer));

it.layer(layer)("a patch's guest", (it) => {
  it.effect("uses the patch's own table until the grant ends, and again once shared again", () =>
    Effect.gen(function* () {
      const grants = yield* GuestGrants.GuestGrants;
      const guest = yield* outsider("northwind");
      const created = decodeCreated(
        yield* (yield* publish(DEV_SEED.token, { html: html("Team notes"), manifest })).json
      );
      const page = new URL(created.address).pathname;
      const open = send(
        HttpClientRequest.get(page).pipe(HttpClientRequest.setHeader("cookie", guest.cookie))
      );
      const share = grants.grant({
        patchId: created.patchId,
        userId: guest.user.id,
        grantedBy: DEV_SEED.userId
      });
      assert.strictEqual((yield* open).status, 404);

      yield* share;
      assert.strictEqual((yield* open).status, 200);
      assert.deepStrictEqual(yield* call(created, guest, "me"), {
        status: 200,
        body: {
          ok: true,
          value: {
            user: { id: guest.user.id, email: guest.user.email, name: guest.user.name },
            company: {
              id: DEV_SEED.companyId,
              handle: DEV_SEED.companyHandle,
              name: DEV_SEED.companyName
            },
            admin: false,
            guest: true
          }
        }
      });
      const inserted = yield* call(created, guest, "tables.insert", {
        table: "notes",
        row: { title: "From Northwind" }
      });
      assert.strictEqual(inserted.status, 200);
      const listed = yield* call(created, guest, "tables.list", { table: "notes" });
      assert.deepStrictEqual(
        decodeRows(listed.body).value.rows.map((row) => row.title),
        ["From Northwind"]
      );
      assert.deepStrictEqual(
        (yield* grants.guests(created.patchId)).map((entry) => [entry.userId, entry.companyName]),
        [[guest.user.id, guest.company.name]]
      );
      assert.deepStrictEqual(
        (yield* grants.sharedWith(guest.user.id)).map((shared) => shared.patchId),
        [created.patchId]
      );

      assert.isTrue(yield* grants.revoke({ patchId: created.patchId, userId: guest.user.id }));
      assert.strictEqual((yield* open).status, 404);
      assert.deepInclude((yield* call(created, guest, "tables.list", { table: "notes" })).body, {
        code: "access_denied"
      });
      assert.deepStrictEqual(yield* grants.guests(created.patchId), []);
      assert.deepStrictEqual(yield* grants.sharedWith(guest.user.id), []);

      yield* share;
      assert.strictEqual((yield* open).status, 200);
      assert.deepStrictEqual(
        decodeRows((yield* call(created, guest, "tables.list", { table: "notes" })).body).value.rows
          .length,
        1
      );

      // Going public and back keeps the guest.
      for (const scope of ["public", "company"]) {
        const shared = yield* send(
          HttpClientRequest.post(`/api/patches/${created.patchId}/share`).pipe(
            HttpClientRequest.bearerToken(DEV_SEED.token),
            HttpClientRequest.bodyJsonUnsafe({ scope })
          )
        );
        assert.strictEqual(shared.status, 200);
      }
      assert.strictEqual(
        decodeRows((yield* call(created, guest, "tables.list", { table: "notes" })).body).value.rows
          .length,
        1
      );
    })
  );

  it.effect("keeps a guest's live stream through a publish, as a member's", () =>
    Effect.gen(function* () {
      const grants = yield* GuestGrants.GuestGrants;
      const guest = yield* outsider("fabrikam");
      const created = decodeCreated(
        yield* (yield* publish(DEV_SEED.token, { html: html("Guest stream"), manifest })).json
      );
      yield* grants.grant({
        patchId: created.patchId,
        userId: guest.user.id,
        grantedBy: DEV_SEED.userId
      });
      const stream = yield* send(
        HttpClientRequest.get("/api/runtime/stream").pipe(
          HttpClientRequest.setUrlParams({
            patchId: created.patchId,
            versionId: created.versionId,
            documentId: "guest_stream_document"
          }),
          HttpClientRequest.setHeaders({
            "x-patchy-wire": String(WIRE_VERSION),
            "x-patchy-principal": JSON.stringify({ userId: guest.user.id }),
            "sec-fetch-site": "same-origin",
            cookie: guest.cookie
          })
        )
      );
      assert.strictEqual(stream.status, 200);
      const frames = yield* Queue.unbounded<RuntimeStreamFrame>();
      yield* stream.stream.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("data: ")),
        Stream.map((line) => decodeFrame(line.slice(6))),
        Stream.runForEach((frame) => Queue.offer(frames, frame)),
        Effect.forkScoped
      );
      assert.strictEqual((yield* Queue.take(frames)).type, "hello");
      assert.deepStrictEqual(yield* Queue.take(frames), {
        type: "served",
        versionId: created.versionId,
        tier: 1
      });
      const updated = decodeUpdated(
        yield* (yield* publish(DEV_SEED.token, {
          html: html("Guest stream, second"),
          manifest,
          patchId: created.patchId
        })).json
      );
      assert.deepStrictEqual(yield* Queue.take(frames), {
        type: "served",
        versionId: updated.versionId,
        tier: 1
      });
    }).pipe(Effect.scoped)
  );
});
