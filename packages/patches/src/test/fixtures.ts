/**
 * Users and machines added to the seeded template. Production Patches never
 * imports Auth: handlers receive identities from the bearer middleware.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import {
  Authorization,
  CurrentIdentity,
  Identity,
  CURRENT_RELEASE,
  MANIFEST_VERSION,
  WIRE_VERSION,
  refuse,
  Unauthorized
} from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { ResourceChanges } from "@patchy/company-database";
import * as CompanyTesting from "@patchy/company-database/testing";
import { ContentStore } from "@patchy/content-store";
import { contentHash, newInternalId, newPatchId } from "@patchy/core";
import { Tables } from "@patchy/primitives";
import { SqlConnectionStore, CredentialKeys, PostgresSource } from "@patchy/integrations";
import { RuntimeLog, Wakes } from "@patchy/runtime";
import type * as Content from "../Content.js";
import * as Patches from "../Patches.js";

export const manifest = {
  manifestVersion: MANIFEST_VERSION,
  release: CURRENT_RELEASE,
  tier: 0 as const,
  tables: {},
  files: {},
  uses: {}
};
export const publishRecord = () => ({
  manifest,
  wireVersion: WIRE_VERSION,
  publishKey: crypto.randomUUID(),
  payloadDigest: "fixture",
  publicBaseUrl: "https://patchy.example",
  warnings: []
});

/** Direct persistence tests still honour the durable object-intent contract. */
export const record = (input: Patches.RecordInput) =>
  Effect.flatMap(Patches.Patches, (patches) =>
    patches.prepareObject(input.objectKey).pipe(Effect.andThen(patches.record(input)))
  );

/** The provenance a fixture publish leaves empty. */
const noProvenance = {
  filename: null,
  repoOrg: null,
  repoName: null,
  cliVersion: null,
  gitBranch: null,
  gitCommitSha: null,
  sourceIp: null,
  userAgent: null
} as const;

/** A `Content.publish` input creating a patch as `identity`; override any field. */
export const publishInput = (
  identity: Identity,
  overrides: Partial<Content.PublishInput> = {}
): Content.PublishInput => ({
  ...publishRecord(),
  ...noProvenance,
  patchId: null,
  companyId: identity.company.id,
  ownerUserId: identity.user.id,
  machineTokenId: identity.machine.id,
  title: "Fixture patch",
  html: "<p>Fixture patch</p>",
  ...overrides
});

/**
 * A `record` input creating a patch as `identity`, with fresh patch and version
 * ids and an object key under the patch; override any field.
 */
export const recordInput = (
  identity: Identity,
  overrides: Partial<Patches.RecordInput> = {}
): Patches.RecordInput => {
  const patchId = overrides.patchId ?? newPatchId();
  const versionId = overrides.versionId ?? newInternalId("ver");
  return {
    ...publishRecord(),
    ...noProvenance,
    intent: "create",
    patchId,
    versionId,
    companyId: identity.company.id,
    ownerUserId: identity.user.id,
    machineTokenId: identity.machine.id,
    title: "Fixture patch",
    objectKey: `patches/${patchId}/versions/${versionId}.html`,
    contentHash: contentHash(versionId),
    fileSize: 1,
    ...overrides
  };
};

/**
 * An in-memory content store. `afterPut` runs after every stored put, so a test
 * can pause a publication or change its target between preflight and record.
 */
export const memoryStore = () => {
  const objects = new Map<string, { readonly bytes: Uint8Array; readonly lastModified: number }>();
  const control = { afterPut: Effect.void as Effect.Effect<void> };
  const write = (key: string, bytes: Uint8Array) =>
    Effect.map(Clock.currentTimeMillis, (lastModified) => {
      objects.set(key, { bytes, lastModified });
    });
  const read = (key: string) =>
    Effect.suspend(() => {
      const bytes = objects.get(key)?.bytes;
      return bytes === undefined
        ? Effect.fail(new ContentStore.ObjectNotFound({ key }))
        : Effect.succeed(bytes.slice());
    });
  const service = ContentStore.ContentStore.of({
    list: (prefix) =>
      Stream.suspend(() =>
        Stream.fromIterable(
          [...objects]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, object]) => ({ key, lastModified: object.lastModified }))
        )
      ),
    put: (key, html) =>
      write(key, new TextEncoder().encode(html)).pipe(
        Effect.andThen(Effect.suspend(() => control.afterPut))
      ),
    get: (key) =>
      Effect.map(read(key), (bytes) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)),
    putBytes: (key, bytes) => write(key, bytes.slice()),
    getBytes: read,
    delete: (key) => Effect.sync(() => void objects.delete(key))
  });
  return {
    service,
    control,
    layer: Layer.succeed(ContentStore.ContentStore, service),
    keys: Effect.sync(() => [...objects.keys()].sort())
  };
};

