import type { SalesforceDeclaration, SalesforceSnapshot } from "@patchy/api";
import { escapeHtml } from "@patchy/core";
const literal = (value: string) => escapeHtml(JSON.stringify(value));
export const generate = (
  declaration: typeof SalesforceDeclaration.Type & { readonly description?: string },
  snapshot: typeof SalesforceSnapshot.Type
) => ({
  client: `import { decodeError, PatchyError } from "patchy/client";
import type { Call } from "patchy/client";
export type RecordValue = null | boolean | number | string | readonly RecordValue[] | { readonly [key: string]: RecordValue };
export type Rows = { readonly ok: true; readonly rows: readonly Readonly<Record<string, RecordValue>>[]; readonly cursor: string | null; readonly totalSize: number };
export type Description = { readonly ok: true; readonly object: string; readonly fields: readonly { readonly name: string; readonly label: string; readonly type: string; readonly nillable: boolean }[] };
export interface Client { query(request: { readonly query: string } | { readonly cursor: string }): Promise<Rows>; describe(object: string): Promise<Description> }
export function createClient(connection: string, call: Call): Client {
  const send = async (op: "salesforce.query" | "salesforce.describe", args: object) => {
    let value: unknown;
    try { value = await call(op, { connection, ...args }); } catch (error) { throw decodeError(error, op) ?? error; }
    const error = decodeError(value, op); if (error) throw error;
    if (value === null || typeof value !== "object" || !("ok" in value) || value.ok !== true) throw new PatchyError("invalid_request", "Invalid Salesforce response.", {});
    return value;
  };
  return { query: async request => await send("salesforce.query", { request }) as Rows, describe: async object => await send("salesforce.describe", { object }) as Description };
}
`,
  context: `# Salesforce connection

Handle: ${literal(declaration.handle)}
Description: ${literal(declaration.description ?? "")}
Snapshot revision: ${declaration.revision}

Read-only, company-wide. Credentials stay in Nango. Dev reads real data through Patchy as your machine key's person.

Use describe("Account") to discover field names, Salesforce types and nullability, then query({ query: "SELECT Id, Name FROM Account LIMIT 100" }). The result has rows, totalSize and cursor. While cursor is non-null, query({ cursor }) reads the next page. No automatic retries or unbounded collection. Each page rechecks access and connection state. At tier 2, use these methods inside actions.

Query results are JSON records validated by Patchy; check the fields your patch expects. No write, arbitrary HTTP, queryAll, bulk or tooling endpoint is exposed.

## Queryable objects

${snapshot.objects.map((object) => `- ${literal(object.name)}: ${literal(object.label)}`).join("\n")}
`
});
