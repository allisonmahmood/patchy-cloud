/**
 * A patch's guest over the whole server: someone from another company opens the patch shared
 * with them and uses its own data as themselves, until the grant ends and after it's restored.
 * On tier 2 they start only the handlers marked for guests, and none while a connection the
 * patch uses blocks guests.
 */
import { assert, it } from "@effect/vitest";
import { build } from "esbuild";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";
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
import { ConnectionStoreDev } from "@patchy/integrations/dev";
import { GuestGrants } from "@patchy/patches";
import { MutationTransaction } from "@patchy/runtime";
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
// The tests' own grants: Share arrives later. Its connection reads aren't what they check.
const layer = (env: Record<string, string> = {}) =>
  Layer.mergeAll(
    Companies.layer,
    GuestGrants.layer.pipe(Layer.provide(ConnectionStoreDev.layer()))
  ).pipe(Layer.provideMerge(server(env)), Layer.provideMerge(NodeCryptography.layer));

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

type Person = { readonly user: { readonly id: string }; readonly cookie: string };

/** The dev company's admin, who publishes the patches here, in a browser. */
const admin: Person = {
  user: { id: DEV_SEED.userId },
  cookie: signedInCookies(
    signSession({
      sub: DEV_SEED.clerkUserId,
      email: DEV_SEED.email,
      name: DEV_SEED.userName,
      azp: origin
    })
  )
};

/** A browser's headers for this person, as the patch's shell sends them. */
const headers = (person: Person) => ({
  "x-patchy-wire": String(WIRE_VERSION),
  "x-patchy-principal": JSON.stringify({ userId: person.user.id }),
  "sec-fetch-site": "same-origin",
  origin,
  cookie: person.cookie
});

