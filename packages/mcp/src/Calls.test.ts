/**
 * `read_patch` through the door, over patches published into a migrated database, with
 * Runtime's invocation as an alternate layer that records what the door handed it and answers
 * as each test says. These cover resolution, the checks a call passes before anything runs and
 * the version they read, the answer's shapes and caps, and the recheck each company callback
 * makes. Calls.workerd.test.ts runs tools on real workerd.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { HandlerDescriptors, RuntimeMe, ServerCallReply } from "@patchy/api";
import { AgentConnections } from "@patchy/auth";
import { Companies } from "@patchy/companies";
import { dateLabel } from "@patchy/core";
import { Patches } from "@patchy/patches";
import { type Binding, Invocation, Runtime } from "@patchy/runtime";
import { at, call, company, door, harness, objectAt, PRODUCTION, publish } from "./test/door.js";
import * as Tools from "./Tools.js";

/** An agent tool's descriptor, taking `stage` unless it says otherwise. */
const tool = (
  kind: "query" | "mutation" | "action",
  description: string,
  args: HandlerDescriptors[string]["args"] = {
    stage: { kind: "text", description: "Which stage." }
  }
) => ({ kind, description, agentTool: true as const, args, result: { kind: "json" as const } });

const deals: HandlerDescriptors = {
  "agent.listDeals": tool("query", "List the deals in a stage."),
  "agent.addLead": tool("mutation", "Add a lead.", { name: { kind: "text" } }),
  "agent.summary": { ...tool("action", "Summarise the pipeline.", {}), readOnly: true },
  "deals.list": { kind: "query", args: {}, result: { kind: "json" } }
};

/** What the door handed Runtime for one call. */
interface Handed {
  readonly call: unknown;
  readonly binding: Binding.Binding["Service"];
  readonly recheck: Effect.Effect<NonNullable<RuntimeMe>, Runtime.RuntimeError>;
}

/**
 * Runtime's invocation as an alternate layer: it records each call and answers with `answer`,
 * run with the test's services.
 */
const runtime = <R>(
  answer: (handed: Handed) => Effect.Effect<ServerCallReply, Runtime.RuntimeError, R>
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const handed: Handed[] = [];
    const service = Invocation.Invocation.of({
      call: (call, binding, recheck) =>
        Effect.suspend(() => {
          const one = { call, binding, recheck };
          handed.push(one);
          return answer(one).pipe(Effect.provideContext(context));
        })
    });
    return { handed, service };
  });

/** A door whose calls reach `service`. */
const doorTo = (service: Invocation.Invocation["Service"], address: string) =>
  door(PRODUCTION, address).pipe(Effect.provideService(Invocation.Invocation, service));

const answered = (response: { readonly json: unknown }) => objectAt(response.json, "result");
const refusal = (response: { readonly json: unknown }) =>
  objectAt(response.json, "result.structuredContent.error");

