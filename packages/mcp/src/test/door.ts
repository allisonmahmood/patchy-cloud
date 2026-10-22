/**
 * The door over a migrated database, a request at a time as the router hands it over, with
 * what its tools read: Patches, Companies and Users. Each suite builds its own door per test,
 * so its in-memory buckets start full, and sends from its own address.
 */
import { assert } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Analytics } from "@patchy/analytics";
import * as WideEvents from "@patchy/analytics/wide-events";
import {
  CURRENT_RELEASE,
  MANIFEST_VERSION,
  WIRE_VERSION,
  type HandlerDescriptors,
  type Manifest
} from "@patchy/api";
import { AgentConnections, MachineTokens } from "@patchy/auth";
import { Companies, Users } from "@patchy/companies";
import * as CompanyTesting from "@patchy/company-database/testing";
import { contentHash } from "@patchy/core";
import { ConnectionStoreDev } from "@patchy/integrations/dev";
import { Limits, OperatingLimits } from "@patchy/limits";
import { Patches } from "@patchy/patches";
import { Tables } from "@patchy/primitives";
import { Wakes } from "@patchy/runtime/core";
import * as Testing from "@patchy/sql/testing";
import * as Door from "../Door.js";

export const PRODUCTION = "https://cloud.example";
export const DEV = "http://patchy-door.localhost:29276";
export const CLAUDE = "https://claude.ai/oauth/claude-code-client-metadata";

/** Every event the door's requests closed, in order. */
const recorded: WideEvents.WideEvent[] = [];
const sink = Layer.succeed(WideEvents.Sink)(
  WideEvents.Sink.of({ write: (event) => Effect.sync(() => void recorded.push(event)) })
);

/**
 * The door's services over a migrated database, with every event it writes recorded, and the
 * company connections patches may declare.
 */
export const harnessWith = (connections: ReadonlyArray<ConnectionStoreDev.DevConnection>) =>
  Layer.mergeAll(
    AgentConnections.layer,
    MachineTokens.layer,
    Limits.layer,
    OperatingLimits.layer,
    Patches.layer,
    Companies.layer,
    Users.layer,
    WideEvents.layerWithSink.pipe(Layer.provide(sink))
  ).pipe(
    Layer.provideMerge(Analytics.layerNoop),
    Layer.provideMerge(ConnectionStoreDev.layer(connections)),
    Layer.provideMerge(Tables.layer),
    Layer.provideMerge(Wakes.layer),
    Layer.provideMerge(CompanyTesting.layer()),
    Layer.provideMerge(CompanyTesting.resourceChangesLayer),
    Layer.provideMerge(Testing.layer())
  );

/** The door's services, with no company connections. */
export const harness = harnessWith([]);

/** The field at a dotted path of a decoded answer, or `undefined`. */
export const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (current, key) => (Predicate.hasProperty(current, key) ? current[key] : undefined),
      value
    );

/** The object at a dotted path of a decoded answer, failing the test when there is none. */
export const objectAt = (value: unknown, path: string): Readonly<Record<string, unknown>> => {
  const found = at(value, path);
  if (!Predicate.isObject(found)) return assert.fail(`No object at ${path}`);
  return { ...found };
};

export interface Sent {
  readonly method?: string;
  readonly path?: string;
  readonly token?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly raw?: string;
  /** Sends the body as a stream with no declared length. */
  readonly chunked?: boolean;
}

/**
 * A door for an instance at `base`, and a way to send it requests from `address`. Requests
 * carry the instance's own `Host` unless a test says otherwise.
 */
export const door = (base: string, address: string) =>
  Effect.gen(function* () {
    const app = yield* HttpRouter.toHttpEffect(
      Layer.mergeAll(
        Door.layer,
        HttpRouter.use((router) =>
          router.add("*", "/*", Effect.succeed(HttpServerResponse.empty({ status: 404 })))
        )
      )
    ).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_PUBLIC_BASE_URL: base }))
      )
    );
    const wide = yield* WideEvents.WideEvents;
    return Effect.fn("send")(function* (sent: Sent) {
      const body = sent.raw ?? (sent.body === undefined ? undefined : JSON.stringify(sent.body));
      const headers: Record<string, string> = {
        host: new URL(base).host,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(body === undefined || sent.chunked === true
          ? {}
          : { "content-length": String(Buffer.byteLength(body)) }),
        ...(sent.token === undefined ? {} : { authorization: `Bearer ${sent.token}` }),
        ...sent.headers
      };
      const init: RequestInit & { duplex?: "half" } = {
        method: sent.method ?? "POST",
        headers,
        ...(body === undefined
          ? {}
          : sent.chunked === true
            ? { body: new Blob([body]).stream(), duplex: "half" }
            : { body })
      };
      const request = HttpServerRequest.fromWeb(
        new Request(new URL(sent.path ?? "/mcp", base), init)
      ).modify({ remoteAddress: Option.some(address) });
      const before = recorded.length;
      const response = yield* wide
        .withEvent({ type: "request", route: "/mcp" }, app)
        .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));
      const web = HttpServerResponse.toWeb(response);
      const text = yield* Effect.promise(() => web.text());
      // Delivery is detached; let it land before reading the event.
      while (recorded.length === before) yield* Effect.yieldNow;
      return {
        status: web.status,
        headers: web.headers,
        text,
        json: text === "" ? undefined : (JSON.parse(text) as unknown),
        event: recorded[before]!
      };
    });
  });

