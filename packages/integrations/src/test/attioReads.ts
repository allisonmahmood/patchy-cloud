import type { AttioAttribute, AttioSnapshot } from "@patchy/api";
import { ContractLimits } from "@patchy/limits";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as CredentialKeys from "../CredentialKeys.js";
import * as Source from "../attio/Source.js";

/**
 * A hand-written Attio workspace for offline tests of reads, in the shapes the probe (#964) saw on
 * the wire. Its ids are made up; nothing here came from a real workspace.
 */

/** A made-up id in Attio's UUID shape. */
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const objects = {
  deals: { id: uuid(1), slug: "deals" },
  companies: { id: uuid(2), slug: "companies" },
  people: { id: uuid(3), slug: "people" }
} as const;

let next = 100;
const attribute = (
  slug: string,
  type: AttioAttribute["type"],
  more: Partial<AttioAttribute> = {}
): AttioAttribute => ({
  id: uuid(next++),
  slug,
  title: slug.replaceAll("_", " "),
  type,
  multiselect: false,
  ...more
});

const deals = [
  attribute("record_id", "text"),
  attribute("name", "text"),
  attribute("stage", "status", { options: ["Lead", "In Progress", "Won 🎉", "Lost"] }),
  attribute("owner", "actor-reference"),
  attribute("value", "currency"),
  attribute("associated_people", "record-reference", {
    multiselect: true,
    targets: [objects.people]
  }),
  attribute("associated_company", "record-reference", { targets: [objects.companies] }),
  attribute("counterparty", "record-reference", {
    multiselect: true,
    targets: [objects.companies, objects.people]
  }),
  attribute("created_at", "timestamp"),
  attribute("is_hot", "checkbox"),
  attribute("amount", "number"),
  attribute("score", "rating"),
  attribute("close_date", "date"),
  attribute("phone", "phone-number"),
  attribute("hq_location", "location"),
  attribute("segment", "select", { options: ["SMB", "Enterprise"] }),
  attribute("tags", "select", { multiselect: true, options: ["Tag 01", "Tag 02"] }),
  attribute("watchers", "actor-reference", { multiselect: true })
];
const people = [
  attribute("record_id", "text"),
  attribute("name", "personal-name"),
  attribute("email_addresses", "email-address", { multiselect: true }),
  attribute("last_interaction", "interaction")
];
const companies = [
  attribute("record_id", "text"),
  attribute("name", "text"),
  attribute("domains", "domain", { multiselect: true })
];
const pipeline = [
  attribute("entry_id", "text"),
  attribute("stage", "status", { options: ["Demo", "Won"] }),
  attribute("flagged", "checkbox"),
  attribute("entered_on", "date")
];

export const snapshot: AttioSnapshot = {
  version: 1,
  workspace: { id: uuid(9), name: "Lumen Bikes", slug: "lumen-bikes" },
  scopes: [
    "record_permission:read",
    "object_configuration:read",
    "list_entry:read",
    "list_configuration:read",
    "user_management:read"
  ],
  objects: [
    { ...objects.deals, name: "Deals", attributes: deals },
    { ...objects.companies, name: "Companies", attributes: companies },
    { ...objects.people, name: "People", attributes: people }
  ],
  lists: [
    {
      id: uuid(20),
      slug: "pipeline",
      name: "Pipeline",
      parents: [objects.deals],
      attributes: pipeline
    },
    {
      id: uuid(21),
      slug: "accounts",
      name: "Accounts",
      parents: [objects.companies, objects.people],
      attributes: [attribute("entry_id", "text")]
    }
  ],
  excluded: []
};

const at = "2026-10-27T23:49:28.945950775Z";
/** What Attio puts around every value item; Patchy drops all of it. */
const meta = (type: string) => ({
  active_from: at,
  active_until: null,
  created_by_actor: { type: "api-token", id: uuid(8) },
  attribute_type: type
});

