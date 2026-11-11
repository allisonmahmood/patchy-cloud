/**
 * A scenario's history: what its company did before `up`, made true once its patches are
 * published. Patches get the dates of their first and latest versions, who opened them, the calls
 * in their logs and when they were retired or deleted; people their computers and apps, and
 * deactivation and what they sent Patchy; the company its invitations; Patchy's team its general
 * requests; offline connections their states. Publishing tokens
 * `up` lent people other than the publisher end. Rows have stable ids, so a resumed `up` writes
 * the same history again, measured from its own now.
 */
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { Companies, Users } from "@patchy/companies";
import { Cryptography } from "@patchy/core";
import { InvocationLog, RuntimeLog } from "@patchy/runtime";
import { settleConnections } from "./connections.js";
import { ids, type Scenario, type ScenarioPatch } from "./scenario.js";

const DAY = 86_400_000;

/** A patch as `up` published it: the scenario's entry and the name it was served under. */
export interface Published {
  readonly patch: ScenarioPatch;
  readonly name: string;
}

/** How each outcome settles in the invocation log, and in the connection call under it. */
const settled = {
  succeeded: { call: { outcome: "success", outcomeCode: null }, connection: "success" },
  failed: {
    call: { outcome: "failure", outcomeCode: "handler_failed" },
    connection: "failure"
  },
  refused: { call: { outcome: "failure", outcomeCode: "access_denied" }, connection: "failure" },
  unknown: {
    call: { outcome: "unknown_outcome", outcomeCode: "unknown_outcome" },
    connection: "unknown"
  }
} as const;
const HOUR = 3_600_000;

/**
 * A stable id in the feedback store's shape, a prefix and 24 lowercase letters and digits: what
 * names it, cut to 21, then its place in its list, so a resumed `up` writes the same rows.
 */
const feedbackId = (prefix: "gen" | "req" | "fbk", name: string, index: number) =>
  `${prefix}_${`env${name}`
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "")
    .slice(0, 21)
    .padEnd(21, "0")}${String(index).padStart(3, "0")}`;

