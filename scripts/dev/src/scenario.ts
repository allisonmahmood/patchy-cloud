/**
 * Scenarios: what `pnpm dev up <name>` builds an environment from. Each lives
 * in `scenarios/<name>/scenario.json` beside the sources of its repo patches
 * (`patches/<repo>/`, builder-owned files only; `patchy init` lays down the
 * managed rest) and its file patches (`files/<file>`).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Cryptography } from "@patchy/core";

const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/));
const Email = Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/));

export const Person = Schema.Struct({
  key: Slug,
  name: Schema.NonEmptyString,
  email: Email,
  role: Schema.Literals(["admin", "member"]),
  /** One of the scenario's other companies, by handle; absent, the scenario's own. */
  company: Schema.optionalKey(Slug)
});
export type Person = typeof Person.Type;

/** A patch repo, initialized at `tier` and overlaid with `patches/<repo>/`. */
export const RepoPatch = Schema.Struct({
  repo: Slug,
  tier: Schema.Literals([1, 2]),
  description: Schema.NonEmptyString,
  /** The patch's empty state offers "Load sample data"; `up` presses it as the publisher. */
  sampleData: Schema.optionalKey(Schema.Boolean),
  /** The scenario's connections it declares, as `integration/handle`: `up` skips it without them. */
  connections: Schema.optionalKey(Schema.Array(Schema.String)),
  /** People at the scenario's other companies, by key, whom `up` shares it with as the publisher. */
  guests: Schema.optionalKey(Schema.Array(Slug))
});

/**
 * A company connection the publisher makes through its connect page, as an admin would, before
 * any patch publishes. Pidgeon's pastes the developer's test admin key and creates a new test
 * address on pidgeon.email, which Pidgeon deletes a day later. Attio's pastes the developer's
 * read-only key to Patchy's probe workspace; it only reads, so there's nothing to take down.
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
export const ScenarioConnection = Schema.Union([
  PidgeonScenarioConnection,
  AttioScenarioConnection
]);
export type ScenarioConnection = typeof ScenarioConnection.Type;

/** A single-file page published from `files/<file>`. */
export const FilePatch = Schema.Struct({
  file: Schema.NonEmptyString,
  name: Slug,
  description: Schema.NonEmptyString,
  guests: RepoPatch.fields.guests
});

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
 * a publisher who is an admin of its own, and guests from its other companies.
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
  const connections = new Set(
    (scenario.connections ?? []).map(
      (connection) => `${connection.integration}/${connection.handle}`
    )
  );
  for (const patch of scenario.patches) {
    const outside = new Set(
      scenario.people.filter((person) => person.company !== undefined).map((person) => person.key)
    );
    const insider = (patch.guests ?? []).find((key) => !outside.has(key));
    if (insider !== undefined)
      return yield* new ScenarioInvalid({
        name,
        problem: `${"repo" in patch ? patch.repo : patch.name} names guest ${insider}, who isn't at one of its other companies.`
      });
    if (!("repo" in patch)) continue;
    for (const connection of patch.connections ?? [])
      if (!connections.has(connection))
        return yield* new ScenarioInvalid({
          name,
          problem: `${patch.repo} names ${connection}, which isn't one of its connections.`
        });
  }
  return { name, dir, scenario };
});

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

/** The publisher's machine token; dev-only and loopback-only, like the seed's. */
export const publisherToken = (scenario: Scenario) =>
  `patchy-env-${scenario.company.handle}-${scenario.publisher}`;

/**
 * Seeds the scenario's companies, people and publishing key into a migrated database, and turns
 * agent access on when the scenario asks. Every start seeds again; agent access is turned on
 * only while nobody has ever switched it, so a switch at Company survives restarts.
 */
export const seedScenario = Effect.fn("seedScenario")(function* (scenario: Scenario) {
  const sql = yield* SqlClient.SqlClient;
  const cryptography = yield* Cryptography.Cryptography;
  const companyId = `cmp_env_${scenario.company.handle}`;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const company of [scenario.company, ...(scenario.companies ?? [])])
        yield* sql`
          INSERT INTO companies (id, handle, name, created_at)
          VALUES (${`cmp_env_${company.handle}`}, ${company.handle}, ${company.name}, now())
          ON CONFLICT (id) DO UPDATE SET handle = EXCLUDED.handle, name = EXCLUDED.name`;
      for (const person of scenario.people) {
        const { companyId: home, userId, clerkUserId, tokenId } = ids(scenario, person);
        yield* sql`
          INSERT INTO users (id, clerk_user_id, company_id, email, name, role, created_at)
          VALUES (${userId}, ${clerkUserId}, ${home}, ${person.email.toLowerCase()},
            ${person.name}, ${person.role}, now())
          ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
            role = EXCLUDED.role, deactivated_at = NULL`;
        if (person.key === scenario.publisher)
          yield* sql`
            INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
            VALUES (${tokenId}, ${userId}, ${"Dev environment"},
              ${yield* cryptography.sha256(publisherToken(scenario))}, now(), now() + interval '90 days', now())
            ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
              expires_at = EXCLUDED.expires_at, last_used_at = EXCLUDED.last_used_at, revoked_at = NULL`;
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
