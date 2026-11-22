// @effect-diagnostics globalJsonInEffect:off -- exercise the guest's raw HTTP JSON request and response boundary.
import { assert, it } from "@effect/vitest";
import { limitRefusal } from "@patchy/api";
import { t, type Config } from "./config.js";
import { createGuest } from "./guest.js";
import { IN_FLIGHT, PER_ACTION } from "./models.js";
import { bindServer } from "./server.js";

/**
 * Model roles' clients as an action's code reaches them through the guest: one scheduler across
 * every alias, four calls at a time, the rest held unsent, the action's 200 calls, the queue
 * cleared when the action ends, and each refusal reaching the handler with its code and `sent`.
 */

const viewer = {
  user: { id: "usr_test", name: "Reader", email: "reader@example.test" },
  company: { id: "com_test", name: "Example", handle: "example" },
  admin: false
};
type Callback = { readonly op: string; readonly args: Record<string, unknown> };
type Clients = Record<string, Record<string, (request: object) => Promise<unknown>>>;
type Handler = (ctx: { readonly connections: Clients }) => Promise<unknown>;
const server = bindServer<Config, Record<never, never>, Record<never, never>, Clients>();

/** Runs `handler` as an action whose host answers each callback with `answer`. */
const action = async (handler: Handler, answer: (callback: Callback) => Promise<unknown>) => {
  const guest = createGuest(
    {
      desk: {
        run: server.action({
          args: {},
          result: t.json(),
          handler: (ctx) => handler(ctx as never) as never
        })
      }
    },
    [],
    {},
    [],
    [],
    [],
    [],
    { triage: "decision", writer: "text" }
  );
  const response = await guest.fetch(
    new Request("https://guest/invoke", {
      method: "POST",
      body: JSON.stringify({ wire: 1, type: "invoke", handler: "desk.run", args: {}, viewer })
    }),
    undefined,
    {
      props: {
        invocationId: "inv_models",
        callbacks: { call: (operation: unknown) => answer(operation as Callback) }
      }
    }
  );
  return (await response.json()) as unknown;
};
const usage = { inputTokens: 1, outputTokens: 1 };

it("holds the release's own bounds", () => {
  assert.strictEqual(IN_FLIGHT, limitRefusal("models.calls.inFlight").value);
  assert.strictEqual(PER_ACTION, limitRefusal("models.calls.perAction").value);
});

it("gives a decision role only decide and a text role only generate", async () => {
  const reply = await action(
    async (ctx) => ({
      triage: Object.keys(ctx.connections.triage!),
      writer: Object.keys(ctx.connections.writer!)
    }),
    async () => ({ ok: true, value: null })
  );
  assert.deepStrictEqual(reply, { ok: true, value: { triage: ["decide"], writer: ["generate"] } });
});

it("runs a call per row four at a time across every alias, holding the rest unsent", async () => {
  let running = 0;
  let peak = 0;
  const sent: string[] = [];
  const reply = await action(
    async (ctx) =>
      Promise.all(
        Array.from({ length: 12 }, (_, row) =>
          row % 3 === 0
            ? ctx.connections.triage!.decide!({
                input: `row ${row}`,
                questions: { urgent: { type: "yesNo", instructions: "Urgent?" } }
              })
            : ctx.connections.writer!.generate!({ input: `row ${row}`, maxOutputTokens: 32 })
        )
      ).then((answers) => answers.length),
    async (callback) => {
      running++;
      peak = Math.max(peak, running);
      sent.push(callback.op);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return {
        ok: true,
        value:
          callback.op === "models.decide"
            ? { answers: { urgent: { probability: 0.5 } }, usage }
            : { text: String(callback.args.input), usage }
      };
    }
  );
  assert.deepStrictEqual(reply, { ok: true, value: 12 });
  assert.strictEqual(peak, 4);
  assert.strictEqual(sent.length, 12);
  assert.strictEqual(sent.filter((op) => op === "models.decide").length, 4);
});

