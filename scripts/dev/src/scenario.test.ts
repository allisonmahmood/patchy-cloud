import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect } from "vitest";
import * as Companies from "@patchy/companies/Companies";
import { Users } from "@patchy/companies";
import * as Testing from "@patchy/sql/testing";
import * as Mailbox from "./mailbox.js";
import { decodeMail } from "./pidgeon.js";
import {
  ids,
  liveConnections,
  loadScenario,
  publisherToken,
  seedScenario,
  sourceOf
} from "./scenario.js";
import { NodeCryptography } from "@patchy/core";

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const repo = new URL("../../..", import.meta.url).pathname;

it.layer(Platform)("scenarios", (it) => {
  it.effect("loads every committed scenario and finds each repo patch's source and its mail", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const name of [
        "team",
        "brightline",
        "dense",
        "pidgeon",
        "attio",
        "imap",
        "guests",
        "kit-room"
      ]) {
        const { dir, scenario } = yield* loadScenario(repo, name);
        for (const patch of scenario.patches) {
          const source =
            "repo" in patch
              ? path.join(sourceOf(path, dir, patch), "patchy.config.ts")
              : sourceOf(path, dir, patch);
          expect(yield* fs.exists(source), source).toBe(true);
        }
        for (const connection of liveConnections(scenario))
          if (connection.integration === "pidgeon" && connection.mail !== undefined) {
            const mail = yield* decodeMail(
              yield* fs.readFileString(path.join(dir, connection.mail))
            );
            const labels = new Set(mail.labels.map((label) => label.name));
            for (const thread of mail.threads) {
              expect(thread.messages[0].from).not.toBe("me");
              for (const label of thread.labels ?? []) expect(labels.has(label), label).toBe(true);
            }
          } else if (connection.integration === "imap" && connection.mail !== undefined)
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Mailbox.Mail))(
              yield* fs.readFileString(path.join(dir, connection.mail))
            );
      }
      const { scenario } = yield* loadScenario(repo, "brightline");
      expect(publisherToken(scenario)).toBe("patchy-env-brightline-allison");
    })
  );

  it.effect("names the available scenarios when one is missing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(loadScenario(repo, "nope"));
      expect(error._tag).toBe("ScenarioNotFound");
      expect(error.message).toContain("brightline, dense, guests, imap, kit-room, pidgeon, team");
    })
  );

  it.effect("refuses a publisher who is not a super admin", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, "scenarios", "bad"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "scenarios", "bad", "scenario.json"),
        `{"company":{"name":"Bad","handle":"bad"},"publisher":"m","patches":[],
          "people":[{"key":"m","name":"M","email":"m@bad.example","role":"member"}]}`
      );
      const error = yield* Effect.flip(loadScenario(root, "bad"));
      expect(error.message).toContain("the publisher must be a super admin");
    }).pipe(Effect.scoped)
  );

  for (const team of ["missing", "design"])
    it.effect(`refuses an invalid team audience: ${team}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(root, "scenarios", "teams"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "scenarios", "teams", "scenario.json"),
          `{"company":{"name":"Teams","handle":"teams"},"publisher":"a",
            "people":[{"key":"a","name":"A","email":"a@teams.example","role":"super_admin"}],
            "teams":[{"key":"design","name":"Design","members":[]}],
            "patches":[{"file":"note.html","name":"note","description":"Note","teams":["${team}"]}]}`
        );
        const error = yield* Effect.flip(loadScenario(root, "teams"));
        expect(error.message).toContain(team === "missing" ? "names a team" : "owner must belong");
      }).pipe(Effect.scoped)
    );
  it.effect("refuses a patch naming a connection the scenario doesn't make", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, "scenarios", "loose"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "scenarios", "loose", "scenario.json"),
        `{"company":{"name":"Loose","handle":"loose"},"publisher":"a",
          "people":[{"key":"a","name":"A","email":"a@loose.example","role":"super_admin"}],
          "patches":[{"repo":"desk","tier":1,"description":"Desk","connections":["pidgeon/support"]}]}`
      );
      const error = yield* Effect.flip(loadScenario(root, "loose"));
      expect(error.message).toContain("desk names pidgeon/support");
    }).pipe(Effect.scoped)
  );

  it.effect(
    "refuses a Postgres connection that needs attention, which Postgres has no reason for",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(root, "scenarios", "worried"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "scenarios", "worried", "scenario.json"),
          `{"company":{"name":"Worried","handle":"worried"},"publisher":"a","patches":[],
          "people":[{"key":"a","name":"A","email":"a@worried.example","role":"super_admin"}],
          "connections":[{"integration":"postgres","handle":"warehouse","description":"Data",
            "state":"needs-attention"}]}`
        );
        const error = yield* Effect.flip(loadScenario(root, "worried"));
        expect(error.message).toContain("postgres/warehouse has no reason");
      }).pipe(Effect.scoped)
  );

  it.effect("refuses a guest from the scenario's own company", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, "scenarios", "inside"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "scenarios", "inside", "scenario.json"),
        `{"company":{"name":"Inside","handle":"inside"},"publisher":"a",
          "people":[{"key":"a","name":"A","email":"a@inside.example","role":"super_admin"}],
          "patches":[{"repo":"desk","tier":1,"description":"Desk","guests":["a"]}]}`
      );
      const error = yield* Effect.flip(loadScenario(root, "inside"));
      expect(error.message).toContain("desk names guest a");
    }).pipe(Effect.scoped)
  );
});

const database = Testing.layer().pipe(Layer.provideMerge(NodeCryptography.layer));

it.layer(
  Layer.mergeAll(
    Platform,
    Layer.mergeAll(Companies.layer, Users.layer).pipe(Layer.provideMerge(database))
  )
)("seeding a scenario", (it) => {
  it.effect("turns brightline's agent access on as its publisher, once", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const { scenario } = yield* loadScenario(repo, "brightline");
      const companyId = `cmp_env_${scenario.company.handle}`;
      const publisher = ids(
        scenario,
        scenario.people.find((p) => p.key === scenario.publisher)!
      );
      yield* seedScenario(scenario);
      const seeded = yield* companies.agentAccess(companyId);
      expect(seeded.on).toBe(true);
      expect(seeded.latest?.by.id).toBe(publisher.userId);

      // Every start seeds again; an admin's switch in Settings stays.
      yield* companies.setAgentAccess({ companyId, on: false, by: publisher.userId });
      yield* seedScenario(scenario);
      expect((yield* companies.agentAccess(companyId)).on).toBe(false);
    })
  );

  it.effect("seeds a person at another company as theirs, not the publisher's", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const { scenario } = yield* loadScenario(repo, "guests");
      yield* seedScenario(scenario);
      const jo = ids(
        scenario,
        scenario.people.find((p) => p.key === "jo")!
      );
      expect((yield* users.findByClerkId(jo.clerkUserId))?.companyId).toBe("cmp_env_pine");
      expect((yield* users.list("cmp_env_harbor")).map((user) => user.id)).not.toContain(jo.userId);
    })
  );
});
