/**
 * The endings table in `docs/product.md` › Connecting an agent, a test per row: each ending ends
 * what its row says, and the next call sees it. The consent rows join with consent, and agent
 * access off, which ends nothing, is the door's.
 *
 * Agent connections run on the database's clock, so time moves by moving stored stamps back.
 */
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { Users } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { sha256 } from "../../../test/crypto.js";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AgentConnections from "./AgentConnections.js";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import { DEV_SEED } from "./seed.js";

const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";

const layer = DeviceLogins.layer.pipe(
  Layer.provide(Limits.layer),
  Layer.provideMerge(Layer.mergeAll(AgentConnections.layer, MachineTokens.layer, Users.layer)),
  Layer.provideMerge(Layer.merge(Testing.layer(), Analytics.layerNoop)),
  Layer.provideMerge(NodeCryptography.layer)
);

/** A fresh person in the dev company, so one row's endings never reach another's. */
const person = (key: string, role: "member" | "admin" = "member") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = `usr_ending_${key}`;
    yield* sql`
      INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES (${id}, ${`clerk_ending_${key}`}, ${DEV_SEED.companyId}, ${`${key}@endings.test`},
        ${`Ending ${key}`}, ${role})`;
    return id;
  });

const ref = (userId: string) => ({ companyId: DEV_SEED.companyId, userId });

const connect = (userId: string) =>
  AgentConnections.AgentConnections.use((connections) =>
    connections.create({ userId, clientId: CLAUDE, clientName: "Claude" })
  );

const refresh = (token: string) =>
  AgentConnections.AgentConnections.use((connections) => connections.refresh(token));

/** Whether the connection behind these tokens still works: its next call, then its refresh. */
const works = (tokens: AgentConnections.Tokens) =>
  Effect.gen(function* () {
    const connections = yield* AgentConnections.AgentConnections;
    const call = yield* connections.authenticate(tokens.accessToken);
    const renewed = yield* connections.refresh(tokens.refreshToken).pipe(
      Effect.map(() => "renewed" as const),
      Effect.catchTags({ RefreshRefused: (refused) => Effect.succeed(refused.reason) })
    );
    return { call: call !== null, renewed };
  });

const ended = { call: false, renewed: "ended" } as const;
const live = { call: true, renewed: "renewed" } as const;

/** Everything else the person holds: a machine token and a device login approved, not collected. */
const otherCredentials = (userId: string) =>
  Effect.gen(function* () {
    const tokens = yield* MachineTokens.MachineTokens;
    const logins = yield* DeviceLogins.DeviceLogins;
    const machine = yield* tokens.mint({ userId, name: "Laptop" });
    const login = yield* logins.start({ machineNameHint: "server" });
    yield* logins.confirm({ userCode: login.userCode, userId, machineName: "Server" });
    return {
      /** Whether the machine token still works and the device login would still mint. */
      work: Effect.gen(function* () {
        const machineWorks = (yield* tokens.authenticate(machine.token)) !== null;
        const minted = yield* logins.poll(login.deviceCode).pipe(
          Effect.map((result) => result.status === "complete"),
          Effect.catchTags({ DeviceLoginUnknown: () => Effect.succeed(false) })
        );
        return { machine: machineWorks, deviceLogin: minted };
      })
    };
  });

