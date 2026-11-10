/**
 * Scenarios: what `pnpm dev up <name>` builds an environment from. Each lives
 * in `scenarios/<name>/scenario.json` beside the sources of its repo patches
 * (`patches/<repo>/`, builder-owned files only; `patchy init` lays down the
 * managed rest) and its file patches (`files/<file>`). Every start seeds its
 * companies and people; `up` publishes its patches and writes its history and
 * offline connections (`history.ts`, `connections.ts`).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Cryptography } from "@patchy/core";

const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/));
const Email = Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/));
/** How long before `up` something happened, such as "2 hours" or "30 days". */
const Ago = Schema.DurationFromString;

/** A computer whose CLI publishes as its person; one unused for 30 days has ended. */
const Computer = Schema.Struct({ name: Schema.NonEmptyString, used: Ago });
/** An app that uses patches as its person through Patchy MCP; 30 days without a call ends it. */
const App = Schema.Struct({
  name: Schema.NonEmptyString,
  site: Schema.NonEmptyString,
  connected: Ago,
  used: Schema.optionalKey(Ago)
});

export const Person = Schema.Struct({
  key: Slug,
  name: Schema.NonEmptyString,
  email: Email,
  role: Schema.Literals(["admin", "member"]),
  /** One of the scenario's other companies, by handle; absent, the scenario's own. */
  company: Schema.optionalKey(Slug),
  /** Deactivated once `up` has published what they own; reactivating them lasts until `down`. */
  deactivated: Schema.optionalKey(Schema.Literal(true)),
  computers: Schema.optionalKey(Schema.Array(Computer)),
  apps: Schema.optionalKey(Schema.Array(App))
});
export type Person = typeof Person.Type;

/** A call in a tier 2 patch's log, as `up` records it: who made it, through which app, and how it went. */
const Call = Schema.Struct({
  by: Slug,
  via: Schema.optionalKey(Schema.NonEmptyString),
  /** The handler as the log names it, such as `deals.move`. */
  handler: Schema.NonEmptyString,
  kind: Schema.Literals(["query", "mutation", "action"]),
  /** A `running` call hasn't settled, and reads as Unknown once its deadline, an hour on, passes. */
  outcome: Schema.Literals(["succeeded", "failed", "refused", "running", "unknown"]),
  /** What a failed call logged. */
  reason: Schema.optionalKey(Schema.NonEmptyString),
  /**
   * A connection the patch declares that the call went through, by name: the integration's
   * operation, such as `listRecords`, and what it read, such as `deals`.
   */
  connection: Schema.optionalKey(
    Schema.Struct({
      name: Schema.NonEmptyString,
      op: Schema.NonEmptyString,
      resource: Schema.optionalKey(Schema.NonEmptyString)
    })
  ),
  ago: Ago
});
/**
 * What either kind of patch may say about its past, which `up` makes true after publishing it.
 * Absent, a patch is the publisher's, published once just now and never opened.
 */
const history = {
  /** Another scenario whose source it publishes, under that scenario's `patches/` or `files/`. */
  from: Schema.optionalKey(Slug),
  /** Whose patch it is, by key; `up` publishes, shares, retires and deletes it as them. */
  owner: Schema.optionalKey(Slug),
  /** How many times `up` publishes it. */
  versions: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
  /** How long ago its first version was published, and its latest; `updated` defaults to `age`. */
  age: Schema.optionalKey(Ago),
  updated: Schema.optionalKey(Ago),
  /** How often each person, by key, has opened it. */
  opens: Schema.optionalKey(Schema.Record(Slug, Schema.Int.check(Schema.isGreaterThan(0)))),
  /** How long ago its owner retired or deleted it. */
  retired: Schema.optionalKey(Ago),
  deleted: Schema.optionalKey(Ago),
  /** People at other companies than its owner's, by key, whom `up` shares it with as its owner. */
  guests: Schema.optionalKey(Schema.Array(Slug))
};

