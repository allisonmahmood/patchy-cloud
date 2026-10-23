/**
 * `change_patch` and its change keys through the door, over patches published into a migrated
 * database, with Runtime's invocation as an alternate layer that records what the door handed
 * it. Two doors over the one database stand for two host replicas. These cover what a first
 * try is given, what a retry gets, the refusals, an action's one run, each key's scope, its
 * 24 hours and the sweep. ChangeKeys.workerd.test.ts writes rows on real workerd.
 */
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { canonicalArgs, type HandlerDescriptors, type ServerCallReply } from "@patchy/api";
import { AgentConnections } from "@patchy/auth";
import { sha256 } from "@patchy/core";
import { Invocation, Runtime } from "@patchy/runtime";
import * as ChangeKeys from "./ChangeKeys.js";
import {
  at,
  call,
  CLAUDE,
  company,
  door,
  doorTo,
  type Handed,
  harness,
  meta,
  objectAt,
  type Person,
  PRODUCTION,
  publish,
  runtime
} from "./test/door.js";

/** An agent tool's descriptor. */
const tool = (
  kind: "query" | "mutation" | "action",
  description: string,
  args: HandlerDescriptors[string]["args"] = {}
) => ({ kind, description, agentTool: true as const, args, result: { kind: "json" as const } });

const leads: HandlerDescriptors = {
  "agent.addLead": tool("mutation", "Add a lead.", {
    name: { kind: "text", description: "Who." },
    score: { kind: "number", description: "How warm." }
  }),
  "agent.renameLead": tool("mutation", "Rename a lead.", { name: { kind: "text" } }),
  "agent.sendDigest": tool("action", "Email the digest of new leads."),
  "agent.listLeads": tool("query", "List the leads.")
};

/** Runtime's shape for a mutation key, which no change key needs to have. */
const MUTATION_KEY = /^\d{1,16}-[A-Za-z0-9_-]{22}$/;

const structured = (response: { readonly json: unknown; readonly text: string }) => {
  const result = objectAt(response.json, "result");
  assert.isUndefined(result["isError"], response.text);
  return objectAt(result, "structuredContent");
};
const refusal = (response: { readonly json: unknown }) =>
  objectAt(response.json, "result.structuredContent.error");
const mutationKeyOf = (handed: Handed | undefined) => at(handed?.call, "mutationKey");

type Send = Effect.Success<ReturnType<typeof doorTo>>;

/** `change_patch` on `patch`, as `person`'s agent. */
const change = (
  send: Send,
  person: Person,
  input: { readonly tool: string; readonly args: unknown; readonly key: string },
  patch = "new-business"
) => send(call(person.token, "change_patch", { patch, ...input }));

/** Runtime's reply to a call that succeeded with `value`. */
const ok = (value: typeof Schema.Json.Type): Effect.Effect<ServerCallReply> =>
  Effect.succeed({ ok: true, value });