export const writeHistory = Effect.fn("writeHistory")(
  function* (scenario: Scenario, published: ReadonlyArray<Published>) {
    const sql = yield* SqlClient.SqlClient;
    const cryptography = yield* Cryptography.Cryptography;
    const log = yield* InvocationLog.InvocationLog;
    const calls = yield* RuntimeLog.RuntimeLog;
    const users = yield* Users.Users;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const people = new Map(scenario.people.map((person) => [person.key, person]));
    const person = (key: string) => people.get(key)!;
    const publisher = person(scenario.publisher);
    /** The instant `ago` milliseconds before now, as SQL. */
    const before = (ago: number) => sql`to_timestamp(${(now - ago) / 1_000})`;
    const at = (ago: Duration.Duration) => before(Duration.toMillis(ago));

    for (const { patch, name } of published) {
      const owner = person(patch.owner ?? scenario.publisher);
      const { companyId } = ids(scenario, owner);
      const [found] = yield* sql<{ readonly id: string }>`
      SELECT id FROM patches WHERE company_id = ${companyId} AND name = ${name}`;
      if (found === undefined) continue;
      const first = Duration.toMillis(patch.age ?? Duration.zero);
      const latest = patch.updated === undefined ? first : Duration.toMillis(patch.updated);
      const rows = yield* sql<{ readonly id: string }>`
      SELECT id FROM patch_versions WHERE patch_id = ${found.id} ORDER BY version_number`;
      // The first version at `age` and the latest at `updated`, the rest spread between them; a
      // patch with neither keeps the dates it was published with.
      const versions = rows.map((version, index) => ({
        id: version.id,
        ago: first + (latest - first) * (rows.length === 1 ? 1 : index / (rows.length - 1))
      }));
      // Its last change is the newest of its latest version and its retirement or deletion, as the
      // service stamps both; a patch with no history of its own keeps the dates it was published with.
      const ended = patch.retired ?? patch.deleted;
      const changed = Math.min(latest, ended === undefined ? latest : Duration.toMillis(ended));
      if (patch.age !== undefined || patch.updated !== undefined || ended !== undefined) {
        for (const version of versions)
          yield* sql`UPDATE patch_versions SET created_at = ${before(version.ago)}
          WHERE id = ${version.id}`;
        // Its description came with its first version.
        yield* sql`UPDATE patches SET created_at = ${before(first)}, updated_at = ${before(changed)},
            last_changed_at = CASE WHEN last_changed_at IS NULL THEN NULL ELSE ${before(changed)} END,
            description_updated_at =
              CASE WHEN description_updated_at IS NULL THEN NULL ELSE ${before(first)} END
          WHERE id = ${found.id}`;
      }
      if (patch.retired !== undefined)
        yield* sql`UPDATE patches SET retired_at = ${at(patch.retired)}
        WHERE id = ${found.id} AND retired_at IS NOT NULL`;
      if (patch.deleted !== undefined)
        yield* sql`UPDATE patches SET deleted_at = ${at(patch.deleted)}
        WHERE id = ${found.id} AND deleted_at IS NOT NULL`;

      const opens = Object.entries(patch.opens ?? {});
      for (const [key, count] of opens)
        yield* sql`
        INSERT INTO patch_opens (user_id, patch_id, last_opened_at, score)
        VALUES (${ids(scenario, person(key)).userId}, ${found.id}, now(), ${count})
        ON CONFLICT (user_id, patch_id) DO UPDATE SET last_opened_at = EXCLUDED.last_opened_at,
          score = EXCLUDED.score`;
      if (opens.length > 0)
        yield* sql`UPDATE patches SET visit_count = ${opens.reduce((sum, [, count]) => sum + count, 0)}
        WHERE id = ${found.id}`;

      if (!("repo" in patch)) continue;
      for (const [index, call] of (patch.calls ?? []).entries()) {
        const id = `inv_env_${found.id}_${index}`;
        if ((yield* sql`SELECT 1 FROM runtime_invocations WHERE id = ${id}`).length > 0) continue;
        const ago = Duration.toMillis(call.ago);
        const startedAt = now - ago;
        // The version serving then: the newest published before the call, else the first.
        const version = versions.filter((each) => each.ago >= ago).at(-1) ?? versions[0]!;
        const durationMs = call.kind === "query" ? 40 + index * 7 : 90 + index * 13;
        const userId = ids(scenario, person(call.by)).userId;
        yield* log.begin({
          id,
          companyId,
          patchId: found.id,
          versionId: version.id,
          handler: call.handler,
          kind: call.kind,
          initiatingViewerId: userId,
          agent: call.via === undefined ? null : { name: call.via },
          parentId: null,
          correlationId: id,
          startedAt,
          // A running call's deadline is ahead, so it reads as Running until then.
          deadline: startedAt + (call.outcome === "running" ? HOUR : 30_000),
          argsBytes: 120
        });
        const outcome = call.outcome === "running" ? undefined : settled[call.outcome];
        if (outcome !== undefined)
          yield* log.finish({
            id,
            ...outcome.call,
            settledAt: startedAt + durationMs,
            durationMs,
            guestMs: Math.round(durationMs / 2),
            dbMs: Math.round(durationMs / 4),
            callbacks: 1,
            resultBytes: call.outcome === "succeeded" ? 640 : 0,
            attempts: 1,
            logLines: call.reason === undefined ? [] : [{ message: call.reason }],
            replyDelivered: call.outcome !== "unknown"
          });
        if (call.connection === undefined) continue;
        const [integration = "", handle = ""] = call.connection.name.split("/");
        const [connection] = yield* sql<{ readonly id: string }>`
        SELECT id FROM connections
        WHERE company_id = ${companyId} AND integration = ${integration} AND handle = ${handle}`;
        const correlationId = `${id}_call`;
        yield* calls.begin({
          companyId,
          userId,
          invocationId: id,
          op: `${integration}.${call.connection.op}`,
          resource: call.connection.resource ?? null,
          connectionId: connection?.id ?? null,
          correlationId,
          // A running call's deadline is its invocation's, an hour after both began.
          ...(call.outcome === "running" ? { deadlineMs: HOUR } : {}),
          patchId: found.id,
          versionId: version.id,
          ...(call.via === undefined
            ? { credentialKind: "session" as const }
            : { credentialKind: "agent" as const, agent: { name: call.via } })
        });
        if (outcome !== undefined)
          yield* calls.finish({
            correlationId,
            outcome: outcome.connection,
            outcomeCode:
              call.outcome === "failed"
                ? "source_unavailable"
                : call.outcome === "refused"
                  ? "access_denied"
                  : null,
            durationMs: durationMs - 20,
            rowCount: call.outcome === "succeeded" ? 12 : null
          });
        // The log stamps a call when it's made; this one was made then.
        yield* sql`UPDATE runtime_calls SET at = ${before(ago - 10)}
        WHERE correlation_id = ${correlationId}`;
      }
    }

    for (const someone of scenario.people) {
      const { companyId, userId } = ids(scenario, someone);
      const home = someone.company ?? scenario.company.handle;
      for (const [index, computer] of (someone.computers ?? []).entries()) {
        const used = Duration.toMillis(computer.used);
        yield* sql`
        INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
        VALUES (${`tok_env_${home}_${someone.key}_${index}`}, ${userId}, ${computer.name},
          ${yield* cryptography.sha256(yield* cryptography.token())}, ${before(used)},
          ${before(used - 90 * DAY)}, ${before(used)})
        ON CONFLICT (id) DO NOTHING`;
      }
      for (const [index, app] of (someone.apps ?? []).entries())
        yield* sql`
        INSERT INTO agent_connections (id, user_id, client_id, client_name, client_site, created_at, last_used_at)
        VALUES (${`agc_env_${home}_${someone.key}_${index}`}, ${userId},
          ${`https://${app.site}/mcp-client`}, ${app.name}, ${app.site}, ${at(app.connected)},
          ${app.used === undefined ? null : at(app.used)})
        ON CONFLICT (id) DO NOTHING`;
      if (someone.deactivated === true)
        yield* users.deactivate({ companyId, userId, actorId: ids(scenario, publisher).userId });
    }

    const { companyId, userId } = ids(scenario, publisher);
    for (const [index, invitation] of (scenario.invitations ?? []).entries()) {
      const sent = Duration.toMillis(invitation.sent);
      yield* sql`
      INSERT INTO invites (id, company_id, email, role, invited_by, clerk_invitation_id,
        created_at, expires_at)
      VALUES (${`invite_env_${scenario.company.handle}_${index}`}, ${companyId},
        ${invitation.email.toLowerCase()}, ${invitation.role}, ${userId},
        ${invitation.unsent === true ? null : `clerk_inv_env_${scenario.company.handle}_${index}`},
        ${before(sent)}, ${before(sent - Companies.INVITATION_LIFETIME_MS)})
      ON CONFLICT DO NOTHING`;
    }

    for (const [index, general] of (scenario.generalRequests ?? []).entries())
      yield* sql`
      INSERT INTO feedback.general_requests (id, title, status, note)
      VALUES (${feedbackId("gen", scenario.company.handle, index)}, ${general.title},
        ${general.status}, ${general.note ?? null})
      ON CONFLICT (id) DO NOTHING`;
    for (const someone of scenario.people) {
      const { companyId: theirs, userId: them } = ids(scenario, someone);
      for (const [index, sent] of (someone.sent ?? []).entries())
        yield* sql`
        INSERT INTO feedback.submissions
          (id, kind, text, why, company_id, user_id, surface, agent, link_general_id, created_at)
        VALUES (${feedbackId(sent.kind === "request" ? "req" : "fbk", `${scenario.company.handle}${someone.key}`, index)},
          ${sent.kind}, ${sent.text}, ${sent.why ?? null}, ${theirs}, ${them}, ${sent.surface},
          ${sent.agent ?? null},
          ${sent.sameAs === undefined ? null : feedbackId("gen", scenario.company.handle, sent.sameAs)},
          ${at(sent.ago)})
        ON CONFLICT (id) DO NOTHING`;
    }

    // The tokens `up` lent owners to publish with end, as a computer left unused would.
    const lent = [
      ...new Set(published.map(({ patch }) => patch.owner ?? scenario.publisher))
    ].filter((key) => key !== scenario.publisher);
    for (const key of lent)
      yield* sql`UPDATE machine_tokens SET revoked_at = now()
      WHERE id = ${ids(scenario, person(key)).tokenId} AND revoked_at IS NULL`;

    yield* settleConnections(scenario);
  },
  // All of it or none, so an interrupted `up` never leaves half a call or a connection unsettled.
  (effect) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(effect))
);
