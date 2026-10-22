/**
 * PROTOTYPE (Pidgeon): `patchy dev`'s binding (ADR-0013's default). An integration that sends
 * mail never reaches the real address while someone builds: each declared connection gets a fake
 * mailbox seeded from the repo's `fixtures/pidgeon-<handle>.json`, and Patchy's own operations
 * run against it unchanged. Sends land in that mailbox and in dev's log, nowhere else.
 */
import { type PidgeonCall, PidgeonRead, type PidgeonSnapshot, PidgeonWrite } from "@patchy/api";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Fake from "./Fake.js";
import * as Operations from "./Operations.js";
import * as Source from "./Source.js";

/** The repo's fixture isn't a mailbox dev can load. */
export class FixtureInvalid extends Schema.TaggedError<FixtureInvalid>()("PidgeonFixtureInvalid", {
  path: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `${this.path} isn't a Pidgeon fixture dev can load: ${String(this.cause)}`;
  }
}

/** Reads `fixtures/pidgeon-<handle>.json`'s contents, as an agent wrote them. */
export const parseFixture = (path: string, contents: string) =>
  Effect.try({
    try: () => Fake.decodeFixture(contents),
    catch: (cause) => new FixtureInvalid({ path, cause })
  });

/** One declared connection's fake mailbox: what connect saw, and the fixture's mail. */
export interface Mailbox {
  readonly declarationId: string;
  readonly snapshot: PidgeonSnapshot;
  readonly fixture: Fake.Fixture;
}

export const handlers = (mailboxes: ReadonlyArray<Mailbox>) => {
  const workspaces = new Map(
    mailboxes.map((mailbox) => [
      mailbox.declarationId,
      {
        email: mailbox.snapshot.address.email,
        workspace: Fake.fromFixture(
          mailbox.fixture,
          mailbox.snapshot.address,
          mailbox.snapshot.access
        )
      }
    ])
  );
  const handle = Effect.fn("PidgeonDev.call")(function* (
    args: PidgeonCall & { readonly connection: string }
  ) {
    const binding = yield* Binding.Binding;
    const declaration = binding.manifest.uses[args.connection];
    if (!Object.hasOwn(binding.manifest.uses, args.connection) || declaration?.kind !== "pidgeon")
      return yield* new Operations.ConnectionNotDeclared({});
    const found = workspaces.get(declaration.id);
    if (found === undefined) return yield* new Runtime.AccessDenied({});
    const api: Operations.Api = (request) =>
      Effect.suspend(() => {
        const query = new URLSearchParams();
        for (const [name, value] of Object.entries(request.query ?? {}))
          if (value !== undefined) query.set(name, String(value));
        const answer = found.workspace.respond(`${Fake.KEY_PREFIX}dev`, {
          method: request.method,
          path: request.path,
          query,
          body: request.body,
          idempotencyKey: request.idempotencyKey
        });
        return Source.interpret(answer);
      });
    const call = { operation: args.operation, input: args.input } as PidgeonCall;
    const result = yield* Operations.run(
      api,
      { email: found.email, identityId: Fake.IDENTITY_ID, connectionId: declaration.id },
      call
    ).pipe(
      Effect.catchTags({
        PidgeonKeyRejected: () => Effect.fail(new Operations.ConnectionRefused({}))
      })
    );
    if (call.operation === "messages.send" || call.operation === "messages.reply")
      yield* Effect.logInfo(
        `pidgeon (fake): ${Operations.recorded.resource({ operation: call.operation, input: call.input })} — kept in dev's fake mailbox, not sent`
      );
    return result as typeof Schema.Json.Type;
  });
  return {
    "pidgeon.read": Runtime.handler(
      { kind: "integration", input: PidgeonRead, output: Schema.Json },
      handle
    ),
    "pidgeon.write": Runtime.handler(
      { kind: "integration", input: PidgeonWrite, output: Schema.Json },
      handle
    )
  };
};