it.layer(harness)("read_patch", (it) => {
  it.effect(
    "runs a read tool as the person through their agent, on the version served, answering it twice",
    () =>
      Effect.gen(function* () {
        const acme = yield* company(
          "read",
          [
            ["Priya Shah", "admin"],
            ["Ben Okafor", "member"]
          ],
          { name: "Acme" }
        );
        const [priya, ben] = acme.people as [(typeof acme.people)[0], (typeof acme.people)[0]];
        const published = yield* publish(acme.id, priya, "new-business", { handlers: deals });
        const fake = yield* runtime(() =>
          Effect.succeed({ ok: true as const, value: { deals: ["Globex-91c"] } })
        );
        const send = yield* doorTo(fake.service, "203.0.113.40");
        for (const [patch, by] of [
          ["new-business", "name"],
          [published.patchId, "id"],
          [`${PRODUCTION}/door-read/new-business`, "address"]
        ] as const) {
          const response = yield* send(
            call(ben.token, "read_patch", { patch, tool: "listDeals", args: { stage: "st-7f3" } })
          );
          assert.strictEqual(response.status, 200);
          const result = answered(response);
          assert.isUndefined(result["isError"], response.text);
          assert.deepStrictEqual(result["structuredContent"], {
            result: { deals: ["Globex-91c"] },
            version: 1
          });
          assert.strictEqual(
            at(result, "content.0.text"),
            '{"result":{"deals":["Globex-91c"]},"version":1}'
          );
          assert.include(response.event, {
            mcpTool: "read_patch",
            agentTool: "listDeals",
            agentToolKind: "read",
            patchRef: by,
            patchId: published.patchId,
            versionId: published.versionId
          });
          // The event never carries the arguments or the result.
          for (const leak of ["st-7f3", "Globex-91c"])
            assert.notInclude(JSON.stringify(response.event), leak);
        }
        assert.strictEqual(fake.handed.length, 3);
        const handed = fake.handed[0]!;
        assert.deepStrictEqual(handed.call, {
          handler: "agent.listDeals",
          args: { stage: "st-7f3" }
        });
        assert.include(handed.binding, {
          patchId: published.patchId,
          versionId: published.versionId,
          companyId: acme.id
        });
        assert.deepStrictEqual(handed.binding.identity, {
          user: { id: ben.id, name: "Ben Okafor", email: ben.email },
          company: { id: acme.id, handle: acme.handle, name: "Acme" },
          admin: false
        });
        assert.deepStrictEqual(handed.binding.principal, { userId: ben.id });
        assert.deepStrictEqual(handed.binding.agent, { name: "Claude Code" });

        // A read-only action is a read.
        const summary = yield* send(
          call(ben.token, "read_patch", { patch: "new-business", tool: "summary", args: {} })
        );
        assert.isUndefined(answered(summary)["isError"]);
        assert.include(summary.event, { agentTool: "summary", agentToolKind: "read" });
      })
  );

  it.effect(
    "refuses a change tool, an unknown tool and arguments the schemas refuse, before anything runs",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("refuse", [["Priya Shah", "admin"]]);
        const priya = acme.people[0]!;
        yield* publish(acme.id, priya, "new-business", { handlers: deals });
        yield* publish(acme.id, priya, "kickoff");
        const fake = yield* runtime(() => Effect.die("nothing runs"));
        const send = yield* doorTo(fake.service, "203.0.113.41");
        const read = (args: unknown) => send(call(priya.token, "read_patch", args));
        const now =
          "Its tools now: addLead, listDeals, summary. Call open_patch to see what each does and takes.";

        const change = yield* read({ patch: "new-business", tool: "addLead", args: { name: "x" } });
        assert.deepStrictEqual(refusal(change), {
          code: "wrong_kind",
          from: "patchy",
          message: `addLead is one of new-business's change tools, so call it with change_patch. ${now}`
        });
        assert.include(change.event, {
          agentTool: "addLead",
          agentToolKind: "change",
          code: "wrong_kind",
          outcome: "refused"
        });

        for (const name of ["deals.list", "list", "agent.listDeals", "x".repeat(129)]) {
          const unknown = yield* read({ patch: "new-business", tool: name, args: {} });
          assert.deepStrictEqual(refusal(unknown), {
            code: "unknown_tool",
            from: "patchy",
            message: `new-business has no tool ${name}. ${now}`
          });
          // An event keeps 128 characters of a name.
          assert.include(unknown.event, { agentTool: name.slice(0, 128), code: "unknown_tool" });
        }
        const page = yield* read({ patch: "kickoff", tool: "listDeals", args: {} });
        assert.strictEqual(
          refusal(page)["message"],
          "kickoff has no tool listDeals. It has no agent tools now. Call open_patch to see what each does and takes."
        );

        for (const args of [{ stage: 7 }, { stage: "won", extra: true }, {}]) {
          const invalid = yield* read({ patch: "new-business", tool: "listDeals", args });
          const error = refusal(invalid);
          assert.strictEqual(error["code"], "invalid_args", JSON.stringify(args));
          assert.match(
            String(error["message"]),
            new RegExp(`^listDeals's arguments don't fit its schema: .+\\. ${now}$`, "u")
          );
          assert.include(invalid.event, { agentToolKind: "read", code: "invalid_args" });
        }

        // The door's own arguments: patch, tool and an args object, nothing else.
        for (const args of [
          undefined,
          { patch: "new-business", tool: "listDeals" },
          { patch: "new-business", tool: "listDeals", args: [] },
          { patch: "new-business", tool: "listDeals", args: {}, key: "k1" },
          { patch: "new-business", tool: "", args: {} },
          { patch: "new-business", tool: "x".repeat(Tools.TOOL_CHARS + 1), args: {} }
        ]) {
          const invalid = yield* read(args);
          const error = refusal(invalid);
          assert.strictEqual(error["code"], "invalid_args", JSON.stringify(args));
          assert.match(
            String(error["message"]),
            /^read_patch's arguments don't fit its schema: .+\. Send \{ patch, tool, args \}/u
          );
        }

        const missing = yield* read({ patch: "old-business", tool: "listDeals", args: {} });
        assert.deepStrictEqual(refusal(missing), {
          code: "not_found",
          from: "patchy",
          message:
            "No patch you can open at Door refuse goes by that. Call find_patches to see the ones you can, and open one by the name it lists."
        });
        assert.strictEqual(fake.handed.length, 0);
      })
  );

  it.effect(
    "runs a call on the version served when it arrived, however a publish lands, and refuses what a publish changed",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("publish", [["Priya Shah", "admin"]]);
        const priya = acme.people[0]!;
        const first = yield* publish(acme.id, priya, "new-business", { handlers: deals });
        const update = (handlers: HandlerDescriptors) =>
          publish(acme.id, priya, "new-business", {
            handlers,
            patchId: first.patchId,
            update: true
          });
        const { "agent.listDeals": listDeals, ...rest } = deals;
        let during = true;
        // A publish lands while the first call runs; that call still ran on the version it read.
        const fake = yield* runtime((handed) =>
          Effect.gen(function* () {
            if (during) {
              during = false;
              yield* Effect.orDie(
                update({ ...rest, "agent.listDeals": { ...listDeals!, kind: "mutation" } })
              );
            }
            return {
              ok: true as const,
              value: handed.binding.manifest.handlers?.["agent.listDeals"]?.kind ?? null
            };
          })
        );
        const send = yield* doorTo(fake.service, "203.0.113.42");
        const read = (args: Record<string, unknown>) =>
          send(call(priya.token, "read_patch", { patch: "new-business", tool: "listDeals", args }));

        const ran = yield* read({ stage: "won" });
        assert.deepStrictEqual(answered(ran)["structuredContent"], { result: "query", version: 1 });
        assert.strictEqual(fake.handed[0]!.binding.versionId, first.versionId);

        const flipped = yield* read({ stage: "won" });
        assert.deepStrictEqual(refusal(flipped), {
          code: "wrong_kind",
          from: "patchy",
          message:
            "listDeals is one of new-business's change tools, so call it with change_patch. Its tools now: addLead, listDeals, summary. Call open_patch to see what each does and takes."
        });

        yield* update(rest);
        assert.strictEqual(
          refusal(yield* read({ stage: "won" }))["message"],
          "new-business has no tool listDeals. Its tools now: addLead, summary. Call open_patch to see what each does and takes."
        );

        yield* update({
          ...rest,
          "agent.listDeals": { ...listDeals!, args: { stage: { kind: "integer" } } }
        });
        const retyped = refusal(yield* read({ stage: "won" }));
        assert.strictEqual(retyped["code"], "invalid_args");
        assert.match(String(retyped["message"]), /Its tools now: addLead, listDeals, summary\./u);
        assert.deepStrictEqual(answered(yield* read({ stage: 2 }))["structuredContent"], {
          result: "query",
          version: 4
        });
        assert.strictEqual(fake.handed.length, 2);
      })
  );

  it.effect(
    "says who retired a patch and when to whoever could open it, and not found to anyone else",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("retired", [
          ["Priya Shah", "admin"],
          ["Ben Okafor", "member"]
        ]);
        const [priya, ben] = acme.people as [(typeof acme.people)[0], (typeof acme.people)[0]];
        const elsewhere = yield* company("retired-elsewhere", [["Cleo Admin", "admin"]]);
        const published = yield* publish(acme.id, ben, "new-business", { handlers: deals });
        const fake = yield* runtime(() => Effect.succeed({ ok: true as const, value: "ran" }));
        const send = yield* doorTo(fake.service, "203.0.113.43");
        const read = (token: string, patch: string) =>
          send(call(token, "read_patch", { patch, tool: "listDeals", args: { stage: "won" } }));
        const patches = yield* Patches.Patches;
        yield* patches.retire(published.patchId, { userId: priya.id, admin: true });
        const [row] = yield* patches.read({
          companyId: acme.id,
          userId: ben.id,
          canOpen: () => true,
          state: "retired"
        });
        const on = dateLabel(row!.patch.retiredAt!);

        for (const patch of [
          "new-business",
          published.patchId,
          `${PRODUCTION}/door-retired/new-business`
        ]) {
          const response = yield* read(ben.token, patch);
          assert.deepStrictEqual(refusal(response), {
            code: "patch_retired",
            from: "patchy",
            message: `new-business was retired by Priya Shah on ${on}; they can restore it. Tell the person.`
          });
          assert.include(response.event, { code: "patch_retired", patchId: published.patchId });
        }

        const notFound = (company: string) => ({
          code: "not_found",
          from: "patchy",
          message: `No patch you can open at ${company} goes by that. Call find_patches to see the ones you can, and open one by the name it lists.`
        });
        // Someone who couldn't open it learns nothing of it.
        const cleo = elsewhere.people[0]!;
        for (const patch of [published.patchId, `${PRODUCTION}/door-retired/new-business`])
          assert.deepStrictEqual(refusal(yield* read(cleo.token, patch)), notFound(elsewhere.name));
        const closed = yield* read(ben.token, "new-business").pipe(
          Effect.provideService(Patches.Openability, () => false)
        );
        assert.deepStrictEqual(refusal(closed), notFound(acme.name));
        assert.notInclude(closed.text, "Priya");

        // Restored, it runs again; deleted, it is not found.
        yield* patches.restore(published.patchId, { userId: priya.id, admin: true });
        assert.deepStrictEqual(
          answered(yield* read(ben.token, "new-business"))["structuredContent"],
          {
            result: "ran",
            version: 1
          }
        );
        yield* patches.delete(published.patchId, { userId: priya.id, admin: true });
        assert.deepStrictEqual(
          refusal(yield* read(ben.token, "new-business")),
          notFound(acme.name)
        );
        assert.strictEqual(fake.handed.length, 1);
      })
  );

  it.effect(
    "refuses arguments over the runtime's cap before running, and a result over 100,000 characters",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("caps", [["Priya Shah", "admin"]]);
        const priya = acme.people[0]!;
        yield* publish(acme.id, priya, "new-business", { handlers: deals });
        const around = JSON.stringify({ result: "", version: 1 }).length;
        let size = 0;
        const fake = yield* runtime(() =>
          Effect.succeed({ ok: true as const, value: "é".repeat(size - around) })
        );
        const send = yield* doorTo(fake.service, "203.0.113.44");
        const read = (stage: string) =>
          send(
            call(priya.token, "read_patch", {
              patch: "new-business",
              tool: "listDeals",
              args: { stage }
            })
          );
        const cap = 1_048_576;
        const empty = JSON.stringify({ stage: "" }).length;

        size = 100_000;
        const full = yield* read("x".repeat(cap - empty));
        assert.isUndefined(answered(full)["isError"], full.text.slice(0, 200));
        assert.strictEqual(String(at(answered(full), "content.0.text")).length, 100_000);

        const over = yield* read("x".repeat(cap - empty + 1));
        assert.deepStrictEqual(refusal(over), {
          code: "too_large",
          from: "patchy",
          message:
            "listDeals's arguments are 1,048,577 bytes of JSON, more than the 1,048,576 one call takes, so nothing ran. Send less in each call."
        });
        assert.include(over.event, { code: "too_large", limitId: "tier2.args.bytes" });
        assert.strictEqual(fake.handed.length, 1);

        size = 100_001;
        const long = yield* read("won");
        assert.deepStrictEqual(refusal(long), {
          code: "too_large",
          from: "patchy",
          message:
            "new-business's listDeals answered with 100,001 characters, more than the 100,000 an agent reads in one answer, so nothing was sent. Narrow the call; the patch's owner, Priya Shah, can add paging."
        });
        assert.include(long.event, { code: "too_large", outcome: "refused" });
      })
  );

  it.effect("passes a patch's own refusal through and keeps Runtime's refusals' shapes", () =>
    Effect.gen(function* () {
      const acme = yield* company("refusals", [["Priya Shah", "admin"]]);
      const priya = acme.people[0]!;
      yield* publish(acme.id, priya, "new-business", { handlers: deals });
      let reply: Effect.Effect<ServerCallReply, Runtime.RuntimeError> = Effect.succeed({
        ok: false,
        source: "handler",
        code: "stage_closed",
        details: { message: "pick an open stage", open: ["lead"] }
      });
      const fake = yield* runtime(() => reply);
      const read = (send: Effect.Success<ReturnType<typeof doorTo>>) =>
        send(
          call(priya.token, "read_patch", {
            patch: "new-business",
            tool: "listDeals",
            args: { stage: "won" }
          })
        );
      const send = yield* doorTo(fake.service, "203.0.113.45");

      const own = yield* read(send);
      assert.deepStrictEqual(refusal(own), {
        code: "stage_closed",
        from: "patch",
        message: "new-business refused listDeals (stage_closed): pick an open stage.",
        details: { message: "pick an open stage", open: ["lead"] }
      });
      assert.strictEqual(
        at(answered(own), "content.0.text"),
        'new-business refused listDeals (stage_closed): pick an open stage. Details: {"open":["lead"]}'
      );
      assert.include(own.event, { code: "stage_closed", outcome: "refused" });

      // Past the read cap, a refusal keeps its code and words, and leaves its details out.
      reply = Effect.succeed({
        ok: false,
        source: "handler",
        code: "stage_closed",
        details: { message: "pick an open stage", open: ["x".repeat(100_000)] }
      });
      const long = answered(yield* read(send));
      assert.match(
        String(at(long, "content.0.text")),
        /^new-business refused listDeals \(stage_closed\): pick an open stage\. Its details were left out: the refusal came to 100,\d{3} characters, more than the 100,000 an agent reads in one answer\.$/u
      );
      assert.deepStrictEqual(Object.keys(objectAt(long, "structuredContent.error")).sort(), [
        "code",
        "from",
        "message"
      ]);

      reply = Effect.fail(new Runtime.AccessDenied({}));
      assert.deepStrictEqual(refusal(yield* read(send)), {
        code: "access_denied",
        from: "patchy",
        message: "Runtime request refused: access_denied."
      });

      // A host that runs no server code says so.
      const without = yield* door(PRODUCTION, "203.0.113.46");
      assert.include(refusal(yield* read(without)), {
        code: "source_unavailable",
        from: "patchy"
      });
    })
  );

  it.effect(
    "rechecks the connection, the person and agent access before each company callback",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("recheck", [
          ["Priya Shah", "admin"],
          ["Ben Okafor", "member"],
          ["Cleo Diaz", "member"]
        ]);
        const [priya, ben, cleo] = acme.people as [
          (typeof acme.people)[0],
          (typeof acme.people)[0],
          (typeof acme.people)[0]
        ];
        yield* publish(acme.id, priya, "new-business", { handlers: deals });
        const sql = yield* SqlClient.SqlClient;
        const access = (on: boolean) =>
          Companies.Companies.use((companies) =>
            companies.setAgentAccess({ companyId: acme.id, on, by: priya.id })
          );
        // Each step changes something between two of the call's callbacks, then rechecks.
        let steps: ReadonlyArray<
          Effect.Effect<
            unknown,
            unknown,
            SqlClient.SqlClient | Companies.Companies | AgentConnections.AgentConnections
          >
        > = [];
        const fake = yield* runtime((handed) =>
          Effect.gen(function* () {
            const seen: string[] = [];
            for (const step of steps) {
              yield* Effect.orDie(step);
              seen.push(
                yield* handed.recheck.pipe(
                  Effect.map((person) => (person.admin ? "admin" : "member")),
                  Effect.catch((error) => Effect.succeed(error.code))
                )
              );
            }
            return { ok: true as const, value: seen };
          })
        );
        const send = yield* doorTo(fake.service, "203.0.113.47");
        const read = (token: string) =>
          send(
            call(token, "read_patch", {
              patch: "new-business",
              tool: "listDeals",
              args: { stage: "won" }
            })
          );

        steps = [
          Effect.void,
          sql`UPDATE users SET role = 'admin' WHERE id = ${ben.id}`,
          access(false),
          access(true),
          AgentConnections.AgentConnections.use((connections) =>
            connections.disconnect({ id: ben.connectionId, userId: ben.id })
          )
        ];
        assert.deepStrictEqual(answered(yield* read(ben.token))["structuredContent"], {
          result: ["member", "admin", "access_denied", "admin", "access_denied"],
          version: 1
        });

        steps = [Effect.void, sql`UPDATE users SET deactivated_at = now() WHERE id = ${cleo.id}`];
        assert.deepStrictEqual(answered(yield* read(cleo.token))["structuredContent"], {
          result: ["member", "access_denied"],
          version: 1
        });
      })
  );
});
