/**
 * Consent from request to agent connection: the request's rules, approval and denial, the code
 * exchange, and each race the spec serializes, against agent access, Disconnect everything and
 * deactivation. Codes run on the database's clock, so time moves by moving stored stamps back.
 */
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { Companies, Users } from "@patchy/companies";
import { randomToken, sha256, NodeCryptography } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AgentConnections from "./AgentConnections.js";
import * as ClientDocuments from "./ClientDocuments.js";
import * as Consents from "./Consents.js";
import * as MachineTokens from "./MachineTokens.js";
import { clientDocumentFixtures, layerClientDocumentNetwork } from "./testing.js";

const BASE = "https://patchy.example";
const AGENT = "https://agent.example/client.json";
const CALLBACK = "https://agent.example/callback";
const OTHER = "https://other.example/client.json";
const documents = [
  {
    url: AGENT,
    body: JSON.stringify({
      client_id: AGENT,
      client_name: "Agent",
      redirect_uris: [CALLBACK, "http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none"
    })
  },
  {
    url: OTHER,
    body: JSON.stringify({
      client_id: OTHER,
      client_name: "Other",
      redirect_uris: ["https://other.example/callback"],
      token_endpoint_auth_method: "none"
    })
  },
  clientDocumentFixtures.claudeCode
];

/** The client ids each check loaded, so a test can say when one fetched nothing. */
const seen: Array<string> = [];
const loads = Layer.effect(
  ClientDocuments.ClientDocuments,
  Effect.gen(function* () {
    const loader = yield* ClientDocuments.make;
    return ClientDocuments.ClientDocuments.of({
      load: (clientId) =>
        Effect.sync(() => void seen.push(clientId)).pipe(Effect.andThen(loader.load(clientId)))
    });
  })
).pipe(Layer.provide([layerClientDocumentNetwork(documents), Limits.layer]));

const layer = Consents.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(AgentConnections.layer, MachineTokens.layer, Users.layer, Companies.layer)
  ),
  Layer.provide(loads),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_PUBLIC_BASE_URL: BASE }))),
  Layer.provide(NodeCryptography.layer)
);

/** A PKCE pair: the verifier a client keeps and the S256 challenge it sends. */
const pkce = () => {
  const verifier = randomToken(32);
  return { verifier, challenge: Buffer.from(sha256(verifier), "hex").toString("base64url") };
};

/** An authorization request with `fields` over a valid one from AGENT. */
const request = (challenge: string, fields: Record<string, string | undefined> = {}) =>
  new URLSearchParams(
    Object.entries({
      response_type: "code",
      client_id: AGENT,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "opaque-state",
      resource: `${BASE}/mcp`,
      ...fields
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );

/** A fresh company with agent access on, and its admin. */
const company = (key: string) =>
  Effect.gen(function* () {
    const companies = yield* Companies.Companies;
    const created = yield* companies.create({
      handle: `consent-${key}`,
      name: `Consent ${key}`,
      clerkUserId: `clerk_consent_${key}`,
      email: `${key}@consent.test`,
      userName: `Admin ${key}`
    });
    yield* companies.setAgentAccess({
      companyId: created.company.id,
      on: true,
      by: created.user.id
    });
    return { companyId: created.company.id, userId: created.user.id };
  });

const access = (person: { readonly companyId: string; readonly userId: string }, on: boolean) =>
  Companies.Companies.use((companies) =>
    companies.setAgentAccess({ companyId: person.companyId, on, by: person.userId })
  );

/** A person's approval of a valid request: the code and the PKCE pair it was bound to. */
const approved = (person: { readonly companyId: string; readonly userId: string }) =>
  Effect.gen(function* () {
    const consents = yield* Consents.Consents;
    const pair = pkce();
    const checked = yield* consents.check(request(pair.challenge));
    const answer = new URL(yield* consents.approve({ request: checked, ...person }));
    return { code: answer.searchParams.get("code")!, answer, ...pair };
  });

const exchange = (
  code: { readonly code: string; readonly verifier: string },
  fields: Partial<Parameters<Consents.Consents["Service"]["exchange"]>[0]> = {}
) =>
  Consents.Consents.use((consents) =>
    consents.exchange({ code: code.code, codeVerifier: code.verifier, clientId: AGENT, ...fields })
  );

const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Consents.CodeRefused ? error.reason : error))
  );

