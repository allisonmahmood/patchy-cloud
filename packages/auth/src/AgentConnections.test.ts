import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";
import { sha256, NodeCryptography } from "@patchy/core";
import * as Testing from "@patchy/sql/testing";
import * as AgentConnections from "./AgentConnections.js";
import * as Authorization from "./Authorization.js";
import * as MachineTokens from "./MachineTokens.js";
import { DEV_SEED, mintDevAgentConnection } from "./seed.js";

// Agent connections run on the database's clock, so these tests move time by
// moving the stored stamps back, never with TestClock.
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";

/** A fresh member of the dev company, so one test's endings never reach another's. */
const person = (key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = `usr_agent_${key}`;
    yield* sql`
      INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES (${id}, ${`clerk_agent_${key}`}, ${DEV_SEED.companyId}, ${`${key}@agents.test`},
        ${`Agent ${key}`}, 'member')`;
    return id;
  });

const connect = (userId: string, clientName = "Claude") =>
  AgentConnections.AgentConnections.use((connections) =>
    connections.create({ userId, clientId: CLAUDE, clientName })
  );

const authenticate = (token: string) =>
  AgentConnections.AgentConnections.use((connections) => connections.authenticate(token));

const refresh = (token: string) =>
  AgentConnections.AgentConnections.use((connections) => connections.refresh(token));

const refused = (token: string) =>
  refresh(token).pipe(
    Effect.flip,
    Effect.map((error) => error.reason)
  );

const revokedAt = (id: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ at: Date | null }>`SELECT revoked_at AS at FROM agent_connections WHERE id = ${id}`
  ).pipe(Effect.map((rows) => rows[0]!.at));

const lastUsedAt = (id: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ at: Date | null }>`SELECT last_used_at AS at FROM agent_connections WHERE id = ${id}`
  ).pipe(Effect.map((rows) => rows[0]!.at));