/** One item of each type as Attio answers it, with fields the wire leaves out. */
export const items = {
  text: (value: string) => ({ ...meta("text"), value }),
  number: (value: number) => ({ ...meta("number"), value }),
  checkbox: (value: boolean) => ({ ...meta("checkbox"), value }),
  date: (value: string) => ({ ...meta("date"), value }),
  timestamp: (value: string) => ({ ...meta("timestamp"), value }),
  currency: (value: number, code: string | null = "USD") => ({
    ...meta("currency"),
    currency_code: code,
    currency_value: value
  }),
  select: (title: string) => ({
    ...meta("select"),
    option: {
      id: { workspace_id: uuid(9), object_id: uuid(1), attribute_id: uuid(7), option_id: uuid(6) },
      title,
      is_archived: false
    }
  }),
  status: (title: string) => ({
    ...meta("status"),
    status: {
      id: { workspace_id: uuid(9), object_id: uuid(1), attribute_id: uuid(7), status_id: uuid(6) },
      title,
      is_archived: false,
      target_time_in_status: null,
      celebration_enabled: false
    }
  }),
  email: (address: string) => ({
    ...meta("email-address"),
    original_email_address: address,
    email_address: address,
    email_domain: address.split("@")[1],
    email_root_domain: address.split("@")[1],
    email_local_specifier: address.split("@")[0]
  }),
  domain: (domain: string) => ({ ...meta("domain"), domain, root_domain: domain }),
  phone: (number: string) => ({
    ...meta("phone-number"),
    phone_number: number,
    original_phone_number: number,
    country_code: "GB"
  }),
  name: (first: string, last: string) => ({
    ...meta("personal-name"),
    first_name: first,
    last_name: last,
    full_name: `${first} ${last}`
  }),
  location: (locality: string) => ({
    ...meta("location"),
    line_1: "788 Probe Street",
    line_2: null,
    line_3: null,
    line_4: null,
    locality,
    region: "TX",
    postcode: "P6573",
    country_code: "US",
    latitude: "30.267153",
    longitude: null
  }),
  reference: (object: string, id: string) => ({
    ...meta("record-reference"),
    target_object: object,
    target_record_id: id
  }),
  actor: (id: string, type = "workspace-member") => ({
    ...meta("actor-reference"),
    referenced_actor_type: type,
    referenced_actor_id: id
  }),
  interaction: (when: string) => ({
    ...meta("interaction"),
    interaction_type: "email",
    interacted_at: when,
    owner_actor: { type: "workspace-member", id: uuid(5) }
  })
};

/** A record as Attio answers it: every attribute the object has, empty as `[]`. */
export const record = (
  object: keyof typeof objects,
  id: string,
  values: Readonly<Record<string, ReadonlyArray<unknown>>> = {}
) => {
  const all = snapshot.objects.find((item) => item.slug === object)!.attributes;
  return {
    id: { workspace_id: uuid(9), object_id: objects[object].id, record_id: id },
    created_at: at,
    web_url: `https://app.attio.com/lumen-bikes/${object}/record/${id}`,
    values: Object.fromEntries(all.map((item) => [item.slug, values[item.slug] ?? []]))
  };
};

/** An entry as Attio answers it, on a deal unless said otherwise. */
export const entry = (
  id: string,
  parent: string,
  values: Readonly<Record<string, ReadonlyArray<unknown>>> = {},
  parentObject = "deals"
) => ({
  id: { workspace_id: uuid(9), list_id: uuid(20), entry_id: id },
  parent_record_id: parent,
  parent_object: parentObject,
  created_at: at,
  entry_values: Object.fromEntries(
    snapshot.lists[0]!.attributes.map((item) => [item.slug, values[item.slug] ?? []])
  )
});

/** The current attributes of an object or list as Attio lists them, from the snapshot's. */
export const currentAttributes = (attributes: ReadonlyArray<AttioAttribute>) =>
  attributes.map((item) => ({
    id: { workspace_id: uuid(9), object_id: uuid(1), attribute_id: item.id },
    title: item.title,
    description: null,
    api_slug: item.slug,
    type: item.type,
    is_system_attribute: false,
    is_writable: true,
    is_required: false,
    is_unique: false,
    is_multiselect: item.multiselect,
    is_default_value_enabled: false,
    is_archived: false,
    default_value: null,
    relationship: null,
    created_at: at,
    config: {
      currency: { default_currency_code: null, display_type: null },
      record_reference: {
        allowed_object_ids: item.targets === undefined ? null : item.targets.map((t) => t.id)
      }
    }
  }));

// ---------- a scripted Attio, for what Patchy sends and how it reads the answer ----------

/** One request Patchy sent: its method, path under the host, query and JSON body. */
export interface Sent {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly authorization: string | undefined;
}
/** An answer: JSON with a status, or a raw `Response` such as an edge's HTML page. */
export type Answer =
  | { readonly status?: number; readonly body: unknown; readonly headers?: Record<string, string> }
  | Response;
export type Route = (sent: Sent) => Answer | undefined;

/** Attio's refusal body, as it writes one. */
export const refusal = (status: number, code: string, path?: ReadonlyArray<string>) => ({
  status,
  body: {
    status_code: status,
    type: status === 429 ? "rate_limit_error" : "invalid_request_error",
    code,
    message: "Attio's own words, never repeated.",
    ...(path === undefined ? {} : { path })
  }
});

/**
 * The current attributes of every object and list in `workspace`, and their options, as the
 * call's check reads them; `routes` answer the rest, first match first. Anything unanswered is a
 * 500. A test can hold matching requests until it releases them.
 */
