/**
 * The portal's test harness: one server with every portal route, real services over a migrated
 * database, and the people, patches, calls and page readers the surface tests share.
 */
import { assert } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  CURRENT_RELEASE,
  MANIFEST_VERSION,
  WIRE_VERSION,
  sharedTableId,
  sharedStoreId,
  type HandlerDescriptors
} from "@patchy/api";
import { Analytics } from "@patchy/analytics";
import { Feedback } from "@patchy/feedback";
import { Limits, OperatingLimits } from "@patchy/limits";
import { AgentConnections, MachineTokens, RequireSession, Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { contentHash, sha256 } from "../../../../test/crypto.js";
import * as Testing from "@patchy/company-database/testing";
import { ConnectionStore } from "@patchy/integrations";
import { ConnectionStoreDev } from "@patchy/integrations/dev";
import { GuestGrants, Patches } from "@patchy/patches";
import { Tables } from "@patchy/primitives";
import * as PortalPages from "../PortalPages.js";
import { InvocationLog, RuntimeLog, Wakes } from "@patchy/runtime";
import { NodeCryptography } from "@patchy/core";

export const DAY = 24 * 60 * 60 * 1_000;
export const events: Analytics.AnalyticsEvent[] = [];
export const recordingAnalytics = Layer.succeed(
  Analytics.Analytics,
  Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
);
/** The lifecycle events reported about one patch, in order, without its publishes. */
export const reported = (patchId: string) =>
  events.filter(
    (event) =>
      event.name !== "patch.created" &&
      event.name !== "patch.updated" &&
      "patchId" in event.properties &&
      event.properties.patchId === patchId
  );
export const routes = Layer.mergeAll(
  PortalPages.layer,
  HttpRouter.use((router) => router.add("GET", "/", RequireSession.withViewer(PortalPages.index)))
);
/** A company's user lifecycle events, as `[name, principal, user]`. */
export const lifecycleEvents = (companyId: string) =>
  events.flatMap((event) =>
    event.companyId === companyId &&
    (event.name === "user.deactivated" || event.name === "user.reactivated")
      ? [[event.name, event.principalId, event.properties.userId]]
      : []
  );
/** The cookies Clerk's backend answers a session refresh with, which a case sets. */
export const clerk = { refreshed: [] as Array<string> };
export const clerkBackend = HttpRouter.serve(
  HttpRouter.use((router) =>
    router.add(
      "POST",
      "/v1/sessions/:sid/refresh",
      Effect.sync(() =>
        HttpServerResponse.jsonUnsafe({ object: "cookies", cookies: clerk.refreshed })
      )
    )
  ),
  { disableLogger: true, disableListenLog: true }
).pipe(
  // A server of its own: layers memoize by reference, and the portal's routes use this one.
  Layer.provideMerge(Layer.fresh(NodeHttpServer.layerTest))
);
/** Sessions as production reads them, with that stub as Clerk's backend. */
export const session = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    if (server.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP");
    return Session.layer.pipe(
      Layer.provide(Layer.succeed(Session.backendApiUrl)(`http://127.0.0.1:${server.address.port}`))
    );
  })
).pipe(Layer.provide(clerkBackend));
export const services = Layer.mergeAll(
  GuestGrants.layer.pipe(Layer.provideMerge(Layer.mergeAll(Patches.layer, Users.layer))),
  session,
  Companies.layer,
  InvocationLog.layer,
  MachineTokens.layer,
  AgentConnections.layer,
  Limits.layer,
  Feedback.layer.pipe(Layer.provide(Layer.mergeAll(Limits.layer, OperatingLimits.layer)))
).pipe(
  Layer.provideMerge(recordingAnalytics),
  Layer.provideMerge(
    ConnectionStoreDev.layer([
      {
        connection: {
          id: "con_warehouse",
          companyId: "cmp_portal_log",
          integration: "postgres",
          handle: "warehouse",
          description: "The sales warehouse",
          mode: "company",
          status: "connected",
          blockGuests: false,
          display: { host: "db.example.com", port: 5432, database: "sales", role: "reader" },
          credentialRevision: 1,
          metadataRevision: 1,
          lastTestedAt: null,
          lastDiscoveredAt: null,
          createdBy: "usr_portal_log"
        } satisfies ConnectionStore.Connection,
        snapshots: []
      },
      {
        connection: {
          id: "con_payroll",
          companyId: "cmp_portal_guests",
          integration: "postgres",
          handle: "payroll",
          description: "Payroll",
          mode: "company",
          status: "connected",
          blockGuests: true,
          display: { host: "db.example.com", port: 5432, database: "payroll", role: "reader" },
          credentialRevision: 1,
          metadataRevision: 1,
          lastTestedAt: null,
          lastDiscoveredAt: null,
          createdBy: "usr_portal_guests"
        } satisfies ConnectionStore.Connection,
        snapshots: []
      },
      {
        // A mailbox its server stopped letting Patchy into, for Home's Needs attention.
        connection: {
          id: "con_home_mailbox",
          companyId: "cmp_portal_home",
          integration: "imap",
          handle: "support",
          description: "The support inbox",
          mode: "company",
          status: "connected",
          blockGuests: false,
          display: {
            host: "imap.example.com",
            port: 993,
            security: "tls",
            username: "support@example.com",
            paused: {
              at: "2026-01-01T00:00:00.000Z",
              reply: "AUTHENTICATIONFAILED",
              during: "call"
            }
          },
          credentialRevision: 1,
          metadataRevision: 1,
          lastTestedAt: null,
          lastDiscoveredAt: null,
          createdBy: "usr_portal_home"
        } satisfies ConnectionStore.Connection,
        snapshots: []
      }
    ])
  ),
  Layer.provideMerge(Tables.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(Testing.resourceChangesLayer),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv()))),
  Layer.provideMerge(Wakes.layer)
);
/** The portal on a test socket, over real services and a migrated database. */
export const socket = HttpRouter.serve(routes, {
  disableLogger: true,
  disableListenLog: true
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(services),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })),
  Layer.provideMerge(NodeCryptography.layer)
);

