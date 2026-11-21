/**
 * A scenario's offline connections (`OfflineConnection`): rows written straight into the
 * database as connect saves them, with invented credentials sealed by the instance's own keys and
 * an invented snapshot, so the connections pages and the patches that declare them read them
 * without their integration. Nothing here reaches the network. `saveConnections` saves each one
 * connected before patches publish; `settleConnections` then leaves it in its scenario state.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Cryptography } from "@patchy/core";
import {
  AttioSource,
  ConnectionStore,
  CredentialKeys,
  GithubAccess,
  GithubConnection,
  GithubSource,
  ImapSource,
  PidgeonSource,
  PostgresSource,
  PostHogSource
} from "@patchy/integrations";
import {
  ids,
  type LiveConnection,
  offlineConnections,
  type OfflineConnection,
  type Scenario
} from "./scenario.js";

const HOUR = 3_600_000;

/** A connection's id, stable so a resumed `up` finds the one it saved. */
export const connectionId = (scenario: Scenario, connection: OfflineConnection) =>
  `conn_env_${scenario.company.handle}_${connection.integration}_${connection.handle}`;

const Target = Schema.Union([
  Schema.Struct({ integration: Schema.Literal("postgres"), display: PostgresSource.Display }),
  Schema.Struct({ integration: Schema.Literal("posthog"), display: PostHogSource.Display }),
  Schema.Struct({ integration: Schema.Literal("pidgeon"), display: PidgeonSource.Display }),
  Schema.Struct({ integration: Schema.Literal("attio"), display: AttioSource.Display }),
  Schema.Struct({ integration: Schema.Literal("imap"), display: ImapSource.Display }),
  Schema.Struct({ integration: Schema.Literal("github"), display: GithubConnection.Display })
]);
// Encoding checks a value against its schema's filters, so an invented one that breaks them fails
// here. The SQL takes the part of the JSON its column holds.
const targetJson = Schema.encodeSync(Schema.fromJsonString(Target));
const metadataJson = Schema.encodeSync(Schema.fromJsonString(ConnectionStore.Metadata));
const writableJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ writable: AttioSource.Display.fields.writable }))
);
const pausedJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ paused: ImapSource.Display.fields.paused }))
);
const attentionJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ attention: GithubConnection.Attention }))
);
/** An invented GitHub installation's id, the same for a connection on every `up`. */
const installationOf = (scenario: Scenario, connection: OfflineConnection) =>
  [...`${scenario.company.handle}/${connection.handle}`].reduce(
    (sum, char) => (sum * 31 + char.charCodeAt(0)) % 9_000_000,
    0
  ) + 1_000_000;

// ---------- what each integration reads: invented, at the company's own example domain ----------

type SnapshotOf<I extends ConnectionStore.Metadata["integration"]> = Extract<
  ConnectionStore.Metadata,
  { readonly integration: I }
>["snapshot"];
type Column = SnapshotOf<"postgres">["relations"][number]["columns"][number];

const pgType = (name: string, sql = name): Column["type"] => ({
  schema: "pg_catalog",
  name,
  sql,
  baseSchema: "pg_catalog",
  baseName: name,
  kind: "base"
});
const [int8, text, numeric, date, bool] = [
  pgType("int8", "bigint"),
  pgType("text"),
  pgType("numeric"),
  pgType("date"),
  pgType("bool", "boolean")
];
/** A table keyed by `id`, its columns given as name and type, the last ones nullable from `nullable`. */
const table = (
  name: string,
  columns: ReadonlyArray<readonly [string, Column["type"]]>,
  nullable = columns.length
) => ({
  schema: "public",
  name,
  kind: "table" as const,
  columns: columns.map(([column, type], at) => ({ name: column, type, nullable: at >= nullable })),
  primaryKey: { name: `${name}_pkey`, columns: ["id"] },
  foreignKeys: []
});
/** A finance warehouse: projects, the hours logged against them, and their invoices. */
const warehouse: SnapshotOf<"postgres"> = {
  version: 1,
  relations: [
    table("projects", [
      ["id", int8],
      ["client", text],
      ["name", text],
      ["started_on", date]
    ]),
    {
      ...table("hours", [
        ["id", int8],
        ["project_id", int8],
        ["person", text],
        ["day", date],
        ["hours", numeric]
      ]),
      foreignKeys: [
        {
          name: "hours_project_id_fkey",
          columns: ["project_id"],
          target: { schema: "public", relation: "projects", columns: ["id"] }
        }
      ]
    },
    table(
      "invoices",
      [
        ["id", int8],
        ["client", text],
        ["amount", numeric],
        ["issued_on", date],
        ["paid", bool],
        ["paid_on", date]
      ],
      5
    )
  ],
  enums: [],
  exclusions: []
};

