import * as z from "zod/v4";
import { request, type PatchyRequest } from "./api.js";
import {
  jsonObject, listOperations, operationReply, operationCatalog,
} from "./operations.js";

export const patchReference = z
  .string()
  .min(1, "Provide a patch id or exact name from list_patches.")
  .regex(/^[^/]+$/, "Use a patch id or exact name, rather than a URL.")
  .refine(
    (value) => value !== "." && value !== "..",
    "Provide a patch id or exact name.",
  );

export const queryCatalog = operationCatalog.omit({ operations: true }).extend({
  queries: z.array(operationCatalog.shape.operations.element.omit({ kind: true })),
});

export const queryResult = z.object({
  patchId: z.string(),
  versionId: z.string(),
  handler: z.string(),
  value: z.json(),
});

export async function listQueries(patch: string, call: PatchyRequest = request) {
  const catalog = await listOperations(patch, call);
  return {
    patchId: catalog.patchId,
    versionId: catalog.versionId,
    queries: catalog.operations
      .filter((operation) => operation.kind === "query")
      .map(({ kind, ...query }) => query),
  };
}

export async function runQuery(
  patch: string,
  handler: string,
  args: z.infer<typeof jsonObject>,
  call: PatchyRequest = request,
) {
  // Refresh the catalog on every call. A new Tool or changed login needs no MCP rebuild.
  const catalog = await listOperations(patch, call);
  if (!catalog.operations.some((op) => op.handler === handler && op.kind === "query"))
    throw new Error(
      `No published read-only query '${handler}' is available on this Tool. Use list_queries to see its current operations. Mutations and actions cannot be called.`,
    );

  // Cloud reauthorizes and validates the current version, including all argument/result rules.
  // Keep schemas as data; no local schema interpreter, remote schema fetch or patch code loading.
  const parsed = operationReply.safeParse(
    await call(`/api/patches/${encodeURIComponent(catalog.patchId)}/query`, {
      handler,
      args,
    }),
  );
  if (!parsed.success || parsed.data.patchId !== catalog.patchId)
    throw new Error(
      "Patchy Cloud returned an invalid query reply. No query result was returned.",
    );
  const reply = parsed.data;
  if (!reply.result.ok)
    throw new Error(
      `Published query '${handler}' refused the request (${reply.result.code}).${reply.result.details === undefined ? "" : ` Details: ${JSON.stringify(reply.result.details)}`}`,
    );
  return {
    patchId: reply.patchId,
    versionId: reply.versionId,
    handler,
    value: reply.result.value,
  };
}