export interface Person {
  readonly id: string;
  readonly companyId: string;
  readonly clerkUserId: string;
  readonly email: string;
  readonly name: string;
  readonly role: "member" | "admin";
  readonly machineTokenId: string;
}
let counter = 0;
export const company = Effect.fn("PortalFixtures.company")(function* (companyId?: string) {
  yield* TestClock.setTime(1_767_225_600_000);
  const sql = yield* SqlClient.SqlClient;
  const id = companyId ?? `cmp_portal_${++counter}`;
  const handle = companyId === undefined ? `portal-${counter}` : `portal-${companyId.slice(11)}`;
  yield* sql`INSERT INTO companies (id, handle, name) VALUES (${id}, ${handle}, 'Northwind')`;
  const people: Person[] = [];
  for (const [name, role] of [
    ["Priya", "member"],
    ["Alex", "member"],
    ["Sam", "admin"]
  ] as const) {
    const userId = `usr_portal_${++counter}`;
    const person: Person = {
      id: userId,
      companyId: id,
      clerkUserId: `clerk_${userId}`,
      email: `${userId}@patchy.local`,
      name,
      role,
      machineTokenId: `tok_${userId}`
    };
    yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES (${person.id}, ${person.clerkUserId}, ${id}, ${person.email}, ${name}, ${role})`;
    yield* sql`INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
      VALUES (${person.machineTokenId}, ${person.id}, 'Portal test machine',
        ${`hash:${person.machineTokenId}`}, now(), now() + interval '90 days', now())`;
    people.push(person);
  }
  return { id, handle, owner: people[0]!, member: people[1]!, admin: people[2]! };
});
export const actor = (person: Person): Patches.Actor => ({
  userId: person.id,
  admin: person.role === "admin"
});
export const manifest = {
  manifestVersion: MANIFEST_VERSION,
  release: CURRENT_RELEASE,
  tier: 1 as const,
  tables: {},
  files: {},
  uses: {}
};
export const publish = Effect.fn("PortalFixtures.publish")(function* (
  person: Person,
  name: string,
  overrides: Partial<Patches.RecordInput> = {}
) {
  const ordinal = ++counter;
  const patchId = overrides.patchId ?? `p${String(ordinal).padStart(11, "0")}`;
  const input: Patches.RecordInput = {
    intent: "create",
    patchId,
    companyId: person.companyId,
    ownerUserId: person.id,
    machineTokenId: person.machineTokenId,
    versionId: `ver_portal_${ordinal}`,
    objectKey: `patches/${patchId}/versions/${ordinal}.html`,
    contentHash: contentHash(String(ordinal)),
    fileSize: 1,
    filename: "patch.html",
    // Lists and the card show the title; a title equal to the name keeps most cases about the name.
    title: name,
    description: "Find the right person. Includes the whole company.",
    repoOrg: null,
    repoName: null,
    cliVersion: null,
    gitBranch: null,
    gitCommitSha: null,
    sourceIp: null,
    userAgent: null,
    manifest: { ...manifest, name },
    wireVersion: WIRE_VERSION,
    publishKey: `portal-publish-${ordinal}`,
    payloadDigest: `portal-payload-${ordinal}`,
    publicBaseUrl: PUBLIC_BASE_URL,
    warnings: [],
    ...overrides
  };
  const patches = yield* Patches.Patches;
  yield* patches.preflight(input);
  yield* patches.prepareObject(input.objectKey);
  if (input.server) yield* patches.prepareObject(input.server.objectKey);
  return yield* patches.record(input);
});
export const publishSource = Effect.fn("PortalFixtures.publishSource")(function* (
  person: Person,
  name: string,
  kind: "table" | "store" = "table"
) {
  return yield* publish(person, name, {
    filename: null,
    manifest: {
      ...manifest,
      name,
      tier: 1,
      tables:
        kind === "table"
          ? {
              notes: {
                description: "Notes keyed by id",
                columns: { body: { kind: "text" } },
                indexes: {},
                shared: true
              }
            }
          : {},
      files:
        kind === "store"
          ? { photos: { description: "Photos keyed by file name.", shared: true } }
          : {}
    }
  });
});
export const sourceDeclaration = (patchId: string) => ({
  kind: "sharedTable" as const,
  patchId,
  table: "notes",
  id: sharedTableId(patchId, "notes"),
  revision: 1
});
export const publishDependant = Effect.fn("PortalFixtures.publishDependant")(function* (
  person: Person,
  name: string,
  sourceId: string,
  kind: "table" | "store" = "table"
) {
  return yield* publish(person, name, {
    manifest: {
      ...manifest,
      name,
      tier: 2,
      uses: {
        source:
          kind === "table"
            ? sourceDeclaration(sourceId)
            : {
                kind: "sharedStore",
                patchId: sourceId,
                store: "photos",
                id: sharedStoreId(sourceId, "photos"),
                revision: 1
              }
      }
    }
  });
});
export const readPatch = Effect.fn("PortalFixtures.readPatch")(function* (
  person: Person,
  patchId: string
) {
  const rows = yield* (yield* Patches.Patches).read({
    companyId: person.companyId,
    userId: person.id,
    canOpen: () => true,
    state: "all",
    patchRef: patchId
  });
  assert.strictEqual(rows.length, 1);
  return rows[0]!;
});
export type FormFields = Record<string, string | readonly string[]>;
export const sessionCookie = (person: Person, sid = "sess_offline") =>
  signedInCookies(
    signSession({ sub: person.clerkUserId, email: person.email, name: person.name, sid })
  );
/** A confirmation posted without, then with, the acknowledgement box ticked. */
export const acknowledgements: ReadonlyArray<FormFields> = [{}, { ack: "on" }];
export const request = Effect.fn("PortalFixtures.request")(function* (
  path: string,
  person: Person | null,
  fields?: FormFields,
  headers: Record<string, string> = {}
) {
  const client = yield* HttpClient.HttpClient;
  const { sid, ...rest } = headers;
  const cookie = person === null ? "" : sessionCookie(person, sid);
  const input =
    fields === undefined
      ? HttpClientRequest.get(path)
      : HttpClientRequest.post(path).pipe(
          HttpClientRequest.bodyText(
            new URLSearchParams(
              Object.entries(fields).flatMap(([name, value]) =>
                typeof value === "string" ? [[name, value]] : value.map((item) => [name, item])
              )
            ).toString(),
            "application/x-www-form-urlencoded"
          )
        );
  return yield* client.execute(input.pipe(HttpClientRequest.setHeaders({ cookie, ...rest })));
});
export const post = (path: string, person: Person, fields: FormFields) =>
  request(path, person, fields, { origin: PUBLIC_BASE_URL });
/** The receipt a form's redirect leaves, as the page it lands on shows it, once. */
export const receiptAfter = Effect.fn("PortalFixtures.receiptAfter")(function* (
  response: HttpClientResponse.HttpClientResponse,
  person: Person
) {
  const page = yield* request(response.headers.location!, person, undefined, {
    cookie: `${sessionCookie(person)}; ${Cookies.toCookieHeader(response.cookies)}`
  });
  const html = yield* page.text;
  return text(html.match(/<p class="note note-ok app-receipt"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");
});
/** The page a Share dialog's form lands on, with the receipt its dialog shows, once. */
export const dialogAfter = Effect.fn("PortalFixtures.dialogAfter")(function* (
  response: HttpClientResponse.HttpClientResponse,
  person: Person
) {
  const page = yield* request(response.headers.location!, person, undefined, {
    cookie: `${sessionCookie(person)}; ${Cookies.toCookieHeader(response.cookies)}`
  });
  const html = yield* page.text;
  const dialog = shareDialog(html);
  return {
    html: dialog,
    receipt: text(dialog.match(/<p class="receipt" role="status">([\s\S]*?)<\/p>/)?.[1] ?? "")
  };
});
/** The Share dialog over a page, or nothing. */
export const shareDialog = (html: string) =>
  html.match(/<section class="dialog[^"]*" id="share"[\s\S]*<\/section>/)?.[0] ?? "";
export const text = (html: string) =>
  html
    // The not-opened-yet dot holds a name's last character, which still reads as part of the name.
    .replace(/<span class="unopened">([^<]*)<span class="unseen"[^>]*><\/span><\/span>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export const heading = (html: string) => text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
export const links = (html: string) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({
    href: match[1]!,
    text: text(match[2]!)
  }));
export const forms = (html: string) =>
  [...html.matchAll(/<form\b[^>]*action="([^"]*)"[^>]*>/g)].map((match) => match[1]!);
export const hidden = (html: string, name: string) =>
  html.match(
    new RegExp(`<input\\b(?=[^>]*\\bname="${name}")(?=[^>]*\\bvalue="([^"]*)")[^>]*>`)
  )?.[1];
/** The hidden fields of the first POST form on the page that submits to `action`. */
export const formFields = (html: string, action: string): FormFields =>
  Object.fromEntries(
    [
      ...(
        html.match(
          new RegExp(
            `<form\\b(?=[^>]*method="post")[^>]*action="${action}"[^>]*>([\\s\\S]*?)</form>`
          )
        )?.[1] ?? ""
      ).matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)
    ].map((match) => [match[1]!, match[2]!])
  );