type Attribute = SnapshotOf<"attio">["objects"][number]["attributes"][number];
const attribute = (slug: string, title: string, type: Attribute["type"]): Attribute => ({
  id: `att-${slug}`,
  slug,
  title,
  type,
  multiselect: false
});

/** Where a connection reads, its credentials and its snapshot, as connect would have saved them. */
const saved = (
  scenario: Scenario,
  connection: OfflineConnection,
  secret: string
): {
  // A scenario seeds no model role.
  readonly target: Exclude<ConnectionStore.Target, { readonly integration: "models" }>;
  readonly credentials: Redacted.Redacted<string>;
  readonly metadata: ConnectionStore.Metadata;
} => {
  const { handle } = connection;
  const domain = `${scenario.company.handle}.example`;
  switch (connection.integration) {
    case "postgres": {
      const display = {
        host: `db.${domain}`,
        port: 5432,
        database: handle.replaceAll("-", "_"),
        role: "patchy_reader"
      };
      return {
        target: { integration: "postgres", display },
        credentials: Redacted.make(
          `postgresql://${display.role}:${secret}@${display.host}:5432/${display.database}?sslmode=verify-full`
        ),
        metadata: { integration: "postgres", snapshot: warehouse }
      };
    }
    case "posthog": {
      const apiKey = `phx_${secret}`;
      const projectId = 40_000 + handle.length;
      return {
        target: {
          integration: "posthog",
          display: { region: "eu", projectId, keyHint: `phx_…${apiKey.slice(-4)}` }
        },
        credentials: PostHogSource.credentials({ region: "eu", projectId, apiKey }),
        metadata: {
          integration: "posthog",
          snapshot: {
            version: 1,
            events: [
              { name: "$pageview" },
              { name: "enquiry_sent", description: "Someone sent the contact form" },
              { name: "case_study_opened" }
            ],
            eventProperties: [
              { name: "$current_url", type: "String" },
              { name: "case_study", type: "String" }
            ],
            personProperties: [
              { name: "email", type: "String" },
              { name: "company", type: "String" }
            ]
          }
        }
      };
    }
    case "attio": {
      const workspace = {
        id: `wks_env_${scenario.company.handle}`,
        name: scenario.company.name,
        slug: scenario.company.handle
      };
      const scopes = [...AttioSource.requiredScopes];
      return {
        target: {
          integration: "attio",
          display: { workspace, keyHint: `…${secret.slice(-4)}`, scopes }
        },
        credentials: AttioSource.credentials({ key: secret, workspaceId: workspace.id }),
        metadata: {
          integration: "attio",
          snapshot: {
            version: 1,
            workspace,
            scopes,
            objects: [
              {
                id: "obj-companies",
                slug: "companies",
                name: "Companies",
                attributes: [
                  attribute("name", "Name", "text"),
                  attribute("domains", "Domains", "text")
                ]
              },
              {
                id: "obj-people",
                slug: "people",
                name: "People",
                attributes: [
                  attribute("name", "Name", "text"),
                  attribute("email_addresses", "Email addresses", "email-address")
                ]
              },
              {
                id: "obj-deals",
                slug: "deals",
                name: "Deals",
                attributes: [
                  attribute("name", "Deal name", "text"),
                  attribute("stage", "Stage", "status"),
                  attribute("value", "Value", "currency"),
                  attribute("close_date", "Close date", "date")
                ]
              }
            ],
            lists: [
              {
                id: "lst-pipeline",
                slug: "pipeline",
                name: "Pipeline",
                parents: [{ id: "obj-deals", slug: "deals" }],
                attributes: [attribute("owner_note", "Owner's note", "text")]
              }
            ],
            excluded: []
          }
        }
      };
    }
    case "pidgeon": {
      const test = connection.test === true;
      const email = `${handle}@${domain}`;
      const inboxId = `inb_env_${handle}`;
      return {
        target: { integration: "pidgeon", display: { email, inboxId, access: "send", test } },
        credentials: PidgeonSource.credentials({
          inboxId,
          key: `pgn_${test ? "test_" : ""}${secret}`
        }),
        metadata: {
          integration: "pidgeon",
          snapshot: {
            version: 2,
            address: { email, displayName: scenario.company.name },
            access: "send",
            test,
            labels: [
              { id: "lbl-new", name: "New client", colour: "green" },
              { id: "lbl-billing", name: "Billing", colour: "amber" }
            ]
          }
        }
      };
    }
    case "github": {
      const account = {
        id: installationOf(scenario, connection) + 7,
        login: `${scenario.company.handle}-labs`,
        type: "Organization" as const
      };
      // A repository gone from the installation is marked left from the start, as a mint's
      // reconciliation marks it, and the connection stays connected.
      const repositories = [
        { id: 1, name: "api", private: true },
        { id: 2, name: "web", private: true },
        { id: 3, name: "docs", private: false }
      ].map((item) => ({
        ...item,
        id: account.id * 10 + item.id,
        ...(connection.reason === "left" && item.name === "docs" ? { left: true as const } : {})
      }));
      const installationId = installationOf(scenario, connection);
      return {
        target: {
          integration: "github",
          display: { installationId, account, repositories, successes: 1 }
        },
        credentials: GithubConnection.credentials({
          installationId,
          repositoryIds: repositories.map((item) => item.id)
        }),
        metadata: {
          integration: "github",
          snapshot: {
            version: 1,
            account,
            repositories: repositories.map((item) => ({
              ...item,
              defaultBranch: "main",
              archived: false,
              disabled: false
            }))
          }
        }
      };
    }
    case "imap": {
      const login = {
        host: connection.host ?? `mail.${domain}`,
        port: 993 as const,
        security: "tls" as const,
        username: `${handle}@${domain}`
      };
      return {
        target: { integration: "imap", display: { ...login, logins: 1 } },
        credentials: ImapSource.credentials({ ...login, password: secret }),
        metadata: {
          integration: "imap",
          snapshot: {
            version: 1,
            ...login,
            capabilities: ["IMAP4rev1", "IDLE", "UIDPLUS"],
            folders: [
              { path: "INBOX", delimiter: "/", specialUse: [], selectable: true },
              { path: "Archive", delimiter: "/", specialUse: ["\\Archive"], selectable: true },
              { path: "Sent", delimiter: "/", specialUse: ["\\Sent"], selectable: true }
            ],
            truncated: false
          }
        }
      };
    }
  }
};