// Mutation keys carry the real time, which the retry window reads, so these run on the real clock.
it.layer(harness, { excludeTestServices: true })("change_patch", (it) => {
  it.effect(
    "gives a first try a fresh mutation key, and answers its retry from the record on any replica without running it",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("change-run", [["Priya Shah", "admin"]]);
        const priya = acme.people[0]!;
        const published = yield* publish(acme.id, priya, "new-business", { handlers: leads });
        const fake = yield* runtime(() => ok({ id: "lead-1", note: "Ada, warm" }));
        const one = yield* doorTo(fake.service, "203.0.113.60");
        const two = yield* doorTo(fake.service, "203.0.113.61");
        const add = { tool: "addLead", args: { name: "Ada", score: 1 }, key: "import-monday" };

        const first = yield* change(one, priya, add);
        assert.deepStrictEqual(structured(first), {
          result: { id: "lead-1", note: "Ada, warm" },
          version: 1
        });
        assert.strictEqual(
          at(first.json, "result.content.0.text"),
          '{"result":{"id":"lead-1","note":"Ada, warm"},"version":1}'
        );
        assert.include(first.event, {
          mcpTool: "change_patch",
          agentTool: "addLead",
          agentToolKind: "change",
          patchId: published.patchId,
          replayed: false
        });
        // Runtime gets a mutation key of its own shape from Patchy, never the agent's key.
        assert.strictEqual(fake.handed.length, 1);
        assert.deepInclude(fake.handed[0]!.call, {
          handler: "agent.addLead",
          args: { name: "Ada", score: 1 }
        });
        assert.match(String(mutationKeyOf(fake.handed[0])), MUTATION_KEY);

        // The retry on the other replica, its arguments in another order and its number
        // written another way, is the same change: the first result, and nothing runs.
        const sent = call(priya.token, "change_patch", {});
        const retry = yield* two({
          ...sent,
          raw: `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"change_patch","arguments":{"key":"import-monday","args":{"score":1.0,"name":"Ada"},"tool":"addLead","patch":"${published.patchId}"},"_meta":${JSON.stringify(meta)}}}`
        });
        assert.deepStrictEqual(structured(retry), {
          result: { id: "lead-1", note: "Ada, warm" },
          version: 1,
          replayed: true
        });
        assert.strictEqual(
          at(retry.json, "result.content.0.text"),
          '{"result":{"id":"lead-1","note":"Ada, warm"},"version":1,"replayed":true}'
        );
        assert.include(retry.event, { mcpTool: "change_patch", replayed: true });
        assert.strictEqual(fake.handed.length, 1);

        // A new key is a new change, under a mutation key of its own.
        assert.notProperty(
          structured(yield* change(one, priya, { ...add, key: "import-tuesday" })),
          "replayed"
        );
        assert.strictEqual(fake.handed.length, 2);
        assert.notStrictEqual(mutationKeyOf(fake.handed[1]), mutationKeyOf(fake.handed[0]));

        // Neither event carries the key, the arguments or the result.
        for (const response of [first, retry])
          for (const leak of ["import-monday", "Ada", "lead-1"])
            assert.notInclude(JSON.stringify(response.event), leak);
      })
  );

  it.effect(
    "refuses a try while its key's first try runs, on either replica, and the same key for another change or after a publish",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("change-refusals", [["Priya Shah", "admin"]]);
        const priya = acme.people[0]!;
        const published = yield* publish(acme.id, priya, "new-business", { handlers: leads });
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const fake = yield* runtime(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(ok({ id: "lead-2" }))
          )
        );
        const one = yield* doorTo(fake.service, "203.0.113.62");
        const two = yield* doorTo(fake.service, "203.0.113.63");
        const add = { tool: "addLead", args: { name: "Ada", score: 2 }, key: "k-busy" };

        // Two replicas race one key: one runs. The other is told to wait a second, or, when its
        // claim comes after the first try committed, gets the first result.
        const racing = yield* Effect.forkChild(
          Effect.all([change(one, priya, add), change(two, priya, add)], {
            concurrency: "unbounded"
          })
        );
        yield* Deferred.await(started);
        // Whichever lost has answered; a third try meets the same refusal.
        const busy = yield* change(two, priya, add);
        assert.deepStrictEqual(refusal(busy), {
          code: "busy",
          from: "patchy",
          message:
            "The first try with this key is still running. Try again in a second with the same key.",
          retryAfterSeconds: 1
        });
        assert.include(busy.event, { code: "busy", outcome: "refused" });
        assert.notProperty(busy.event, "replayed");
        // Another change under the running key is refused for that first.
        assert.strictEqual(
          refusal(yield* change(one, priya, { ...add, args: { name: "Bea", score: 2 } }))["code"],
          "key_conflict"
        );
        yield* Deferred.succeed(gate, undefined);
        const raced = yield* Fiber.join(racing);
        const outcomes = raced
          .map(
            (response) =>
              at(response.json, "result.structuredContent.error.code") ??
              (at(response.json, "result.structuredContent.replayed") === true ? "replayed" : "ran")
          )
          .sort();
        assert.oneOf(outcomes.join(" "), ["busy ran", "ran replayed"]);
        assert.strictEqual(fake.handed.length, 1);

        const conflict = {
          code: "key_conflict",
          from: "patchy",
          message:
            "That key was used for a different change to new-business; pick a new one. A key names one change: one tool with the same arguments."
        };
        // Other arguments, or another tool, under the same key.
        assert.deepStrictEqual(
          refusal(yield* change(two, priya, { ...add, args: { name: "Ada", score: 3 } })),
          conflict
        );
        assert.deepStrictEqual(
          refusal(yield* change(two, priya, { ...add, tool: "renameLead", args: { name: "Ada" } })),
          conflict
        );

        // A publish since the first try: the key is bound to the version it ran on.
        yield* publish(acme.id, priya, "new-business", {
          handlers: leads,
          patchId: published.patchId,
          update: true
        });
        const after = yield* change(one, priya, add);
        assert.deepStrictEqual(refusal(after), {
          code: "version_changed",
          from: "patchy",
          message:
            "new-business was published since your first try with this key; read before retrying. If the change still needs making, make it with a new key."
        });
        assert.include(after.event, { code: "version_changed", outcome: "refused" });
        assert.strictEqual(fake.handed.length, 1);
      })
  );

  it.effect(
    "a try that didn't commit leaves its key to the same change, which runs again under the same mutation key and says when Runtime's record answered",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("change-unknown", [["Priya Shah", "admin"]]);
        const priya = acme.people[0]!;
        yield* publish(acme.id, priya, "new-business", { handlers: leads });
        const replies: Array<
          (handed: Handed) => Effect.Effect<ServerCallReply, Runtime.RuntimeError>
        > = [
          () =>
            Effect.fail(
              new Runtime.UnknownOutcome({ cause: "lost", correlationId: "cor_unknown" })
            ),
          // Runtime finds its key committed by the first try: its record answers, and it says so.
          (handed) =>
            (handed.binding.onReplay ?? Effect.void).pipe(Effect.andThen(ok({ id: "lead-3" }))),
          () => Effect.succeed({ ok: false, source: "handler", code: "duplicate_lead" }),
          () => ok({ id: "lead-4" })
        ];
        const fake = yield* runtime(
          (handed) => replies.shift()?.(handed) ?? Effect.die("called too often")
        );
        const send = yield* doorTo(fake.service, "203.0.113.64");
        const add = { tool: "addLead", args: { name: "Ada", score: 3 }, key: "k-unknown" };

        const unknown = yield* change(send, priya, add);
        assert.deepStrictEqual(refusal(unknown), {
          code: "unknown_outcome",
          from: "patchy",
          message:
            "Runtime request refused: unknown_outcome. Retry with the same key: Patchy answers its result if it happened and makes it if it didn't. Correlation id: cor_unknown."
        });
        assert.include(unknown.event, { replayed: false });
        const resolved = yield* change(send, priya, add);
        assert.deepStrictEqual(structured(resolved), {
          result: { id: "lead-3" },
          version: 1,
          replayed: true
        });
        assert.include(resolved.event, { replayed: true });
        // Both tries ran under the first try's mutation key, so Runtime commits it at most once.
        assert.strictEqual(fake.handed.length, 2);
        assert.strictEqual(new Set(fake.handed.map(mutationKeyOf)).size, 1);
        // Recorded now, it is answered from the record without reaching Runtime.
        assert.deepStrictEqual(structured(yield* change(send, priya, add)), {
          result: { id: "lead-3" },
          version: 1,
          replayed: true
        });
        assert.strictEqual(fake.handed.length, 2);

        // A patch's own refusal rolled the change back, so its retry runs it, and nothing replayed.
        const other = { ...add, key: "k-refused" };
        assert.strictEqual(refusal(yield* change(send, priya, other))["code"], "duplicate_lead");
        const ran = yield* change(send, priya, other);
        assert.deepStrictEqual(structured(ran), { result: { id: "lead-4" }, version: 1 });
        assert.include(ran.event, { replayed: false });
        assert.strictEqual(mutationKeyOf(fake.handed[3]), mutationKeyOf(fake.handed[2]));
      })
  );

  it.effect(
    "keeps a key held when its agent goes away mid-try, until its lease runs out and a retry resolves it",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("change-gone", [["Priya Shah", "admin"]]);
        const priya = acme.people[0]!;
        const published = yield* publish(acme.id, priya, "new-business", { handlers: leads });
        const started = yield* Deferred.make<void>();
        let first = true;
        const fake = yield* runtime((handed) =>
          first
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            : (handed.binding.onReplay ?? Effect.void).pipe(Effect.andThen(ok({ id: "lead-7" })))
        );
        const send = yield* doorTo(fake.service, "203.0.113.70");
        const add = { tool: "addLead", args: { name: "Ada", score: 7 }, key: "k-gone" };

        // The agent hangs up while Runtime still has the try.
        const gone = yield* Effect.forkChild(change(send, priya, add));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(gone);
        first = false;
        assert.strictEqual(refusal(yield* change(send, priya, add))["code"], "busy");
        assert.strictEqual(fake.handed.length, 1);

        // Once its lease runs out, the retry runs under the same mutation key, and Runtime's
        // record of it answers.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE change_keys SET running_until = clock_timestamp()
          WHERE patch_id = ${published.patchId}`;
        assert.deepStrictEqual(structured(yield* change(send, priya, add)), {
          result: { id: "lead-7" },
          version: 1,
          replayed: true
        });
        assert.strictEqual(mutationKeyOf(fake.handed[1]), mutationKeyOf(fake.handed[0]));
      })
  );

  it.effect(
    "runs an action once per key: a later try is refused unrun, a timeout may have partly happened, and a large result is left out",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("change-action", [["Priya Shah", "admin"]]);
        const priya = acme.people[0]!;
        yield* publish(acme.id, priya, "new-business", { handlers: leads });
        const replies: Array<Effect.Effect<ServerCallReply, Runtime.RuntimeError>> = [
          ok({ sent: 3 }),
          Effect.fail(new Invocation.HandlerTimeout({ correlationId: "cor_digest" })),
          ok("x".repeat(100_001))
        ];
        const fake = yield* runtime(() => replies.shift() ?? Effect.die("called too often"));
        const send = yield* doorTo(fake.service, "203.0.113.65");
        const digest = (key: string) => change(send, priya, { tool: "sendDigest", args: {}, key });

        const sent = yield* digest("digest-1");
        assert.deepStrictEqual(structured(sent), { result: { sent: 3 }, version: 1 });
        assert.include(sent.event, { replayed: false });
        assert.isUndefined(mutationKeyOf(fake.handed[0]));
        const used = {
          code: "key_used",
          from: "patchy",
          message:
            "sendDigest is an action, and it already ran with this key; an action that writes is not safe to retry, so Patchy never runs its key twice. Read what it changes first, then retry with a new key if it still needs doing."
        };
        assert.deepStrictEqual(refusal(yield* digest("digest-1")), used);

        assert.deepStrictEqual(refusal(yield* digest("digest-2")), {
          code: "handler_timeout",
          from: "patchy",
          message:
            "The handler exceeded its deadline. It may have partly happened: read what it changes before trying again, with a new change key. Correlation id: cor_digest."
        });
        assert.deepStrictEqual(refusal(yield* digest("digest-2")), used);

        const large = yield* digest("digest-3");
        assert.deepStrictEqual(structured(large), {
          version: 1,
          resultLeftOut:
            "sendDigest succeeded, but its result came to 100,026 characters, more than the 100,000 an agent reads in one answer, so it was left out. Read what you need of the change through the patch's read tools."
        });
        assert.strictEqual(fake.handed.length, 3);
      })
  );

  it.effect("keeps each key to its agent connection and patch", () =>
    Effect.gen(function* () {
      const acme = yield* company("change-scope", [
        ["Priya Shah", "admin"],
        ["Ben Okafor", "member"]
      ]);
      const [priya, ben] = acme.people as [Person, Person];
      yield* publish(acme.id, priya, "new-business", { handlers: leads });
      yield* publish(acme.id, priya, "renewals", { handlers: leads });
      const codex = yield* AgentConnections.AgentConnections.use((connections) =>
        connections.create({ userId: priya.id, clientId: CLAUDE, clientName: "Codex" })
      );
      const fake = yield* runtime(() => ok({ id: "lead-4" }));
      const send = yield* doorTo(fake.service, "203.0.113.66");
      const add = { tool: "addLead", args: { name: "Ada", score: 4 }, key: "same-key" };

      for (const [person, patch] of [
        [priya, "new-business"],
        [priya, "renewals"],
        [{ ...priya, token: codex.tokens.accessToken }, "new-business"],
        [ben, "new-business"]
      ] as const)
        assert.notProperty(structured(yield* change(send, person, add, patch)), "replayed");
      assert.strictEqual(fake.handed.length, 4);
      assert.strictEqual(new Set(fake.handed.map(mutationKeyOf)).size, 4);
      assert.strictEqual(structured(yield* change(send, priya, add))["replayed"], true);
      assert.strictEqual(fake.handed.length, 4);
    })
  );

  it.effect(
    "keeps only hashes, a key lives 24 hours and is a new change past them, a retry stops before Runtime's record goes, and the sweep",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("change-expiry", [["Priya Shah", "admin"]]);
        const priya = acme.people[0]!;
        const published = yield* publish(acme.id, priya, "new-business", { handlers: leads });
        let unknown = false;
        const fake = yield* runtime(() =>
          unknown
            ? Effect.fail(new Runtime.UnknownOutcome({ cause: "lost", correlationId: "cor_late" }))
            : ok({ id: "lead-5" })
        );
        const send = yield* doorTo(fake.service, "203.0.113.67");
        const add = (key: string) => ({
          tool: "addLead",
          args: { name: "Ada Lovelace", score: 5 },
          key
        });
        const sql = yield* SqlClient.SqlClient;
        const keyed = (key: string) =>
          sql`patch_id = ${published.patchId} AND key_hash = ${sha256(canonicalArgs(key))}`;
        /** Makes a key's first try, and the mutation key it was given, `interval` older. */
        const age = (key: string, interval: string) =>
          sql`UPDATE change_keys SET created_at = created_at - ${interval}::interval,
              issued_at = issued_at - ${interval}::interval
            WHERE ${keyed(key)}`;

        yield* change(send, priya, add("import-monday"));
        const stored = JSON.stringify(
          yield* sql`SELECT * FROM change_keys WHERE patch_id = ${published.patchId}`
        );
        for (const leak of ["import-monday", "Ada Lovelace"]) assert.notInclude(stored, leak);

        // Just inside its 24 hours it is the same change; past them, a new one.
        yield* age("import-monday", "23 hours 59 minutes");
        assert.strictEqual(
          structured(yield* change(send, priya, add("import-monday")))["replayed"],
          true
        );
        yield* age("import-monday", "2 minutes");
        const again = yield* change(send, priya, add("import-monday"));
        assert.notProperty(structured(again), "replayed");
        assert.include(again.event, { replayed: false });
        assert.strictEqual(fake.handed.length, 2);
        assert.notStrictEqual(mutationKeyOf(fake.handed[1]), mutationKeyOf(fake.handed[0]));

        // A mutation whose outcome Patchy doesn't know runs again under its mutation key only
        // while Runtime is sure to keep that key's outcome, which ends minutes before 24 hours.
        unknown = true;
        assert.strictEqual(
          refusal(yield* change(send, priya, add("import-late")))["code"],
          "unknown_outcome"
        );
        unknown = false;
        // Runtime ages the mutation key from the time in it, however late its row was written.
        yield* sql`UPDATE change_keys SET issued_at = issued_at - interval '23 hours 55 minutes'
          WHERE ${keyed("import-late")}`;
        assert.deepStrictEqual(refusal(yield* change(send, priya, add("import-late"))), {
          code: "key_expired",
          from: "patchy",
          message:
            "Patchy doesn't know whether your first try with this key happened, and the key is too close to the end of its 24 hours to retry safely. Read what it changes first, then use a new key if it still needs doing."
        });
        assert.strictEqual(fake.handed.length, 3);

        // The sweep drops keys past their 24 hours and keeps the rest.
        yield* age("import-late", "24 hours");
        yield* ChangeKeys.ChangeKeys.use((keys) => keys.sweep);
        assert.deepStrictEqual(
          yield* sql`SELECT key_hash AS "keyHash" FROM change_keys WHERE patch_id = ${published.patchId}`,
          [{ keyHash: sha256(canonicalArgs("import-monday")) }]
        );
      })
  );

  it.effect(
    "refuses arguments without a string key, a read tool and a host without patch code, keeping the key free, and takes any string as a key",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("change-args", [["Priya Shah", "admin"]]);
        const priya = acme.people[0]!;
        const published = yield* publish(acme.id, priya, "new-business", { handlers: leads });
        const fake = yield* runtime(() => ok({ id: "lead-6" }));
        const send = yield* doorTo(fake.service, "203.0.113.68");
        const args = { name: "Ada", score: 6 };

        for (const sent of [
          { patch: "new-business", tool: "addLead", args },
          { patch: "new-business", tool: "addLead", args, key: 7 }
        ]) {
          const refused = refusal(yield* send(call(priya.token, "change_patch", sent)));
          assert.strictEqual(refused["code"], "invalid_args");
          assert.include(String(refused["message"]), "change_patch's arguments don't fit");
        }
        assert.deepStrictEqual(
          refusal(yield* change(send, priya, { tool: "listLeads", args: {}, key: "k-read" })),
          {
            code: "wrong_kind",
            from: "patchy",
            message:
              "listLeads is one of new-business's read tools, so call it with read_patch. Its tools now: addLead, listLeads, renameLead, sendDigest. Call open_patch to see what each does and takes."
          }
        );
        const without = yield* door(PRODUCTION, "203.0.113.69");
        assert.strictEqual(
          refusal(yield* change(without, priya, { tool: "sendDigest", args: {}, key: "k-host" }))[
            "code"
          ],
          "source_unavailable"
        );
        assert.strictEqual(fake.handed.length, 0);
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT count(*)::int AS count FROM change_keys WHERE patch_id = ${published.patchId}`,
          [{ count: 0 }]
        );
        // Any string is a key, the empty one, a long one and lone surrogates included, and two
        // strings UTF-8 can't tell apart are still two keys.
        for (const key of ["", "k".repeat(5_000), "import-monday ✓", "\ud800", "\ud801"])
          assert.deepStrictEqual(
            structured(yield* change(send, priya, { tool: "addLead", args, key })),
            {
              result: { id: "lead-6" },
              version: 1
            }
          );
        assert.strictEqual(fake.handed.length, 5);
      })
  );
});
