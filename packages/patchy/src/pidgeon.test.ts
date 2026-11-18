import { expect, expectTypeOf, it } from "vitest";
import type * as Api from "../../api/src/pidgeon.js";
import type { PidgeonLabel as ApiLabel } from "../../api/src/pidgeonSnapshot.js";
import { isPatchyError } from "./clientError.js";
import {
  createPidgeonClient,
  type PidgeonLabel,
  type PidgeonMessage,
  type PidgeonReader,
  type PidgeonSearchHit,
  type PidgeonSender,
  type PidgeonSent,
  type PidgeonThread
} from "./pidgeon.js";

/** Every call the client makes, answered with `value`. */
const recording = (value: unknown = { labels: [] }) => {
  const calls: Array<{ op: string; args: unknown }> = [];
  const call = async (op: string, args: unknown) => {
    calls.push({ op, args });
    return value;
  };
  return { calls, call };
};

it("mirrors the wire's results, so a field the host leaves out can't be typed in", () => {
  expectTypeOf<PidgeonThread>().toEqualTypeOf<typeof Api.PidgeonThread.Type>();
  expectTypeOf<PidgeonMessage>().toEqualTypeOf<typeof Api.PidgeonMessage.Type>();
  expectTypeOf<PidgeonSearchHit>().toEqualTypeOf<typeof Api.PidgeonSearchHit.Type>();
  expectTypeOf<PidgeonSent>().toEqualTypeOf<typeof Api.PidgeonSent.Type>();
  expectTypeOf<PidgeonLabel>().toEqualTypeOf<typeof ApiLabel.Type>();
  type Out<K extends keyof typeof Api.pidgeonReads> =
    (typeof Api.pidgeonReads)[K]["output"]["Type"];
  expectTypeOf<Awaited<ReturnType<PidgeonReader["threads"]["list"]>>>().toEqualTypeOf<
    Out<"threads.list">
  >();
  expectTypeOf<Awaited<ReturnType<PidgeonReader["threads"]["get"]>>>().toEqualTypeOf<
    Out<"threads.get">
  >();
  expectTypeOf<Awaited<ReturnType<PidgeonReader["messages"]["search"]>>>().toEqualTypeOf<
    Out<"messages.search">
  >();
  // A search names its words: there's no search for everything.
  expectTypeOf<Parameters<PidgeonReader["messages"]["search"]>[0]>().toEqualTypeOf<
    (typeof Api.pidgeonReads)["messages.search"]["input"]["Type"]
  >();
});

it("gives a read connection's client no write methods, at runtime or in its types", async () => {
  const { call } = recording();
  const reader = createPidgeonClient("support", call, "read");
  expectTypeOf(reader).toEqualTypeOf<PidgeonReader>();
  expectTypeOf(reader.messages).not.toHaveProperty("reply");
  expectTypeOf(reader.threads).not.toHaveProperty("update");
  expect(Object.keys(reader.messages).sort()).toEqual(["get", "search"]);
  expect(Object.keys(reader.threads).sort()).toEqual(["get", "list"]);
  const sender = createPidgeonClient("support", call, "send");
  expectTypeOf(sender).toEqualTypeOf<PidgeonSender>();
  expect(Object.keys(sender.messages).sort()).toEqual(["get", "reply", "search", "send"]);
  expect(Object.keys(sender.threads).sort()).toEqual(["get", "label", "list", "unlabel", "update"]);
});

it("leaves out options set to undefined, which the broker refuses, and sends each call as written", async () => {
  const { calls, call } = recording();
  const support = createPidgeonClient("support", call, "send");
  await support.threads.list({
    status: undefined,
    folder: "archive",
    limit: 10,
    cursor: undefined
  });
  await support.threads.get("thr_1", { cursor: undefined });
  await support.messages.search({ text: "order", cursor: undefined });
  await support.labels.list();
  await support.messages.reply("msg_1", {
    text: "Hi",
    cc: undefined,
    idempotencyKey: "draft-0001"
  });
  await support.messages.send({
    to: "sam@customer.example",
    subject: "Order",
    text: "Shipped.",
    idempotencyKey: "draft-0002"
  });
  await support.threads.update("thr_1", { status: "waiting" });
  await support.threads.label("thr_1", "lbl-1");
  expect(calls).toEqual([
    {
      op: "pidgeon.read",
      args: {
        connection: "support",
        operation: "threads.list",
        input: { folder: "archive", limit: 10 }
      }
    },
    {
      op: "pidgeon.read",
      args: { connection: "support", operation: "threads.get", input: { id: "thr_1" } }
    },
    {
      op: "pidgeon.read",
      args: { connection: "support", operation: "messages.search", input: { text: "order" } }
    },
    { op: "pidgeon.read", args: { connection: "support", operation: "labels.list", input: {} } },
    {
      op: "pidgeon.write",
      args: {
        connection: "support",
        operation: "messages.reply",
        input: { id: "msg_1", text: "Hi", idempotencyKey: "draft-0001" }
      }
    },
    {
      op: "pidgeon.write",
      args: {
        connection: "support",
        operation: "messages.send",
        input: {
          to: ["sam@customer.example"],
          subject: "Order",
          text: "Shipped.",
          idempotencyKey: "draft-0002"
        }
      }
    },
    {
      op: "pidgeon.write",
      args: {
        connection: "support",
        operation: "threads.update",
        input: { id: "thr_1", status: "waiting" }
      }
    },
    {
      op: "pidgeon.write",
      args: {
        connection: "support",
        operation: "threads.label",
        input: { id: "thr_1", labelId: "lbl-1" }
      }
    }
  ]);
});

it("throws Pidgeon's refusals with their operation, so their details narrow", async () => {
  const { call } = recording({
    ok: false,
    source: "patchy",
    code: "idempotency_conflict",
    error: "Still sending.",
    retryAfter: 7,
    details: { reason: "in_progress" }
  });
  const support = createPidgeonClient("support", call, "send");
  const error = await support.messages
    .reply("msg_1", { text: "Hi", idempotencyKey: "draft-0003" })
    .then(
      () => undefined,
      (caught: unknown) => caught
    );
  expect(isPatchyError(error, "idempotency_conflict", "pidgeon")).toBe(true);
  if (!isPatchyError(error, "idempotency_conflict", "pidgeon")) return;
  expectTypeOf(error.details.reason).toEqualTypeOf<"mismatch" | "in_progress" | "unconfirmed">();
  expect(error).toMatchObject({
    operation: "pidgeon.write",
    retryAfter: 7,
    details: { reason: "in_progress" }
  });
});
