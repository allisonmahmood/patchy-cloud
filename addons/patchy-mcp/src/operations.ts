import { randomBytes } from "node:crypto";
import * as z from "zod/v4";
import { CloudApiError, request, type PatchyRequest } from "./api.js";

const jsonObject = z.record(z.string(), z.json());
export const mutationKey = z
  .string()
  .regex(
    /^\d+-[A-Za-z0-9_-]{22}$/,
    "Use a mutationKey from list_operations; retain it for this one intended change.",
  );
export const operationCatalog = z.object({
  patchId: z.string().min(1),
  versionId: z.string().min(1),
  operations: z.array(
    z.object({
      handler: z.string().min(1),
      kind: z.enum(["query", "mutation"]),
      description: z.string(),
      inputSchema: jsonObject,
      outputSchema: jsonObject,
    }),
  ),
});
export const discoveredOperations = operationCatalog.extend({ mutationKey });
export const mutationInput = z.strictObject({
  patch: z
    .string()
    .min(1)
    .regex(/^[^/]+$/)
    .refine((value) => value !== "." && value !== "..")
    .describe("Canonical patchId from list_operations, not a name or URL."),
  versionId: z
    .string()
    .min(1)
    .describe(
      "Exact versionId from list_operations; never silently switch versions.",
    ),
  handler: z
    .string()
    .min(1)
    .describe("Exact handler whose declared kind is mutation."),
  args: jsonObject.describe(
    "Input object matching this mutation's inputSchema.",
  ),
  mutationKey: mutationKey.describe(
    "Fresh key from list_operations for one intended change. After any uncertain result retain this key, person, instance, version, handler and args. Never automatically retry.",
  ),
});
export const mutationResult = z.object({
  patchId: z.string(),
  versionId: z.string(),
  kind: z.literal("mutation"),
  handler: z.string(),
  args: jsonObject,
  mutationKey,
  outcome: z.enum([
    "committed",
    "rolled_back",
    "not_attempted",
    "refused",
    "unknown",
  ]),
  value: z.json().optional(),
  revisions: z.record(z.string(), z.string()).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      status: z.number().int().optional(),
      details: z.json().optional(),
      correlationId: z.string().optional(),
    })
    .optional(),
});
const replySchema = z.object({
  patchId: z.string().min(1),
  versionId: z.string().min(1),
  result: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      value: z.json(),
      revisions: z.record(z.string(), z.string()).optional(),
    }),
    z.object({
      ok: z.literal(false),
      source: z.literal("handler"),
      code: z.string().min(1),
      details: z.json().optional(),
    }),
  ]),
});
export async function listOperations(
  patch: string,
  call: PatchyRequest = request,
) {
  const parsed = operationCatalog.safeParse(
    await call(`/api/patches/${encodeURIComponent(patch)}/operations`),
  );
  if (!parsed.success)
    throw new Error(
      "Patchy Cloud returned an invalid operation catalog. No operations were discovered.",
    );
  return parsed.data;
}
export const mintMutationKey = () =>
  `${Date.now()}-${randomBytes(16).toString("base64url")}`;

/** One POST at most. Recovery is an explicit human/client decision, never an automatic retry. */
export async function runMutation(
  input: z.infer<typeof mutationInput>,
  call: PatchyRequest,
): Promise<z.infer<typeof mutationResult>> {
  const { patch, versionId, handler, args, mutationKey } = input;
  const context = {
    patchId: patch,
    versionId,
    kind: "mutation" as const,
    handler,
    args,
    mutationKey,
  };
  let sent = false;
  try {
    const catalog = await listOperations(patch, call);
    if (catalog.patchId !== patch)
      throw new CloudApiError(
        "Use the canonical patchId from list_operations.",
        "invalid_patch",
      );
    if (catalog.versionId !== versionId)
      throw new CloudApiError(
        "The published version changed. Review fresh operations before a new change. This call was not sent; an earlier uncertain outcome is still unresolved.",
        "version_changed",
        409,
      );
    if (
      !catalog.operations.some(
        (op) => op.handler === handler && op.kind === "mutation",
      )
    )
      throw new CloudApiError(
        "Only a declared mutation can be called here. Queries use run_query; actions and arbitrary resource operations are unavailable.",
        "invalid_operation",
      );
    sent = true;
    const response = await call(
      `/api/patches/${encodeURIComponent(patch)}/mutation`,
      { versionId, handler, args, mutationKey },
    );
    const parsed = replySchema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.patchId !== patch ||
      parsed.data.versionId !== versionId
    )
      throw new Error(
        "Patchy returned an invalid mutation reply; its outcome is uncertain.",
      );
    if (!parsed.data.result.ok)
      return {
        ...context,
        outcome: "rolled_back",
        error: {
          code: parsed.data.result.code,
          message:
            "The Tool refused the change and Cloud rolled back its transaction.",
          ...(parsed.data.result.details === undefined
            ? {}
            : { details: parsed.data.result.details }),
        },
      };
    return {
      ...context,
      outcome: "committed",
      value: parsed.data.result.value,
      ...(parsed.data.result.revisions === undefined
        ? {}
        : { revisions: parsed.data.result.revisions }),
    };
  } catch (error) {
    const status =
      error instanceof CloudApiError
        ? error.status
        : (error as { status?: number })?.status;
    const code =
      error instanceof CloudApiError ? error.code : "mutation_failed";
    const knownRefusal =
      status !== undefined &&
      [400, 401, 403, 404, 409, 413, 429].includes(status) &&
      code !== "unknown_outcome";
    const outcome = !sent
      ? "not_attempted"
      : knownRefusal
        ? "refused"
        : "unknown";
    const message =
      outcome === "unknown"
        ? "The change may have committed. Do not automatically retry or mint a new key. Retain this exact person, instance, patch, version, handler, args and mutationKey for an explicit recovery decision."
        : error instanceof Error
          ? error.message
          : "Mutation request refused.";
    const details = z
      .json()
      .safeParse(error instanceof CloudApiError ? error.details : undefined);
    return {
      ...context,
      outcome,
      error: {
        code: outcome === "unknown" ? "unknown_outcome" : code,
        message,
        ...(status === undefined ? {} : { status }),
        ...(details.success ? { details: details.data } : {}),
        ...(error instanceof CloudApiError && error.correlationId !== undefined
          ? { correlationId: error.correlationId }
          : {}),
      },
    };
  }
}
