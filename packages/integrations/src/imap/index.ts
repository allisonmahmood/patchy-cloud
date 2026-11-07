import { ImapSnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import { defineIntegration } from "../definition.js";
import { generate } from "./Generate.js";
import { operations } from "./Operations.js";
import * as Source from "./Source.js";

const metadata = {
  schema: ImapSnapshot,
  discover: Effect.fn("Imap.metadata.discover")(function* (credentials: Source.Credentials) {
    const source = yield* Source.Source;
    return yield* source.inspect(Source.settings(credentials));
  })
};

// Keep declaration emission pointed at the operation module's public types.
export const imap: {
  readonly name: "imap";
  readonly modes: readonly ["company"];
  readonly credentials: typeof Source.Credentials;
  readonly metadata?: typeof metadata;
  readonly operations: typeof operations;
  readonly generate: typeof generate;
  readonly live?: ReadonlyArray<keyof typeof operations>;
} = defineIntegration({
  name: "imap",
  modes: ["company"],
  credentials: Source.Credentials,
  metadata,
  operations,
  generate,
  // Mail a builder's agent invents never resembles a company's: dev reads the real mailbox.
  live: [
    "listFolders",
    "folderStatus",
    "scanMessages",
    "listMessages",
    "searchMessages",
    "getMessages"
  ]
});