const call = (
  version: { readonly patchId: string; readonly versionId: string },
  person: Person,
  op: string,
  args: Record<string, unknown> = {}
) =>
  send(
    HttpClientRequest.post("/api/runtime/call").pipe(
      HttpClientRequest.setHeaders(headers(person)),
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

it.layer(layer())("a patch's guest", (it) => {
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

/** A tier 2 page whose guests list and add notes, and can't count them. */
const handlers = {
  ...manifest,
  tier: 2,
  handlers: {
    "notes.list": { kind: "query", guest: true, args: {}, result: { kind: "json" } },
    "notes.add": {
      kind: "mutation",
      guest: true,
      args: { title: { kind: "text" } },
      result: { kind: "json" }
    },
    "notes.count": { kind: "query", args: {}, result: { kind: "integer" } }
  }
};
const handlersServer = Effect.promise(() =>
  build({
    stdin: {
      contents: `import { createGuest, mutation, query, t } from "patchy/server";
const list = query({ guest: true, args: {}, result: t.json(),
  handler: async (ctx) => (await ctx.tables.notes.list({ limit: 100 })).rows.map((row) => row.title) });
const add = mutation({ guest: true, args: { title: t.text() }, result: t.json(),
  handler: async (ctx, args) => {
    await ctx.tables.notes.insert({ title: args.title });
    return { by: ctx.viewer.user.id, company: ctx.viewer.company.id, guest: ctx.viewer.guest ?? false };
  } });
const count = query({ args: {}, result: t.integer(),
  handler: async (ctx) => (await ctx.tables.notes.list({ limit: 100 })).rows.length });
export default createGuest({ notes: { list, add, count } });`,
      resolveDir: new URL("../../../packages/patchy", import.meta.url).pathname,
      sourcefile: "guest-handlers-fixture.ts"
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["development"]
  })
).pipe(Effect.map((built) => built.outputFiles[0]!.text));

it.layer(layer({ NODE_ENV: "development" }), { excludeTestServices: true })(
  "a tier 2 patch's guest",
  (it) => {
    it.effect(
      "starts only the handlers marked for guests, until the grant ends",
      () =>
        Effect.gen(function* () {
          const grants = yield* GuestGrants.GuestGrants;
          const guest = yield* outsider("tailspin");
          const created = decodeCreated(
            yield* (yield* publish(DEV_SEED.token, {
              html: html("Guest handlers"),
              server: yield* handlersServer,
              manifest: handlers
            })).json
          );
          const run = Effect.fnUntraced(function* (
            handler: string,
            args: Record<string, unknown> = {}
          ) {
            const mutationKey =
              handler === "notes.add" ? yield* MutationTransaction.mint : undefined;
            return yield* call(created, guest, "server.call", {
              handler,
              args,
              ...(mutationKey === undefined ? {} : { mutationKey })
            });
          });
          yield* grants.grant({
            patchId: created.patchId,
            userId: guest.user.id,
            grantedBy: DEV_SEED.userId
          });

          // A marked mutation runs as the guest, in the patch's company.
          const added = yield* run("notes.add", { title: "From Tailspin" });
          assert.strictEqual(added.status, 200);
          assert.deepInclude(added.body, {
            ok: true,
            value: { by: guest.user.id, company: DEV_SEED.companyId, guest: true }
          });
          assert.deepStrictEqual(yield* run("notes.list"), {
            status: 200,
            body: { ok: true, value: ["From Tailspin"] }
          });
          assert.deepInclude((yield* run("notes.count")).body, { code: "access_denied" });

          yield* grants.revoke({ patchId: created.patchId, userId: guest.user.id });
          assert.deepInclude((yield* run("notes.list")).body, { code: "access_denied" });
        }),
      30_000
    );

    it.effect(
      "subscribes live only to the queries marked for guests",
      () =>
        Effect.gen(function* () {
          const grants = yield* GuestGrants.GuestGrants;
          const guest = yield* outsider("contoso");
          const created = decodeCreated(
            yield* (yield* publish(DEV_SEED.token, {
              html: html("Guest live queries"),
              server: yield* handlersServer,
              manifest: handlers
            })).json
          );
          yield* grants.grant({
            patchId: created.patchId,
            userId: guest.user.id,
            grantedBy: DEV_SEED.userId
          });
          const document = {
            patchId: created.patchId,
            versionId: created.versionId,
            documentId: "guest_live_document"
          };
          const stream = yield* send(
            HttpClientRequest.get("/api/runtime/stream").pipe(
              HttpClientRequest.setUrlParams(document),
              HttpClientRequest.setHeaders(headers(guest))
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
          /** The next frame answering the subscription `id`. */
          const answered = Effect.fnUntraced(function* (id: string) {
            while (true) {
              const frame = yield* Queue.take(frames);
              if ("id" in frame && frame.id === id) return frame;
            }
          });
          const hello = yield* Queue.take(frames);
          if (hello.type !== "hello") throw new Error("Expected stream hello");
          const subscribe = (sequence: number, id: string, handler: string) =>
            send(
              HttpClientRequest.post("/api/runtime/subscriptions").pipe(
                HttpClientRequest.setHeaders(headers(guest)),
                HttpClientRequest.bodyJsonUnsafe({
                  ...document,
                  generation: hello.generation,
                  sequence,
                  type: "subscribe",
                  subscription: { id, op: "server.call", args: { handler, args: {} } }
                })
              )
            );

          assert.strictEqual((yield* subscribe(1, "list", "notes.list")).status, 200);
          assert.deepInclude(yield* answered("list"), { type: "snapshot", result: [] });
          assert.strictEqual((yield* subscribe(2, "count", "notes.count")).status, 200);
          assert.deepNestedInclude(yield* answered("count"), {
            type: "error",
            "error.code": "access_denied"
          });
        }).pipe(Effect.scoped),
      30_000
    );

    it.effect(
      "turns guests away while a connection the patch uses blocks them, and lets them back after",
      () =>
        Effect.gen(function* () {
          const grants = yield* GuestGrants.GuestGrants;
          const guest = yield* outsider("woodgrove");
          // Connecting needs a warehouse to reach; publish and the doors read only this row.
          const connectionId = "con_guests_warehouse";
          yield* (yield* SqlClient.SqlClient)`INSERT INTO connections (id, company_id,
            integration, handle, description, mode, status, display, credentials, key_id,
            credential_revision, metadata_revision, created_by)
            VALUES (${connectionId}, ${DEV_SEED.companyId}, 'postgres', 'guests-warehouse',
              'Sales warehouse', 'company', 'connected',
              ${JSON.stringify({ host: "warehouse.invalid", port: 5432, database: "sales", role: "reader" })},
              'unused', 'unused', 1, 1, ${DEV_SEED.userId})`;
          const created = decodeCreated(
            yield* (yield* publish(DEV_SEED.token, {
              html: html("Guests and the warehouse"),
              server: yield* handlersServer,
              manifest: {
                ...handlers,
                uses: {
                  sales: {
                    kind: "postgres",
                    handle: "guests-warehouse",
                    id: connectionId,
                    revision: 1
                  }
                }
              }
            })).json
          );
          yield* grants.grant({
            patchId: created.patchId,
            userId: guest.user.id,
            grantedBy: DEV_SEED.userId
          });
          const list = (person: Person) =>
            call(created, person, "server.call", { handler: "notes.list", args: {} });
          /** The admin's Block guests or Allow guests, landing back on the connection's page. */
          const set = (action: "block-guests" | "allow-guests") =>
            send(
              HttpClientRequest.post(`/company/connections/${connectionId}/${action}`).pipe(
                HttpClientRequest.setHeaders({ origin, cookie: admin.cookie }),
                HttpClientRequest.bodyUrlParams({})
              )
            );
          assert.deepStrictEqual((yield* list(guest)).body, { ok: true, value: [] });

          assert.strictEqual((yield* set("block-guests")).status, 200);
          assert.deepInclude((yield* list(guest)).body, { code: "access_denied" });
          assert.deepStrictEqual((yield* list(admin)).body, { ok: true, value: [] });

          assert.strictEqual((yield* set("allow-guests")).status, 200);
          assert.deepStrictEqual((yield* list(guest)).body, { ok: true, value: [] });
        }),
      30_000
    );
  }
);
