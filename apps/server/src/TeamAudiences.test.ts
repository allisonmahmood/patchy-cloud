/**
 * Data only a later release writes: a patch open to selected teams and a connection restricted to
 * teams. This release can't tell who is on a team, so it fails closed. The patch is opened by
 * nobody and every surface answers as if it doesn't exist; the connection is built and called
 * with by nobody and only admins see it. Nothing here turns either into something the whole
 * company reaches, and a request naming an audience, as a later CLI sends, is refused.
 */
import { assert, it } from "@effect/vitest";
import { build } from "esbuild";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";
import { MANIFEST_VERSION, CURRENT_RELEASE, PublishCreated } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies } from "@patchy/companies";
import { Cryptography, NodeCryptography } from "@patchy/core";
import { GuestGrants } from "@patchy/patches";
import { answer, html, publish, publishBody, send, server } from "./test/server.js";

const origin = "https://patchy.example";
const decodeCreated = Schema.decodeUnknownSync(PublishCreated);
const decodeList = Schema.decodeUnknownSync(
  Schema.Struct({ patches: Schema.Array(Schema.Struct({ id: Schema.String })) })
);
const decodeConnections = Schema.decodeUnknownSync(
  Schema.Struct({ connections: Schema.Array(Schema.Struct({ handle: Schema.String })) })
);
const layer = Companies.layer.pipe(
  Layer.provideMerge(server()),
  Layer.provideMerge(NodeCryptography.layer)
);

const cookieOf = (user: { readonly clerkUserId: string; readonly email: string }) =>
  signedInCookies(signSession({ sub: user.clerkUserId, email: user.email, azp: origin }));
const admin = cookieOf({ clerkUserId: DEV_SEED.clerkUserId, email: DEV_SEED.email });
/** A page as the person with this cookie sees it, or a form they post. */
const page = (
  cookie: string,
  path: string,
  method: "GET" | "POST" = "GET",
  fields: Record<string, string> = {}
) =>
  send(
    method === "GET"
      ? HttpClientRequest.get(path).pipe(HttpClientRequest.setHeaders({ cookie, origin }))
      : HttpClientRequest.post(path).pipe(
          HttpClientRequest.setHeaders({ cookie, origin }),
          HttpClientRequest.bodyUrlParams(fields)
        )
  ).pipe(
    Effect.flatMap((response) =>
      Effect.map(response.text, (body) => ({ status: response.status, body }))
    )
  );
/** A request to the API with the dev admin's machine token. */
const api = (method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, unknown>) => {
  const request = HttpClientRequest.make(method)(path).pipe(
    HttpClientRequest.bearerToken(DEV_SEED.token)
  );
  return send(body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)));
};

/** A member of the dev company, signed in. */
const member = Effect.fn("TeamAudiencesTest.member")(function* (key: string) {
  const companies = yield* Companies.Companies;
  const email = `${key}@patchy.local`;
  const invite = yield* companies.createInvite({
    companyId: DEV_SEED.companyId,
    email,
    invitedBy: DEV_SEED.userId,
    role: "member"
  });
  const user = yield* companies.consumeInvite({
    inviteId: invite.id,
    clerkUserId: `user_${key}`,
    email,
    name: "Morgan"
  });
  return { user, cookie: cookieOf(user) };
});

/** Someone from another company, with their browser's session cookie. */
const outsider = Effect.fn("TeamAudiencesTest.outsider")(function* (handle: string) {
  const { user } = yield* (yield* Companies.Companies).create({
    handle,
    name: `Company ${handle}`,
    clerkUserId: `user_${handle}_gina`,
    email: `gina@${handle}.example`,
    userName: "Gina"
  });
  return { user, cookie: cookieOf(user) };
});

/** A team as a later release stores it, with the dev admin on it. */
const team = Effect.fn("TeamAudiencesTest.team")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO company_teams (id, company_id, name) VALUES (${id}, ${DEV_SEED.companyId}, ${id})`;
  yield* sql`INSERT INTO company_team_members (company_id, team_id, user_id)
    VALUES (${DEV_SEED.companyId}, ${id}, ${DEV_SEED.userId})`;
  return id;
});

/** A patch the dev admin owns, then opened to `teamId` only, as a later release does it. */
const teamPatch = Effect.fn("TeamAudiencesTest.teamPatch")(function* (
  title: string,
  teamId: string
) {
  const created = decodeCreated(
    yield* (yield* publish(DEV_SEED.token, { html: html(title) })).json
  );
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE patches SET scope = 'teams' WHERE id = ${created.patchId}`;
  yield* sql`INSERT INTO patch_audience_teams (patch_id, company_id, team_id)
    VALUES (${created.patchId}, ${DEV_SEED.companyId}, ${teamId})`;
  return created;
});

