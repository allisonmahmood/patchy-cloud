/** Seed only this prototype's disposable database, through the real encrypted connection store. */
import { writeFile } from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { sha256 } from "@patchy/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Sql from "@patchy/sql";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { readPlan } from "../../../scripts/dev/src/state.js";
import { readCredentialKeys } from "../../../scripts/dev/src/developerEnv.js";
import * as ConnectionStore from "../src/ConnectionStore.js";
import * as SqlConnectionStore from "../src/SqlConnectionStore.js";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as PostgresSource from "../src/postgres/Source.js";
import * as PostHogSource from "../src/posthog/Source.js";
import * as LocalSource from "./localSource.js";
import { customers } from "./customers.js";

const root = new URL("../../../", import.meta.url).pathname;
const plan = await Effect.runPromise(
  readPlan(`${root}.local/dev`).pipe(
    Effect.map(Option.getOrThrow),
    Effect.provide(NodeServices.layer)
  )
);
if (new URL(plan.apiUrl).hostname !== "127.0.0.1" || plan.worktree !== root.replace(/\/$/, ""))
  throw new Error("Refusing a nonlocal prototype seed");
const keyring = await Effect.runPromise(
  readCredentialKeys(`${plan.stateDir}/dev.env`).pipe(Effect.provide(NodeServices.layer))
);
const services = SqlConnectionStore.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      CredentialKeys.layerFromKeys(keyring),
      PostgresSource.layer,
      LocalSource.layer,
      RuntimeLog.layer
    )
  ),
  Layer.provideMerge(Sql.layerFromUrl(Redacted.make(plan.databaseUrl)))
);

const seeded = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ConnectionStore.ConnectionStore;
    const result = [];
    for (const customer of customers) {
      yield* sql`INSERT INTO companies (id, handle, name) VALUES (${customer.companyId}, ${customer.handle}, ${customer.name}) ON CONFLICT (id) DO NOTHING`;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES (${customer.userId}, ${`dev_${customer.handle}`}, ${customer.companyId}, ${customer.email}, ${customer.name}, 'admin') ON CONFLICT (id) DO NOTHING`;
      yield* sql`INSERT INTO machine_tokens (id, user_id, name, token_hash, expires_at, last_used_at)
      VALUES (${`tok_${customer.handle}`}, ${customer.userId}, 'Activepieces local demo', ${sha256(`local-machine-${customer.handle}`)}, now() + interval '90 days', now()) ON CONFLICT (id) DO NOTHING`;
      const found = (yield* store.list(customer.companyId)).find(
        (item) => item.integration === "posthog" && item.handle === "analytics"
      );
      const connection =
        found ??
        (yield* store.connect({
          integration: "posthog",
          companyId: customer.companyId,
          userId: customer.userId,
          handle: "analytics",
          description: "SIMULATED PostHog — Activepieces local prototype",
          credentials: PostHogSource.credentials({
            region: "us",
            projectId: customer.projectId,
            apiKey: customer.key
          })
        }));
      result.push({
        handle: customer.handle,
        email: customer.email,
        connectionId: connection.id,
        projectId: customer.projectId
      });
    }
    return result;
  }).pipe(Effect.scoped, Effect.provide(services))
);
await writeFile(`${plan.stateDir}/activepieces-customers.json`, JSON.stringify(seeded, null, 2));
