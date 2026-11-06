/**
 * IMAP's dev binding is the real mailbox (ADR-0013): mail a builder's agent invents never
 * resembles a company's. `patchy dev` sends each read to the instance's dev door as the machine
 * token's person, whichever local viewer asked; the instance borrows a session from the same pool
 * and gates published patches use. Nothing can change the mailbox through Patchy, so every
 * operation reads live.
 *
 * An attachment comes back as bytes over the door's private transport, at most
 * `files.stage.bytes`, and is staged in the local store once its size and sha256 match what the
 * instance stated: a transfer that ends short, differs or runs over stages nothing.
 */
import {
  ImapFolderStatus,
  ImapGetMessages,
  ImapListFolders,
  ImapListMessages,
  ImapScanMessages,
  ImapSearchMessages,
  ImapStageAttachment,
  imapReads,
  imapStageAttachment,
  type ImapRead
} from "@patchy/api";
import { Cryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import { Binding, FileStaging, Runtime } from "@patchy/runtime/core";
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

const encodeStaged = Schema.encodeEffect(imapStageAttachment.output);

/**
 * The reads and the stage for `patchy dev`: the local manifest routes, the instance reads, and an
 * attachment stages in `staging`, the dev daemon's own store.
 */
export const handlers = Effect.fn("ImapDev.handlers")(function* (
  instance: DevDoor.Instance,
  staging: FileStaging.FileStaging["Service"]
) {
  const http = yield* HttpClient.HttpClient;
  const cryptography = yield* Cryptography.Cryptography;
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
  const stage = ({ connection: alias, ...args }: typeof ImapStageAttachment.Type) =>
    Effect.gen(function* () {
      const binding = yield* Binding.Binding;
      const declaration = binding.manifest.uses[alias];
      if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "imap")
        return yield* new ConnectionNotDeclared({});
      const maxBytes = yield* ContractLimits.get("files.stage.bytes");
      const { bytes, meta } = yield* DevDoor.attachment(
        instance,
        {
          op: "imap.stageAttachment",
          connection: { id: declaration.id, handle: declaration.handle },
          args
        },
        maxBytes
      ).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(Cryptography.Cryptography, cryptography)
      );
      const staged = yield* staging.stage(bytes, meta.contentType);
      return yield* encodeStaged({
        ok: true,
        upload: staged.upload,
        size: staged.upload.size,
        sha256: staged.sha256,
        contentType: staged.upload.contentType,
        filename: meta.filename
      }).pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
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
    "imap.getMessages": handler(ImapGetMessages, read("getMessages")),
    "imap.stageAttachment": handler(ImapStageAttachment, stage)
  };
});