it("refuses the action's 201st call without sending it", async () => {
  let sent = 0;
  const reply = await action(
    async (ctx) => {
      const calls = Array.from({ length: 201 }, (_, row) =>
        ctx.connections.writer!.generate!({ input: `row ${row}`, maxOutputTokens: 16 }).then(
          () => "ok",
          (error: {
            readonly code: string;
            readonly limitId?: string;
            readonly details?: object;
          }) => [error.code, error.limitId, error.details]
        )
      );
      return (await Promise.all(calls)).filter((outcome) => outcome !== "ok");
    },
    async () => {
      sent++;
      return { ok: true, value: { text: "x", usage } };
    }
  );
  assert.deepStrictEqual(reply, {
    ok: true,
    value: [["limit_exceeded", "models.calls.perAction", { sent: false }]]
  });
  assert.strictEqual(sent, 200);
});

it("sends nothing still waiting once the action ends", async () => {
  let sent = 0;
  const reply = await action(
    async (ctx) => {
      for (let row = 0; row < 10; row++)
        void ctx.connections.writer!.generate!({ input: `row ${row}`, maxOutputTokens: 16 }).catch(
          () => undefined
        );
      return "done";
    },
    async () => {
      sent++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, value: { text: "x", usage } };
    }
  );
  assert.deepStrictEqual(reply, { ok: true, value: "done" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.strictEqual(sent, 4);
});

it("sends nothing still waiting once a handler throws, while its diagnostics are written", async () => {
  let sent = 0;
  const reply = await action(
    async (ctx) => {
      for (let row = 0; row < 10; row++)
        void ctx.connections.writer!.generate!({ input: `row ${row}`, maxOutputTokens: 16 }).catch(
          () => undefined
        );
      throw new Error("The handler failed after starting its rows.");
    },
    async (callback) => {
      // The diagnostic log takes longer than the running calls, which settle meanwhile.
      if (callback.op === "log") {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { ok: true, value: null };
      }
      sent++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true, value: { text: "x", usage } };
    }
  );
  assert.deepInclude(reply, { ok: false, code: "handler_failed" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.strictEqual(sent, 4);
});

it("hands each refusal to the handler with its code, its limit and whether it was sent", async () => {
  const refusals = [
    { code: "timeout", limitId: "models.cutoff", details: { sent: true } },
    { code: "timeout", limitId: "models.send.floor", details: { sent: false } },
    { code: "source_rate_limited", retryAfter: 7, details: { sent: true, limit: "requests" } },
    { code: "model_refused", details: { sent: true } },
    { code: "output_truncated", details: { sent: true, maxOutputTokens: 16 } },
    { code: "shape_mismatch", details: { sent: true } },
    { code: "source_unavailable", details: { sent: false, reason: "connection_changed" } },
    { code: "too_large", limitId: "models.answer.bytes", details: { sent: true } },
    { code: "invalid_request", details: { sent: false, reason: "kind", kind: "decision" } },
    { code: "busy", limitId: "models.outbound.provider", retryAfter: 1, details: { sent: false } },
    // A reply lost in transit: whether anything was sent is unknown.
    { code: "source_unavailable" }
  ];
  let next = 0;
  const reply = await action(
    async (ctx) => {
      const seen: unknown[] = [];
      for (let call = 0; call < refusals.length; call++)
        try {
          await ctx.connections.writer!.generate!({ input: "x", maxOutputTokens: 16 });
        } catch (error) {
          const { code, limitId, retryAfter, details, operation } = error as Record<
            string,
            unknown
          >;
          // As JSON, so an absent field is left out rather than sent as undefined.
          seen.push(JSON.parse(JSON.stringify({ code, limitId, retryAfter, details, operation })));
        }
      return seen;
    },
    async () => ({ ok: false, source: "patchy", error: "refused", ...refusals[next++] })
  );
  assert.deepStrictEqual(reply, {
    ok: true,
    value: refusals.map((refusal) =>
      JSON.parse(
        JSON.stringify({
          code: refusal.code,
          limitId: refusal.limitId,
          retryAfter: refusal.retryAfter,
          details: refusal.details ?? {},
          operation: "models.generate"
        })
      )
    )
  });
});