/** `sql` whose transactions go through `withTransaction`, to hold or fail them from a test. */
export const withTransactions = (
  sql: SqlClient.SqlClient,
  withTransaction: SqlClient.SqlClient["withTransaction"]
): SqlClient.SqlClient =>
  new Proxy(sql, {
    get: (target, property, receiver) =>
      property === "withTransaction" ? withTransaction : Reflect.get(target, property, receiver)
  });

const company = {
  id: DEV_SEED.companyId,
  handle: DEV_SEED.companyHandle,
  name: DEV_SEED.companyName
};

/** The identities the tests act as; two machines may act as the same user. */
export const identities = {
  admin: new Identity({
    user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
    company,
    role: DEV_SEED.role,
    machine: { id: DEV_SEED.tokenId, name: DEV_SEED.tokenName }
  }),
  uploader: new Identity({
    user: { id: "usr_uploader", email: "uploader@patchy.local", name: "Uploader" },
    company,
    role: "member",
    machine: { id: "tok_uploader", name: "Upload machine" }
  }),
  sibling: new Identity({
    user: { id: "usr_uploader", email: "uploader@patchy.local", name: "Uploader" },
    company,
    role: "member",
    machine: { id: "tok_sibling", name: "Sibling machine" }
  }),
  reader: new Identity({
    user: { id: "usr_reader", email: "reader@patchy.local", name: "Reader" },
    company,
    role: "member",
    machine: { id: "tok_reader", name: "Reader machine" }
  }),
  quota: new Identity({
    user: { id: "usr_quota", email: "quota@patchy.local", name: "Quota" },
    company,
    role: "member",
    machine: { id: "tok_quota", name: "Quota machine" }
  }),
  quotaSibling: new Identity({
    user: { id: "usr_quota", email: "quota@patchy.local", name: "Quota" },
    company,
    role: "member",
    machine: { id: "tok_quota_sibling", name: "Second quota machine" }
  })
} as const;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const identity of Object.values(identities)) {
    if (identity.machine.id === DEV_SEED.tokenId) continue;
    yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES (${identity.user.id}, ${`clerk_${identity.user.id}`}, ${identity.company.id},
              ${identity.user.email}, ${identity.user.name}, ${identity.role})
      ON CONFLICT (id) DO NOTHING`;
    yield* sql`INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
      VALUES (${identity.machine.id}, ${identity.user.id}, ${identity.machine.name},
              ${`hash:${identity.machine.id}`}, now(), now() + interval '90 days', now())`;
  }
});

export const integrations = SqlConnectionStore.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 1).toString("base64")}`)),
      PostgresSource.layer,
      RuntimeLog.layer
    )
  )
);

export const resourceChanges = Layer.effect(
  ResourceChanges.ResourceChanges,
  Effect.map(Wakes.Wakes, (wakes) => ResourceChanges.ResourceChanges.of({ publish: wakes.publish }))
).pipe(Layer.provideMerge(Wakes.layer));

/** The seeded template with the additional users and machines above. */
export const database = Layer.mergeAll(Layer.effectDiscard(seed), Tables.layer, integrations).pipe(
  Layer.provideMerge(CompanyTesting.layer()),
  Layer.provideMerge(resourceChanges)
);

/** The server side of the bearer middleware: the credential is the machine's id. */
export const authorization = Layer.succeed(
  Authorization,
  Authorization.of({
    bearer: (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        const identity = Object.values(identities).find((it) => it.machine.id === token);
        if (identity === undefined) {
          return refuse(Unauthorized, {
            ok: false,
            error: "Missing or invalid API token."
          });
        }
        return yield* Effect.provideService(httpEffect, CurrentIdentity, identity);
      })
  })
);

/** The client side: present this identity's credential on every request. */
export const as = (identity: Identity) =>
  HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, identity.machine.id))
  );

/**
 * Runs an in-memory `HttpApiTest` client on a router of its own. A suite that
 * also serves on a socket sees the router `HttpRouter.serve` built, and the
 * client would otherwise register its routes on the server's router.
 */
export const ownRouter = <A, E, R>(client: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.updateContext(
    client,
    // The client builds its own router when none is present, so removing it keeps R.
    (context: Context.Context<R>) =>
      Context.omit(HttpRouter.HttpRouter)(context) as Context.Context<R>
  );
