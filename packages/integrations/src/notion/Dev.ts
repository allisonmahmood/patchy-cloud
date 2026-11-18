import {
  NotionGetRow,
  NotionListPeople,
  NotionListRows,
  NotionMarkdown,
  NotionSearch,
  notionReads,
  type NotionRead
} from "@patchy/api";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as DevDoor from "../DevDoor.js";
import { ConnectionNotDeclared } from "./Operations.js";

export const handlers = Effect.fn("NotionDev.handlers")(function* (instance: DevDoor.Instance) {
  const http = yield* HttpClient.HttpClient;
  const read = <
    I extends Schema.Top & Schema.Codec<{ readonly connection: string }, unknown>,
    O extends Schema.Top & Schema.Codec<unknown, unknown>
  >(
    name: NotionRead,
    input: I,
    output: O
  ) => {
    const decode = Schema.decodeUnknownOption(output);
    return Runtime.handler(
      { kind: "integration", input, output },
      ({ connection: alias, ...args }) =>
        Effect.gen(function* () {
          const binding = yield* Binding.Binding;
          const declaration = binding.manifest.uses[alias];
          if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "notion")
            return yield* new ConnectionNotDeclared({});
          return yield* DevDoor.read(
            instance,
            {
              op: `notion.${name}`,
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
  return {
    "notion.listRows": read("listRows", NotionListRows, notionReads.listRows.output),
    "notion.getRow": read("getRow", NotionGetRow, notionReads.getRow.output),
    "notion.markdown": read("markdown", NotionMarkdown, notionReads.markdown.output),
    "notion.search": read("search", NotionSearch, notionReads.search.output),
    "notion.listPeople": read("listPeople", NotionListPeople, notionReads.listPeople.output)
  };
});
