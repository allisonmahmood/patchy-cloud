/**
 * Notion's dev binding (ADR-0013). `patchy dev` reads the real workspace through the instance's
 * dev door, as the machine token's person, and simulates every write. An append or a row write
 * is checked as the host checks it, its arguments against the version's snapshot and the
 * connection's access, then answered here, a create with an id starting `dev_`, and shown in
 * dev's output. Nothing reaches the instance or Notion, so the next read doesn't show it.
 */
import {
  type DeclarationMetadata,
  notionReads,
  notionWrites,
  type NotionRead,
  type NotionSnapshot,
  type NotionWrite
} from "@patchy/api";
import { Cryptography } from "@patchy/core";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as DevDoor from "../DevDoor.js";
import {
  ConnectionNotDeclared,
  declarationOf,
  isRefusal,
  recorded,
  refusal
} from "./Operations.js";
import type * as Source from "./Source.js";
import * as Writes from "./Writes.js";

type Values = Readonly<Record<string, Schema.Json>>;

/** A write dev answered itself, as dev's output shows it. Nothing reached Notion. */
export interface Simulated {
  /** Whoever made the call: either local viewer. */
  readonly viewerId: string;
  /** `notion/<handle>`. */
  readonly connection: string;
  readonly operation: `notion.${NotionWrite}`;
  /** The operation as recent calls name it: its data source, row and property names. */
  readonly summary: string;
}

/** A row dev made stands for a Notion row, so it's checked as one. */
const live = (id: string) => (id.startsWith("dev_") ? id.slice("dev_".length) : id);

/** The same for rows a relation names, so a row dev made can be related to in the next call. */
const liveRelations = <Args extends { readonly source: string; readonly properties: Values }>(
  snapshot: NotionSnapshot,
  args: Args
): Args => {
  const relations = new Set(
    snapshot.dataSources
      .find(({ key }) => key === args.source)
      ?.properties.filter(({ type }) => type === "relation")
      .map(({ name }) => name)
  );
  return {
    ...args,
    properties: Object.fromEntries(
      Object.entries(args.properties).map(([name, value]) => [
        name,
        relations.has(name) && Array.isArray(value)
          ? value.map((id) => (typeof id === "string" ? live(id) : id))
          : value
      ])
    )
  };
};

/**
 * Notion's operations for `patchy dev`. `connections` is generation's metadata for the repo's
 * Notion declarations, whose snapshots say each connection's access; `simulated` shows each write
 * in dev's output.
 */
export const handlers = Effect.fn("NotionDev.handlers")(function* (
  instance: DevDoor.Instance,
  connections: (typeof DeclarationMetadata.Type)["notion"],
  simulated: (write: Simulated) => Effect.Effect<void>
) {
  const http = yield* HttpClient.HttpClient;
  const cryptography = yield* Cryptography.Cryptography;
  const snapshots = new Map(
    Object.values(connections).map(({ declaration, snapshot }) => [declaration.id, snapshot])
  );
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
    O extends Schema.Top & Schema.Codec<unknown, unknown>
  >(
    name: NotionWrite,
    { op, guest, output }: { op: `notion.${NotionWrite}`; guest: I; output: O },
    check: (
      snapshot: NotionSnapshot,
      args: I["Type"]
    ) => Effect.Effect<unknown, Runtime.InvalidRequest | Source.Refusal>,
    answer: (args: I["Type"]) => Effect.Effect<O["Type"]>
  ) =>
    Runtime.handler({ kind: "integration", input: guest, output }, (args) =>
      Effect.gen(function* () {
        const binding = yield* Binding.Binding;
        const declaration = declarationOf(args.connection, binding);
        if (!declaration) return yield* new ConnectionNotDeclared({});
        const snapshot = snapshots.get(declaration.id);
        // A read connection never changes anything in Notion, in dev as published.
        if (binding.identity === null || snapshot?.access !== "write")
          return yield* new Runtime.AccessDenied({});
        yield* check(snapshot, args).pipe(
          Effect.mapError((error) => (isRefusal(error) ? refusal(error) : error))
        );
        const value = yield* answer(args);
        yield* simulated({
          viewerId: binding.identity.user.id,
          connection: `notion/${declaration.handle}`,
          operation: op,
          summary: [op, recorded[name].resource(args)].filter((part) => part !== null).join(" ")
        });
        return value;
      })
    );

  return {
    [notionReads.listRows.op]: read(notionReads.listRows),
    [notionReads.getRow.op]: read(notionReads.getRow),
    [notionReads.markdown.op]: read(notionReads.markdown),
    [notionReads.search.op]: read(notionReads.search),
    [notionReads.listPeople.op]: read(notionReads.listPeople),
    [notionWrites.appendMarkdown.op]: simulate(
      "appendMarkdown",
      notionWrites.appendMarkdown,
      (snapshot, args) => Writes.planAppendMarkdown(snapshot, { ...args, id: live(args.id) }),
      ({ id }) => Effect.succeed({ id, warnings: [] })
    ),
    [notionWrites.create.op]: simulate(
      "create",
      notionWrites.create,
      (snapshot, args) => Writes.planCreate(snapshot, liveRelations(snapshot, args)),
      () => Effect.map(cryptography.randomUUID, (id) => ({ id: `dev_${id}`, url: "" }))
    ),
    [notionWrites.update.op]: simulate(
      "update",
      notionWrites.update,
      (snapshot, args) =>
        Writes.planUpdate(snapshot, { ...liveRelations(snapshot, args), id: live(args.id) }),
      ({ id }) => Effect.succeed({ id })
    ),
    [notionWrites.trash.op]: simulate(
      "trash",
      notionWrites.trash,
      (snapshot, args) => Writes.planTrash(snapshot, { ...args, id: live(args.id) }),
      ({ id }) => Effect.succeed({ id, inTrash: true })
    ),
    [notionWrites.restore.op]: simulate(
      "restore",
      notionWrites.restore,
      (snapshot, args) => Writes.planRestore(snapshot, { ...args, id: live(args.id) }),
      ({ id }) => Effect.succeed({ id, inTrash: false })
    )
  };
});
