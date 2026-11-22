/**
 * The connection codecs release 45's CLI decodes discovery with, frozen as they stood in
 * `packages/api/src/schemas.ts` before Models: the integrations it knows, a listed connection, the
 * listing and a connection's detail. A new host's answers decode through these in the
 * compatibility fixtures, so a change to the live codecs can't hide that an older CLI breaks.
 *
 * Each integration's snapshot fields come from `@patchy/api`: Models changed none of them, and the
 * fixtures only decode a Postgres one.
 */
import {
  AttioSnapshot,
  GithubSnapshot,
  ImapSnapshot,
  PidgeonSnapshot,
  PostHogSnapshot
} from "@patchy/api";
import { Snapshot } from "@patchy/api/postgres-snapshot";
import * as Schema from "effect/Schema";

export const integrations = ["postgres", "posthog", "pidgeon", "attio", "imap", "github"] as const;
const Integration = Schema.Literals(integrations);
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ConnectionSummary = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  integration: Integration,
  description: Schema.String,
  status: Schema.Literals(["connected", "disconnected"]),
  hint: Schema.String,
  reason: Schema.optionalKey(Schema.Literal("not_connected")),
  test: Schema.optionalKey(Schema.Literal(true)),
  paused: Schema.optionalKey(Schema.Literal(true)),
  suspended: Schema.optionalKey(Schema.Literal(true))
});

export const Connections = Schema.Struct({
  connections: Schema.Array(ConnectionSummary),
  offered: Schema.optionalKey(
    Schema.Array(Schema.Struct({ integration: Integration, connected: Schema.Boolean }))
  )
});

const detail = <const I extends (typeof integrations)[number], F extends Schema.Struct.Fields>(
  integration: I,
  snapshot: F
) =>
  Schema.Struct({
    integration: Schema.Literal(integration),
    handle: ConnectionSummary.fields.handle,
    description: ConnectionSummary.fields.description,
    status: ConnectionSummary.fields.status,
    snapshot: Schema.NullOr(
      Schema.Struct({ ...snapshot, revision: Revision, takenAt: Schema.String })
    )
  });

export const ConnectionDetail = Schema.Union([
  detail("postgres", Snapshot.fields),
  detail("posthog", PostHogSnapshot.fields),
  detail("pidgeon", PidgeonSnapshot.fields),
  detail("attio", AttioSnapshot.fields),
  Schema.Struct({
    ...detail("imap", ImapSnapshot.fields).fields,
    paused: Schema.optionalKey(Schema.Struct({ at: Schema.String }))
  }),
  detail("github", GithubSnapshot.fields)
]);