/** A patch repo, initialized at `tier` and overlaid with `patches/<repo>/`. */
export const RepoPatch = Schema.Struct({
  repo: Slug,
  tier: Schema.Literals([1, 2]),
  description: Schema.NonEmptyString,
  /** The patch's empty state offers "Load sample data"; `up` presses it as the publisher. */
  sampleData: Schema.optionalKey(Schema.Boolean),
  /** The scenario's connections it declares, as `integration/handle`: `up` skips it without them. */
  connections: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Shared tables it reads from earlier patches of its company's, by their key and table, under
   * the table's name; `up` declares each with `patchy add shared-table` before publishing it.
   */
  reads: Schema.optionalKey(Schema.Array(Schema.Struct({ patch: Slug, table: Slug }))),
  calls: Schema.optionalKey(Schema.Array(Call)),
  ...history
});

/**
 * A company connection the publisher makes through its connect page, as an admin would, before
 * any patch publishes. Pidgeon's pastes the developer's test admin key and creates a new test
 * address on pidgeon.email, which Pidgeon deletes a day later. Attio's pastes the developer's
 * read-only key to Patchy's probe workspace; it only reads, so there's nothing to take down.
 * IMAP's starts a dev mailbox in Docker on this machine and types its login; `down` removes it.
 */
export const PidgeonScenarioConnection = Schema.Struct({
  integration: Schema.Literal("pidgeon"),
  handle: Slug,
  description: Schema.NonEmptyString,
  /** The new address's local part; a code after it makes each environment's its own. */
  localPart: Slug,
  displayName: Schema.NonEmptyString,
  access: Schema.Literals(["read", "send"]),
  /** A file beside `scenario.json` holding the mail `up` delivers to the new address. */
  mail: Schema.optionalKey(Schema.NonEmptyString)
});
export const AttioScenarioConnection = Schema.Struct({
  integration: Schema.Literal("attio"),
  handle: Slug,
  description: Schema.NonEmptyString
});
export const ImapScenarioConnection = Schema.Struct({
  integration: Schema.Literal("imap"),
  handle: Slug,
  description: Schema.NonEmptyString,
  /** The mailbox's login, at `mail.<company handle>.test`. */
  username: Schema.NonEmptyString,
  /** A file beside `scenario.json` holding the folders and messages `up` puts in the mailbox. */
  mail: Schema.optionalKey(Schema.NonEmptyString)
});
export const LiveConnection = Schema.Union([
  PidgeonScenarioConnection,
  AttioScenarioConnection,
  ImapScenarioConnection
]);
export type LiveConnection = typeof LiveConnection.Type;

/**
 * A company connection written straight into the database, offline: its credentials are invented
 * and nothing reaches its integration. `up` saves it connected, as the publisher, before any patch
 * publishes, then leaves it in `state`: `connected`; `paused`, disconnected by the publisher; or
 * `needs-attention` for its integration's own reason, an Attio key a Test found writable, an IMAP
 * login the mail server refused, or a Pidgeon key Patchy replaced but couldn't revoke. Postgres and
 * PostHog keep no such reason.
 */
export const OfflineConnection = Schema.Struct({
  integration: Schema.Literals(["postgres", "posthog", "attio", "pidgeon", "imap"]),
  handle: Slug,
  description: Schema.NonEmptyString,
  state: Schema.Literals(["connected", "needs-attention", "paused"]),
  /** Connected with a Pidgeon test key, so its mail stays in Pidgeon. */
  test: Schema.optionalKey(Schema.Literal(true)),
  /** An admin kept guests off it, so patches that declare it turn their guests away. */
  blockGuests: Schema.optionalKey(Schema.Literal(true))
});
export type OfflineConnection = typeof OfflineConnection.Type;

// An offline connection has a state and a live one doesn't, so the offline one is tried first.
export const ScenarioConnection = Schema.Union([OfflineConnection, LiveConnection]);
export type ScenarioConnection = typeof ScenarioConnection.Type;

const isOffline = Schema.is(OfflineConnection);
/** The connections `up` makes through their connect pages. */
export const liveConnections = (scenario: Scenario): ReadonlyArray<LiveConnection> =>
  (scenario.connections ?? []).filter(
    (connection): connection is LiveConnection => !isOffline(connection)
  );