/** A publish payload's identity as the server hashes it: its keys sorted at every depth. */
const payloadDigest = (json: unknown) =>
  Effect.flatMap(Cryptography.Cryptography, (cryptography) =>
    cryptography.contentHash(
      JSON.stringify(json, (_key, value: unknown) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            )
          : value
      )
    )
  );

const stored = (patchId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly scope: string; readonly teams: number }>`SELECT scope,
      (SELECT count(*)::int FROM patch_audience_teams WHERE patch_id = ${patchId}) AS teams
      FROM patches WHERE id = ${patchId}`
  );

it.layer(layer)("data from a release with team audiences", (it) => {
  it.effect(
    "opens a team patch for nobody, and every other patch as before",
    () =>
      Effect.gen(function* () {
        const finance = yield* team("finance");
        const hidden = yield* teamPatch("Finance plan", finance);
        const open = decodeCreated(
          yield* (yield* publish(DEV_SEED.token, { html: html("Company notes") })).json
        );
        const guest = yield* outsider("northwind");
        const grants = yield* GuestGrants.GuestGrants;
        for (const patch of [hidden, open])
          yield* grants.grant({
            patchId: patch.patchId,
            userId: guest.user.id,
            grantedBy: DEV_SEED.userId
          });

        // Its owner, on its team, and an admin: the API lists and reads only the other.
        const listed = yield* api("GET", "/api/patches?state=all");
        assert.strictEqual(listed.status, 200);
        const ids = decodeList(yield* listed.json).patches.map((patch) => patch.id);
        assert.include(ids, open.patchId);
        assert.notInclude(ids, hidden.patchId);
        assert.strictEqual((yield* api("GET", `/api/patches/${hidden.patchId}`)).status, 404);
        assert.strictEqual((yield* api("GET", `/api/patches/${hidden.patchId}/log`)).status, 404);

        // Its address and card answer 404; Home, All patches and People still render.
        const address = (patch: typeof open) => new URL(patch.address).pathname;
        assert.strictEqual((yield* page(admin, address(hidden))).status, 404);
        assert.strictEqual((yield* page(admin, address(open))).status, 200);
        const name = address(hidden).split("/").at(-1)!;
        assert.strictEqual((yield* page(admin, `/patches/${name}`)).status, 404);
        for (const path of ["/", "/patches?state=all", "/settings/people"]) {
          const shown = yield* page(admin, path);
          assert.strictEqual(shown.status, 200, path);
          assert.notInclude(shown.body, "Finance plan", path);
        }

        // Its guest is turned away from it, and their Home lists only the other.
        assert.strictEqual((yield* page(guest.cookie, address(hidden))).status, 404);
        assert.strictEqual((yield* page(guest.cookie, address(open))).status, 200);
        assert.strictEqual((yield* page(guest.cookie, "/")).status, 200);
        assert.deepStrictEqual(
          (yield* grants.sharedWith(guest.user.id)).map((shared) => shared.patchId),
          [open.patchId]
        );
      }),
    60_000
  );

  it.effect(
    "changes nothing about a team patch, so it never opens to the whole company",
    () =>
      Effect.gen(function* () {
        const hidden = yield* teamPatch("Payroll", yield* team("payroll"));
        const name = new URL(hidden.address).pathname.split("/").at(-1)!;
        const refused = [
          yield* api("POST", `/api/patches/${hidden.patchId}/share`, { scope: "company" }),
          yield* api("POST", `/api/patches/${hidden.patchId}/share`, { scope: "public" }),
          yield* publish(DEV_SEED.token, { patchId: hidden.patchId, html: html("Payroll, again") }),
          yield* api("POST", `/api/patches/${hidden.patchId}/guests`, { email: "x@example.test" }),
          yield* api("POST", `/api/patches/${hidden.patchId}/retire`),
          yield* api("DELETE", `/api/patches/${hidden.patchId}`)
        ];
        assert.deepStrictEqual(
          refused.map((response) => response.status),
          [404, 404, 404, 404, 404, 404]
        );
        for (const action of ["retire", "delete", "reassign"])
          assert.strictEqual(
            (yield* page(admin, `/patches/${name}/${action}`, "POST")).status,
            404
          );
        assert.deepStrictEqual(yield* stored(hidden.patchId), [{ scope: "teams", teams: 1 }]);
      }),
    60_000
  );

  it.effect(
    "refuses a publish or share that names an audience, rather than ignore it",
    () =>
      Effect.gen(function* () {
        const before = decodeList(
          yield* (yield* api("GET", "/api/patches?state=all")).json
        ).patches;
        for (const audience of [{ kind: "teams", teamIds: ["finance"] }, { kind: "company" }]) {
          const refused = yield* answer(
            yield* publish(DEV_SEED.token, { html: html("Budget"), audience })
          );
          assert.strictEqual(refused.status, 400);
          assert.deepInclude(refused.body, { code: "upgrade_required" });
        }
        const after = decodeList(yield* (yield* api("GET", "/api/patches?state=all")).json).patches;
        assert.strictEqual(after.length, before.length);

        const open = decodeCreated(
          yield* (yield* publish(DEV_SEED.token, { html: html("Roadmap") })).json
        );
        const shared = yield* answer(
          yield* api("POST", `/api/patches/${open.patchId}/share`, {
            audience: { kind: "public" }
          })
        );
        assert.strictEqual(shared.status, 400);
        assert.deepInclude(shared.body, { code: "upgrade_required" });
        assert.deepStrictEqual(yield* stored(open.patchId), [{ scope: "company", teams: 0 }]);
      }),
    60_000
  );

  it.effect(
    "refuses a retried publish that a later release stored with its audience",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A later CLI's first publish of a team patch, which committed but lost its answer.
        const retried = publishBody({
          html: html("Forecast"),
          audience: { kind: "teams", teamIds: ["forecast"] }
        });
        const created = decodeCreated(
          yield* (yield* publish(DEV_SEED.token, {
            html: html("Forecast"),
            publishKey: retried.publishKey
          })).json
        );
        yield* sql`UPDATE patches SET scope = 'teams' WHERE id = ${created.patchId}`;
        yield* sql`UPDATE patch_versions SET payload_digest = ${yield* payloadDigest(retried)}
          WHERE id = ${created.versionId}`;

        const replayed = yield* answer(yield* publish(DEV_SEED.token, retried));
        assert.strictEqual(replayed.status, 400);
        assert.deepInclude(replayed.body, { code: "upgrade_required" });
        assert.notInclude(JSON.stringify(replayed.body), created.patchId);
      }),
    60_000
  );

  it.effect(
    "changes nothing for a sharing form that names an audience",
    () =>
      Effect.gen(function* () {
        const open = decodeCreated(
          yield* (yield* publish(DEV_SEED.token, { html: html("Hiring plan") })).json
        );
        const name = new URL(open.address).pathname.split("/").at(-1)!;
        const posted = yield* page(admin, `/patches/${name}/scope`, "POST", {
          expectedPatchId: open.patchId,
          expectedScope: "company",
          scope: "public",
          confirm: "public",
          audience: "teams"
        });
        assert.strictEqual(posted.status, 422);
        assert.deepStrictEqual(yield* stored(open.patchId), [{ scope: "company", teams: 0 }]);
      }),
    60_000
  );

  it.effect(
    "removing a guest from every patch leaves their grant on a team patch as it was",
    () =>
      Effect.gen(function* () {
        const hidden = yield* teamPatch("Board pack", yield* team("board"));
        const open = decodeCreated(
          yield* (yield* publish(DEV_SEED.token, { html: html("Board notes") })).json
        );
        const guest = yield* outsider("fairway");
        const grants = yield* GuestGrants.GuestGrants;
        for (const patch of [hidden, open])
          yield* grants.grant({
            patchId: patch.patchId,
            userId: guest.user.id,
            grantedBy: DEV_SEED.userId
          });

        const removed = yield* page(
          admin,
          `/settings/people/guests/${guest.user.id}/remove`,
          "POST"
        );
        assert.strictEqual(removed.status, 200);
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT patch_id AS "patchId", revoked_at IS NULL AS active
            FROM patch_guest_grants WHERE user_id = ${guest.user.id} ORDER BY active`,
          [
            { patchId: open.patchId, active: false },
            { patchId: hidden.patchId, active: true }
          ]
        );
      }),
    60_000
  );

  it.effect(
    "lets nobody build with a connection restricted to teams, and shows it only to admins",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sales = yield* team("sales");
        const connectionId = "con_restricted_warehouse";
        yield* sql`INSERT INTO connections (id, company_id, integration, handle, description, mode,
          status, display, credentials, key_id, credential_revision, metadata_revision, created_by,
          audience_kind)
        VALUES (${connectionId}, ${DEV_SEED.companyId}, 'postgres', 'sales-warehouse',
          'Sales warehouse', 'company', 'connected',
          ${JSON.stringify({ host: "warehouse.invalid", port: 5432, database: "sales", role: "reader" })},
          'unused', 'unused', 1, 1, ${DEV_SEED.userId}, 'teams')`;
        yield* sql`INSERT INTO connection_team_grants (connection_id, company_id, team_id)
        VALUES (${connectionId}, ${DEV_SEED.companyId}, ${sales})`;

        // Discovery and agents' reads leave it out.
        const discovered = yield* api("GET", "/api/connections?integrations=postgres");
        assert.strictEqual(discovered.status, 200);
        assert.deepStrictEqual(decodeConnections(yield* discovered.json).connections, []);
        assert.strictEqual(
          (yield* api("GET", "/api/connections/postgres/sales-warehouse")).status,
          404
        );

        // A publish that declares it is refused, so no patch builds with it.
        const published = yield* answer(
          yield* publish(DEV_SEED.token, {
            html: html("Pipeline"),
            server: yield* pingServer,
            manifest: {
              ...tier2,
              uses: {
                sales: {
                  kind: "postgres",
                  handle: "sales-warehouse",
                  id: connectionId,
                  revision: 1
                }
              }
            }
          })
        );
        assert.deepInclude(published, { status: 422 });
        assert.deepInclude(published.body, { code: "connection_not_connected" });

        // Admins see it; a member sees neither it nor its page.
        const forAdmin = yield* page(admin, "/settings/integrations");
        assert.strictEqual(forAdmin.status, 200);
        assert.include(forAdmin.body, "sales-warehouse");
        const colleague = yield* member("morgan-restricted");
        const forMember = yield* page(colleague.cookie, "/settings/integrations");
        assert.strictEqual(forMember.status, 200);
        assert.notInclude(forMember.body, "sales-warehouse");
        assert.strictEqual(
          (yield* page(colleague.cookie, `/settings/integrations/${connectionId}`)).status,
          404
        );

        // An admin's changes to it leave it restricted.
        assert.strictEqual(
          (yield* page(admin, `/settings/integrations/${connectionId}/block-guests`, "POST"))
            .status,
          200
        );
        assert.deepStrictEqual(
          yield* sql`SELECT audience_kind AS "audienceKind", block_guests AS "blockGuests",
          (SELECT count(*)::int FROM connection_team_grants WHERE connection_id = ${connectionId}) AS teams
          FROM connections WHERE id = ${connectionId}`,
          [{ audienceKind: "teams", blockGuests: true, teams: 1 }]
        );
      }),
    60_000
  );
});

/** A tier 2 patch with one query, which the connection test declares a use beside. */
const tier2 = {
  manifestVersion: MANIFEST_VERSION,
  release: CURRENT_RELEASE,
  tier: 2,
  tables: {},
  files: {},
  uses: {},
  handlers: { "ping.ping": { kind: "query", args: {}, result: { kind: "integer" } } }
};
const pingServer = Effect.promise(() =>
  build({
    stdin: {
      contents: `import { createGuest, query, t } from "patchy/server";
const ping = query({ args: {}, result: t.integer(), handler: async () => 1 });
export default createGuest({ ping: { ping } });`,
      resolveDir: new URL("../../../packages/patchy", import.meta.url).pathname,
      sourcefile: "team-audiences-fixture.ts"
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["development"]
  })
).pipe(Effect.map((built) => built.outputFiles[0]!.text));
