/**
 * IMAP's dev binding is the real mailbox (ADR-0013): mail a builder's agent invents never
 * resembles a company's. `patchy dev` sends each read to the instance's dev door as the machine
 * token's person, whichever local viewer asked; the instance borrows a session from the same pool
 * and gates published patches use. Nothing can change the mailbox through Patchy, so every
 * operation reads live.
 */
import {
  ImapFolderStatus,
  ImapGetMessages,
  ImapListFolders,
  ImapListMessages,
  ImapScanMessages,
  ImapSearchMessages,
  imapReads,
  type ImapRead
} from "@patchy/api";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as DevDoor from "../DevDoor.js";
import { ConnectionNotDeclared } from "./Operations.js";

/** Each read's answer held to that read's wire before the patch sees it. */
const answers: {
  readonly [K in ImapRead]: (value: unknown) => Option.Option<typeof Schema.Json.Type>;
} = {
  listFolders: Schema.decodeUnknownOption(imapReads.listFolders.output),
  folderStatus: Schema.decodeUnknownOption(imapReads.folderStatus.output),
  scanMessages: Schema.decodeUnknownOption(imapReads.scanMessages.output),
  listMessages: Schema.decodeUnknownOption(imapReads.listMessages.output),
  searchMessages: Schema.decodeUnknownOption(imapReads.searchMessages.output),
  getMessages: Schema.decodeUnknownOption(imapReads.getMessages.output)
};

/** The six reads for `patchy dev`: the local manifest routes, the instance reads. */
export const handlers = Effect.fn("ImapDev.handlers")(function* (instance: DevDoor.Instance) {
  const http = yield* HttpClient.HttpClient;
  const read =
    <K extends ImapRead>(name: K) =>
    ({ connection: alias, ...args }: { readonly connection: string }) =>
      Effect.gen(function* () {
        const binding = yield* Binding.Binding;
        const declaration = binding.manifest.uses[alias];
        if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "imap")
          return yield* new ConnectionNotDeclared({});
        return yield* DevDoor.read(
          instance,
          {
            op: `imap.${name}`,
            connection: { id: declaration.id, handle: declaration.handle },
            args
          },
          answers[name]
        ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      });
  const handler = <I extends Schema.Top & Schema.Codec<unknown, unknown>>(
    input: I,
    run: (
      args: I["Type"]
    ) => Effect.Effect<typeof Schema.Json.Type, Runtime.RuntimeError, Binding.Binding>
  ) => Runtime.handler({ kind: "integration", input, output: Schema.Json }, run);
  return {
    "imap.listFolders": handler(ImapListFolders, read("listFolders")),
    "imap.folderStatus": handler(ImapFolderStatus, read("folderStatus")),
    "imap.scanMessages": handler(ImapScanMessages, read("scanMessages")),
    "imap.listMessages": handler(ImapListMessages, read("listMessages")),
    "imap.searchMessages": handler(ImapSearchMessages, read("searchMessages")),
    "imap.getMessages": handler(ImapGetMessages, read("getMessages"))
  };
});
