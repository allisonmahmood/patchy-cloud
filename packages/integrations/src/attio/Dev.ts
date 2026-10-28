/**
 * Attio's dev binding is the real workspace (ADR-0013): hand-written CRM rows wouldn't resemble a
 * company's. `patchy dev` sends each read to the instance's dev door as the machine token's
 * person, whichever local viewer asked, with the revision the repo was generated from, so the
 * instance decodes by the snapshot the client was generated against. Attio can't be written
 * through Patchy, so every operation reads live.
 */
import {
  AttioGetEntry,
  AttioGetManyRecords,
  AttioGetRecord,
  AttioListEntries,
  AttioListMembers,
  AttioListRecords,
  attioReads,
  type AttioRead
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
  readonly [K in AttioRead]: (value: unknown) => Option.Option<typeof Schema.Json.Type>;
} = {
  listRecords: Schema.decodeUnknownOption(attioReads.listRecords.output),
  getRecord: Schema.decodeUnknownOption(attioReads.getRecord.output),
  getManyRecords: Schema.decodeUnknownOption(attioReads.getManyRecords.output),
  listEntries: Schema.decodeUnknownOption(attioReads.listEntries.output),
  getEntry: Schema.decodeUnknownOption(attioReads.getEntry.output),
  listMembers: Schema.decodeUnknownOption(attioReads.listMembers.output)
};

/** The six reads for `patchy dev`: the local manifest routes, the instance reads. */
export const handlers = Effect.fn("AttioDev.handlers")(function* (instance: DevDoor.Instance) {
  const http = yield* HttpClient.HttpClient;
  const read =
    <K extends AttioRead>(name: K) =>
    ({ connection: alias, ...args }: { readonly connection: string }) =>
      Effect.gen(function* () {
        const binding = yield* Binding.Binding;
        const declaration = binding.manifest.uses[alias];
        if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "attio")
          return yield* new ConnectionNotDeclared({});
        return yield* DevDoor.read(
          instance,
          {
            op: `attio.${name}`,
            connection: {
              id: declaration.id,
              handle: declaration.handle,
              revision: declaration.revision
            },
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
    "attio.listRecords": handler(AttioListRecords, read("listRecords")),
    "attio.getRecord": handler(AttioGetRecord, read("getRecord")),
    "attio.getManyRecords": handler(AttioGetManyRecords, read("getManyRecords")),
    "attio.listEntries": handler(AttioListEntries, read("listEntries")),
    "attio.getEntry": handler(AttioGetEntry, read("getEntry")),
    "attio.listMembers": handler(AttioListMembers, read("listMembers"))
  };
});
