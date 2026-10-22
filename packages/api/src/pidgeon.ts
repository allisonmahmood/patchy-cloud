/**
 * PROTOTYPE (Pidgeon): one company email address, read and answered through operations Patchy
 * writes. Patch code never names another address, a Pidgeon path or a key: the connection is the
 * address, and sends always go from it. Reads travel as `pidgeon.read`; anything that changes the
 * mailbox or sends mail travels as `pidgeon.write`, so recent calls tell them apart.
 */
import * as Schema from "effect/Schema";
import { DefinitionName } from "./schemas.js";

const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));
const Cursor = Schema.String.check(Schema.isBetweenLength(1, 512));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));
/** An address as a person types it; Pidgeon decides whether it can be delivered to. */
export const PidgeonEmail = Schema.String.check(
  Schema.isMaxLength(320),
  Schema.isPattern(/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/)
);
const Recipients = (minimum: number) =>
  Schema.Array(PidgeonEmail).check(Schema.isBetweenLength(minimum, 50));
const Body = Schema.String.check(Schema.isBetweenLength(1, 100_000));
export const pidgeonThreadStatuses = ["open", "waiting", "resolved", "human_review"] as const;
const ThreadStatus = Schema.Literals(pidgeonThreadStatuses);
/**
 * Names one intended send. Sending again with the same key never sends twice, so a patch that
 * retries after a timeout can't double-mail anyone. The generated client makes one per call.
 */
const IdempotencyKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,128}$/));

const reads = [
  Schema.Struct({
    operation: Schema.Literal("threads.list"),
    input: Schema.Struct({
      status: Schema.optionalKey(ThreadStatus),
      limit: Schema.optionalKey(Limit),
      cursor: Schema.optionalKey(Cursor)
    })
  }),
  Schema.Struct({ operation: Schema.Literal("threads.get"), input: Schema.Struct({ id: Id }) }),
  Schema.Struct({ operation: Schema.Literal("messages.get"), input: Schema.Struct({ id: Id }) }),
  Schema.Struct({
    operation: Schema.Literal("messages.search"),
    input: Schema.Struct({
      text: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 200))),
      from: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 200))),
      to: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 200))),
      labelId: Schema.optionalKey(Id),
      hasAttachment: Schema.optionalKey(Schema.Boolean),
      folder: Schema.optionalKey(Schema.Literals(["inbox", "sent", "archive", "spam"])),
      limit: Schema.optionalKey(Limit)
    })
  }),
  Schema.Struct({ operation: Schema.Literal("labels.list"), input: Schema.Struct({}) }),
  Schema.Struct({ operation: Schema.Literal("attachments.text"), input: Schema.Struct({ id: Id }) })
] as const;

const writes = [
  Schema.Struct({
    operation: Schema.Literal("messages.send"),
    input: Schema.Struct({
      to: Recipients(1),
      cc: Schema.optionalKey(Recipients(0)),
      subject: Schema.String.check(Schema.isBetweenLength(1, 500)),
      text: Body,
      idempotencyKey: IdempotencyKey
    })
  }),
  Schema.Struct({
    operation: Schema.Literal("messages.reply"),
    input: Schema.Struct({
      id: Id,
      text: Body,
      cc: Schema.optionalKey(Recipients(0)),
      idempotencyKey: IdempotencyKey
    })
  }),
  Schema.Struct({
    operation: Schema.Literal("threads.update"),
    input: Schema.Struct({ id: Id, status: ThreadStatus })
  }),
  Schema.Struct({
    operation: Schema.Literal("threads.label"),
    input: Schema.Struct({ id: Id, labelId: Id })
  }),
  Schema.Struct({
    operation: Schema.Literal("threads.unlabel"),
    input: Schema.Struct({ id: Id, labelId: Id })
  })
] as const;

/** One Patchy-written operation and its typed input, without the connection. */
export const PidgeonReadCall = Schema.Union(reads);
export type PidgeonReadCall = typeof PidgeonReadCall.Type;
export const PidgeonWriteCall = Schema.Union(writes);
export type PidgeonWriteCall = typeof PidgeonWriteCall.Type;
export type PidgeonCall = PidgeonReadCall | PidgeonWriteCall;
export type PidgeonOperation = PidgeonCall["operation"];

export const PidgeonRead = Schema.Union(
  reads.map((read) => Schema.Struct({ connection: DefinitionName, ...read.fields }))
);
export type PidgeonRead = typeof PidgeonRead.Type;
export const PidgeonWrite = Schema.Union(
  writes.map((write) => Schema.Struct({ connection: DefinitionName, ...write.fields }))
);
export type PidgeonWrite = typeof PidgeonWrite.Type;

export const pidgeonOperations = {
  "pidgeon.read": {
    request: Schema.Struct({ op: Schema.Literal("pidgeon.read"), args: PidgeonRead }),
    response: Schema.Json,
    kind: "integration"
  },
  "pidgeon.write": {
    request: Schema.Struct({ op: Schema.Literal("pidgeon.write"), args: PidgeonWrite }),
    response: Schema.Json,
    kind: "integration"
  }
} as const;