export const scripted = (
  routes: ReadonlyArray<Route>,
  workspace: AttioSnapshot = snapshot,
  limits: Partial<Record<"attio.calls.concurrent" | "attio.host.concurrent", number>> = {}
) => {
  const requests: Sent[] = [];
  const holds: Array<{ match: (sent: Sent) => boolean; release: Deferred.Deferred<void> }> = [];
  const schema: Route = (sent) => {
    const match =
      /^\/v2\/(objects|lists)\/([^/]+)\/attributes(?:\/([^/]+)\/(options|statuses))?$/.exec(
        sent.path
      );
    if (match === null || sent.method !== "GET") return undefined;
    const [, kind, slug, attribute] = match;
    const container = (kind === "objects" ? workspace.objects : workspace.lists).find(
      (item) => item.slug === decodeURIComponent(slug!)
    );
    if (container === undefined) return refusal(404, "not_found");
    if (attribute === undefined)
      return {
        body: {
          data: currentAttributes(container.attributes).slice(
            Number(sent.query.offset ?? 0),
            Number(sent.query.offset ?? 0) + Number(sent.query.limit ?? 500)
          )
        }
      };
    const found = container.attributes.find((item) => item.slug === decodeURIComponent(attribute));
    return found === undefined
      ? refusal(404, "not_found")
      : { body: { data: (found.options ?? []).map((title) => ({ title, is_archived: false })) } };
  };
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const sent: Sent = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body:
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
        authorization: request.headers.authorization
      };
      requests.push(sent);
      const index = holds.findIndex((hold) => hold.match(sent));
      if (index !== -1) {
        const [hold] = holds.splice(index, 1);
        yield* Deferred.await(hold!.release);
      }
      let answer: Answer | undefined;
      for (const route of [...routes, schema]) {
        answer = route(sent);
        if (answer !== undefined) break;
      }
      return HttpClientResponse.fromWeb(
        request,
        answer === undefined
          ? Response.json({ status_code: 500, code: "internal" }, { status: 500 })
          : answer instanceof Response
            ? answer
            : Response.json(answer.body, {
                status: answer.status ?? 200,
                headers: answer.headers ?? {}
              })
      );
    })
  );
  return {
    requests,
    /** Requests other than the check's and option reads. */
    queries: () => requests.filter((sent) => !sent.path.includes("/attributes")),
    /** Holds the next request that matches until `release` completes. */
    hold: (match: (sent: Sent) => boolean, release: Deferred.Deferred<void>) => {
      holds.push({ match, release });
    },
    layer: Layer.effect(Source.Source, Source.make).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Layer.provide(Layer.succeed(ContractLimits.overrides, limits))
    )
  };
};

/** Matches `method path`, the path under `/v2`. */
export const route =
  (method: string, path: string, answer: Answer | ((sent: Sent) => Answer)): Route =>
  (sent) =>
    sent.method === method && sent.path === `/v2${path}`
      ? typeof answer === "function"
        ? answer(sent)
        : answer
      : undefined;

/** The read key every seeded connection holds. */
export const key = "f".repeat(64);

/**
 * An Attio connection to `workspace`'s snapshot at revisions 1 and up, seeded straight into the
 * database: each of `revisions` is a snapshot, the last one current.
 */
export const seed = Effect.fn("AttioReadsTest.seed")(function* (input: {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly handle: string;
  readonly revisions?: ReadonlyArray<AttioSnapshot>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* CredentialKeys.CredentialKeys;
  const revisions = input.revisions ?? [snapshot];
  const last = revisions[revisions.length - 1]!;
  const display: Source.Display = {
    workspace: last.workspace,
    keyHint: `…${key.slice(-4)}`,
    scopes: last.scopes
  };
  const encrypted = yield* keys.encrypt(
    { companyId: input.companyId, id: input.id, integration: "attio" },
    Source.credentials({ key, workspaceId: last.workspace.id })
  );
  yield* sql`INSERT INTO connections
    (id, company_id, integration, handle, description, mode, status, display, credentials, key_id,
     credential_revision, metadata_revision, created_by, last_tested_at, last_discovered_at)
    VALUES (${input.id}, ${input.companyId}, 'attio', ${input.handle}, 'The CRM',
      'company', 'connected', ${JSON.stringify(display)}::jsonb, ${encrypted.credentials},
      ${encrypted.keyId}, 1, ${revisions.length}, ${input.userId}, now(), now())`;
  for (const [index, revision] of revisions.entries())
    yield* sql`INSERT INTO connection_snapshots
      (company_id, connection_id, integration, revision, snapshot, created_at)
      VALUES (${input.companyId}, ${input.id}, 'attio', ${index + 1}, ${JSON.stringify(revision)}::jsonb, now())`;
});