export const inputs = (html: string, name: string, type: string) =>
  [...html.matchAll(/<input\b[^>]*>/g)]
    .map((match) => match[0])
    .filter(
      (input) =>
        input.includes(`name="${name}"`) &&
        (input.includes(`type="${type}"`) || (type === "text" && !/\btype=/.test(input)))
    );
export const radioValues = (html: string) =>
  inputs(html, "user", "radio").map((input) => input.match(/\bvalue="([^"]*)"/)?.[1]);
export const inputValues = (html: string, name: string, type: string) =>
  inputs(html, name, type)
    .filter((input) => !/\bdisabled\b/.test(input))
    .map((input) => input.match(/\bvalue="([^"]*)"/)?.[1]);
export const userPath = (person: Person, action: "deactivate" | "reactivate") =>
  `/settings/people/users/${person.id}/${action}`;
export const readUser = Effect.fn("PortalFixtures.readUser")(function* (person: Person) {
  const user = yield* (yield* Users.Users).findByClerkId(person.clerkUserId);
  assert.isNotNull(user);
  return user!;
});
export const cardPath = (name: string) => `/patches/${name}`;
/** The patch titles in All patches' table, in order; fixtures title a patch by its name. */
export const listed = (html: string) =>
  [
    ...(html.match(/<tbody>([\s\S]*)<\/tbody>/)?.[1] ?? "").matchAll(
      /<a class="row-link" href="[^"]*">([\s\S]*?)<\/a>/g
    )
  ]
    .map((match) => text(match[1]!))
    .filter((name) => /^[a-z0-9-]+$/.test(name));
