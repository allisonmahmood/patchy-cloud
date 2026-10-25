/** Local-only module adapter over Patchy's existing encrypted connection table and call log. */
import { RequireSession } from "@patchy/auth";
import { newInternalId } from "@patchy/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as Pieces from "./Pieces.js";

export class Refused extends Schema.TaggedError<Refused>()("CommunityRefused", {
  code: Schema.Literals(["forbidden", "missing", "invalid", "conflict"])
}) {
  get status() {
    return { forbidden: 403, missing: 404, invalid: 422, conflict: 409 }[this.code];
  }
  override get message() {
    return {
      forbidden: "Only company admins can use this local prototype.",
      missing: "This connection is unavailable in your company.",
      invalid:
        "Enter a bot token starting with xoxb- and a handle of 3–32 lowercase letters, digits or hyphens.",
      conflict: "The connection changed or that handle is already in use. Reload and try again."
    }[this.code];
  }
}
export interface Connection {
  readonly id: string;
  readonly handle: string;
  readonly status: "connected" | "disconnected";
}
export type Failure = Refused | Pieces.PieceFailure | SqlError | CredentialKeys.CredentialError;
/** Authorization is intentionally resolved for each signed-in request.
 * @effect-expect-leaking Viewer
 */
export class CommunityConnections extends Context.Service<
  CommunityConnections,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<Connection>,
      Refused | SqlError,
      RequireSession.Viewer
    >;
    readonly connect: (input: {
      readonly handle: string;
      readonly token: Redacted.Redacted<string>;
      readonly id?: string;
    }) => Effect.Effect<string, Failure, RequireSession.Viewer>;
    readonly run: (id: string) => Effect.Effect<unknown, Failure, RequireSession.Viewer>;
    readonly disconnect: (id: string) => Effect.Effect<void, Failure, RequireSession.Viewer>;
    readonly delete: (id: string) => Effect.Effect<void, Failure, RequireSession.Viewer>;
  }
>()("prototype/activepieces/CommunityConnections") {}

const integration = "activepieces:slack";
const admin = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  if (viewer.role !== "admin") return yield* new Refused({ code: "forbidden" });
  return viewer;
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* CredentialKeys.CredentialKeys;
  const pieces = yield* Pieces.Pieces;
  const logs = yield* RuntimeLog.RuntimeLog;

  const get = Effect.fn("CommunityConnections.get")(function* (companyId: string, id: string) {
    const rows = yield* sql<Connection & { credentials: string; keyId: string; revision: number }>`
      SELECT id, handle, status, credentials, key_id AS "keyId", credential_revision AS revision
      FROM connections WHERE company_id = ${companyId} AND id = ${id} AND integration = ${integration}`;
    if (!rows[0]) return yield* new Refused({ code: "missing" });
    return rows[0];
  });

  const list = Effect.gen(function* () {
    const viewer = yield* admin;
    return yield* sql<Connection>`SELECT id, handle, status FROM connections
      WHERE company_id = ${viewer.company.id} AND integration = ${integration} ORDER BY handle`;
  });

  const connect = Effect.fn("CommunityConnections.connect")(function* (
    input: Parameters<CommunityConnections["Service"]["connect"]>[0]
  ) {
    const viewer = yield* admin;
    if (
      !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(input.handle) ||
      !/^xoxb-[A-Za-z0-9-]{8,4090}$/.test(Redacted.value(input.token))
    )
      return yield* new Refused({ code: "invalid" });
    // Authorize an existing id before handing any token to the external connector.
    const before = input.id ? yield* get(viewer.company.id, input.id) : undefined;
    if (!(yield* pieces.validate("slack", input.token))) return yield* new Pieces.PieceFailure({});
    const id = before?.id ?? newInternalId("conn");
    const encrypted = yield* keys.encrypt(
      { companyId: viewer.company.id, id, integration },
      input.token
    );
    const rows = before
      ? yield* sql`UPDATE connections SET credentials = ${encrypted.credentials}, key_id = ${encrypted.keyId},
          credential_revision = credential_revision + 1, status = 'connected', last_tested_at = now()
          WHERE company_id = ${viewer.company.id} AND id = ${id} AND integration = ${integration}
          AND credential_revision = ${before.revision} RETURNING id`
      : yield* sql`INSERT INTO connections (id, company_id, integration, handle, description, mode,
          status, display, credentials, key_id, credential_revision, metadata_revision, created_by, last_tested_at)
          VALUES (${id}, ${viewer.company.id}, ${integration}, ${input.handle}, 'Local Activepieces Slack prototype',
          'company', 'connected', ${JSON.stringify({ piece: "slack", version: Pieces.catalog.slack.version })}::jsonb,
          ${encrypted.credentials}, ${encrypted.keyId}, 1, 1, ${viewer.user.id}, now())
          ON CONFLICT DO NOTHING RETURNING id`;
    if (!rows.length) return yield* new Refused({ code: "conflict" });
    return id;
  });

  const run = Effect.fn("CommunityConnections.run")(function* (id: string) {
    const viewer = yield* admin;
    const started = yield* Clock.currentTimeMillis;
    const correlationId = newInternalId("corr");
    // Failed company lookups are logged to the caller's company, never the target's history.
    yield* logs.begin({
      companyId: viewer.company.id,
      userId: viewer.user.id,
      credentialKind: "admin",
      patchId: null,
      versionId: null,
      op: "activepieces.slack.list_channels",
      resource: "slack_list_channels",
      connectionId: id,
      correlationId,
      deadlineMs: 6000
    });
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        const row = yield* get(viewer.company.id, id);
        if (row.status !== "connected") return yield* new Refused({ code: "missing" });
        const token = yield* keys.decrypt({ companyId: viewer.company.id, id, integration }, row);
        const value = yield* pieces.run("slack", token);
        // A token rotation or disconnect during the request invalidates this result.
        const current = yield* get(viewer.company.id, id);
        if (current.status !== "connected" || current.revision !== row.revision)
          return yield* new Refused({ code: "conflict" });
        return value;
      })
    );
    yield* logs.finish({
      correlationId,
      outcome: Exit.isSuccess(result) ? "success" : "failure",
      outcomeCode: Exit.isSuccess(result) ? null : "community_action_failed",
      durationMs: (yield* Clock.currentTimeMillis) - started,
      rowCount: null
    });
    return yield* result;
  });

  const disconnect = Effect.fn("CommunityConnections.disconnect")(function* (id: string) {
    const viewer = yield* admin;
    yield* get(viewer.company.id, id);
    yield* sql`UPDATE connections SET status = 'disconnected', credential_revision = credential_revision + 1,
      credentials = '', key_id = '' WHERE company_id = ${viewer.company.id} AND id = ${id} AND integration = ${integration}`;
  });
  const remove = Effect.fn("CommunityConnections.delete")(function* (id: string) {
    const viewer = yield* admin;
    const rows =
      yield* sql`DELETE FROM connections WHERE company_id = ${viewer.company.id} AND id = ${id}
      AND integration = ${integration} AND status = 'disconnected' RETURNING id`;
    if (!rows.length) return yield* new Refused({ code: "missing" });
  });
  return CommunityConnections.of({ list, connect, run, disconnect, delete: remove });
});
export const layer = Layer.effect(CommunityConnections, make);