/** The connections `up` writes straight into the database. */
export const offlineConnections = (scenario: Scenario): ReadonlyArray<OfflineConnection> =>
  (scenario.connections ?? []).filter(isOffline);

/** A single-file page published from `files/<file>`. */
export const FilePatch = Schema.Struct({
  file: Schema.NonEmptyString,
  name: Slug,
  description: Schema.NonEmptyString,
  ...history
});
export type ScenarioPatch = typeof RepoPatch.Type | typeof FilePatch.Type;

export const Scenario = Schema.Struct({
  company: Schema.Struct({
    name: Schema.NonEmptyString,
    handle: Slug,
    /** The company's agent access starts on, turned on by the publisher, so worker agents can use its agent areas. */
    agentAccess: Schema.optionalKey(Schema.Boolean)
  }),
  /** Other companies, whose people the company can share a patch with as its guests. */
  companies: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.NonEmptyString, handle: Slug }))
  ),
  people: Schema.NonEmptyArray(Person),
  /** The admin the environment's CLI publishes as. */
  publisher: Slug,
  /**
   * Invitations to the company the publisher sent that long ago; one sent 30 days ago has expired,
   * and one `unsent` is one whose email didn't go out.
   */
  invitations: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        email: Email,
        role: Schema.Literals(["admin", "member"]),
        sent: Ago,
        unsent: Schema.optionalKey(Schema.Literal(true))
      })
    )
  ),
  connections: Schema.optionalKey(Schema.Array(ScenarioConnection)),
  patches: Schema.Array(Schema.Union([RepoPatch, FilePatch]))
});
export type Scenario = typeof Scenario.Type;

export class ScenarioNotFound extends Schema.TaggedError<ScenarioNotFound>()("ScenarioNotFound", {
  name: Schema.String,
  available: Schema.Array(Schema.String)
}) {
  override get message() {
    return `No scenario "${this.name}". Available: ${this.available.join(", ") || "none"}.`;
  }
}

export class ScenarioInvalid extends Schema.TaggedError<ScenarioInvalid>()("ScenarioInvalid", {
  name: Schema.String,
  problem: Schema.String
}) {
  override get message() {
    return `Scenario "${this.name}" is invalid: ${this.problem}`;
  }
}

export const scenariosDir = (worktree: string) =>
  Effect.map(Path.Path, (path) => path.join(worktree, "scenarios"));

const decodeScenario = Schema.decodeUnknownEffect(Schema.fromJsonString(Scenario));

/**
 * The named scenario, checked: unique keys, emails and company handles, people at its companies,
 * a publisher who is an active admin of its own, patches owned, opened and called by its people
 * and shared with people at other companies than their owner's, and connections in a state
 * their integration has.
 */
