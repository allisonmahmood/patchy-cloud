/**
 * The door's admission of `read_patch` and `change_patch`, over patches published into a
 * migrated database, with Runtime's invocation as an alternate layer: the person's calls a
 * minute on each patch, their calls in flight across their agents, and the company's
 * admission, which its pages spend too. Every refusal is a tool result over HTTP 200 that ran
 * nothing, so it wrote no log row, kept the change key free and named its limit in the event.
 */
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import type { HandlerDescriptors, ServerCallReply } from "@patchy/api";
import { AgentConnections } from "@patchy/auth";
import { OperatingLimits } from "@patchy/limits";
import { CompanyAdmission, ExecutionLifecycle, Invocation, Runtime } from "@patchy/runtime";
import { call, CLAUDE, company, doorTo, harness, objectAt, publish, runtime } from "./test/door.js";

/** An agent tool's descriptor. */
const tool = (
  kind: "query" | "mutation" | "action",
  description: string,
  args: HandlerDescriptors[string]["args"] = {}
) => ({ kind, description, agentTool: true as const, args, result: { kind: "json" as const } });

const deals: HandlerDescriptors = {
  "agent.listDeals": tool("query", "List the deals in a stage.", {
    stage: { kind: "text", description: "Which stage." }
  }),
  "agent.sendDigest": tool("action", "Email the digest of new deals.")
};

const ok: Effect.Effect<ServerCallReply> = Effect.succeed({ ok: true, value: null });

const answered = (response: { readonly json: unknown }) => objectAt(response.json, "result");
const refusal = (response: { readonly json: unknown }) =>
  objectAt(response.json, "result.structuredContent.error");

/** The limits a request's event measured, without their configuration revisions. */
const measured = (event: { readonly limits?: ReadonlyArray<{ readonly limitId: string }> }) =>
  Object.fromEntries(
    (event.limits ?? []).map((limit) => {
      const { limitId, value, peak } = limit as { limitId: string; value: number; peak: number };
      return [limitId, { value, peak }];
    })
  );

const override = (companyId: string, limitId: string, value: number) =>
  OperatingLimits.OperatingLimits.use((limits) =>
    limits.setOverride({ companyId, limitId, value, actor: "admission-test" })
  );

/** Another agent of the same person, connected through its own consent. */
const connect = (userId: string, clientName: string) =>
  Effect.map(
    AgentConnections.AgentConnections.use((connections) =>
      connections.create({ userId, clientId: CLAUDE, clientName })
    ),
    ({ tokens }) => tokens.accessToken
  );

