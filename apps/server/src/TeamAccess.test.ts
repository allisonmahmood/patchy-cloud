import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
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
  RuntimeStreamFrame,
  WIRE_VERSION
} from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { signedInCookies, signSession } from "@patchy/auth/testing";
import { Teams } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { answer, html, publish, send, server } from "./test/server.js";

const decodeCreated = Schema.decodeUnknownSync(PublishCreated);
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(RuntimeStreamFrame));
const origin = "https://patchy.example";

it.layer(server().pipe(Layer.provideMerge(NodeCryptography.layer)))(
  "team audience on the real server",
  (it) => {
    it.effect("refuses deleting a team in use, naming the patches and connections using it", () =>
      Effect.gen(function* () {
        const actor = { companyId: DEV_SEED.companyId, actorId: DEV_SEED.userId };
        const teams = yield* Teams.Teams;
        const team = yield* teams.create({ ...actor, name: "Referenced team" });
        yield* teams.setMemberships({
          ...actor,
          teamId: team.id,
          userIds: [DEV_SEED.userId],
          added: true
        });
        const audience = { kind: "teams", teamIds: [team.id] };
        const named = decodeCreated(
          yield* (yield* publish(DEV_SEED.token, { html: html("Team uses named"), audience })).json
        );
        const disabled = decodeCreated(
          yield* (yield* publish(DEV_SEED.token, { html: html("Team uses hidden"), audience })).json
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${disabled.patchId}`;
        yield* sql`INSERT INTO connections(id, company_id, integration, handle, description, mode, status,
            display, credentials, key_id, credential_revision, metadata_revision, created_by, audience_kind)
          VALUES ('conn_team_uses', ${actor.companyId}, 'postgres', 'team-uses', '', 'company', 'connected',
            '{}', 'synthetic', 'test', 1, 1, ${actor.actorId}, 'teams')`;
        yield* sql`INSERT INTO connection_team_grants(connection_id, company_id, team_id)
          VALUES ('conn_team_uses', ${actor.companyId}, ${team.id})`;
        const cookie = signedInCookies(
          signSession({
            sub: DEV_SEED.clerkUserId,
            email: DEV_SEED.email,
            name: "Owner",
            azp: origin
          })
        );
        const refused = yield* send(
          HttpClientRequest.post(`/settings/company/teams/delete?team=${team.id}`).pipe(
            HttpClientRequest.setHeaders({ cookie, origin }),
            HttpClientRequest.bodyUrlParams({})
          )
        );
        assert.strictEqual(refused.status, 409);
        assert.include(
          yield* refused.text,
          `${named.name}, postgres/team-uses and 1 more you can’t see use this team.`
        );
        assert.isTrue((yield* teams.list(actor)).some((found) => found.id === team.id));
      })
    );

    it.effect(
      "closes the stream and refuses broker calls after the only membership is removed, then restores access",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const member = {
            id: "usr_team_reader",
            clerkId: "user_team_reader",
            email: "reader@patchy.local"
          };
          yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role) VALUES (${member.id}, ${member.clerkId}, ${DEV_SEED.companyId}, ${member.email}, 'Reader', 'member')`;
          const actor = { companyId: DEV_SEED.companyId, actorId: DEV_SEED.userId };
          const team = yield* (yield* Teams.Teams).create({ ...actor, name: "Only granting team" });
          yield* (yield* Teams.Teams).setMemberships({
            ...actor,
            teamId: team.id,
            userIds: [DEV_SEED.userId, member.id],
            added: true
          });
          const created = decodeCreated(
            yield* (yield* publish(DEV_SEED.token, {
              html: html("Team stream"),
              manifest: {
                manifestVersion: MANIFEST_VERSION,
                release: CURRENT_RELEASE,
                tier: 1,
                tables: {
                  notes: { description: "Notes", columns: { title: { kind: "text" } }, indexes: {} }
                },
                files: {},
                uses: {}
              },
              audience: { kind: "teams", teamIds: [team.id] }
            })).json
          );
          const headers = {
            "x-patchy-wire": String(WIRE_VERSION),
            "x-patchy-principal": JSON.stringify({ userId: member.id }),
            "sec-fetch-site": "same-origin",
            origin,
            cookie: signedInCookies(
              signSession({ sub: member.clerkId, email: member.email, name: "Reader", azp: origin })
            )
          };
          const document = {
            patchId: created.patchId,
            versionId: created.versionId,
            documentId: "team_revocation_document"
          };
          const broker = send(
            HttpClientRequest.post("/api/runtime/call").pipe(
              HttpClientRequest.setHeaders(headers),
              HttpClientRequest.bodyJsonUnsafe({
                patchId: created.patchId,
                versionId: created.versionId,
                wire: WIRE_VERSION,
                principal: { userId: member.id },
                op: "tables.list",
                args: { table: "notes" }
              })
            )
          ).pipe(Effect.flatMap(answer));
          const open = send(
            HttpClientRequest.get("/api/runtime/stream").pipe(
              HttpClientRequest.setUrlParams(document),
              HttpClientRequest.setHeaders(headers)
            )
          );
          assert.strictEqual((yield* broker).status, 200);
          const response = yield* open;
          assert.strictEqual(response.status, 200);
          const frames = yield* Queue.unbounded<RuntimeStreamFrame>();
          const ended = yield* Deferred.make<void>();
          yield* response.stream.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filter((line) => line.startsWith("data: ")),
            Stream.map((line) => decodeFrame(line.slice(6))),
            Stream.runForEach((frame) => Queue.offer(frames, frame)),
            Effect.andThen(Deferred.succeed(ended, undefined)),
            Effect.forkScoped
          );
          const hello = yield* Queue.take(frames);
          assert.strictEqual(hello.type, "hello");
          if (hello.type !== "hello") return;
          assert.strictEqual((yield* Queue.take(frames)).type, "served");
          const subscribed = yield* send(
            HttpClientRequest.post("/api/runtime/subscriptions").pipe(
              HttpClientRequest.setHeaders(headers),
              HttpClientRequest.bodyJsonUnsafe({
                ...document,
                generation: hello.generation,
                sequence: 1,
                type: "subscribe",
                subscription: { id: "notes", op: "tables.list", args: { table: "notes" } }
              })
            )
          );
          assert.strictEqual(subscribed.status, 200);
          assert.strictEqual((yield* Queue.take(frames)).type, "admitted");
          assert.strictEqual((yield* Queue.take(frames)).type, "snapshot");
          yield* (yield* Teams.Teams).setMemberships({
            ...actor,
            teamId: team.id,
            userIds: [member.id],
            added: false
          });
          assert.deepStrictEqual(yield* Queue.take(frames), { type: "access_denied" });
          yield* Deferred.await(ended);
          assert.deepInclude((yield* broker).body, { ok: false, code: "access_denied" });
          const denied = yield* open;
          assert.strictEqual(denied.status, 403);
          yield* denied.text;
          yield* (yield* Teams.Teams).setMemberships({
            ...actor,
            teamId: team.id,
            userIds: [member.id],
            added: true
          });
          assert.strictEqual((yield* broker).status, 200);
          const restored = yield* open;
          assert.strictEqual(restored.status, 200);
          const reopened = yield* restored.stream.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filter((line) => line.startsWith("data: ")),
            Stream.map((line) => decodeFrame(line.slice(6))),
            Stream.take(2),
            Stream.runCollect
          );
          assert.deepStrictEqual(
            reopened.map((frame) => frame.type),
            ["hello", "served"]
          );
        }).pipe(Effect.scoped)
    );
  }
);