export const loadScenario = Effect.fn("loadScenario")(function* (worktree: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(yield* scenariosDir(worktree), name);
  const file = path.join(dir, "scenario.json");
  if (!(yield* fs.exists(file))) {
    const root = yield* scenariosDir(worktree);
    const entries = (yield* fs.exists(root)) ? yield* fs.readDirectory(root) : [];
    const available: Array<string> = [];
    for (const entry of [...entries].sort())
      if (
        (yield* fs.stat(path.join(root, entry))).type === "Directory" &&
        (yield* fs.exists(path.join(root, entry, "scenario.json")))
      )
        available.push(entry);
    return yield* new ScenarioNotFound({ name, available });
  }
  const scenario = yield* decodeScenario(yield* fs.readFileString(file)).pipe(
    Effect.mapError((error) => new ScenarioInvalid({ name, problem: error.message }))
  );
  const keys = new Set(scenario.people.map((person) => person.key));
  const emails = new Set(scenario.people.map((person) => person.email.toLowerCase()));
  if (keys.size !== scenario.people.length || emails.size !== scenario.people.length)
    return yield* new ScenarioInvalid({ name, problem: "people need unique keys and emails." });
  const handles = new Set([scenario.company, ...(scenario.companies ?? [])].map((c) => c.handle));
  if (handles.size !== 1 + (scenario.companies ?? []).length)
    return yield* new ScenarioInvalid({ name, problem: "companies need unique handles." });
  const stranger = scenario.people.find(
    (person) => person.company !== undefined && !handles.has(person.company)
  );
  if (stranger !== undefined)
    return yield* new ScenarioInvalid({
      name,
      problem: `${stranger.key} is at ${stranger.company}, which isn't one of its companies.`
    });
  const publisher = scenario.people.find((person) => person.key === scenario.publisher);
  if (publisher?.role !== "admin" || publisher.company !== undefined)
    return yield* new ScenarioInvalid({
      name,
      problem: "the publisher must be an admin of the scenario's own company."
    });
  const invalid = (problem: string) => new ScenarioInvalid({ name, problem });
  if (publisher.deactivated === true) return yield* invalid("the publisher can't be deactivated.");
  const reasonless = offlineConnections(scenario).find(
    (connection) =>
      (connection.state === "needs-attention" &&
        (connection.integration === "postgres" || connection.integration === "posthog")) ||
      (connection.test === true && connection.integration !== "pidgeon")
  );
  if (reasonless !== undefined)
    return yield* invalid(
      `${reasonless.integration}/${reasonless.handle} ${reasonless.test === true ? "can't have a test key: only Pidgeon's do" : "has no reason of its integration's to need attention"}.`
    );
  const connections = new Set(
    (scenario.connections ?? []).map(
      (connection) => `${connection.integration}/${connection.handle}`
    )
  );
  const people = new Map(scenario.people.map((person) => [person.key, person]));
  const home = (person: Person) => person.company ?? scenario.company.handle;
  for (const patch of scenario.patches) {
    const key = "repo" in patch ? patch.repo : patch.name;
    const owner = people.get(patch.owner ?? scenario.publisher);
    if (owner === undefined)
      return yield* invalid(`${key} is owned by ${patch.owner}, who isn't one of its people.`);
    const insider = (patch.guests ?? []).find((guest) => {
      const person = people.get(guest);
      return person === undefined || home(person) === home(owner);
    });
    if (insider !== undefined)
      return yield* invalid(
        `${key} names guest ${insider}, who isn't one of its people at another company than its owner's.`
      );
    const stranger = [
      ...Object.keys(patch.opens ?? {}),
      ...("repo" in patch ? (patch.calls ?? []).map((call) => call.by) : [])
    ].find((person) => !people.has(person));
    if (stranger !== undefined)
      return yield* invalid(`${key} names ${stranger}, who isn't one of its people.`);
    if (patch.retired !== undefined && patch.deleted !== undefined)
      return yield* invalid(`${key} can't be both retired and deleted.`);
    if (!("repo" in patch)) continue;
    const earlier = scenario.patches.slice(0, scenario.patches.indexOf(patch));
    const unpublished = (patch.reads ?? []).find(
      (read) =>
        !earlier.some(
          (source) =>
            "repo" in source &&
            source.repo === read.patch &&
            home(people.get(source.owner ?? scenario.publisher) ?? owner) === home(owner)
        )
    );
    if (unpublished !== undefined)
      return yield* invalid(
        `${patch.repo} reads ${unpublished.patch}, which isn't a repo its company publishes before it.`
      );
    for (const connection of patch.connections ?? [])
      if (!connections.has(connection))
        return yield* invalid(
          `${patch.repo} names ${connection}, which isn't one of its connections.`
        );
    const undeclared = (patch.calls ?? []).find(
      (call) =>
        call.connection !== undefined && !(patch.connections ?? []).includes(call.connection.name)
    );
    if (undeclared !== undefined)
      return yield* invalid(
        `${patch.repo} has a call through ${undeclared.connection?.name}, which it doesn't declare.`
      );
  }
  return { name, dir, scenario };
});

/**
 * Where a patch's source is: its repo's builder-owned files or its file, beside its scenario's
 * `scenario.json`, or under the scenario it names as `from`.
 */