/**
 * Saves each offline connection connected, as the publisher, the way connect saves one. A
 * connection already saved under its id is left be, so a resumed `up` changes nothing.
 */
export const saveConnections = Effect.fn("saveConnections")(
  function* (scenario: Scenario) {
    const sql = yield* SqlClient.SqlClient;
    const keys = yield* CredentialKeys.CredentialKeys;
    const cryptography = yield* Cryptography.Cryptography;
    const publisher = scenario.people.find((person) => person.key === scenario.publisher)!;
    const { companyId, userId } = ids(scenario, publisher);
    for (const connection of offlineConnections(scenario)) {
      const id = connectionId(scenario, connection);
      const { target, credentials, metadata } = saved(
        scenario,
        connection,
        yield* cryptography.token(24)
      );
      const sealed = yield* keys.encrypt(
        { companyId, id, integration: connection.integration },
        credentials
      );
      const inserted = yield* sql`INSERT INTO connections
      (id, company_id, integration, handle, description, mode, status, display, credentials, key_id,
       credential_revision, metadata_revision, created_by, last_tested_at, last_discovered_at)
      VALUES (${id}, ${companyId}, ${connection.integration}, ${connection.handle},
        ${connection.description}, 'company', 'connected', ${targetJson(target)}::jsonb -> 'display',
        ${sealed.credentials}, ${sealed.keyId}, 1, 1, ${userId}, now(), now())
      ON CONFLICT DO NOTHING RETURNING id`;
      if (inserted.length > 0)
        yield* sql`INSERT INTO connection_snapshots
        (company_id, connection_id, integration, revision, snapshot, created_at)
        VALUES (${companyId}, ${id}, ${connection.integration}, 1,
          ${metadataJson(metadata)}::jsonb -> 'snapshot', now())`;
      // A GitHub connection's installation is the company's, as a connect claims it.
      if (inserted.length > 0 && target.integration === "github") {
        yield* sql`INSERT INTO github_installations (installation_id)
          VALUES (${target.display.installationId}) ON CONFLICT DO NOTHING`;
        yield* sql`INSERT INTO github_installation_claims (installation_id, company_id)
          VALUES (${target.display.installationId}, ${companyId}) ON CONFLICT DO NOTHING`;
      }
    }
  },
  // Every connection with its snapshot, or none, so a resumed `up` never finds one without it.
  (effect) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(effect))
);

