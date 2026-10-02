/**
 * Scenarios: what `pnpm dev up <name>` builds an environment from. Each lives
 * in `scenarios/<name>/scenario.json` beside the sources of its repo patches
 * (`patches/<repo>/`, builder-owned files only; `patchy init` lays down the
 * managed rest) and its file patches (`files/<file>`).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { sha256 } from "@patchy/core";
import { layerFromUrl } from "@patchy/sql";

const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/));
const Email = Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/));

export const Person = Schema.Struct({
  key: Slug,
  name: Schema.NonEmptyString,
  email: Email,
  role: Schema.Literals(["admin", "member"])
});
export type Person = typeof Person.Type;

/** A patch repo, initialized at `tier` and overlaid with `patches/<repo>/`. */
export const RepoPatch = Schema.Struct({
  repo: Slug,
  tier: Schema.Literals([0, 1, 2]),
  description: Schema.NonEmptyString,
  /** The patch's empty state offers "Load sample data"; `up` presses it as the publisher. */
  sampleData: Schema.optionalKey(Schema.Boolean)
});

/** A static page published from `files/<file>`. */
export const FilePatch = Schema.Struct({
  file: Schema.NonEmptyString,
  name: Slug,
  description: Schema.NonEmptyString
});

export const Scenario = Schema.Struct({
  company: Schema.Struct({ name: Schema.NonEmptyString, handle: Slug }),
  people: Schema.NonEmptyArray(Person),
  /** The admin the environment's CLI publishes as. */
  publisher: Slug,
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

/** The named scenario, checked: unique keys and emails, and an admin publisher. */
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
  if (scenario.people.find((person) => person.key === scenario.publisher)?.role !== "admin")
    return yield* new ScenarioInvalid({ name, problem: "the publisher must be an admin." });
  return { name, dir, scenario };
});

/** Stable ids, so seeding twice updates the same rows. */
const ids = (scenario: Scenario, person: Person) => ({
  userId: `usr_env_${scenario.company.handle}_${person.key}`,
  clerkUserId: `env_${scenario.company.handle}_${person.key}`,
  tokenId: `tok_env_${scenario.company.handle}_${person.key}`
});

/** The publisher's machine token; dev-only and loopback-only, like the seed's. */
export const publisherToken = (scenario: Scenario) =>
  `patchy-env-${scenario.company.handle}-${scenario.publisher}`;

/** Seeds the scenario's company, people and publishing key into a migrated database. */
export const seedScenario = Effect.fn("seedScenario")(function* (
  databaseUrl: string,
  scenario: Scenario
) {
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const companyId = `cmp_env_${scenario.company.handle}`;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO companies (id, handle, name, created_at)
          VALUES (${companyId}, ${scenario.company.handle}, ${scenario.company.name}, now())
          ON CONFLICT (id) DO UPDATE SET handle = EXCLUDED.handle, name = EXCLUDED.name`;
        for (const person of scenario.people) {
          const { userId, clerkUserId, tokenId } = ids(scenario, person);
          yield* sql`
            INSERT INTO users (id, clerk_user_id, company_id, email, name, role, created_at)
            VALUES (${userId}, ${clerkUserId}, ${companyId}, ${person.email.toLowerCase()},
              ${person.name}, ${person.role}, now())
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
              role = EXCLUDED.role, deactivated_at = NULL`;
          if (person.key === scenario.publisher)
            yield* sql`
              INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
              VALUES (${tokenId}, ${userId}, ${"Dev environment"},
                ${sha256(publisherToken(scenario))}, now(), now() + interval '90 days', now())
              ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
                expires_at = EXCLUDED.expires_at, last_used_at = EXCLUDED.last_used_at, revoked_at = NULL`;
        }
      })
    );
  }).pipe(Effect.provide(layerFromUrl(Redacted.make(databaseUrl))));
});
