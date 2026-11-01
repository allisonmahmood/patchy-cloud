/**
 * A run's own company and people, seeded into its side's instance. Runs share
 * an instance, so each gets the task scenario's companies and people under its
 * own names: every company handle suffixed with the run's id and every email
 * plus-addressed with it (emails are unique across an instance), keys, names
 * and roles kept. No run sees another's patches in `patchy list`, and two runs
 * never collide on a patch name. Once graded, the run's people are deactivated,
 * which also takes them off the instance's personas list.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { layerFromUrl } from "@patchy/sql";
import { readPlan } from "../state.js";
import { ids, publisherToken, type Scenario, seedScenario } from "../scenario.js";
import type { RunPerson } from "./task.js";

export class SideNotRunning extends Schema.TaggedError<SideNotRunning>()("SideNotRunning", {
  clone: Schema.String
}) {
  override get message() {
    return `The instance in ${this.clone} has no plan.json; it isn't running.`;
  }
}

/** A random lowercase id, for run ids, door keys and anonymous names. */
export const randomId = (length: number) =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(length)),
    (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]
  ).join("");

const HANDLE_MAX = 32;

/** A handle under a run's id, within the 32 characters a handle may have. */
export const runHandle = (handle: string, run: string) =>
  `${handle.slice(0, HANDLE_MAX - run.length - 1).replace(/-+$/, "")}-${run}`;

/** An email under a run's id: plus-addressed, so it keeps its reserved example domain. */
export const runEmail = (email: string, run: string) => {
  const [local = "", domain = ""] = email.toLowerCase().split("@");
  return `${local}+${run}@${domain}`;
};

/**
 * The scenario's companies and people under a run's id. Its patches and
 * connections are left out: a run's fixtures are staged by the evaluator,
 * not by the scenario.
 */
export const namespaceScenario = (scenario: Scenario, run: string): Scenario => ({
  company: { ...scenario.company, handle: runHandle(scenario.company.handle, run) },
  ...(scenario.companies === undefined
    ? {}
    : {
        companies: scenario.companies.map((company) => ({
          ...company,
          handle: runHandle(company.handle, run)
        }))
      }),
  people: Arr.map(scenario.people, (person) => ({
    ...person,
    email: runEmail(person.email, run),
    ...(person.company === undefined ? {} : { company: runHandle(person.company, run) })
  })),
  publisher: scenario.publisher,
  patches: []
});

/** A run's identities as the grader and the record see them. */
export interface RunIdentities {
  readonly company: { readonly name: string; readonly handle: string };
  /** The run's people at its own company; people at its other companies are guests. */
  readonly people: ReadonlyArray<RunPerson>;
  readonly publisher: RunPerson;
  /** The publisher's machine token, for the run's CLI. Dev-only and loopback-only, like the seed's. */
  readonly token: string;
}

/** The database a side's instance runs on, from the `plan.json` its runner recorded. */
export const sideDatabase = Effect.fn("Eval.sideDatabase")(function* (clone: string) {
  const path = yield* Path.Path;
  const plan = yield* readPlan(path.join(clone, ".local", "dev"));
  if (Option.isNone(plan)) return yield* new SideNotRunning({ clone });
  return plan.value.databaseUrl;
});

/** A side's database, for seeding and retiring runs: one pool for the suite. */
export const sideSql = (databaseUrl: string) => layerFromUrl(Redacted.make(databaseUrl));

/** Seeds a run's companies and people into its side's database. */
export const seedRun = Effect.fn("Eval.seedRun")(function* (scenario: Scenario, run: string) {
  const namespaced = namespaceScenario(scenario, run);
  yield* seedScenario(namespaced);
  const people = namespaced.people
    .filter((person) => person.company === undefined)
    .map(({ key, name, email, role }) => ({ key, name, email, role }));
  return {
    company: { name: namespaced.company.name, handle: namespaced.company.handle },
    people,
    publisher: people.find((person) => person.key === namespaced.publisher)!,
    token: publisherToken(namespaced)
  } satisfies RunIdentities;
});

/** Deactivates a graded run's people and revokes its publisher's token. */
export const retireRun = Effect.fn("Eval.retireRun")(function* (scenario: Scenario, run: string) {
  const sql = yield* SqlClient.SqlClient;
  const namespaced = namespaceScenario(scenario, run);
  const users = namespaced.people.map((person) => ids(namespaced, person).userId);
  yield* sql`UPDATE users SET deactivated_at = now() WHERE id IN ${sql.in(users)}`;
  yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id IN ${sql.in(users)}`;
});
