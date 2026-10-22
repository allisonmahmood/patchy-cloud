import {
  SalesforceQuery,
  SalesforceDescribe,
  SalesforceRows,
  SalesforceDescription
} from "@patchy/api";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as ConnectionStore from "../ConnectionStore.js";
import * as Nango from "../Nango.js";
import * as Source from "./Source.js";
import { operation } from "../definition.js";

const Errors = Schema.Union([
  Nango.Failed,
  Runtime.AccessDenied,
  Runtime.InvalidRequest,
  Runtime.SourceUnavailable
]);
/** Shared by production and the existing machine-token dev door. */
const read = Effect.fn("Salesforce.read")(function* <E>(
  target: {
    readonly companyId: string;
    readonly connection: { readonly id: string; readonly handle: string };
    readonly recheck: Effect.Effect<void, E>;
  },
  run: (mapping: Nango.Mapping) => Effect.Effect<unknown, Nango.Failed>
) {
  yield* target.recheck;
  const store = yield* ConnectionStore.ConnectionStore;
  const connection = yield* store
    .get(target.companyId, target.connection.id)
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ConnectionNotFound" ? cause : new Runtime.SourceUnavailable({ cause })
      )
    );
  if (
    connection.integration !== "salesforce" ||
    connection.companyId !== target.companyId ||
    connection.handle !== target.connection.handle
  )
    return yield* new ConnectionStore.ConnectionNotFound({
      companyId: target.companyId,
      lookup: { id: target.connection.id }
    });
  if (connection.status !== "connected")
    return yield* new ConnectionStore.ConnectionNotConnected({});
  const secret = yield* store
    .poolCredentials(
      target.companyId,
      {
        kind: "salesforce",
        id: connection.id,
        handle: connection.handle,
        revision: connection.metadataRevision
      },
      connection.credentialRevision
    )
    .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
  return yield* run(yield* Source.parseCredentials(secret));
});
const bound = Effect.fn("Salesforce.bound")(function* (
  alias: string,
  run: (mapping: Nango.Mapping) => Effect.Effect<unknown, Nango.Failed>
) {
  const binding = yield* Binding.Binding;
  const declaration = binding.manifest.uses[alias];
  if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "salesforce")
    return yield* new Runtime.InvalidRequest({});
  if (
    binding.scope !== "company" ||
    binding.identity === null ||
    binding.principal === null ||
    binding.identity.company.id !== binding.companyId ||
    binding.identity.user.id !== binding.principal.userId
  )
    return yield* new Runtime.AccessDenied({});
  return yield* read(
    { companyId: binding.companyId, connection: declaration, recheck: Effect.void },
    run
  ).pipe(
    Effect.catchTags({
      ConnectionNotFound: (cause) => Effect.fail(new Runtime.AccessDenied({ cause })),
      ConnectionNotConnected: (cause) => Effect.fail(new Runtime.AccessDenied({ cause }))
    })
  );
});
const decodeRows = Schema.decodeUnknownEffect(SalesforceRows);
const decodeDescription = Schema.decodeUnknownEffect(SalesforceDescription);
const query = operation({
  input: SalesforceQuery,
  output: SalesforceRows,
  errors: Errors,
  run: (args: typeof SalesforceQuery.Type) =>
    bound(args.connection, (mapping) => Source.query(mapping, args.request)).pipe(
      Effect.flatMap(decodeRows),
      Effect.mapError((cause) =>
        cause._tag === "SchemaError" ? new Nango.Failed({ stage: "response" }) : cause
      )
    )
});
const describe = operation({
  input: SalesforceDescribe,
  output: SalesforceDescription,
  errors: Errors,
  run: (args: typeof SalesforceDescribe.Type) =>
    bound(args.connection, (mapping) => Source.describeObject(mapping, args.object)).pipe(
      Effect.flatMap(decodeDescription),
      Effect.mapError((cause) =>
        cause._tag === "SchemaError" ? new Nango.Failed({ stage: "response" }) : cause
      )
    )
});
export const operations = { query, describe };
const recorded = {
  resource: (args: unknown) =>
    Predicate.isObject(args) && typeof args.object === "string" ? args.object : null,
  rowCount: (value: unknown) =>
    Predicate.isObject(value) && Array.isArray(value.rows) ? value.rows.length : null,
  // SOQL may contain literal customer values; do not record it.
  sql: (): string | undefined => undefined
};
export const makeHandlers = Effect.gen(function* () {
  const store = yield* ConnectionStore.ConnectionStore;
  const nango = yield* Effect.serviceOption(Nango.Nango);
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ConnectionStore.ConnectionStore, store),
      Effect.provideService(
        Nango.Nango,
        nango.pipe(
          // A disabled adapter fails only when used, preserving all existing integration paths.
          Option.getOrElse(() =>
            Nango.Nango.of({
              request: () => Effect.fail(new Nango.Failed({ stage: "configuration" }))
            })
          )
        )
      )
    );
  const connectionId = (args: unknown, binding: Binding.Binding["Service"]) => {
    const declaration =
      Predicate.isObject(args) &&
      typeof args.connection === "string" &&
      Object.hasOwn(binding.manifest.uses, args.connection)
        ? binding.manifest.uses[args.connection]
        : undefined;
    return declaration?.kind === "salesforce" ? declaration.id : null;
  };
  return {
    "salesforce.query": Runtime.handler(
      { kind: "integration", ...query, ...recorded, connectionId },
      (args) => provide(query.run(args))
    ),
    "salesforce.describe": Runtime.handler(
      { kind: "integration", ...describe, ...recorded, connectionId },
      (args) => provide(describe.run(args))
    )
  };
});

const decodeDevQuery = Schema.decodeUnknownEffect(
  Schema.Struct({ request: SalesforceQuery.fields.request }),
  { onExcessProperty: "error" }
);
const decodeDevDescribe = Schema.decodeUnknownEffect(
  Schema.Struct({ object: SalesforceDescribe.fields.object }),
  { onExcessProperty: "error" }
);
export const devReads: Readonly<
  Record<"salesforce.query" | "salesforce.describe", import("../posthog/Operations.js").DevRead>
> = {
  "salesforce.query": {
    ...recorded,
    run: (target, args) =>
      decodeDevQuery(args).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })),
        Effect.flatMap((args) => read(target, (mapping) => Source.query(mapping, args.request)))
      )
  },
  "salesforce.describe": {
    ...recorded,
    run: (target, args) =>
      decodeDevDescribe(args).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })),
        Effect.flatMap((args) =>
          read(target, (mapping) => Source.describeObject(mapping, args.object))
        )
      )
  }
};