/** Whether a connection's access token still passes the `work` check. */
const works = (connected: AgentConnections.Connected) =>
  AgentConnections.AgentConnections.use((connections) =>
    connections.authenticate(connected.tokens.accessToken)
  ).pipe(Effect.map((identity) => identity !== null));

const codes = (userId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM agent_consents WHERE user_id = ${userId}`
  ).pipe(Effect.map((rows) => rows[0]!.n));

// Waits until `count` sessions on this test's database wait on a lock.
const lockWaits = (count: number) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`.pipe(
      Effect.repeat({ until: (rows) => rows.length === count })
    )
  );
// Bounds one wait in a race, failing when one of `fibers` ends first or after three real seconds.
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
/** `effect` started while `held` holds its locks, once it waits on one. */
const waiting = Effect.fn("waiting")(function* <A, E, R>(
  name: string,
  held: { readonly fiber: Fiber.Fiber<unknown, unknown> },
  effect: Effect.Effect<A, E, R>
) {
  const fiber = yield* Effect.forkScoped(Effect.result(effect));
  yield* within(`${name} waiting`, lockWaits(1), held.fiber, fiber);
  return fiber;
});

it.layer(layer)("Consent", (it) => {
  it.effect("holds a request to every rule, fetching the document only for a sound request", () =>
    Effect.gen(function* () {
      const consents = yield* Consents.Consents;
      const { challenge } = pkce();
      const refused = (params: URLSearchParams) =>
        consents.check(params).pipe(
          Effect.flip,
          Effect.map((error) =>
            error._tag === "AuthorizeRequestRefused" ? error.parameter : error._tag
          )
        );
      seen.length = 0;
      const doubled = request(challenge);
      doubled.append("redirect_uri", "https://evil.example/");
      assert.strictEqual(yield* refused(doubled), "redirect_uri");
      assert.strictEqual(
        yield* refused(request(challenge, { response_type: "token" })),
        "response_type"
      );
      // A PKCE downgrade: no method, plain, or no challenge at all.
      for (const [fields, parameter] of [
        [{ code_challenge_method: undefined }, "code_challenge_method"],
        [{ code_challenge_method: "plain" }, "code_challenge_method"],
        [{ code_challenge: undefined }, "code_challenge"],
        [{ code_challenge: "short" }, "code_challenge"]
      ] as const)
        assert.strictEqual(yield* refused(request(challenge, fields)), parameter);
      for (const resource of [`${BASE}/api`, "https://other.example/mcp", `${BASE}/mcp?x=1`])
        assert.strictEqual(yield* refused(request(challenge, { resource })), "resource");
      assert.deepStrictEqual(
        seen,
        [],
        "nothing is fetched for a request that breaks its own rules"
      );

      assert.strictEqual(
        yield* refused(request(challenge, { client_id: "http://agent.example/client.json" })),
        "ClientDocumentRefused"
      );
      assert.strictEqual(
        yield* refused(request(challenge, { client_id: "https://agent.example/missing.json" })),
        "ClientDocumentUnavailable"
      );
      for (const redirect_uri of [
        undefined,
        "https://agent.example/elsewhere",
        "https://other.example/callback",
        "http://127.0.0.1:4000/elsewhere"
      ])
        assert.strictEqual(yield* refused(request(challenge, { redirect_uri })), "redirect_uri");

      const checked = yield* consents.check(
        request(challenge, {
          redirect_uri: "http://127.0.0.1:53682/callback",
          resource: `${BASE}/mcp/`,
          scope: "patches offline_access"
        })
      );
      assert.deepStrictEqual(
        { ...checked, client: checked.client.name },
        {
          client: "Agent",
          redirectUri: "http://127.0.0.1:53682/callback",
          codeChallenge: challenge,
          state: "opaque-state"
        }
      );
      // No resource names the door by default; it is Patchy's only one.
      yield* consents.check(request(challenge, { resource: undefined }));
    })
  );

  it.effect("approval records only a code; its answer carries the code, state and issuer", () =>
    Effect.gen(function* () {
      const consents = yield* Consents.Consents;
      const person = yield* company("approve");
      const { challenge } = pkce();
      const checked = yield* consents.check(request(challenge));

      const denied = new URL(consents.deny(checked));
      assert.strictEqual(`${denied.origin}${denied.pathname}`, CALLBACK);
      assert.deepStrictEqual([...denied.searchParams.keys()].sort(), [
        "error",
        "error_description",
        "iss",
        "state"
      ]);
      assert.strictEqual(denied.searchParams.get("error"), "access_denied");
      assert.strictEqual(denied.searchParams.get("iss"), BASE);
      assert.strictEqual(yield* codes(person.userId), 0, "a denial records nothing");

      const answer = new URL(yield* consents.approve({ request: checked, ...person }));
      assert.strictEqual(`${answer.origin}${answer.pathname}`, CALLBACK);
      assert.deepStrictEqual([...answer.searchParams.keys()].sort(), ["code", "iss", "state"]);
      assert.strictEqual(answer.searchParams.get("state"), "opaque-state");
      assert.strictEqual(answer.searchParams.get("iss"), BASE);
      assert.match(answer.searchParams.get("code")!, /^pwc_[\w-]{43}$/);
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT code_hash AS "codeHash", connection_id AS "connectionId"
          FROM agent_consents WHERE user_id = ${person.userId}`,
        [{ codeHash: sha256(answer.searchParams.get("code")!), connectionId: null }]
      );

      // An approval is for the account the page showed, in its own company only.
      const elsewhere = yield* company("approve-elsewhere");
      const crossed = yield* consents
        .approve({ request: checked, userId: person.userId, companyId: elsewhere.companyId })
        .pipe(Effect.flip);
      assert.strictEqual(crossed._tag, "UserUnavailable");
    })
  );

  it.effect("the exchange connects the code's client as its person, once", () =>
    Effect.gen(function* () {
      const connections = yield* AgentConnections.AgentConnections;
      const person = yield* company("exchange");
      const code = yield* approved(person);
      const connected = yield* exchange(code, { redirectUri: CALLBACK, resource: `${BASE}/mcp` });
      assert.deepStrictEqual(connected.connection.clientName, "Agent");
      const identity = yield* connections.authenticate(connected.tokens.accessToken);
      assert.strictEqual(identity?.user.id, person.userId);
      assert.strictEqual(identity?.company.id, person.companyId);

      // A replay ends the connection the code made, committed before it is refused.
      assert.strictEqual(yield* refusal(exchange(code)), "replayed");
      assert.isFalse(yield* works(connected));
      assert.strictEqual(yield* refusal(exchange(code, { codeVerifier: "x" })), "replayed");
    })
  );

  it.effect("a replay long after the code expired still ends the connection it made", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const person = yield* company("late-replay");
      const code = yield* approved(person);
      const connected = yield* exchange(code);
      const abandoned = yield* approved(person);
      yield* sql`
        UPDATE agent_consents SET expires_at = clock_timestamp() - interval '1 day'
        WHERE user_id = ${person.userId}`;
      // The next approval sweeps expired codes: the abandoned one goes, the exchanged one stays.
      yield* approved(person);
      assert.strictEqual(yield* refusal(exchange(abandoned)), "unknown");
      assert.isTrue(yield* works(connected));
      assert.strictEqual(yield* refusal(exchange(code)), "replayed");
      assert.isFalse(yield* works(connected));
    })
  );

  it.effect("a refused exchange leaves its code to the request it was approved for", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const person = yield* company("refused");
      const code = yield* approved(person);
      assert.strictEqual(yield* refusal(exchange({ ...code, code: "pwc_unknown" })), "unknown");
      assert.strictEqual(
        yield* refusal(exchange(code, { codeVerifier: pkce().verifier })),
        "verifier"
      );
      assert.strictEqual(
        yield* refusal(exchange(code, { codeVerifier: code.challenge })),
        "verifier"
      );
      assert.strictEqual(yield* refusal(exchange(code, { clientId: OTHER })), "client");
      assert.strictEqual(
        yield* refusal(exchange(code, { redirectUri: "http://127.0.0.1/callback" })),
        "redirect_uri"
      );
      const target = yield* exchange(code, { resource: `${BASE}/api` }).pipe(Effect.flip);
      assert.strictEqual(target._tag, "ResourceRefused");
      // None of those spent it: the request it was approved for still exchanges it.
      const connected = yield* exchange(code);
      assert.isTrue(yield* works(connected));

      // A minute on, it has expired.
      const late = yield* approved(person);
      yield* sql`
        UPDATE agent_consents SET expires_at = clock_timestamp() - interval '1 second'
        WHERE code_hash = ${sha256(late.code)}`;
      assert.strictEqual(yield* refusal(exchange(late)), "expired");
    })
  );

  it.effect("a code exchanges only as the person who approved it, with their own verifier", () =>
    Effect.gen(function* () {
      const connections = yield* AgentConnections.AgentConnections;
      const first = yield* company("inject-first");
      const second = yield* company("inject-second");
      const mine = yield* approved(first);
      const theirs = yield* approved(second);
      // Another account's code under this client's verifier, and the other way round.
      assert.strictEqual(
        yield* refusal(exchange({ code: theirs.code, verifier: mine.verifier })),
        "verifier"
      );
      assert.strictEqual(
        yield* refusal(exchange({ code: mine.code, verifier: theirs.verifier })),
        "verifier"
      );
      const connected = yield* exchange(theirs);
      assert.strictEqual(
        (yield* connections.authenticate(connected.tokens.accessToken))?.user.id,
        second.userId
      );
    })
  );

  it.effect(
    "with agent access off nothing is issued, and off cancels codes not yet exchanged",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const consents = yield* Consents.Consents;
        const person = yield* company("off");
        const pending = yield* approved(person);
        const exchanged = yield* approved(person);
        const connected = yield* exchange(exchanged);

        yield* access(person, false);
        const { challenge } = pkce();
        const checked = yield* consents.check(request(challenge));
        const off = yield* consents.approve({ request: checked, ...person }).pipe(Effect.flip);
        assert.strictEqual(off._tag, "AgentAccessOff");
        // On again, the code approved before the off is still cancelled; the connection stands.
        yield* access(person, true);
        assert.strictEqual(yield* refusal(exchange(pending)), "unknown");
        assert.isTrue(yield* works(connected));
        assert.strictEqual(yield* codes(person.userId), 1, "only the exchanged code is kept");

        // A code that somehow outlived an off is still refused while access is off.
        const survivor = yield* approved(person);
        yield* sql`UPDATE companies SET agent_access_on = false WHERE id = ${person.companyId}`;
        assert.strictEqual(yield* refusal(exchange(survivor)), "agent_access_off");
      })
  );

  it.effect("a code made at or before the person's credentials ended is dead", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const tokens = yield* MachineTokens.MachineTokens;
      const users = yield* Users.Users;
      const person = yield* company("stamp");
      const everything = yield* approved(person);
      yield* tokens.revokeAll(person.userId);
      assert.strictEqual(yield* refusal(exchange(everything)), "ended");
      // Approved after the ending, it works.
      assert.isTrue(yield* works(yield* exchange(yield* approved(person))));

      const member = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const id = "usr_consent_member";
        yield* sql`
          INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
          VALUES (${id}, 'clerk_consent_member', ${person.companyId}, 'member@consent.test',
            'Member', 'member')`;
        return { companyId: person.companyId, userId: id };
      });
      const deactivated = yield* approved(member);
      yield* users.deactivate(member);
      yield* users.reactivate(member);
      assert.strictEqual(yield* refusal(exchange(deactivated)), "ended");
    })
  );

  it.effect("approval and agent access off serialize, whichever commits first", () =>
    Effect.gen(function* () {
      const consents = yield* Consents.Consents;
      const person = yield* company("race-approve");
      const { challenge } = pkce();
      const checked = yield* consents.check(request(challenge));
      const approve = consents.approve({ request: checked, ...person });

      // The off commits first: the approval waits on the company, then is refused.
      const off = yield* hold("agent access off", access(person, false));
      const late = yield* waiting("the approval", off, approve);
      yield* off.release;
      const refused = yield* within("the approval", Fiber.join(late));
      assert.isTrue(refused._tag === "Failure" && refused.failure._tag === "AgentAccessOff");
      yield* access(person, true);

      // The approval commits first: the off waits, then cancels its code.
      const held = yield* hold("the approval", approve);
      const ending = yield* waiting("agent access off", held, access(person, false));
      const answer = new URL(yield* held.release);
      yield* within("agent access off", Fiber.join(ending));
      yield* access(person, true);
      assert.strictEqual(
        yield* refusal(exchange({ code: answer.searchParams.get("code")!, verifier: "" })),
        "unknown"
      );
    }).pipe(Effect.scoped)
  );

  it.effect("an exchange and agent access off serialize, whichever commits first", () =>
    Effect.gen(function* () {
      const person = yield* company("race-off");

      // The off commits first: the exchange waits on the company, then finds its code cancelled.
      const cancelled = yield* approved(person);
      const off = yield* hold("agent access off", access(person, false));
      const late = yield* waiting("the exchange", off, refusal(exchange(cancelled)));
      yield* off.release;
      const refused = yield* within("the exchange", Fiber.join(late));
      assert.isTrue(refused._tag === "Success" && refused.success === "unknown");
      yield* access(person, true);

      // The exchange commits first: the off waits, then ends no connection.
      const code = yield* approved(person);
      const held = yield* hold("the exchange", exchange(code));
      const ending = yield* waiting("agent access off", held, access(person, false));
      const connected = yield* held.release;
      yield* within("agent access off", Fiber.join(ending));
      assert.isTrue(yield* works(connected));
    }).pipe(Effect.scoped)
  );

  it.effect("an exchange racing Disconnect everything or deactivation leaves nothing live", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const tokens = yield* MachineTokens.MachineTokens;
      const users = yield* Users.Users;
      const person = yield* company("race-endings");
      const sql = yield* SqlClient.SqlClient;
      const member = (key: string) =>
        Effect.gen(function* () {
          const id = `usr_consent_race_${key}`;
          yield* sql`
            INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
            VALUES (${id}, ${`clerk_consent_race_${key}`}, ${person.companyId},
              ${`${key}@race.test`}, ${key}, 'member')`;
          return { companyId: person.companyId, userId: id };
        });
      const endings = [
        [
          "Disconnect everything",
          (who: { readonly userId: string }) => tokens.revokeAll(who.userId)
        ],
        [
          "deactivation",
          (who: { readonly companyId: string; readonly userId: string }) =>
            Effect.asVoid(users.deactivate(who))
        ]
      ] as const;
      for (const [name, end] of endings) {
        // The ending commits first: the exchange waits, then finds the code dead.
        const late = yield* member(`${name}-late`);
        const lateCode = yield* approved(late);
        const ending = yield* hold(name, end(late));
        const exchanging = yield* waiting("the exchange", ending, refusal(exchange(lateCode)));
        yield* ending.release;
        const refused = yield* within("the exchange", Fiber.join(exchanging));
        assert.isTrue(refused._tag === "Success" && refused.success === "ended", name);

        // The exchange commits first: the ending waits, then ends the connection it made.
        const early = yield* member(`${name}-early`);
        const earlyCode = yield* approved(early);
        const held = yield* hold("the exchange", exchange(earlyCode));
        const ended = yield* waiting(name, held, end(early));
        const connected = yield* held.release;
        yield* within(name, Fiber.join(ended));
        assert.isFalse(yield* works(connected), name);
      }
    }).pipe(Effect.scoped)
  );

  it.effect("an approval racing Disconnect everything is dead only if it committed first", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const tokens = yield* MachineTokens.MachineTokens;
      const consents = yield* Consents.Consents;
      const person = yield* company("race-stamp");
      const pair = pkce();
      const checked = yield* consents.check(request(pair.challenge));
      const approve = consents
        .approve({ request: checked, ...person })
        .pipe(Effect.map((answer) => new URL(answer).searchParams.get("code")!));

      const held = yield* hold("the approval", approve);
      const ending = yield* waiting("Disconnect everything", held, tokens.revokeAll(person.userId));
      const before = yield* held.release;
      yield* within("Disconnect everything", Fiber.join(ending));
      assert.strictEqual(
        yield* refusal(exchange({ code: before, verifier: pair.verifier })),
        "ended"
      );

      const ended = yield* hold("Disconnect everything", tokens.revokeAll(person.userId));
      const approving = yield* waiting("the approval", ended, approve);
      yield* ended.release;
      const after = yield* within("the approval", Fiber.join(approving));
      assert.isTrue(after._tag === "Success");
      if (after._tag === "Success")
        assert.isTrue(
          yield* works(yield* exchange({ code: after.success, verifier: pair.verifier }))
        );
    }).pipe(Effect.scoped)
  );

  it.effect("two exchanges of one code: the second ends what the first made", () =>
    Effect.gen(function* () {
      const person = yield* company("race-replay");
      const code = yield* approved(person);
      const first = yield* hold("the first exchange", exchange(code));
      const second = yield* waiting("the second exchange", first, refusal(exchange(code)));
      const connected = yield* first.release;
      const replayed = yield* within("the second exchange", Fiber.join(second));
      assert.isTrue(replayed._tag === "Success" && replayed.success === "replayed");
      assert.isFalse(yield* works(connected));
    }).pipe(Effect.scoped)
  );
});
