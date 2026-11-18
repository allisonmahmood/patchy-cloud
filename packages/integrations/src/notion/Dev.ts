import { NotionListRows, notionReads } from "@patchy/api";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as DevDoor from "../DevDoor.js";
import { ConnectionNotDeclared } from "./Operations.js";

const decode = Schema.decodeUnknownOption(notionReads.listRows.output);

export const handlers = Effect.fn("NotionDev.handlers")(function* (instance: DevDoor.Instance) {
  const http = yield* HttpClient.HttpClient;
  return {
    "notion.listRows": Runtime.handler(
      {
        kind: "integration",
        input: NotionListRows,
        output: notionReads.listRows.output
      },
      ({ connection: alias, ...args }) =>
        Effect.gen(function* () {
          const binding = yield* Binding.Binding;
          const declaration = binding.manifest.uses[alias];
          if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "notion")
            return yield* new ConnectionNotDeclared({});
          return yield* DevDoor.read(
            instance,
            {
              op: "notion.listRows",
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
    )
  };
});
