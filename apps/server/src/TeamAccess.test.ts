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
    it.effect("serializes a first publish racing team deletion without a dangling audience", () =>
      Effect.gen(function* () {
        const ref = { companyId: DEV_SEED.companyId, actorId: DEV_SEED.userId };
        const team = yield* Teams.create({ ...ref, name: "Concurrent publication" });
        yield* Teams.setMemberships({
          ...ref,
          teamId: team.id,
          userIds: [ref.actorId],
          added: true
        });
        const cookie = signedInCookies(
          signSession({
            sub: DEV_SEED.clerkUserId,
            email: DEV_SEED.email,
            name: "Owner",
            azp: origin
          })
        );
        const [published, deleted] = yield* Effect.all(
          [
            publish(DEV_SEED.token, {
              html: html("Racing team"),
              audience: { members: { kind: "teams", teamIds: [team.id] } }
            }),
            send(
              HttpClientRequest.post(`/settings/company/teams/delete?team=${team.id}`).pipe(
                HttpClientRequest.setHeaders({ cookie, origin }),
                HttpClientRequest.bodyUrlParams({})
              )
            )
          ],
          { concurrency: 2 }
        );
        assert.isTrue(
          (published.status === 201 && deleted.status === 409) ||
            (published.status === 400 && deleted.status === 200)
        );
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(
          yield* sql`SELECT g.patch_id FROM patch_audience_teams g JOIN company_teams t ON t.id = g.team_id WHERE t.deleted_at IS NOT NULL`,
          []
        );
      })
    );

    it.effect(
      "composes multi-team publication, reference guards and team recovery through session routes",
      () =>
        Effect.gen(function* () {
          const actor = { companyId: DEV_SEED.companyId, actorId: DEV_SEED.userId };
          const design = yield* Teams.create({ ...actor, name: "Design integration" });
          const engineering = yield* Teams.create({ ...actor, name: "Engineering integration" });
          for (const team of [design, engineering])
            yield* Teams.setMemberships({
              ...actor,
              teamId: team.id,
              userIds: [DEV_SEED.userId],
              added: true
            });
          const created = decodeCreated(
            yield* (yield* publish(DEV_SEED.token, {
              html: html("Multi-team journey"),
              audience: { members: { kind: "teams", teamIds: [design.id, engineering.id] } }
            })).json
          );
          const cookie = signedInCookies(
            signSession({
              sub: DEV_SEED.clerkUserId,
              email: DEV_SEED.email,
              name: "Owner",
              azp: origin
            })
          );
          const transition = (teamId: string, action: "delete" | "restore") =>
            send(
              HttpClientRequest.post(`/settings/company/teams/${action}?team=${teamId}`).pipe(
                HttpClientRequest.setHeaders({ cookie, origin }),
                HttpClientRequest.bodyUrlParams({})
              )
            );
          assert.equal((yield* transition(design.id, "delete")).status, 409);
          const sql = yield* SqlClient.SqlClient;
          // Retained lifecycle states still refer to the team's stable identity.
          yield* sql`UPDATE patches SET retired_at = now() WHERE id = ${created.patchId}`;
          assert.equal((yield* transition(design.id, "delete")).status, 409);
          yield* sql`UPDATE patches SET retired_at = NULL WHERE id = ${created.patchId}`;
          // Deliberately remove the audience before team deletion; no automatic widening.
          yield* sql`DELETE FROM patch_audience_teams WHERE patch_id = ${created.patchId} AND team_id = ${design.id}`;
          yield* sql`INSERT INTO connections(id, company_id, integration, handle, description, mode, status, display, credentials, key_id, credential_revision, metadata_revision, created_by, audience_kind)
        VALUES ('conn_team_recovery', ${actor.companyId}, 'postgres', 'recovery', '', 'company', 'connected', '{}', 'synthetic', 'test', 1, 1, ${actor.actorId}, 'teams')`;
          yield* sql`INSERT INTO connection_team_grants(connection_id, company_id, team_id) VALUES ('conn_team_recovery', ${actor.companyId}, ${design.id})`;
          assert.equal((yield* transition(design.id, "delete")).status, 409);
          yield* sql`DELETE FROM connection_team_grants WHERE connection_id = 'conn_team_recovery'`;
          yield* sql`UPDATE connections SET audience_kind = 'company' WHERE id = 'conn_team_recovery'`;
          assert.equal((yield* transition(design.id, "delete")).status, 200);
          assert.deepEqual(yield* Teams.memberships(actor.companyId, actor.actorId), [
            engineering.id
          ]);
          assert.equal(
            (yield* publish(DEV_SEED.token, {
              html: html("Deleted target"),
              audience: { members: { kind: "teams", teamIds: [design.id] } }
            })).status,
            400
          );
          assert.equal((yield* transition(design.id, "restore")).status, 200);
          assert.sameMembers(yield* Teams.memberships(actor.companyId, actor.actorId), [
            design.id,
            engineering.id
          ]);
          assert.deepEqual(yield* sql`SELECT scope FROM patches WHERE id = ${created.patchId}`, [
            { scope: "teams" }
          ]);
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
          const team = yield* Teams.create({ ...actor, name: "Only granting team" });
          yield* Teams.setMemberships({
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
              audience: { members: { kind: "teams", teamIds: [team.id] } }
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
          yield* Teams.setMemberships({
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
          yield* Teams.setMemberships({
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
