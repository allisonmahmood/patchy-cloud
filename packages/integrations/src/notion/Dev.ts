import { notionReads, notionWrites, type NotionRead, type NotionSnapshot } from "@patchy/api";
import { Cryptography } from "@patchy/core";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as DevDoor from "../DevDoor.js";
import { ConnectionNotDeclared, declarationOf, refusal, writeResource } from "./Operations.js";

import * as Writes from "./Writes.js";

export const handlers = Effect.fn("NotionDev.handlers")(function* (
  instance: DevDoor.Instance,
  metadata: Readonly<Record<string, { readonly snapshot: NotionSnapshot }>>,
  log: (entry: { viewerId: string; connection: string; summary: string }) => Effect.Effect<void>
) {
  const crypto = yield* Cryptography.Cryptography;
  const http = yield* HttpClient.HttpClient;
  const read = <
    I extends Schema.Top & Schema.Codec<{ readonly connection: string }, unknown>,
    O extends Schema.Top & Schema.Codec<unknown, unknown>
  >({
    op,
    guest: input,
    output
  }: {
    op: `notion.${NotionRead}`;
    guest: I;
    output: O;
  }) => {
    const decode = Schema.decodeUnknownOption(output);
    return Runtime.handler(
      { kind: "integration", input, output },
      ({ connection: alias, ...args }) =>
        Effect.gen(function* () {
          const binding = yield* Binding.Binding;
          const declaration = declarationOf(alias, binding);
          if (!declaration) return yield* new ConnectionNotDeclared({});
          return yield* DevDoor.read(
            instance,
            {
              op,
              connection: {
                id: declaration.id,
                handle: declaration.handle,
                revision: declaration.revision
              },
              args
            },
            decode
          ).pipe(Effect.provideService(HttpClient.HttpClient, http));
        })
    );
  };
  const simulate = <
    I extends Schema.Top & Schema.Codec<{ readonly connection: string }, unknown>,
    O extends Schema.Top & Schema.Codec<{ readonly id: string }, unknown>
  >(
    { op, guest: input, output }: { op: string; guest: I; output: O },
    validate: (
      snapshot: NotionSnapshot,
      args: I["Type"]
    ) => Effect.Effect<unknown, Runtime.RuntimeError>,
    result: (args: I["Type"]) => Effect.Effect<O["Type"]>
  ) =>
    Runtime.handler({ kind: "integration", input, output }, (args) =>
      Effect.gen(function* () {
        const binding = yield* Binding.Binding;
        const connection = declarationOf(args.connection, binding);
        if (!connection) return yield* new ConnectionNotDeclared({});
        const snapshot = Object.hasOwn(metadata, args.connection)
          ? metadata[args.connection]?.snapshot
          : undefined;
        if (snapshot?.access !== "write") return yield* new Runtime.AccessDenied({});
        yield* validate(snapshot, args);
        const value = yield* result(args);
        const summary = writeResource({ ...args, id: value.id });
        yield* log({
          viewerId: binding.identity?.user.id ?? "local",
          connection: connection.handle,
          summary: [op, summary].filter(Boolean).join(" ")
        });
        return value;
      })
    );

  const liveId = (id: string) => (id.startsWith("dev_") ? id.slice(4) : id);
  return {
    [notionReads.listRows.op]: read(notionReads.listRows),
    [notionReads.getRow.op]: read(notionReads.getRow),
    [notionReads.markdown.op]: read(notionReads.markdown),
    [notionReads.search.op]: read(notionReads.search),
    [notionReads.listPeople.op]: read(notionReads.listPeople),
    [notionWrites.create.op]: simulate(
      notionWrites.create,
      (snapshot, input) => Writes.planCreate(snapshot, input).pipe(Effect.mapError(refusal)),
      () => crypto.randomUUID.pipe(Effect.map((id) => ({ id: `dev_${id}`, url: "" })))
    ),
    [notionWrites.update.op]: simulate(
      notionWrites.update,
      (snapshot, input) =>
        Writes.planUpdate(snapshot, { ...input, id: liveId(input.id) }).pipe(
          Effect.mapError(refusal)
        ),
      ({ id }) => Effect.succeed({ id })
    ),
    [notionWrites.trash.op]: simulate(
      notionWrites.trash,
      (snapshot, input) =>
        Writes.planTrash(snapshot, { ...input, id: liveId(input.id) }).pipe(
          Effect.mapError(refusal)
        ),
      ({ id }) => Effect.succeed({ id, inTrash: true })
    ),
    [notionWrites.restore.op]: simulate(
      notionWrites.restore,
      (snapshot, input) =>
        Writes.planRestore(snapshot, { ...input, id: liveId(input.id) }).pipe(
          Effect.mapError(refusal)
        ),
      ({ id }) => Effect.succeed({ id, inTrash: false })
    )
  };
});
