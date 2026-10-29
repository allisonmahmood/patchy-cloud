/**
 * Pidgeon's dev binding (ADR-0013). `patchy dev` reads the real address through the instance's
 * dev door, as the machine token's person, and simulates every write. A reply, send or triage is
 * checked as the host checks it, its arguments and the connection's access, then answered here
 * with a result whose new ids start `dev_` and whose `test` is true, and shown in dev's output.
 * Nothing reaches the instance or Pidgeon: nobody receives mail, and the next read doesn't show
 * it. Dev doesn't check the send policy, since the snapshot can't tell who the address has
 * written with. Test-mode keys wouldn't do instead: their replies and triage land in the real
 * conversations the team reads.
 */
import {
  type DeclarationMetadata,
  PidgeonRead,
  PidgeonWrite,
  pidgeonReads,
  type PidgeonReadOperation,
  type PidgeonSent,
  type PidgeonWriteOperation
} from "@patchy/api";
import { newInternalId } from "@patchy/core";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as DevDoor from "../DevDoor.js";
import { ConnectionNotDeclared, ReadOnly, recorded } from "./Operations.js";

/** A write dev answered itself, as dev's output shows it. Nothing reached Pidgeon. */
export interface Simulated {
  /** Whoever made the call: either local viewer. */
  readonly viewerId: string;
  /** `pidgeon/<handle>`. */
  readonly connection: string;
  readonly operation: PidgeonWriteOperation;
  /**
   * As recent calls name the call: a send's subject and recipients, a reply's message and CC, a
   * triage's thread and status or label.
   */
  readonly summary: string;
}

/** Each read's answer held to that read's wire before the patch sees it. */
const answers: {
  readonly [K in PidgeonReadOperation]: (value: unknown) => Option.Option<typeof Schema.Json.Type>;
} = {
  "threads.list": Schema.decodeUnknownOption(pidgeonReads["threads.list"].output),
  "threads.get": Schema.decodeUnknownOption(pidgeonReads["threads.get"].output),
  "messages.get": Schema.decodeUnknownOption(pidgeonReads["messages.get"].output),
  "messages.search": Schema.decodeUnknownOption(pidgeonReads["messages.search"].output),
  "labels.list": Schema.decodeUnknownOption(pidgeonReads["labels.list"].output),
  "attachments.text": Schema.decodeUnknownOption(pidgeonReads["attachments.text"].output)
};

/** A send or reply as Pidgeon answers one it sent, to no one. */
const sent = (): typeof PidgeonSent.Type => ({
  status: "sent",
  messageId: newInternalId("dev"),
  threadId: newInternalId("dev"),
  rejected: [],
  replayed: false,
  test: true
});

/**
 * `pidgeon.read` and `pidgeon.write` for `patchy dev`. `connections` is generation's metadata for
 * the repo's Pidgeon declarations, whose snapshots say each connection's access; `simulated`
 * shows each write in dev's output.
 */
export const handlers = Effect.fn("PidgeonDev.handlers")(function* (
  instance: DevDoor.Instance,
  connections: (typeof DeclarationMetadata.Type)["pidgeon"],
  simulated: (write: Simulated) => Effect.Effect<void>
) {
  const http = yield* HttpClient.HttpClient;
  const snapshots = new Map(
    Object.values(connections).map(({ declaration, snapshot }) => [declaration.id, snapshot])
  );
  /** The declared Pidgeon connection an alias names, as a published patch's call finds it. */
  const declared = Effect.fnUntraced(function* (alias: string) {
    const binding = yield* Binding.Binding;
    const declaration = binding.manifest.uses[alias];
    if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "pidgeon")
      return yield* new ConnectionNotDeclared({});
    return { binding, declaration };
  });
  return {
    "pidgeon.read": Runtime.handler(
      { kind: "integration", input: PidgeonRead, output: Schema.Json },
      Effect.fn("PidgeonDev.read")(function* ({ connection: alias, ...read }) {
        const { declaration } = yield* declared(alias);
        return yield* DevDoor.read(
          instance,
          {
            op: "pidgeon.read",
            connection: { id: declaration.id, handle: declaration.handle },
            args: read
          },
          answers[read.operation]
        ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      })
    ),
    "pidgeon.write": Runtime.handler(
      { kind: "integration", input: PidgeonWrite, output: Schema.Json },
      Effect.fn("PidgeonDev.write")(function* (write) {
        const { binding, declaration } = yield* declared(write.connection);
        const snapshot = snapshots.get(declaration.id);
        if (binding.identity === null || "guest" in binding.identity || snapshot === undefined)
          return yield* new Runtime.AccessDenied({});
        // A read connection never changes anything in Pidgeon, in dev as published.
        if (snapshot.access !== "send") return yield* new ReadOnly({});
        const answer: typeof Schema.Json.Type =
          write.operation === "messages.send" || write.operation === "messages.reply"
            ? sent()
            : write.operation === "threads.update"
              ? // The thread as the change left it, as far as dev knows it without asking Pidgeon.
                {
                  id: write.input.id,
                  subject: null,
                  status: write.input.status,
                  from: null,
                  preview: null,
                  messageCount: 0,
                  hasAttachments: false,
                  lastMessageAt: null,
                  createdAt: DateTime.formatIso(yield* DateTime.now)
                }
              : {
                  labels:
                    write.operation === "threads.label"
                      ? snapshot.labels.filter((label) => label.id === write.input.labelId)
                      : []
                };
        yield* simulated({
          viewerId: binding.identity.user.id,
          connection: `pidgeon/${declaration.handle}`,
          operation: write.operation,
          summary: recorded.resource(write) ?? write.operation
        });
        return answer;
      })
    )
  };
});