it.layer(harness)("admission", (it) => {
  it.effect(
    "holds a person to their calls a minute on each patch, across their agents, and starts a new minute",
    () =>
      Effect.gen(function* () {
        const acme = yield* company(
          "calls-minute",
          [
            ["Priya Shah", "admin"],
            ["Ben Okafor", "member"]
          ],
          { name: "Acme" }
        );
        const [priya, ben] = acme.people as [(typeof acme.people)[0], (typeof acme.people)[0]];
        const published = yield* publish(acme.id, priya, "new-business", { handlers: deals });
        yield* publish(acme.id, priya, "renewals", { handlers: deals });
        // Another company keeps the default: an override reaches only its own company's people.
        const globex = yield* company("calls-minute-other", [["Sam Lee", "admin"]]);
        const sam = globex.people[0]!;
        yield* publish(globex.id, sam, "new-business", { handlers: deals });
        yield* override(acme.id, "mcp.calls.perMinute", 2);

        const fake = yield* runtime(() => ok);
        const send = yield* doorTo(fake.service, "203.0.113.70");
        // A second agent of Priya's spends the same minute: the person is the key.
        const codex = yield* connect(priya.id, "Codex");
        const read = (token: string, patch = "new-business") =>
          send(call(token, "read_patch", { patch, tool: "listDeals", args: { stage: "lead" } }));
        const change = (token: string, key: string) =>
          send(
            call(token, "change_patch", {
              patch: "new-business",
              tool: "sendDigest",
              args: {},
              key
            })
          );

        const first = yield* read(priya.token);
        assert.isUndefined(answered(first)["isError"], first.text);
        assert.deepInclude(measured(first.event), {
          "mcp.calls.perMinute": { value: 2, peak: 1 },
          "mcp.inFlight": { value: 16, peak: 1 }
        });
        // A change spends the same minute.
        const digest = yield* change(codex, "digest-1");
        assert.isUndefined(answered(digest)["isError"], digest.text);
        assert.deepInclude(measured(digest.event), {
          "mcp.calls.perMinute": { value: 2, peak: 2 }
        });

        const limited = yield* read(priya.token);
        assert.strictEqual(limited.status, 200);
        assert.deepStrictEqual(refusal(limited), {
          code: "rate_limited",
          from: "patchy",
          message:
            "Priya Shah's agents called new-business more than 2 times in a minute; try again in 60 seconds. Bulk work wants a tool that takes a list; if new-business has none, its owner, Priya Shah, can add one.",
          retryAfterSeconds: 60
        });
        assert.include(limited.event, {
          mcpTool: "read_patch",
          agentTool: "listDeals",
          patchId: published.patchId,
          outcome: "refused",
          code: "rate_limited",
          limitId: "mcp.calls.perMinute"
        });
        // A change refused by the minute ran nothing and keeps its key for the next one.
        assert.include(refusal(yield* change(codex, "digest-2")), { code: "rate_limited" });
        assert.strictEqual(fake.handed.length, 2);

        // Another patch, a colleague and someone at another company each have their own minute.
        for (const [token, patch] of [
          [priya.token, "renewals"],
          [ben.token, "new-business"],
          [sam.token, "new-business"]
        ] as const) {
          const own = yield* read(token, patch);
          assert.isUndefined(answered(own)["isError"], own.text);
        }

        yield* TestClock.adjust("1 minute");
        const later = yield* change(codex, "digest-2");
        assert.isUndefined(answered(later)["isError"], later.text);
        assert.strictEqual(fake.handed.length, 6);
      })
  );

  it.effect(
    "refuses the seventeenth call in flight busy, across the person's agents, until one settles",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("in-flight", [
          ["Priya Shah", "admin"],
          ["Ben Okafor", "member"]
        ]);
        const [priya, ben] = acme.people as [(typeof acme.people)[0], (typeof acme.people)[0]];
        yield* publish(acme.id, priya, "new-business", { handlers: deals });

        // As Runtime does, each call's work is dispatched into a fiber of its own that retains the
        // caller's slot until it settles, and the request only joins it. The work then waits for
        // its stage's gate, as a handler would; interrupting it fails the test, since nothing
        // should. A `cold` call is still waiting for the company's server, before dispatch.
        const gates = new Map<string, Deferred.Deferred<ServerCallReply, Runtime.RuntimeError>>();
        const started = yield* Queue.unbounded<string>();
        const settled = yield* Queue.unbounded<string>();
        // How many of Priya's calls run at once, and the most there ever were.
        let running = 0;
        let most = 0;
        const interrupted: string[] = [];
        const fake = yield* runtime(({ call: sent, binding }) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const stage = String((sent as { args: { stage?: string } }).args.stage ?? "digest");
              if (stage === "cold") {
                yield* Queue.offer(started, stage);
                return yield* restore(Effect.never);
              }
              const hers =
                (binding.identity !== null && "user" in binding.identity
                  ? binding.identity.user.id
                  : undefined) === priya.id;
              const gate = yield* Deferred.make<ServerCallReply, Runtime.RuntimeError>();
              gates.set(stage, gate);
              if (hers) most = Math.max(most, ++running);
              const release = binding.retain === undefined ? Effect.void : yield* binding.retain;
              const work = yield* Effect.forkDetach(
                Deferred.await(gate).pipe(
                  Effect.onInterrupt(() => Effect.sync(() => void interrupted.push(stage))),
                  Effect.ensuring(
                    Effect.sync(() => void (hers && running--)).pipe(
                      Effect.andThen(release),
                      Effect.andThen(Queue.offer(settled, stage))
                    )
                  )
                )
              );
              yield* Queue.offer(started, stage);
              return yield* restore(Fiber.join(work));
            })
          )
        );
        const send = yield* doorTo(fake.service, "203.0.113.71");
        const codex = yield* connect(priya.id, "Codex");
        const read = (token: string, stage: string) =>
          send(
            call(token, "read_patch", { patch: "new-business", tool: "listDeals", args: { stage } })
          );
        const open = (stage: string) =>
          Deferred.succeed(gates.get(stage)!, { ok: true, value: null });

        // Sixteen in flight from two of Priya's agents.
        const calls = new Map<string, Fiber.Fiber<unknown, unknown>>();
        for (let index = 0; index < 16; index++)
          calls.set(
            `s${index}`,
            yield* read(index % 2 === 0 ? priya.token : codex, `s${index}`).pipe(Effect.forkChild)
          );
        for (let index = 0; index < 16; index++) yield* Queue.take(started);

        const busy = {
          code: "busy",
          from: "patchy",
          message:
            "Priya Shah already has 16 calls in flight through their agents; try again in a second, once one has finished.",
          retryAfterSeconds: 1
        };
        const seventeenth = yield* read(priya.token, "s16");
        assert.strictEqual(seventeenth.status, 200);
        assert.deepStrictEqual(refusal(seventeenth), busy);
        assert.include(seventeenth.event, {
          mcpTool: "read_patch",
          outcome: "refused",
          code: "busy",
          limitId: "mcp.inFlight"
        });
        assert.deepInclude(measured(seventeenth.event), {
          "mcp.inFlight": { value: 16, peak: 16 }
        });
        // A new connection of Priya's gains nothing, and a change refused busy keeps its key.
        const claude = yield* connect(priya.id, "Claude");
        const refusedChange = yield* send(
          call(claude, "change_patch", {
            patch: "new-business",
            tool: "sendDigest",
            args: {},
            key: "digest-1"
          })
        );
        assert.deepStrictEqual(refusal(refusedChange), busy);
        assert.strictEqual(fake.handed.length, 16);

        // Someone else in the company has slots of their own.
        const colleague = yield* read(ben.token, "ben").pipe(Effect.forkChild);
        assert.strictEqual(yield* Queue.take(started), "ben");
        yield* open("ben");
        yield* Fiber.join(colleague);
        assert.strictEqual(yield* Queue.take(settled), "ben");

        // A client that goes away leaves its call running, holding its slot until it settles.
        yield* Fiber.interrupt(calls.get("s0")!);
        assert.deepStrictEqual(refusal(yield* read(priya.token, "s17")), busy);
        yield* open("s0");
        assert.strictEqual(yield* Queue.take(settled), "s0");
        // A work's failure gives its slot back too.
        yield* Deferred.fail(
          gates.get("s1")!,
          new Runtime.SourceUnavailable({ cause: new Error("The source went away.") })
        );
        yield* Fiber.join(calls.get("s1")!);
        assert.strictEqual(yield* Queue.take(settled), "s1");

        // Two slots came back: a change takes one, with the key its refusal kept, and a call
        // still waiting for the company's server the other.
        const digest = yield* send(
          call(claude, "change_patch", {
            patch: "new-business",
            tool: "sendDigest",
            args: {},
            key: "digest-1"
          })
        ).pipe(Effect.forkChild);
        assert.strictEqual(yield* Queue.take(started), "digest");
        const cold = yield* read(codex, "cold").pipe(Effect.forkChild);
        assert.strictEqual(yield* Queue.take(started), "cold");
        assert.deepStrictEqual(refusal(yield* read(priya.token, "s18")), busy);
        // Its client gives up before anything was dispatched, so its slot comes back at once.
        yield* Fiber.interrupt(cold);
        calls.set("s19", yield* read(priya.token, "s19").pipe(Effect.forkChild));
        assert.strictEqual(yield* Queue.take(started), "s19");
        assert.deepStrictEqual(refusal(yield* read(priya.token, "s20")), busy);

        // The freed slot and settling calls race fresh ones: never more than 16 run.
        const racing = [];
        for (let index = 2; index < 8; index++) yield* open(`s${index}`);
        for (let index = 21; index < 29; index++)
          racing.push(yield* read(priya.token, `s${index}`).pipe(Effect.forkChild));
        for (let index = 2; index < 8; index++) yield* Fiber.join(calls.get(`s${index}`)!);
        assert.isAtMost(most, 16);

        // Settle everything still running.
        yield* open("digest");
        assert.isUndefined(answered(yield* Fiber.join(digest))["isError"]);
        const pending = [...calls.values(), ...racing];
        for (let turn = 0; pending.some((fiber) => fiber.pollUnsafe() === undefined); turn++) {
          if (turn > 10_000) assert.fail("A call never settled.");
          for (const gate of gates.values())
            yield* Deferred.succeed(gate, { ok: true, value: null });
          yield* Effect.yieldNow;
        }
        assert.isAtMost(most, 16);
        assert.deepStrictEqual(interrupted, []);
      })
  );

  it.effect("spends the company's admission with its pages", () =>
    Effect.gen(function* () {
      const acme = yield* company("company-admission", [["Priya Shah", "admin"]], {
        name: "Acme"
      });
      const priya = acme.people[0]!;
      yield* publish(acme.id, priya, "new-business", { handlers: deals });
      yield* override(acme.id, "company.admission.burst", 2);
      const fake = yield* runtime(() => ok);
      const send = yield* doorTo(fake.service, "203.0.113.72");
      const read = send(
        call(priya.token, "read_patch", {
          patch: "new-business",
          tool: "listDeals",
          args: { stage: "lead" }
        })
      );
      // One of the company's pages spends a token, as Runtime's admission does.
      const admission = yield* CompanyAdmission.CompanyAdmission;
      yield* admission.admit(acme.id);

      const first = yield* read;
      assert.isUndefined(answered(first)["isError"], first.text);
      assert.deepInclude(measured(first.event), {
        "company.admission.burst": { value: 2, peak: 2 }
      });
      const refused = yield* read;
      assert.deepStrictEqual(refusal(refused), {
        code: "limit_exceeded",
        from: "patchy",
        message: "Acme is making calls faster than Patchy admits them; try again in 1 second.",
        retryAfterSeconds: 1
      });
      assert.include(refused.event, {
        outcome: "refused",
        code: "limit_exceeded",
        limitId: "company.admission.rate"
      });
      assert.strictEqual(fake.handed.length, 1);
      // And the agent's call spent the page's token.
      const page = yield* admission.admit(acme.id).pipe(Effect.flip);
      assert.strictEqual(page.code, "limit_exceeded");
    })
  );

  it.effect("keeps an action's key when Runtime refuses it before it starts", () =>
    Effect.gen(function* () {
      const acme = yield* company("action-admission", [["Priya Shah", "admin"]]);
      const priya = acme.people[0]!;
      yield* publish(acme.id, priya, "new-business", { handlers: deals });
      const refusals: ReadonlyArray<Runtime.RuntimeError> = [
        new Invocation.InvocationBusy({
          limitId: "tier2.actions.viewer",
          value: 2,
          scope: "viewer"
        }),
        new ExecutionLifecycle.LifecycleError({
          code: "patch_paused",
          status: 429,
          retryAfterSeconds: 30,
          limitId: "execution.breaker.kills",
          scope: "patch",
          value: 3
        }),
        new Invocation.ExecutorBusy({
          limitId: "execution.residency.processes",
          scope: "host",
          retryAfter: 2,
          cause: new Error("Every process is busy.")
        })
      ];
      let refusing = 0;
      const fake = yield* runtime(() =>
        refusing < refusals.length ? Effect.fail(refusals[refusing++]!) : ok
      );
      const send = yield* doorTo(fake.service, "203.0.113.73");
      const digest = send(
        call(priya.token, "change_patch", {
          patch: "new-business",
          tool: "sendDigest",
          args: {},
          key: "digest-1"
        })
      );
      const slots = yield* digest;
      assert.include(refusal(slots), { code: "busy", retryAfterSeconds: 1 });
      assert.include(slots.event, { code: "busy", limitId: "tier2.actions.viewer" });
      const paused = yield* digest;
      assert.include(refusal(paused), { code: "patch_paused", retryAfterSeconds: 30 });
      assert.include(paused.event, { limitId: "execution.breaker.kills" });
      const full = yield* digest;
      assert.include(refusal(full), { code: "busy", retryAfterSeconds: 2 });
      assert.include(full.event, { limitId: "execution.residency.processes" });
      // None started, so the same key runs now, once.
      const ran = yield* digest;
      assert.isUndefined(answered(ran)["isError"], ran.text);
      assert.include(refusal(yield* digest), { code: "key_used" });
      assert.strictEqual(fake.handed.length, 4);
    })
  );
});
