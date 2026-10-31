/**
 * A patch's guest over the whole server: someone from another company opens the patch shared
 * with them and uses its own data as themselves, until the grant ends and after it's restored.
 * On tier 2 they start only the handlers marked for guests, and none while a connection the
 * patch uses blocks guests; they can be the person in its member columns.
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
  Member,
  PublishCreated,
  PublishUpdated,
  RuntimeStreamFrame,
  sharedTableId,
  TablePage,
  WIRE_VERSION
} from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, type Users } from "@patchy/companies";
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
const decodeMembers = Schema.decodeUnknownSync(Schema.Array(Member));
const decodePeople = Schema.decodeUnknownSync(
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Array(Member) })
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
/** A tier 2 server module from its source, bundled with the SDK as the CLI bundles one. */
const bundle = (contents: string) =>
  Effect.promise(() =>
    build({
      stdin: {
        contents,
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
const handlersServer = bundle(`import { createGuest, mutation, query, t } from "patchy/server";
const list = query({ guest: true, args: {}, result: t.json(),
  handler: async (ctx) => (await ctx.tables.notes.list({ limit: 100 })).rows.map((row) => row.title) });
const add = mutation({ guest: true, args: { title: t.text() }, result: t.json(),
  handler: async (ctx, args) => {
    await ctx.tables.notes.insert({ title: args.title });
    return { by: ctx.viewer.user.id, company: ctx.viewer.company.id, guest: ctx.viewer.guest ?? false };
  } });
const count = query({ args: {}, result: t.integer(),
  handler: async (ctx) => (await ctx.tables.notes.list({ limit: 100 })).rows.length });
export default createGuest({ notes: { list, add, count } });`);

/**
 * A tier 2 patch whose tasks are each someone's, a member's or a guest's, and which shares them.
 * Guests claim tasks and use the people picker; only the company assigns tasks and looks people up.
 */
const tasks = {
  ...manifest,
  tier: 2,
  tables: {
    tasks: {
      description: "Tasks.",
      columns: { title: { kind: "text" }, owner: { kind: "member" } },
      indexes: {},
      shared: true
    }
  },
  uses: { members: { kind: "members" } },
  handlers: {
    "tasks.claim": {
      kind: "mutation",
      guest: true,
      args: { title: { kind: "text" } },
      result: { kind: "json" }
    },
    "tasks.assign": {
      kind: "mutation",
      args: { title: { kind: "text" }, owner: { kind: "text" } },
      result: { kind: "json" }
    },
    "people.list": {
      kind: "query",
      guest: true,
      args: { text: { kind: "text" } },
      result: { kind: "json" }
    },
    "people.get": { kind: "query", args: { id: { kind: "text" } }, result: { kind: "json" } }
  }
};
const tasksServer = bundle(`import { createGuest, mutation, query, t } from "patchy/server";
const claim = mutation({ guest: true, args: { title: t.text() }, result: t.json(),
  handler: (ctx, args) => ctx.tables.tasks.insert({ title: args.title, owner: ctx.viewer.user.id }) });
const assign = mutation({ args: { title: t.text(), owner: t.text() }, result: t.json(),
  handler: (ctx, args) => ctx.tables.tasks.insert(args) });
const list = query({ guest: true, args: { text: t.text() }, result: t.json(),
  handler: async (ctx, args) =>
    (args.text === "" ? await ctx.members.list() : await ctx.members.search(args.text)).rows });
const get = query({ args: { id: t.text() }, result: t.json(),
  handler: (ctx, args) => ctx.members.get(args.id) });
export default createGuest({ tasks: { claim, assign }, people: { list, get } });`);

/** A tasks patch, published by the dev company's admin. */
const publishTasks = Effect.fn("GuestsTest.publishTasks")(function* (title: string) {
  const response = yield* publish(DEV_SEED.token, {
    html: html(title),
    server: yield* tasksServer,
    manifest: tasks
  });
  return decodeCreated(yield* response.json);
});

/** How the patch's directory shows an active guest: never its company's admin, whatever theirs. */
const inDirectory = ({ user }: { readonly user: Users.User }) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  admin: false,
  active: true,
  guest: true as const
});

/** How a patch the guest isn't shared with now shows them: by name, inactive, without email. */
const unshared = (guest: { readonly user: Users.User }) => ({
  ...inDirectory(guest),
  email: "",
  active: false
});

/** The fixtures' mutations, whose calls carry a fresh key. */
const mutations = new Set(
  [handlers, tasks].flatMap((fixture) =>
    Object.entries(fixture.handlers).flatMap(([name, { kind }]) =>
      kind === "mutation" ? [name] : []
    )
  )
);

/** One of this person's tier 2 handler calls. */
const handle = Effect.fn("GuestsTest.handle")(function* (
  version: { readonly patchId: string; readonly versionId: string },
  person: Person,
  handler: string,
  args: Record<string, unknown> = {}
) {
  const mutationKey = mutations.has(handler) ? yield* MutationTransaction.mint : undefined;
  return yield* call(version, person, "server.call", {
    handler,
    args,
    ...(mutationKey === undefined ? {} : { mutationKey })
  });
});

/** This person's live stream on a version: subscribe to a query, then read what answers it. */
const live = Effect.fn("GuestsTest.live")(function* (
  version: { readonly patchId: string; readonly versionId: string },
  person: Person,
  documentId: string
) {
  const document = { patchId: version.patchId, versionId: version.versionId, documentId };
  const stream = yield* send(
    HttpClientRequest.get("/api/runtime/stream").pipe(
      HttpClientRequest.setUrlParams(document),
      HttpClientRequest.setHeaders(headers(person))
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
  const hello = yield* Queue.take(frames);
  if (hello.type !== "hello") throw new Error("Expected stream hello");
  let sequence = 0;
  return {
    subscribe: (id: string, handler: string, args: Record<string, unknown> = {}) =>
      send(
        HttpClientRequest.post("/api/runtime/subscriptions").pipe(
          HttpClientRequest.setHeaders(headers(person)),
          HttpClientRequest.bodyJsonUnsafe({
            ...document,
            generation: hello.generation,
            sequence: ++sequence,
            type: "subscribe",
            subscription: { id, op: "server.call", args: { handler, args } }
          })
        )
      ),
    /** The next frame answering the subscription `id`. */
    answered: Effect.fnUntraced(function* (id: string) {
      while (true) {
        const frame = yield* Queue.take(frames);
        if ("id" in frame && frame.id === id) return frame;
      }
    })
  };
});

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
          const run = (handler: string, args?: Record<string, unknown>) =>
            handle(created, guest, handler, args);
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
          const { subscribe, answered } = yield* live(created, guest, "guest_live_document");
          assert.strictEqual((yield* subscribe("list", "notes.list")).status, 200);
          assert.deepInclude(yield* answered("list"), { type: "snapshot", result: [] });
          assert.strictEqual((yield* subscribe("count", "notes.count")).status, 200);
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

    it.effect(
      "can be the person in a member column while their grant stands",
      () =>
        Effect.gen(function* () {
          const grants = yield* GuestGrants.GuestGrants;
          const guest = yield* outsider("litware");
          const created = yield* publishTasks("Team tasks");
          const elsewhere = yield* publishTasks("Other tasks");
          const share = grants.grant({
            patchId: created.patchId,
            userId: guest.user.id,
            grantedBy: DEV_SEED.userId
          });
          const assign = (title: string) =>
            handle(created, admin, "tasks.assign", { title, owner: guest.user.id });
          const lookUp = handle(created, admin, "people.get", { id: guest.user.id });
          const asGuest = inDirectory(guest);
          yield* share;

          // The patch's picker offers them, as a guest; another patch's doesn't.
          const offered = yield* handle(created, guest, "people.list", { text: "" });
          assert.deepInclude(decodePeople(offered.body).value, asGuest);
          assert.deepStrictEqual(
            (yield* handle(created, guest, "people.list", { text: "gin" })).body,
            { ok: true, value: [asGuest] }
          );
          assert.deepStrictEqual(
            (yield* handle(elsewhere, admin, "people.list", { text: "gin" })).body,
            { ok: true, value: [] }
          );

          // They put themselves in a member column, and a member puts them in another row.
          assert.deepInclude(
            (yield* handle(created, guest, "tasks.claim", { title: "Mine" })).body,
            { ok: true }
          );
          assert.deepInclude((yield* assign("Theirs")).body, { ok: true });
          assert.deepStrictEqual((yield* lookUp).body, { ok: true, value: asGuest });

          // Ended: they resolve by name, inactive, and no one assigns them anew.
          yield* grants.revoke({ patchId: created.patchId, userId: guest.user.id });
          assert.deepStrictEqual((yield* lookUp).body, { ok: true, value: unshared(guest) });
          assert.deepInclude((yield* assign("Too late")).body, { code: "invalid_row" });

          // Shared again: active and assignable.
          yield* share;
          assert.deepStrictEqual((yield* lookUp).body, { ok: true, value: asGuest });
          assert.deepInclude((yield* assign("Welcome back")).body, { ok: true });
        }),
      30_000
    );

    it.effect(
      "is inactive where their grant ended, whatever their grant on another patch",
      () =>
        Effect.gen(function* () {
          const grants = yield* GuestGrants.GuestGrants;
          const guest = yield* outsider("proseware");
          const first = yield* publishTasks("First tasks");
          const second = yield* publishTasks("Second tasks");
          const share = (patchId: string) =>
            grants.grant({ patchId, userId: guest.user.id, grantedBy: DEV_SEED.userId });
          const revoke = (patchId: string) => grants.revoke({ patchId, userId: guest.user.id });
          const lookUp = (version: typeof first) =>
            handle(version, admin, "people.get", { id: guest.user.id }).pipe(
              Effect.map(({ body }) => body)
            );
          yield* share(first.patchId);
          yield* share(second.patchId);

          yield* revoke(first.patchId);
          assert.deepStrictEqual(yield* lookUp(first), { ok: true, value: unshared(guest) });
          assert.deepStrictEqual(yield* lookUp(second), { ok: true, value: inDirectory(guest) });

          // Sharing the other patch again doesn't bring them back in the first.
          yield* revoke(second.patchId);
          yield* share(second.patchId);
          assert.deepStrictEqual(yield* lookUp(first), { ok: true, value: unshared(guest) });
        }),
      30_000
    );

    it.effect(
      "is named, without their email, by another of the company's patches reading its shared table",
      () =>
        Effect.gen(function* () {
          const grants = yield* GuestGrants.GuestGrants;
          const guest = yield* outsider("adatum");
          const source = yield* publishTasks("Shared tasks");
          yield* grants.grant({
            patchId: source.patchId,
            userId: guest.user.id,
            grantedBy: DEV_SEED.userId
          });
          assert.deepInclude(
            (yield* handle(source, guest, "tasks.claim", { title: "Mine" })).body,
            { ok: true }
          );
          const reader = decodeCreated(
            yield* (yield* publish(DEV_SEED.token, {
              html: html("Task owners"),
              server: yield* bundle(`import { createGuest, query, t } from "patchy/server";
const list = query({ args: {}, result: t.json(), handler: async (ctx) =>
  ctx.members.getMany((await ctx.shared.tasks.list()).rows.map((row) => row.owner)) });
export default createGuest({ owners: { list } });`),
              manifest: {
                ...manifest,
                tier: 2,
                tables: {},
                uses: {
                  tasks: {
                    kind: "sharedTable",
                    patchId: source.patchId,
                    table: "tasks",
                    id: sharedTableId(source.patchId, "tasks"),
                    revision: source.schemaRevision
                  },
                  members: { kind: "members" }
                },
                handlers: { "owners.list": { kind: "query", args: {}, result: { kind: "json" } } }
              }
            })).json
          );
          assert.deepStrictEqual((yield* handle(reader, admin, "owners.list")).body, {
            ok: true,
            value: [unshared(guest)]
          });
        }),
      30_000
    );

    it.effect(
      "joins and leaves a member's live picker as the grant starts and ends",
      () =>
        Effect.gen(function* () {
          const grants = yield* GuestGrants.GuestGrants;
          const guest = yield* outsider("fourthcoffee");
          const created = yield* publishTasks("Live picker");
          const grant = { patchId: created.patchId, userId: guest.user.id };
          const { subscribe, answered } = yield* live(created, admin, "guest_picker_document");
          /** Who the picker's next snapshot offers. */
          const offered = Effect.gen(function* () {
            const frame = yield* answered("people");
            if (frame.type !== "snapshot") throw new Error(`Expected a snapshot: ${frame.type}`);
            return decodeMembers(frame.result).map((member) => member.id);
          });
          assert.strictEqual((yield* subscribe("people", "people.list", { text: "" })).status, 200);
          assert.notInclude(yield* offered, guest.user.id);

          yield* grants.grant({ ...grant, grantedBy: DEV_SEED.userId });
          assert.include(yield* offered, guest.user.id);
          yield* grants.revoke(grant);
          assert.notInclude(yield* offered, guest.user.id);
        }).pipe(Effect.scoped),
      30_000
    );
  }
);
