/**
 * The dev instance's server entrypoint: the server as production's `start.ts` launches it, except
 * that mailboxes `pnpm dev up` started on this machine are reached on loopback, under the hosts
 * their certificates name. Only the dev runner's supervisor starts this file; no production host
 * runs it, and production's entrypoint never includes the loopback network.
 *
 * `PATCHY_DEV_MAILBOXES` names the file listing them, which is read again for every session, so
 * a mailbox added to a running instance works at once. A missing file means none.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the network seam asks synchronously, once per session.
import { readFileSync } from "node:fs";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ImapNetwork } from "@patchy/integrations";
import { launch } from "@patchy/server/launch";

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ImapNetwork.LoopbackServer))
);
const listed = (file: string) => (): ReadonlyArray<ImapNetwork.LoopbackServer> => {
  try {
    return Option.getOrElse(decode(readFileSync(file, "utf8")), () => []);
  } catch {
    return [];
  }
};

launch(
  Layer.unwrap(
    Effect.map(Config.option(Config.String("PATCHY_DEV_MAILBOXES")), (file) =>
      ImapNetwork.loopback(Option.isSome(file) ? listed(file.value) : () => [])
    )
  )
);
