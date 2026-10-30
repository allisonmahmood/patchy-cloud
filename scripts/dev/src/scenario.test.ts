import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect } from "vitest";
import * as Companies from "@patchy/companies/Companies";
import { Users } from "@patchy/companies";
import * as Testing from "@patchy/sql/testing";
import { decodeMail } from "./pidgeon.js";
import { ids, loadScenario, publisherToken, seedScenario } from "./scenario.js";
import { NodeCryptography } from "@patchy/core";

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const repo = new URL("../../..", import.meta.url).pathname;

it.layer(Platform)("scenarios", (it) => {
  it.effect("loads every committed scenario and finds each repo patch's source and its mail", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const name of ["team", "brightline", "pidgeon", "attio", "guests"]) {
        const { dir, scenario } = yield* loadScenario(repo, name);
        for (const patch of scenario.patches) {
          const source =
            "repo" in patch
              ? path.join(dir, "patches", patch.repo, "patchy.config.ts")
              : path.join(dir, "files", patch.file);
          expect(yield* fs.exists(source), source).toBe(true);
        }
        for (const connection of scenario.connections ?? [])
          if (connection.integration === "pidgeon" && connection.mail !== undefined) {
            const mail = yield* decodeMail(
              yield* fs.readFileString(path.join(dir, connection.mail))
            );
            const labels = new Set(mail.labels.map((label) => label.name));
            for (const thread of mail.threads) {
              expect(thread.messages[0].from).not.toBe("me");
              for (const label of thread.labels ?? []) expect(labels.has(label), label).toBe(true);
            }
          }
      }
      const { scenario } = yield* loadScenario(repo, "brightline");
      expect(publisherToken(scenario)).toBe("patchy-env-brightline-allison");
    })
  );

  it.effect("names the available scenarios when one is missing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(loadScenario(repo, "nope"));
      expect(error._tag).toBe("ScenarioNotFound");
      expect(error.message).toContain("brightline, guests, pidgeon, team");
    })
  );

  it.effect("refuses a publisher who is not an admin", () =>
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
      expect(error.message).toContain("the publisher must be an admin");
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
          "people":[{"key":"a","name":"A","email":"a@loose.example","role":"admin"}],
          "patches":[{"repo":"desk","tier":1,"description":"Desk","connections":["pidgeon/support"]}]}`
      );
      const error = yield* Effect.flip(loadScenario(root, "loose"));
      expect(error.message).toContain("desk names pidgeon/support");
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

      // Every start seeds again; an admin's switch at Company stays.
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