// Waits until `count` sessions on this test's database wait on a lock.
const lockWaits = (count: number) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`.pipe(
      Effect.repeat({ until: (rows) => rows.length === count })
    )
  );
// Bounds one wait in a race. It fails naming the wait when one of `fibers` ends first, or after
// three real seconds, instead of hanging until the test's own timeout.
const within = <A, E, R>(
  name: string,
  wait: Effect.Effect<A, E, R>,
  ...fibers: ReadonlyArray<Fiber.Fiber<unknown, unknown>>
) =>
  Effect.raceAllFirst([
    wait,
    TestClock.withLive(Effect.sleep("3 seconds")).pipe(
      Effect.map(() => assert.fail(`${name}: still waiting after three seconds`))
    ),
    ...fibers.map((fiber) =>
      Fiber.await(fiber).pipe(Effect.map((exit) => assert.fail(`${name}: ended first: ${exit}`)))
    )
  ]);
// Runs `change` in a transaction left open, holding its row locks, until `release` commits it.
const hold = Effect.fn("hold")(function* <A, E, R>(name: string, change: Effect.Effect<A, E, R>) {
  const sql = yield* SqlClient.SqlClient;
  const ran = yield* Deferred.make<void>();
  const commit = yield* Deferred.make<void>();
  const fiber = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const result = yield* change;
        yield* Deferred.succeed(ran, undefined);
        yield* Deferred.await(commit);
        return result;
      })
    )
    .pipe(Effect.forkScoped);
  yield* within(name, Deferred.await(ran), fiber);
  return {
    fiber,
    release: Deferred.succeed(commit, undefined).pipe(
      Effect.andThen(within(`${name}: commit`, Fiber.join(fiber)))
    )
  };
});

it.layer(layer)("Every way a person's credentials end", (it) => {
  it.effect("disconnecting one agent ends that connection only, and nobody else can", () =>
    Effect.gen(function* () {
      const connections = yield* AgentConnections.AgentConnections;
      const userId = yield* person("disconnect");
      const admin = yield* person("disconnect-admin", "admin");
      const disconnected = yield* connect(userId);
      const kept = yield* connect(userId);
      // Rotated just now, so a retry of the old token is within its minute.
      const rotated = yield* refresh(disconnected.tokens.refreshToken);

      // An admin can't aim at one person's agent: another person's id is not found.
      const foreign = yield* connections
        .disconnect({ id: disconnected.connection.id, userId: admin })
        .pipe(Effect.flip);
      assert.strictEqual(foreign._tag, "AgentConnectionNotFound");
      assert.deepStrictEqual(yield* works(rotated), live);

      yield* connections.disconnect({ id: disconnected.connection.id, userId });
      assert.deepStrictEqual(yield* works(rotated), ended);
      assert.deepStrictEqual(
        yield* works(disconnected.tokens),
        ended,
        "the minute's retry is refused too"
      );
      assert.deepStrictEqual(yield* works(kept.tokens), live);
      // Disconnecting it again keeps when it first ended.
      const sql = yield* SqlClient.SqlClient;
      const revokedAt = sql<{ at: Date }>`
        SELECT revoked_at AS at FROM agent_connections WHERE id = ${disconnected.connection.id}`;
      const [first] = yield* revokedAt;
      yield* connections.disconnect({ id: disconnected.connection.id, userId });
      assert.deepStrictEqual(yield* revokedAt, [first!]);
    })
  );

  it.effect(
    "Disconnect everything ends every machine token, agent connection and approval not yet collected",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const tokens = yield* MachineTokens.MachineTokens;
        const userId = yield* person("everything");
        const first = yield* connect(userId);
        const second = yield* connect(userId);
        const others = yield* otherCredentials(userId);
        yield* tokens.revokeAll(userId);
        assert.deepStrictEqual(yield* works(first.tokens), ended);
        assert.deepStrictEqual(yield* works(second.tokens), ended);
        assert.deepStrictEqual(yield* others.work, { machine: false, deviceLogin: false });

        // It needs no machine token to end an agent connection.
        const agentOnly = yield* person("everything-agent-only");
        const connection = yield* connect(agentOnly);
        yield* tokens.revokeAll(agentOnly);
        assert.deepStrictEqual(yield* works(connection.tokens), ended);
        // It is no ban: connecting again works.
        assert.deepStrictEqual(yield* works((yield* connect(agentOnly)).tokens), live);
      })
  );

  it.effect("30 days without a call ends that connection only", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* person("idle");
      const idle = yield* connect(userId);
      const kept = yield* connect(userId);
      yield* sql`
        UPDATE agent_connections SET created_at = clock_timestamp() - interval '30 days 1 minute'
        WHERE id = ${idle.connection.id}`;
      assert.deepStrictEqual(yield* works(idle.tokens), ended);
      assert.deepStrictEqual(yield* works(kept.tokens), live);
    })
  );

  it.effect("a refresh token reused after its minute ends that connection only", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* person("reused");
      const reused = yield* connect(userId);
      const kept = yield* connect(userId);
      const rotated = yield* refresh(reused.tokens.refreshToken);
      yield* sql`
        UPDATE agent_connection_refresh_tokens SET rotated_at = rotated_at - interval '61 seconds'
        WHERE token_hash = ${sha256(reused.tokens.refreshToken)}`;
      assert.deepStrictEqual(yield* works(reused.tokens), { call: true, renewed: "reused" });
      assert.deepStrictEqual(yield* works(rotated), ended);
      assert.deepStrictEqual(yield* works(kept.tokens), live);
    })
  );

  it.effect(
    "deactivation ends every credential and pending approval, and refuses a new connection",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const users = yield* Users.Users;
        const userId = yield* person("deactivated");
        const connection = yield* connect(userId);
        const others = yield* otherCredentials(userId);
        yield* users.deactivate(ref(userId));
        assert.deepStrictEqual(yield* works(connection.tokens), ended);
        assert.deepStrictEqual(yield* others.work, { machine: false, deviceLogin: false });
        assert.strictEqual((yield* connect(userId).pipe(Effect.flip))._tag, "UserUnavailable");
      })
  );

  it.effect("reactivation brings nothing back, and a fresh connection works", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const users = yield* Users.Users;
      const userId = yield* person("reactivated");
      const connection = yield* connect(userId);
      const others = yield* otherCredentials(userId);
      yield* users.deactivate(ref(userId));
      yield* users.reactivate(ref(userId));
      assert.deepStrictEqual(yield* works(connection.tokens), ended);
      assert.deepStrictEqual(yield* others.work, { machine: false, deviceLogin: false });
      assert.deepStrictEqual(yield* works((yield* connect(userId)).tokens), live);
    })
  );

  it.effect(
    "a connection made racing a deactivation never outlives it, whichever commits first",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const users = yield* Users.Users;

        // The deactivation commits first: the exchange waits on the person's row, then is refused,
        // so reactivation finds nothing to bring back.
        const late = yield* person("race-late");
        const deactivation = yield* hold("the deactivation", users.deactivate(ref(late)));
        const exchange = yield* connect(late).pipe(Effect.flip, Effect.forkScoped);
        yield* within("the exchange waiting", lockWaits(1), deactivation.fiber, exchange);
        yield* deactivation.release;
        assert.strictEqual(
          (yield* within("the exchange", Fiber.join(exchange)))._tag,
          "UserUnavailable"
        );
        yield* users.reactivate(ref(late));
        assert.deepStrictEqual(
          yield* sql`SELECT id FROM agent_connections WHERE user_id = ${late}`,
          []
        );

        // The exchange commits first: the deactivation waits, then its stamp ends the connection.
        const early = yield* person("race-early");
        const held = yield* hold("the exchange", connect(early));
        const ending = yield* users.deactivate(ref(early)).pipe(Effect.forkScoped);
        yield* within("the deactivation waiting", lockWaits(1), held.fiber, ending);
        const made = yield* held.release;
        yield* within("the deactivation", Fiber.join(ending));
        yield* users.reactivate(ref(early));
        assert.deepStrictEqual(yield* works(made.tokens), ended);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a refresh racing Disconnect everything leaves nothing live, whichever commits first",
    () =>
      Effect.gen(function* () {
        const tokens = yield* MachineTokens.MachineTokens;

        // The ending commits first: the refresh waits on the person's row, then is refused.
        const late = yield* person("refresh-late");
        const lateConnection = yield* connect(late);
        const ending = yield* hold("Disconnect everything", tokens.revokeAll(late));
        const renewing = yield* refresh(lateConnection.tokens.refreshToken).pipe(
          Effect.flip,
          Effect.forkScoped
        );
        yield* within("the refresh waiting", lockWaits(1), ending.fiber, renewing);
        yield* ending.release;
        assert.strictEqual((yield* within("the refresh", Fiber.join(renewing))).reason, "ended");

        // The refresh commits first: what it issued ends with the connection.
        const early = yield* person("refresh-early");
        const earlyConnection = yield* connect(early);
        const held = yield* hold("the refresh", refresh(earlyConnection.tokens.refreshToken));
        const disconnecting = yield* tokens.revokeAll(early).pipe(Effect.forkScoped);
        yield* within("Disconnect everything waiting", lockWaits(1), held.fiber, disconnecting);
        const renewed = yield* held.release;
        yield* within("Disconnect everything", Fiber.join(disconnecting));
        assert.deepStrictEqual(yield* works(renewed), ended);
      }).pipe(Effect.scoped)
  );
});