export const sourceOf = (path: Path.Path, scenarioDir: string, patch: ScenarioPatch) => {
  const dir =
    patch.from === undefined ? scenarioDir : path.join(path.dirname(scenarioDir), patch.from);
  return "repo" in patch
    ? path.join(dir, "patches", patch.repo)
    : path.join(dir, "files", patch.file);
};

/** Stable ids, so seeding twice updates the same rows. */
export const ids = (scenario: Scenario, person: Person) => {
  const handle = person.company ?? scenario.company.handle;
  return {
    companyId: `cmp_env_${handle}`,
    userId: `usr_env_${handle}_${person.key}`,
    clerkUserId: `env_${handle}_${person.key}`,
    tokenId: `tok_env_${handle}_${person.key}`
  };
};

/** A person's machine token, which `up` publishes as; dev-only and loopback-only, like the seed's. */
export const tokenOf = (scenario: Scenario, person: Person) =>
  `patchy-env-${person.company ?? scenario.company.handle}-${person.key}`;

/** The publisher's machine token, the environment's CLI's own. */
export const publisherToken = (scenario: Scenario) =>
  `patchy-env-${scenario.company.handle}-${scenario.publisher}`;

/**
 * Saves `person`'s machine token as live, so `up` can publish as them. Every start seeds the
 * publisher's again; anyone else's lasts until `up` has published what they own.
 */
export const allowPublishing = Effect.fn("allowPublishing")(function* (
  scenario: Scenario,
  person: Person
) {
  const sql = yield* SqlClient.SqlClient;
  const cryptography = yield* Cryptography.Cryptography;
  const { userId, tokenId } = ids(scenario, person);
  yield* sql`
    INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
    VALUES (${tokenId}, ${userId}, ${"Dev environment"},
      ${yield* cryptography.sha256(tokenOf(scenario, person))}, now(), now() + interval '90 days', now())
    ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
      expires_at = EXCLUDED.expires_at, last_used_at = EXCLUDED.last_used_at, revoked_at = NULL`;
});

/**
 * Seeds the scenario's companies, people and publishing key into a migrated database, and turns
 * agent access on when the scenario asks. Every start seeds again; agent access is turned on
 * only while nobody has ever switched it, so a switch in Settings survives restarts.
 */
export const seedScenario = Effect.fn("seedScenario")(function* (scenario: Scenario) {
  const sql = yield* SqlClient.SqlClient;
  const companyId = `cmp_env_${scenario.company.handle}`;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const company of [scenario.company, ...(scenario.companies ?? [])])
        yield* sql`
          INSERT INTO companies (id, handle, name, created_at)
          VALUES (${`cmp_env_${company.handle}`}, ${company.handle}, ${company.name}, now())
          ON CONFLICT (id) DO UPDATE SET handle = EXCLUDED.handle, name = EXCLUDED.name`;
      for (const person of scenario.people) {
        const { companyId: home, userId, clerkUserId } = ids(scenario, person);
        // `up` deactivates someone the scenario says is, once they've published; a start after
        // leaves them as they are, so reactivating them at People lasts.
        yield* sql`
          INSERT INTO users (id, clerk_user_id, company_id, email, name, role, created_at)
          VALUES (${userId}, ${clerkUserId}, ${home}, ${person.email.toLowerCase()},
            ${person.name}, ${person.role}, now())
          ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
            role = EXCLUDED.role,
            deactivated_at = ${person.deactivated === true ? sql`users.deactivated_at` : sql`NULL`}`;
        if (person.key === scenario.publisher) yield* allowPublishing(scenario, person);
      }
      if (scenario.company.agentAccess === true) {
        const publisher = scenario.people.find((person) => person.key === scenario.publisher)!;
        yield* sql`
          UPDATE companies SET agent_access_on = true,
            agent_access_changed_by = ${ids(scenario, publisher).userId}, agent_access_changed_at = now()
          WHERE id = ${companyId} AND agent_access_changed_at IS NULL`;
      }
    })
  );
});