/** The labels in one row's action menu, by its id: a patch's id, on Home after its shelf's. */
export const menuItems = (html: string, id: string) =>
  text(html.match(new RegExp(`<div class="menu" id="menu-${id}"[\\s\\S]*?</div>`))?.[0] ?? "");
export const assertStale = (html: string, action: string) => {
  assert.include(
    text(html),
    `This patch changed while you had this page open: ${action} by Sam 2 minutes ago. Nothing was done.`
  );
  assert.notInclude(text(html), "revision");
};

export interface Seed {
  readonly companyId: string;
  readonly patchId: string;
  readonly versionId: string;
}
/** Writes one settled invocation the way Runtime does, starting now; returns its id. */
export const invoke = Effect.fn("PortalFixtures.invoke")(function* (
  seed: Seed,
  viewer: Person,
  input: {
    readonly handler: string;
    readonly kind: "query" | "mutation" | "action";
    /** The worker agent the viewer called through; absent for a page's call. */
    readonly agent?: { readonly name: string };
    readonly outcome?: Exclude<InvocationLog.Outcome, "pending">;
    readonly outcomeCode?: string | null;
    readonly parentId?: string;
    readonly durationMs?: number;
    readonly attempts?: number;
    readonly logLines?: InvocationLog.Finish["logLines"];
    readonly replyDelivered?: boolean;
    /** Runs between admission and settlement, such as the calls the invocation makes. */
    readonly inside?: (
      id: string
    ) => Effect.Effect<
      void,
      SqlError,
      RuntimeLog.RuntimeLog | InvocationLog.InvocationLog | SqlClient.SqlClient
    >;
  }
) {
  const log = yield* InvocationLog.InvocationLog;
  const id = `inv_portal_${++counter}`;
  const startedAt = yield* Clock.currentTimeMillis;
  yield* log.begin({
    id,
    companyId: seed.companyId,
    patchId: seed.patchId,
    versionId: seed.versionId,
    handler: input.handler,
    kind: input.kind,
    initiatingViewerId: viewer.id,
    agent: input.agent ?? null,
    parentId: input.parentId ?? null,
    correlationId: `correlation-${id}`,
    startedAt,
    deadline: startedAt + 60_000,
    argsBytes: 2
  });
  if (input.inside)
    yield* input
      .inside(id)
      .pipe(Effect.provide(RuntimeLog.layer), Effect.provide(NodeCryptography.layer));
  yield* log.finish({
    id,
    outcome: input.outcome ?? "success",
    outcomeCode: input.outcomeCode ?? null,
    settledAt: startedAt + (input.durationMs ?? 30),
    durationMs: input.durationMs ?? 30,
    guestMs: 0,
    dbMs: 0,
    callbacks: 0,
    resultBytes: 0,
    attempts: input.attempts ?? 1,
    logLines: input.logLines ?? [],
    replyDelivered: input.replyDelivered ?? true
  });
  yield* TestClock.adjust(1_000);
  return id;
});
/** One logged operation row inside an invocation, a second after the last step. */
export const operation = Effect.fn("PortalFixtures.operation")(function* (
  seed: Seed,
  invocationId: string,
  input: {
    readonly op: string;
    readonly resource: string;
    readonly as: Person | "patch";
    readonly agent?: { readonly name: string };
    readonly outcome: "success" | "failure";
    readonly outcomeCode?: string;
    readonly rowCount: number | null;
  }
) {
  yield* TestClock.adjust(1_000);
  const log = yield* RuntimeLog.RuntimeLog;
  const correlationId = `correlation-call-${++counter}`;
  const principal = input.as === "patch" ? "patch" : input.as.id;
  yield* log.begin({
    companyId: seed.companyId,
    patchId: seed.patchId,
    versionId: seed.versionId,
    userId: principal === "patch" ? null : principal,
    effectivePrincipal: principal,
    invocationId,
    ...(input.agent === undefined
      ? { credentialKind: "session" as const }
      : { credentialKind: "agent" as const, agent: input.agent }),
    op: input.op,
    resource: input.resource,
    connectionId: input.op.startsWith("postgres.") ? "con_warehouse" : null,
    correlationId
  });
  yield* log.finish({
    correlationId,
    outcome: input.outcome,
    outcomeCode: input.outcomeCode ?? null,
    durationMs: 12,
    rowCount: input.rowCount
  });
});
export const seedOf = (companyId: string, recorded: Patches.Recorded): Seed => ({
  companyId,
  patchId: recorded.patchId,
  versionId: recorded.versionId
});
export const logPath = (name: string, query = "") => `${cardPath(name)}/log${query}`;
/** A tier 2 patch, as tier 2 publishes: a server artifact beside the page. */
export const publishTier2 = Effect.fn("PortalFixtures.publishTier2")(function* (
  person: Person,
  name: string
) {
  const ordinal = ++counter;
  return yield* publish(person, name, {
    filename: null,
    manifest: { ...manifest, name, tier: 2, handlers: {} },
    server: {
      objectKey: `patches/tier2-${ordinal}/server.js`,
      sha256: sha256(String(ordinal)),
      bytes: 0
    }
  });
});
/** A tier 2 patch whose agent area has a tool of each kind, beside a page handler. */
export const agentHandlers: HandlerDescriptors = {
  "agent.moveDeal": {
    kind: "mutation",
    description: "Move one deal to another stage.",
    agentTool: true,
    args: { deal: { kind: "text" } },
    result: { kind: "boolean" }
  },
  "agent.findDeals": {
    kind: "query",
    description: "Search the pipeline for <b>open</b> deals.",
    agentTool: true,
    args: {},
    result: { kind: "json" }
  },
  "agent.exportDeals": {
    kind: "action",
    description: "Export the board as CSV.",
    readOnly: true,
    agentTool: true,
    args: {},
    result: { kind: "text" }
  },
  "agent.addNote": {
    kind: "action",
    description: "Add a note to a deal's timeline.",
    agentTool: true,
    args: {},
    result: { kind: "boolean" }
  },
  "deals.update": { kind: "mutation", args: {}, result: { kind: "boolean" } }
};
export const publishAgentArea = Effect.fn("PortalFixtures.publishAgentArea")(function* (
  person: Person,
  name: string,
  handlers: HandlerDescriptors = agentHandlers,
  overrides: Partial<Patches.RecordInput> = {}
) {
  const ordinal = ++counter;
  return yield* publish(person, name, {
    filename: null,
    manifest: { ...manifest, name, tier: 2, handlers },
    server: {
      objectKey: `patches/agents-${ordinal}/server.js`,
      sha256: sha256(String(ordinal)),
      bytes: 0
    },
    ...overrides
  });
});
