import { SalesforceDescription, SalesforceObject, SalesforceRows } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Nango from "../Nango.js";

// Pinned Salesforce REST contract; no caller can choose a host, method or arbitrary path.
export const base = "/services/data/v61.0";
export const Display = Schema.Struct({ organizationId: Schema.String });
export const credentials = Nango.credentials;
export const parseCredentials = Nango.parseCredentials;
const identity = Schema.decodeUnknownEffect(
  Schema.Struct({ organization_id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{15,18}$/)) })
);
const objects = Schema.decodeUnknownEffect(
  Schema.Struct({ sobjects: Schema.Array(SalesforceObject) })
);
const describe = Schema.decodeUnknownEffect(
  Schema.Struct({
    name: SalesforceDescription.fields.object,
    fields: SalesforceDescription.fields.fields
  })
);
const page = Schema.decodeUnknownEffect(
  Schema.Struct({
    records: SalesforceRows.fields.rows,
    totalSize: SalesforceRows.fields.totalSize,
    done: Schema.Boolean,
    nextRecordsUrl: Schema.optionalKey(Schema.String)
  })
);
const decodeRows = Schema.decodeUnknownEffect(SalesforceRows);
const failed = (cause: unknown) =>
  new Nango.Failed({ stage: "response", cause: Redacted.make(cause) });
export const test = Effect.fn("Salesforce.test")(function* (secret: Redacted.Redacted<string>) {
  const mapping = yield* parseCredentials(secret);
  const result = yield* Nango.request("GET", "/services/oauth2/userinfo", undefined, mapping).pipe(
    Effect.flatMap(identity),
    Effect.mapError(failed)
  );
  return { organizationId: result.organization_id };
});
export const inspect = Effect.fn("Salesforce.inspect")(function* (
  secret: Redacted.Redacted<string>
) {
  const display = yield* test(secret);
  const mapping = yield* parseCredentials(secret);
  const result = yield* Nango.request("GET", `${base}/sobjects/`, undefined, mapping).pipe(
    Effect.flatMap(objects),
    Effect.mapError(failed)
  );
  return {
    display,
    snapshot: { version: 1 as const, objects: result.sobjects.filter((object) => object.queryable) }
  };
});
export const describeObject = Effect.fn("Salesforce.describe")(function* (
  mapping: Nango.Mapping,
  object: string
) {
  const result = yield* Nango.request(
    "GET",
    `${base}/sobjects/${encodeURIComponent(object)}/describe`,
    undefined,
    mapping
  ).pipe(Effect.flatMap(describe), Effect.mapError(failed));
  if (result.name !== object) return yield* new Nango.Failed({ stage: "response" });
  return { ok: true as const, object, fields: result.fields };
});
export const query = Effect.fn("Salesforce.query")(function* (
  mapping: Nango.Mapping,
  request: { readonly query: string } | { readonly cursor: string }
) {
  if (
    "query" in request &&
    (!/^\s*SELECT\b/i.test(request.query) || /\bFOR\s+UPDATE\b/i.test(request.query))
  )
    return yield* new Nango.Failed({ stage: "authorization" });
  const path =
    "query" in request
      ? `${base}/query?q=${encodeURIComponent(request.query)}`
      : `${base}/query/${encodeURIComponent(request.cursor)}`;
  const result = yield* Nango.request("GET", path, undefined, mapping, {
    "Sforce-Query-Options": "batchSize=200"
  }).pipe(Effect.flatMap(page), Effect.mapError(failed));
  const prefix = `${base}/query/`;
  const cursor = result.done
    ? null
    : result.nextRecordsUrl?.startsWith(prefix)
      ? result.nextRecordsUrl.slice(prefix.length)
      : undefined;
  if (
    cursor === undefined ||
    (result.done && result.nextRecordsUrl !== undefined) ||
    result.records.length > 2000
  )
    return yield* new Nango.Failed({ stage: "response" });
  const output = { ok: true as const, rows: result.records, cursor, totalSize: result.totalSize };
  return yield* decodeRows(output).pipe(Effect.mapError(failed));
});