/** Moves a refresh token's rotation `seconds` into the past. */
const ageRotation = (token: string, seconds: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      UPDATE agent_connection_refresh_tokens
      SET rotated_at = rotated_at - make_interval(secs => ${seconds})
      WHERE token_hash = ${sha256(token)}`
  );

const bearer = <P extends Authorization.Purpose>(purpose: P, token: string) =>
  Authorization.identify(purpose).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1/", { headers: { authorization: `Bearer ${token}` } })
      )
    )
  );

const layer = Layer.mergeAll(AgentConnections.layer, MachineTokens.layer).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provide(NodeCryptography.layer)
);

it.layer(layer)("AgentConnections", (it) => {
  it.effect(
    "an access token acts as its person through the connection, stored only as hashes",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const userId = yield* person("acts");
        const { connection, tokens } = yield* connect(userId, "Claude\u0007");
        assert.match(connection.id, /^agc_/);
        assert.deepStrictEqual(
          { clientName: connection.clientName, clientSite: connection.clientSite },
          { clientName: "Claude", clientSite: "claude.ai" }
        );
        assert.match(tokens.accessToken, /^pwa_[A-Za-z0-9_-]{43}$/);
        assert.match(tokens.refreshToken, /^pwr_[A-Za-z0-9_-]{43}$/);
        assert.strictEqual(tokens.expiresIn, 3600);

        assert.isNull(yield* lastUsedAt(connection.id), "a new connection has had no call");
        const identity = yield* authenticate(tokens.accessToken);
        assert.deepStrictEqual(identity, {
          user: { id: userId, email: "acts@agents.test", name: "Agent acts" },
          company: {
            id: DEV_SEED.companyId,
            handle: DEV_SEED.companyHandle,
            name: DEV_SEED.companyName
          },
          role: "member",
          agentConnection: { id: connection.id, clientName: "Claude", clientSite: "claude.ai" }
        });
        assert.isNotNull(yield* lastUsedAt(connection.id));

        const [stored] = yield* sql<{
          clientId: string;
          clientName: string;
          clientSite: string;
          accessHash: string;
          refreshHash: string;
          hourLong: boolean;
        }>`
        SELECT c.client_id AS "clientId", c.client_name AS "clientName",
          c.client_site AS "clientSite", a.token_hash AS "accessHash", r.token_hash AS "refreshHash",
          a.expires_at - c.created_at BETWEEN interval '1 hour' AND interval '1 hour 1 second'
            AS "hourLong"
        FROM agent_connections c
        JOIN agent_connection_access_tokens a ON a.connection_id = c.id
        JOIN agent_connection_refresh_tokens r ON r.connection_id = c.id
        WHERE c.id = ${connection.id}`;
        assert.deepStrictEqual(stored, {
          clientId: CLAUDE,
          clientName: "Claude",
          clientSite: "claude.ai",
          accessHash: sha256(tokens.accessToken),
          refreshHash: sha256(tokens.refreshToken),
          hourLong: true
        });
        assert.isNull(yield* authenticate("pwa_unknown"));
      })
  );

  it.effect("an access token passes for an hour and is refused after", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { tokens } = yield* connect(yield* person("hour"));
      const age = (minutes: number) => sql`
        UPDATE agent_connection_access_tokens SET expires_at = expires_at - make_interval(mins => ${minutes})
        WHERE token_hash = ${sha256(tokens.accessToken)}`;
      yield* age(59);
      assert.isNotNull(yield* authenticate(tokens.accessToken));
      yield* age(2);
      assert.isNull(yield* authenticate(tokens.accessToken));
    })
  );

  it("shows a client's name without control characters, cut to 64, or its document's host", () => {
    const name = (raw: string) => AgentConnections.clientName(raw, CLAUDE);
    assert.strictEqual(name("  Cl\u0000au\u202ede\r\n"), "Claude");
    assert.strictEqual(name("x".repeat(70)), "x".repeat(64));
    assert.strictEqual(name("🤖".repeat(70)), "🤖".repeat(64), "a character is a code point");
    assert.strictEqual(name("\u0007 \u200f\u2028 "), "claude.ai");
    assert.strictEqual(
      AgentConnections.clientName("", "https://ExAmple.com:8443/doc"),
      "example.com:8443"
    );
  });

  it.effect("a refresh rotates the chain, and a retry within the minute gets the same tokens", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { connection, tokens: first } = yield* connect(yield* person("rotate"));
      const second = yield* refresh(first.refreshToken);
      assert.notStrictEqual(second.accessToken, first.accessToken);
      assert.notStrictEqual(second.refreshToken, first.refreshToken);
      assert.strictEqual(second.expiresIn, 3600);

      const retried = yield* refresh(first.refreshToken);
      assert.deepStrictEqual(
        { accessToken: retried.accessToken, refreshToken: retried.refreshToken },
        { accessToken: second.accessToken, refreshToken: second.refreshToken }
      );
      assert.isAtLeast(retried.expiresIn, 3590);
      assert.isAtMost(retried.expiresIn, 3600);

      // Every access token lives its hour; the chain moves on.
      assert.isNotNull(yield* authenticate(first.accessToken));
      assert.isNotNull(yield* authenticate(second.accessToken));
      const third = yield* refresh(second.refreshToken);
      assert.isNotNull(yield* authenticate(third.accessToken));
      assert.isNull(yield* revokedAt(connection.id));

      // The minute's copies are encrypted, and the sweep drops each once its minute is up.
      const copies = () => sql<{ retry: string }>`
        SELECT retry FROM agent_connection_refresh_tokens
        WHERE connection_id = ${connection.id} AND retry IS NOT NULL`;
      const kept = yield* copies();
      assert.strictEqual(kept.length, 2);
      for (const { retry } of kept)
        for (const token of [second, third])
          for (const secret of [token.accessToken, token.refreshToken])
            assert.notInclude(retry, secret.slice(4));
      yield* ageRotation(first.refreshToken, 61);
      yield* AgentConnections.AgentConnections.use((connections) => connections.sweepRetries);
      assert.strictEqual((yield* copies()).length, 1, "the copy still in its minute stays");
      yield* ageRotation(second.refreshToken, 61);
      yield* AgentConnections.AgentConnections.use((connections) => connections.sweepRetries);
      assert.deepStrictEqual(yield* copies(), []);
    })
  );

  it.effect("refreshes racing on one token all get the same new tokens", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { connection, tokens } = yield* connect(yield* person("race"));
      const results = yield* Effect.all(
        Array.from({ length: 4 }, () => refresh(tokens.refreshToken)),
        { concurrency: "unbounded" }
      );
      assert.strictEqual(new Set(results.map((result) => result.refreshToken)).size, 1);
      assert.strictEqual(new Set(results.map((result) => result.accessToken)).size, 1);
      const chain = yield* sql<{ current: boolean }>`
        SELECT rotated_at IS NULL AS current FROM agent_connection_refresh_tokens
        WHERE connection_id = ${connection.id} ORDER BY current`;
      assert.deepStrictEqual(
        chain.map((row) => row.current),
        [false, true]
      );
    })
  );

  it.effect(
    "a refresh token reused after its minute ends the connection before it is refused",
    () =>
      Effect.gen(function* () {
        const userId = yield* person("reuse");
        const { connection, tokens: first } = yield* connect(userId);
        const second = yield* refresh(first.refreshToken);
        yield* ageRotation(first.refreshToken, 61);
        assert.strictEqual(yield* refused(first.refreshToken), "reused");
        assert.isNotNull(
          yield* revokedAt(connection.id),
          "the ending committed before the refusal"
        );
        assert.isNull(yield* authenticate(second.accessToken));
        assert.strictEqual(yield* refused(second.refreshToken), "ended");

        // A token several rotations back is reuse too, so a copier who rotated twice can't hide.
        const other = yield* connect(userId);
        const a = yield* refresh(other.tokens.refreshToken);
        const b = yield* refresh(a.refreshToken);
        yield* ageRotation(other.tokens.refreshToken, 61);
        assert.strictEqual(yield* refused(other.tokens.refreshToken), "reused");
        assert.isNull(yield* authenticate(b.accessToken));
      })
  );

  it.effect("a retry is served only after a revocation check", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* person("retry-check");
      const disconnected = yield* connect(userId);
      yield* refresh(disconnected.tokens.refreshToken);
      yield* sql`UPDATE agent_connections SET revoked_at = clock_timestamp()
        WHERE id = ${disconnected.connection.id}`;
      assert.strictEqual(yield* refused(disconnected.tokens.refreshToken), "ended");

      const deactivated = yield* connect(userId);
      yield* refresh(deactivated.tokens.refreshToken);
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${userId}`;
      assert.strictEqual(yield* refused(deactivated.tokens.refreshToken), "ended");
      assert.strictEqual(
        (yield* connect(userId).pipe(Effect.flip))._tag,
        "UserUnavailable",
        "a deactivated person gets no new connection"
      );
    })
  );

  it.effect("a connection ends after 30 days without a call, however often it refreshes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* person("idle");
      const { connection, tokens } = yield* connect(userId);
      yield* authenticate(tokens.accessToken);
      const idleFor = (interval: string) => sql`
        UPDATE agent_connections SET last_used_at = clock_timestamp() - ${interval}::interval
        WHERE id = ${connection.id}`;
      yield* idleFor("29 days");
      const before = yield* lastUsedAt(connection.id);
      const renewed = yield* refresh(tokens.refreshToken);
      assert.deepStrictEqual(yield* lastUsedAt(connection.id), before, "a refresh is not a call");
      yield* idleFor("30 days 1 minute");
      assert.isNull(yield* authenticate(renewed.accessToken));
      assert.strictEqual(yield* refused(renewed.refreshToken), "ended");

      // One never called counts from when it was connected.
      const unused = yield* connect(userId);
      yield* sql`UPDATE agent_connections SET created_at = clock_timestamp() - interval '30 days 1 minute'
        WHERE id = ${unused.connection.id}`;
      assert.isNull(yield* authenticate(unused.tokens.accessToken));
    })
  );

  it.effect("every call stamps last used; refreshes never do", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { connection, tokens } = yield* connect(yield* person("stamp"));
      const next = yield* refresh(tokens.refreshToken);
      assert.isNull(yield* lastUsedAt(connection.id));
      yield* authenticate(next.accessToken);
      assert.isNotNull(yield* lastUsedAt(connection.id));
      yield* sql`
        UPDATE agent_connections SET last_used_at = clock_timestamp() - interval '1 minute'
        WHERE id = ${connection.id}`;
      const aged = (yield* lastUsedAt(connection.id))!.getTime();
      yield* authenticate(next.accessToken);
      assert.isAbove((yield* lastUsedAt(connection.id))!.getTime(), aged + 59_000);
    })
  );

  it.effect(
    "a call's recheck reads who a live connection acts as now, without using it, and nothing once it ends",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const current = (id: string) =>
          AgentConnections.AgentConnections.use((connections) => connections.current(id));
        const userId = yield* person("recheck");
        const { connection, tokens } = yield* connect(userId);
        const identity = yield* authenticate(tokens.accessToken);
        const stamped = yield* lastUsedAt(connection.id);
        assert.deepStrictEqual(yield* current(connection.id), identity);
        assert.deepStrictEqual(yield* lastUsedAt(connection.id), stamped, "a recheck is no call");
        // A role change shows on the next recheck, and an expired access token ends nothing.
        yield* sql`UPDATE users SET role = 'admin' WHERE id = ${userId}`;
        yield* sql`UPDATE agent_connection_access_tokens SET expires_at = clock_timestamp()
          WHERE connection_id = ${connection.id}`;
        assert.strictEqual((yield* current(connection.id))?.role, "admin");

        for (const [key, end] of [
          [
            "disconnected",
            (id: string) =>
              sql`UPDATE agent_connections SET revoked_at = clock_timestamp() WHERE id = ${id}`
          ],
          [
            "deactivated",
            (id: string) => sql`UPDATE users SET deactivated_at = clock_timestamp()
              WHERE id = (SELECT user_id FROM agent_connections WHERE id = ${id})`
          ],
          [
            "idle",
            (id: string) => sql`UPDATE agent_connections
              SET last_used_at = clock_timestamp() - interval '30 days 1 minute' WHERE id = ${id}`
          ]
        ] as const) {
          const other = yield* connect(yield* person(`recheck-${key}`));
          assert.isNotNull(yield* current(other.connection.id), key);
          yield* end(other.connection.id);
          assert.isNull(yield* current(other.connection.id), key);
        }
        assert.isNull(yield* current("agc_unknown"));
      })
  );

  it.effect("a connection made at or before the person's credentials ended is dead", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* person("ended");
      const before = yield* connect(userId);
      yield* MachineTokens.MachineTokens.use((tokens) => tokens.revokeAll(userId));
      assert.isNull(yield* authenticate(before.tokens.accessToken));
      assert.strictEqual(yield* refused(before.tokens.refreshToken), "ended");

      const after = yield* connect(userId);
      assert.isNotNull(yield* authenticate(after.tokens.accessToken));
      yield* sql`UPDATE users SET credentials_ended_at =
          (SELECT created_at FROM agent_connections WHERE id = ${after.connection.id})
        WHERE id = ${userId}`;
      assert.isNull(yield* authenticate(after.tokens.accessToken), "at the stamp is dead too");
    })
  );

  it.effect("each purpose's bearer check refuses the other credential as unknown", () =>
    Effect.gen(function* () {
      const { connection, tokens } = yield* connect(yield* person("purpose"));
      assert.isTrue(Option.isNone(yield* bearer("build", tokens.accessToken)));
      assert.isNull(
        yield* MachineTokens.MachineTokens.use((t) => t.authenticate(tokens.accessToken))
      );
      assert.isTrue(Option.isNone(yield* bearer("work", DEV_SEED.token)));
      assert.isTrue(Option.isNone(yield* bearer("work", tokens.refreshToken)));
      assert.strictEqual(
        Option.getOrThrow(yield* bearer("work", tokens.accessToken)).agentConnection.id,
        connection.id
      );
      assert.strictEqual(
        Option.getOrThrow(yield* bearer("build", DEV_SEED.token)).machine.id,
        DEV_SEED.tokenId
      );
      // An access token is no refresh token, and trying it ends nothing.
      assert.strictEqual(yield* refused(tokens.accessToken), "unknown");
      assert.isNull(yield* revokedAt(connection.id));
    })
  );

  it.effect("lists a person's live connections, newest first, with when each ends on its own", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* person("list");
      const old = yield* connect(userId, "Claude Code");
      yield* authenticate(old.tokens.accessToken);
      yield* sql`
          UPDATE agent_connections SET created_at = clock_timestamp() - interval '20 days',
            last_used_at = clock_timestamp() - interval '10 days'
          WHERE id = ${old.connection.id}`;
      const idle = yield* connect(userId, "Idle");
      yield* sql`
          UPDATE agent_connections SET created_at = clock_timestamp() - interval '30 days 1 minute'
          WHERE id = ${idle.connection.id}`;
      const disconnected = yield* connect(userId, "Disconnected");
      yield* AgentConnections.AgentConnections.use((connections) =>
        connections.disconnect({ id: disconnected.connection.id, userId })
      );
      const fresh = yield* connect(userId, "Claude Code");
      yield* connect(yield* person("list_other"), "Someone else's");

      const listed = yield* AgentConnections.AgentConnections.use((connections) =>
        connections.list(userId)
      );
      assert.deepStrictEqual(
        listed.map(({ id, clientName, clientSite }) => ({ id, clientName, clientSite })),
        [
          { id: fresh.connection.id, clientName: "Claude Code", clientSite: "claude.ai" },
          { id: old.connection.id, clientName: "Claude Code", clientSite: "claude.ai" }
        ]
      );
      const [newest, oldest] = listed;
      assert.isNull(newest!.lastUsedAt, "never called");
      const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;
      // Calendar days in the database's time zone, as the connection's own ending counts them,
      // so a daylight saving change moves them by an hour.
      const hour = 1 / 24 + 1e-6;
      assert.closeTo(days(newest!.connectedAt, newest!.endsAt), 30, hour);
      assert.closeTo(days(oldest!.connectedAt, oldest!.lastUsedAt!), 10, hour);
      assert.closeTo(days(oldest!.lastUsedAt!, oldest!.endsAt), 30, hour);
    })
  );

  it.effect("a dev-minted connection's access token outlives the hour", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const minted = yield* mintDevAgentConnection({
        email: DEV_SEED.email,
        clientName: "Codex",
        clientId: "http://127.0.0.1:4100/dev/mcp-token"
      });
      const { clientName, clientSite } = minted.connection;
      assert.deepStrictEqual(
        { clientName, clientSite },
        { clientName: "Codex", clientSite: "127.0.0.1:4100" }
      );
      const [row] = yield* sql<{ yearLong: boolean }>`
        SELECT expires_at > clock_timestamp() + interval '364 days' AS "yearLong"
        FROM agent_connection_access_tokens WHERE token_hash = ${sha256(minted.token)}`;
      assert.isTrue(row!.yearLong);
      assert.strictEqual((yield* authenticate(minted.token))?.user.id, DEV_SEED.userId);
      assert.strictEqual(
        (yield* mintDevAgentConnection({
          email: "nobody@agents.test",
          clientName: "Codex",
          clientId: "http://127.0.0.1:4100/dev/mcp-token"
        }).pipe(Effect.flip))._tag,
        "UnknownPerson"
      );
    })
  );
});