export const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2.1.308" },
  "io.modelcontextprotocol/clientCapabilities": {}
};

/** A modern request, with the headers a conforming client mirrors from it. */
export const modern = (
  token: string,
  method: string,
  params: Record<string, unknown> = {}
): Sent => ({
  token,
  headers: {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(typeof params["name"] === "string" ? { "mcp-name": params["name"] } : {})
  },
  body: { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }
});

export const legacy = (
  token: string,
  method: string,
  params: Record<string, unknown> = {}
): Sent => ({
  token,
  headers: { "mcp-protocol-version": "2025-06-18" },
  body: { jsonrpc: "2.0", id: 1, method, params }
});

/** A modern `tools/call` of one of the door's tools. */
export const call = (token: string, name: string, args?: unknown) =>
  modern(token, "tools/call", { name, ...(args === undefined ? {} : { arguments: args }) });

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: "admin" | "member";
  readonly machineTokenId: string;
  readonly token: string;
  readonly connectionId: string;
}

/**
 * A company of its own with `people`, each with a machine to publish from and an agent
 * connection. Agent access is on unless `access` says otherwise.
 */
export const company = Effect.fn("DoorTest.company")(function* (
  key: string,
  people: ReadonlyArray<readonly [name: string, role: "admin" | "member"]>,
  options: { readonly access?: boolean; readonly name?: string } = {}
) {
  const sql = yield* SqlClient.SqlClient;
  const id = `cmp_door_${key}`;
  const handle = `door-${key}`;
  const name = options.name ?? `Door ${key}`;
  yield* sql`
    INSERT INTO companies (id, handle, name, created_at)
    VALUES (${id}, ${handle}, ${name}, now())`;
  const members: Person[] = [];
  for (const [index, [personName, role]] of people.entries()) {
    const userId = `usr_door_${key}_${index}`;
    const email = `${key}-${index}@door.test`;
    yield* sql`
      INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES (${userId}, ${`clerk_${userId}`}, ${id}, ${email}, ${personName}, ${role})`;
    const machineTokenId = `tok_${userId}`;
    yield* sql`
      INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
      VALUES (${machineTokenId}, ${userId}, 'Door test machine', ${`hash:${machineTokenId}`},
        now(), now() + interval '90 days', now())`;
    const { connection, tokens } = yield* AgentConnections.AgentConnections.use((connections) =>
      connections.create({ userId, clientId: CLAUDE, clientName: "Claude Code" })
    );
    members.push({
      id: userId,
      name: personName,
      email,
      role,
      machineTokenId,
      token: tokens.accessToken,
      connectionId: connection.id
    });
  }
  const admin = members.find((member) => member.role === "admin");
  if (options.access !== false && admin !== undefined)
    yield* Companies.Companies.use((companies) =>
      companies.setAgentAccess({ companyId: id, on: true, by: admin.id })
    );
  return { id, handle, name, people: members };
});

let published = 0;

/**
 * A tier 0 page, or with `handlers` a tier 2 patch, published by `owner` as Patches records it,
 * provisioning any `tables` it defines.
 */
export const publish = Effect.fn("DoorTest.publish")(function* (
  companyId: string,
  owner: Person,
  name: string,
  options: {
    readonly handlers?: HandlerDescriptors;
    readonly tables?: (typeof Manifest.Type)["tables"];
    readonly uses?: (typeof Manifest.Type)["uses"];
    readonly title?: string;
    readonly description?: string;
    readonly patchId?: string;
    readonly scope?: "company" | "public";
    /** Publish a new version of `patchId`, renaming it to `name`. */
    readonly update?: boolean;
  } = {}
) {
  const ordinal = ++published;
  const patchId = options.patchId ?? `pd${String(ordinal).padStart(10, "0")}`;
  const versionId = `ver_door_${ordinal}`;
  const tier2 = options.handlers !== undefined;
  const input: Patches.RecordInput = {
    intent: options.update === true ? "update" : "create",
    patchId,
    companyId,
    ownerUserId: owner.id,
    machineTokenId: owner.machineTokenId,
    versionId,
    objectKey: `patches/${patchId}/versions/${ordinal}.html`,
    contentHash: contentHash(String(ordinal)),
    fileSize: 1,
    filename: null,
    title: options.title ?? `${name} title`,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    repoOrg: null,
    repoName: null,
    cliVersion: null,
    gitBranch: null,
    gitCommitSha: null,
    sourceIp: null,
    userAgent: null,
    manifest: {
      manifestVersion: MANIFEST_VERSION,
      release: CURRENT_RELEASE,
      tier: tier2 ? 2 : 0,
      tables: options.tables ?? {},
      files: {},
      uses: options.uses ?? {},
      name,
      ...(tier2 ? { handlers: options.handlers } : {})
    },
    ...(tier2
      ? {
          server: {
            objectKey: `patches/${patchId}/server/${ordinal}.js`,
            sha256: "0".repeat(64),
            bytes: 0
          }
        }
      : {}),
    wireVersion: WIRE_VERSION,
    publishKey: `door-publish-${ordinal}`,
    payloadDigest: `door-payload-${ordinal}`,
    publicBaseUrl: PRODUCTION,
    warnings: []
  };
  const patches = yield* Patches.Patches;
  yield* patches.preflight(input);
  yield* patches.prepareObject(input.objectKey);
  if (input.server) yield* patches.prepareObject(input.server.objectKey);
  yield* patches.record(input);
  return { patchId, versionId, name };
});