/**
 * Leaves each offline connection in its scenario state, once patches that declare it have
 * published, as the store leaves one: paused is disconnected, an Attio key a Test found writable is
 * named and disconnected, and an IMAP login the server refused pauses it, connected. One that
 * keeps guests off says so.
 */
export const settleConnections = Effect.fn("settleConnections")(function* (scenario: Scenario) {
  const sql = yield* SqlClient.SqlClient;
  const publisher = scenario.people.find((person) => person.key === scenario.publisher)!;
  const { companyId, userId } = ids(scenario, publisher);
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const ago = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(now - ms));
  for (const connection of offlineConnections(scenario)) {
    const id = connectionId(scenario, connection);
    const disconnect = sql`status = 'disconnected', credential_revision = credential_revision + 1`;
    if (connection.suspended === true && connection.integration === "github")
      yield* sql`UPDATE github_installations SET suspended_seen_at = now() - interval '12 minutes'
        WHERE installation_id = ${installationOf(scenario, connection)}`;
    if (connection.blockGuests === true)
      yield* sql`UPDATE connections SET block_guests = true
        WHERE id = ${id} AND company_id = ${companyId}`;
    if (connection.state === "paused")
      yield* sql`UPDATE connections SET ${disconnect}
        WHERE id = ${id} AND company_id = ${companyId} AND status = 'connected'`;
    else if (connection.state === "needs-attention" && connection.integration === "attio")
      yield* sql`UPDATE connections SET ${disconnect},
        display = display || ${writableJson({
          writable: {
            scopes: ["record_permission:read-write"],
            by: userId,
            at: ago(48 * HOUR),
            during: "test"
          }
        })}::jsonb
        WHERE id = ${id} AND company_id = ${companyId} AND status = 'connected'`;
    else if (
      connection.state === "needs-attention" &&
      connection.integration === "github" &&
      connection.reason !== "left"
    )
      yield* sql`UPDATE connections SET ${disconnect},
        display = display || ${attentionJson({
          attention:
            connection.reason === "permissions"
              ? {
                  reason: "permissions",
                  at: ago(26 * HOUR),
                  during: "test",
                  by: userId,
                  missing: ["actions"],
                  above: []
                }
              : { reason: "uninstalled", at: ago(5 * HOUR), during: "call" }
        })}::jsonb
        WHERE id = ${id} AND company_id = ${companyId} AND status = 'connected'`;
    else if (connection.state === "needs-attention" && connection.integration === "imap")
      yield* sql`UPDATE connections SET display = display || ${pausedJson({
        paused: { at: ago(3 * HOUR), reply: "AUTHENTICATIONFAILED", during: "call" }
      })}::jsonb
        WHERE id = ${id} AND company_id = ${companyId}`;
  }
});

/**
 * The `github` scenario's connection, seeded from the developer's development App: its
 * installation and repositories are read through the App, live, as connect checks and discovers
 * them, and saved as the publisher's, as connect saves one. GitHub's sign-in can't run here, so
 * nobody is shown administering anything: this is the developer's word for their own App. A
 * connection already saved under its id is left be.
 */
export const seedGithub = Effect.fn("seedGithub")(function* (
  scenario: Scenario,
  connection: Extract<LiveConnection, { readonly integration: "github" }>,
  seed: { readonly installationId: number; readonly repositoryIds: ReadonlyArray<number> },
  app: GithubSource.App
) {
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* CredentialKeys.CredentialKeys;
  const publisher = scenario.people.find((person) => person.key === scenario.publisher)!;
  const { companyId, userId } = ids(scenario, publisher);
  const id = `conn_env_${scenario.company.handle}_github_${connection.handle}`;
  const found = yield* sql`SELECT 1 FROM connections WHERE id = ${id}`;
  if (found.length > 0) return false;
  const inspected = yield* Effect.gen(function* () {
    const access = yield* GithubAccess.Access;
    return yield* access.inspect(seed.installationId, seed.repositoryIds, "the development App");
  }).pipe(
    Effect.provide(
      GithubAccess.layer.pipe(
        Layer.provide(
          Layer.effect(GithubSource.Source, GithubSource.makeWith(Option.some(app))).pipe(
            Layer.provide(FetchHttpClient.layer)
          )
        )
      )
    )
  );
  const display = {
    installationId: seed.installationId,
    account: inspected.account,
    repositories: inspected.repositories.map(({ id: repository, name, private: hidden }) => ({
      id: repository,
      name,
      private: hidden
    })),
    successes: 1
  };
  const sealed = yield* keys.encrypt(
    { companyId, id, integration: "github" },
    GithubConnection.credentials({
      installationId: seed.installationId,
      repositoryIds: seed.repositoryIds
    })
  );
  const metadata: ConnectionStore.Metadata = {
    integration: "github",
    snapshot: { version: 1, account: inspected.account, repositories: inspected.repositories }
  };
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO github_installations (installation_id)
        VALUES (${seed.installationId}) ON CONFLICT DO NOTHING`;
      yield* sql`INSERT INTO github_installation_claims (installation_id, company_id)
        VALUES (${seed.installationId}, ${companyId}) ON CONFLICT DO NOTHING`;
      yield* sql`INSERT INTO connections
        (id, company_id, integration, handle, description, mode, status, display, credentials, key_id,
         credential_revision, metadata_revision, created_by, last_tested_at, last_discovered_at)
        VALUES (${id}, ${companyId}, 'github', ${connection.handle}, ${connection.description},
          'company', 'connected', ${targetJson({ integration: "github", display })}::jsonb -> 'display',
          ${sealed.credentials}, ${sealed.keyId}, 1, 1, ${userId}, now(), now())`;
      yield* sql`INSERT INTO connection_snapshots
        (company_id, connection_id, integration, revision, snapshot, created_at)
        VALUES (${companyId}, ${id}, 'github', 1, ${metadataJson(metadata)}::jsonb -> 'snapshot', now())`;
    })
  );
  return true;
});
