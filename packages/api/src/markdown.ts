/**
 * Renders `docs/API.md` from the OpenAPI document `OpenApi.fromApi(PatchyApi)`
 * produces. Deliberately small: one heading per route, its description, the
 * request body, and every response with its shape spelled out inline. Named
 * shapes get one section each at the end.
 */
import * as Schema from "effect/Schema";
import * as OpenApi from "effect/http-api/OpenApi";
import { PatchyApi } from "./api.js";
import { RuntimeStreamFrame } from "./runtime.js";
import * as GuestProtocol from "./guest.js";

/** The subset of JSON Schema `fromApi` emits, as far as this renderer reads it. */
interface JsonSchema {
  $ref?: string;
  type?: string;
  title?: string;
  enum?: ReadonlyArray<unknown>;
  anyOf?: ReadonlyArray<JsonSchema>;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  required?: ReadonlyArray<string>;
  items?: JsonSchema;
}

interface Operation {
  operationId?: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  parameters?: ReadonlyArray<{ name: string; in: string; schema?: JsonSchema }>;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
}

const METHOD_ORDER = ["get", "post", "delete", "put", "patch"] as const;
const streamFrameDocument = Schema.toJsonSchemaDocument(RuntimeStreamFrame);

export function renderApiMarkdown(): string {
  const spec = OpenApi.fromApi(PatchyApi);
  const components = {
    ...spec.components.schemas,
    ...streamFrameDocument.definitions
  } as Record<string, JsonSchema>;
  const shapeName = (ref: string) =>
    ref.replace(/^#\/(?:components\/schemas|\$defs)\//, "").replace(/Encoded$/, "");

  const lines: string[] = [
    `# ${spec.info.title}`,
    "",
    "Rendered from `PatchyApi` in `packages/api` by `pnpm --filter @patchy/api render-docs`.",
    "Edit the schemas or renderer, then regenerate this file. There is no automated API-document drift check.",
    "",
    spec.info.description ?? "",
    ""
  ];

  for (const tag of spec.tags) {
    lines.push(`## ${tag.name}`, "");
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of METHOD_ORDER) {
        const operation = (methods as Record<string, Operation | undefined>)[method];
        if (!operation || !operation.tags?.includes(tag.name)) continue;
        lines.push(`### \`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}\``, "");
        if (operation.description) lines.push(operation.description, "");

        const body = operation.requestBody?.content?.["application/json"]?.schema;
        if (body) lines.push(`Request body: ${renderType(body)}`, "");
        else if (operation.requestBody?.content?.["application/octet-stream"])
          lines.push("Request body: raw bytes (`application/octet-stream`)", "");

        lines.push("Responses:", "");
        for (const [status, response] of Object.entries(operation.responses)) {
          const schema = response.content?.["application/json"]?.schema;
          const body = schema
            ? renderType(schema)
            : response.content?.["application/octet-stream"]
              ? "raw bytes (`application/octet-stream`)"
              : response.content?.["text/event-stream"]
                ? `SSE (\`text/event-stream\`), JSON data: ${renderType(streamFrameDocument.schema as JsonSchema)}`
                : "no body";
          lines.push(`- \`${status}\` ${body}`);
        }
        lines.push("");
      }
    }
  }

  lines.push(
    "## Agent tools",
    "",
    "Patchy MCP's door, `patchy dev agent`, the card and the publish check show an agent the same thing, from [`packages/api/src/agentTools.ts`](../packages/api/src/agentTools.ts). These are shapes inside MCP tool results, not `HttpApi` routes.",
    "",
    '- **Schemas.** Handler descriptors map onto JSON Schema 2020-12: objects are closed (`additionalProperties: false`) and require every field that isn\'t optional; nullable is `anyOf` the value or `null`, with an outer description winning over the value\'s; integers are `integer` between -2147483648 and 2147483647; timestamps are `{ type: "string", format: "date-time" }`; `t.json()` is `{}`, any value; enums are string enums. `t.row(table)` is the full stored row, `id`, `createdAt`, `updatedAt` and the columns, all required with optional columns nullable, closed and described "A row of <table>: <table description>" unless the value has its own description. Uploads and file handles never cross.',
    "- **`open_patch`.** Its answer is `{ name, description, owner, address, tools }`, the owner's name cut at 200 characters, within 64 KiB of compact JSON. Each tool is `{ name, kind, description, args, returns, refusals? }`, in name order: `kind` is `read` for a query or read-only action and `change` otherwise, `args` is the closed arguments object and `refusals` lists the tool's declared error codes.",
    "- **The agent area check** refuses an `agent.*` handler without the agent tool mark, which only `server/agent.ts` builds, a tool with no description, one using `t.upload()` or `t.fileHandle()` anywhere, a row naming an undefined table, and tools whose rendering exceeds 60 KiB of UTF-8, leaving 4 KiB for the patch's name, description, owner and address. Undescribed top-level arguments warn. The CLI names the file; the instance names the tool.",
    "- **Results.** A success carries its document twice, as compact JSON text and as `structuredContent`; `read_patch` and `change_patch` answer `{ result, version }`, adding `replayed: true` for a change key's retry of a committed change.",
    '- **Refusals** are `isError: true` with `structuredContent: { error: { code, from: "patch" | "patchy", message, details?, retryAfterSeconds? } }` and text saying what happened and then what to do. A patch\'s own refusal keeps its code and details, and reads "<patch> refused <tool> (<code>): <details.message>", followed by any other details; without a message it says the tool\'s description in `open_patch` says when it refuses and what to do.',
    "",
    "## Version eligibility",
    "",
    "The stream contract includes a reserved `revoked` frame, and the shell stops if it receives one. There is no version-revocation operation or persisted revocation state. Admission checks retained versions and the existing patch/session/access states. Who may revoke a version, how that appears and how it is undone remain open on [#425](https://github.com/allisonmahmood/patchy-cloud/issues/425). The frame is not evidence that version revocation is built.",
    "",
    "## Private guest protocol",
    "",
    `Wire ${GuestProtocol.wireVersion} is pinned to workerd \`${GuestProtocol.workerdVersion}\`, compatibility date \`${GuestProtocol.compatibilityDate}\`.`,
    "The authoritative schemas are in [`packages/api/src/guest.ts`](../packages/api/src/guest.ts).",
    "These are engine/inspection contracts, not public `HttpApi` routes or CLI operations.",
    "",
    "- `BundleBinding`: company, patch and version ids plus lowercase SHA-256. `Bundle` adds the closed ESM source.",
    "- `BindRequest`: wire and bundle. `BindReply` acknowledges the binding with `ok: true` or returns a typed binding refusal.",
    "- `Invoke`: wire, binding, invocation id, attempt id, process generation, absolute deadline, handler, JSON arguments, initiating viewer, the worker agent `{ name }` the call runs for, and issuing-host callback address/capability. Only Patchy's agent callers set `agent`, and a nested call keeps its parent's; it is absent for a page's call, so loaders and guests that predate it keep serving pages.",
    "- `InvokeReply`: an engine-owned `outcome` plus guest elapsed milliseconds. `returned` carries an untrusted guest `reply`; `deadline` means expired before dispatch; `guest_failed` means execution or reply decoding failed. Late returns remain guest data. Only the host classifies transaction settlement and verifies guest-claimed platform refusals against its own attempt records, preserving the recorded HTTP status rather than trusting a guest-supplied status.",
    "- `GuestRequest`: describe or invoke. Description yields handler descriptors; invocation yields the existing `RuntimeReply` envelope without wrapping successful business data. An invocation carries `agent` only when the `Invoke` did, and handler code reads its absence as `ctx.agent` null.",
    "- `Callback`: runtime operation, arguments and optional raw file body. `CallbackReply` preserves runtime refusals or returns JSON/file bytes. File bodies carry `Uint8Array` bytes and a content type over RPC, not JSON byte arrays.",
    "- Host callback transport uses JSON except binary requests marked by `X-Patchy-Callback`, whose value is URI-encoded operation metadata. `Content-Type` carries the file media type. Binary replies use `X-Patchy-File-Body: 1` with the same media-type convention. Authorization is the private per-attempt bearer, never a guest field.",
    "- File callback bodies enforce `tier2.callbacks.fileBytes` and return `too_large` with limit id, scope and value. Callback deadline expiry returns `timeout`; transport or malformed replies return `source_unavailable`. Neither classifies commit or promises a safe retry.",
    "- Staged uploads use raw `PUT /api/runtime/staged-files/:patchId/:versionId` with a claimed Content-Type and return `{ ok: true, value: { token, size, contentType } }`. `files.discard { upload }` uses the public JSON runtime route. Both are tier-2 shell-only, bound to viewer/patch/loaded version and unlogged. Each stage is at most 20 MiB; outstanding limits are 16 stages and 100 MiB per viewer per patch and 1 GiB per company by default. Quota refusals carry the applicable limit id, scope and value.",
    "- `t.upload()` is action-arguments-only. The SDK resolves each argument with private action-only `files.inspectUpload { upload }` before application code runs, replacing supplied metadata with stored measured size and claimed content type. It is not a public operation. Adoption uses JSON callback `files.put { store, name, upload }`, has no byte body, and logs the existing file mutation. The public JSON route still refuses files.put. Adoption and discard serialize on the stage row, and consumed, discarded, expired or differently bound uploads return not_found. Uploads expire after one hour; an object id is never authority. Adoption writes a pointer without copying bytes. A subsequent failed mutation leaves the adopted file intact.",
    "- The private host `/callback` listener is separate from the public API and accepts only a replica-local invocation capability. `X-Patchy-Invocation-Id`, `X-Patchy-Attempt-Id` and `X-Patchy-Process-Generation` must match its immutable attempt. Ended references answer `access_denied` with the end reason for five minutes; an old attempt never gains a later attempt's authority.",
    "- The host enforces handler-kind rules and resolves the effective principal per callback: the patch for owned resources, the live initiating viewer for shared resources, connections and members. Viewer callbacks trust the admitted JWT until its expiry, then share one backend check of its Clerk session id and subject for the rest of that invocation, including concurrent callers and failed results. The cache never crosses invocations. Every authorized callback still reloads database membership, role and deactivation without changing user or company. It allows 1,000 callbacks per invocation, queues above eight outstanding, and bounds request/reply bytes to 64 MiB per call tree. `log` callbacks accept `{ message, details? }` within 32 KiB per invocation.",
    "- Return, deadline, supersession and process kill fence callbacks. Resource cancellation continues after the caller disconnects; unresolved resources are destroyed at the five-second cleanup bound. Mutation transactions classify acknowledged commit or rollback and reconcile uncertain commits by key. An abnormal action fence after an effect began can remain `unknown_outcome`, including an earlier completed autocommit. Fiber interruption alone is not confirmed non-commit. Callback writes and integration calls carry `invocation_id` and `effective_principal` in their operation rows.",
    "- Required pre-dispatch journal writes share the action/mutation deadline; no handler runs before its row is confirmed. Settlement journal writes share the absolute deadline plus cleanup bound and cannot retain action slots indefinitely. When the journal is unavailable, overdue pending invocation and operation rows read as unknown while stored evidence remains available for reconciliation.",
    "- Queries with declared company resources use one read-only `REPEATABLE READ` transaction across callbacks, with the declared resources' revision vector captured as the commit watermark before reads. Resource-free queries retain their callback lifetime without acquiring or provisioning company storage; their watermark is empty and database-held time is zero. Acquisition consumes the three-second deadline; deadline fencing starts protocol cancellation, followed by confirmed release or destruction within cleanup. Shared-table authority is checked live outside the data snapshot on every callback. Query files expose `files.list` and `files.stat` metadata; file bytes and connections are refused by the kind rule.",
    "- Mutations run callback jobs on one host-owned SERIALIZABLE company transaction, opened on the first database callback or at result commit for a callback-free handler. Table callbacks reuse its connection and savepoints. Completion refuses queued callbacks before validated-result commit. A `40001` makes the attempt abort-only and re-invokes the entire handler up to three times within the original five-second deadline; exhaustion is `write_conflict` with `limitId: tier2.mutation.attempts`, the enforced value and viewer scope. Only the transaction owner announces written resources after commit, after releasing its company lease. Wake delivery is bounded and does not delay or change an acknowledged successful reply. Mutation success carries the committed revision vector.",
    "- The mutation key, binding, originating invocation, argument fingerprint and result commit with the writes. An in-window key with no visible committed result may execute. Key-specific `23505` at insert or commit rolls back the loser before resolving the winner; unrelated uniqueness failures never deduplicate. Keys expire at 24 hours and reject more than five minutes of future skew. Changed patch, handler, version, viewer or arguments are refused. A resolved COMMIT on an aborted transaction is rollback, not success; uncertain commit stays `unknown_outcome`. Later key replay reconciles the originating invocation when stored commit evidence becomes available, preserving its original metering and reply-delivery record.",
    "- Actions have a sixty-second deadline and no surrounding transaction. They read shared tables, transfer plain file bytes, and call declared integrations as the viewer with live access checks and a fifteen-second per-call deadline. `ctx.run` uses `server.call` callbacks to sibling queries and mutations; action targets are refused. Each child has its own invocation row and parent link, shares the tree byte budget, and keeps the parent's exact binding with a deadline no later than the parent's. Nested mutations have host-minted keys and independent transactions; their connection time contributes to the parent's `db_ms`.",
    "- Descriptors may carry a `description` on a handler or any value, `readOnly: true` on an action and `agentTool: true` on an `agent.*` handler built from a patch's `agent/` folder; absent fields are omitted, never false or null. A read-only action's capability carries its flag: the host refuses its table inserts, updates and deletes and its file puts and deletes, its `ctx.run` reaches queries only, and its connection reads stay inside `BEGIN READ ONLY` like every Postgres call. A marked agent tool is refused on every call from a page, nested calls included.",
    "- `server.call` arguments are at most one MiB; mutation results at most 64 KiB and query/action results at most eight MiB. Result schema failures and oversized results are `handler_failed`. A lost query reply is retried once by the client, using handler kinds supplied by the loaded shell's nonce-bound bootstrap. In dev, trusted stream `handlers` frames replace those kinds after a server rebind and on reconnect, without reloading the document. Mutation `unknown_outcome` offers explicit `retry()` with the same key and captured arguments; new calls mint fresh keys from stream `hello.serverTime`. Actions and unknown kinds are never replayed.",
    "- `InspectRequest`: wire and source only. `InspectionReply` contains descriptors or a runtime refusal. Inspection has no company binding, capability or callback path and runs in a reaped, deadline-bounded process.",
    "",
    "See [ADR-0012](./adr/ADR-0012-credential-free-execution-service.md) for authority, lifetime and hosting contracts. Dev and test can use the local executor; production tier 2 admission requires the ECS provider (`EXECUTION_PROVIDER=ecs`), which production runs on.",
    "",
    "## Private execution management protocol",
    "",
    "The schemas in [`packages/api/src/management.ts`](../packages/api/src/management.ts) are private host-to-supervisor operations, never public `HttpApi` routes or CLI commands. All five routes use POST and authenticate the current or previous deployment secret as a bearer before reading JSON. Invocation capabilities are refused. The listener binds loopback or an explicitly configured private interface; deployment security groups restrict access to hosts.",
    "",
    "- Every request may carry `taskId`, the task the host resolved. A supervisor that is not that task, or has no task identity, refuses `wrong_task` before any effect, so a stopped task's reused private address cannot reach a fresh task holding the same deployment secret. Supervisors from before this field refuse it as an unknown key, so a host sends it only to tasks running its own release's exec task definition, and reuses a resolved address only for those.",
    "- `/bind` takes `companyId`, `bindingEpoch` and an optional guest `Bundle`. The first call reserves the company. Retrying a bundle bind at the same epoch is idempotent while its resident process is alive; rebinding after reap creates a new generation. Adoption raises the epoch. A bundle bind returns `bindingEpoch`, `binding` and `processGeneration`. Another company or a stopped task cannot reuse it. Unfinished initialization expires at `execution.process.idle` (60 seconds by default), even while health probes succeed, with a `load_failed` refusal and process-report end cause.",
    "- A bind by hash carries the version's `BundleBinding` as `binding` instead of its `Bundle`, never both. It makes the same checks as a bundle bind, waits for a loading process and checks the epoch after the wait, and returns the same reply. A supervisor whose process for that version is not alive refuses `bundle_required` before any effect, and the host sends the bundle bind. A different hash for a held version is `binding_conflict`. Older supervisors refuse `binding` as an unknown key with `invalid_request`, also before any effect, so a host sends the bundle bind after that refusal too. Fleet hosts bind by hash first only to tasks of their own release; a local task can outlive its host's checkout.",
    "- Bind may also carry `operatingLimits` and `configRevision` together. The controller sends the resolved probe interval, process RSS, process idle, resident process count and aggregate bytes for the company. The supervisor applies them under the binding owner check, including on an idempotent bind, and ignores an older override revision at the same epoch. Probe intervals must remain below the six-second stall bound. Guests cannot configure these values.",
    "- Bind may carry `callbackUrls`, up to 64 private IPv4 HTTP `/callback` addresses with explicit ports. An authenticated host registers its issuing address under the binding epoch check. Registrations last for the task's lifetime, so old and replacement hosts can use an already-loaded process during a rollout. Workerd still sees only one loopback proxy; the supervisor selects the target from its immutable invocation record, never guest input.",
    "- `/invoke` takes `bindingEpoch` and the guest `Invoke` as `request`, including the generation returned by bind. Admission can evict idle siblings under residency pressure, never the target process; without enough capacity it refuses `busy`. Success is the guest `InvokeReply`; a killed process returns `process_killed`, not a transaction outcome. `bundle_required` and `stale_generation` are refused before dispatch, when the bound process was reaped or replaced after bind: a host binds again, once, and sends a fresh attempt for the current generation. After any other failure, transport loss included, the caller must not replay automatically.",
    "- `/touch` takes `bindingEpoch` and a version's `BundleBinding` as `binding`. For a ready process of exactly that version and hash at the current epoch it restarts the idle clock and returns `outcome: \"touched\"`. A loading process keeps its initialization deadline from spawn and returns `loading`; no live process returns `absent`. Every reply also carries `idleMs`, the `execution.process.idle` window the supervisor reaps by: its last bind's setting, which a changed limit reaches only with the next bind. A host spaces its touches by the smaller of that and the configured window. A touch never loads, reserves, evicts or changes the epoch, so eviction under residency or memory pressure still applies and only a bind reloads an evicted version. A different hash is `binding_conflict`. Supervisors from before this route don't serve it, so a host touches only tasks of its own release's exec task definition.",
    "- `/stop` takes `bindingEpoch` and optional `processGeneration`, returning 204. With a generation it kills only that process; without one it permanently stops the supervisor's admissions and reaps all processes. `/stats` remains available for reports.",
    "- `/stats` takes `bindingEpoch` and optional `acknowledgeReports` ids. It returns company, epoch, stopped state, aggregate RSS, live process statistics and unacknowledged process reports. The host must persist reports before acknowledging them. Retried stats replies retain the same report ids.",
    "- A process report includes its binding, epoch, generation, spawn/end times, end cause, CPU seconds, peak RSS, calls served, interrupted attempt identities and process wide event. The event's `startMs` is how long the process took from spawn until it was ready for its first call, absent when it never was, and `firstOnTask` says it was the first process its task started for the company. Hosts decode both as optional, so neighbouring releases read each other's reports. Residency peaks cover that process's lifetime, not earlier residents. The supervisor samples meters before reap. An unexpected sampling failure kills only the affected resident with end cause `metering_failed`, leaving other residents supervised. Only the host classifies each interrupted attempt by its commit outcome.",
    "- Callback forwarding stamps `X-Patchy-Binding-Epoch`, `X-Patchy-Process-Generation`, `X-Patchy-Invocation-Id` and `X-Patchy-Attempt-Id`. The supervisor rejects ended attempts and killed generations before forwarding, independently of the host's capability checks.",
    "- Refusals are `{ ok: false, code }`, with `scope`, `limitId` and the enforced `value` for limit refusals (`retryAfter` only where safe). Authentication returns 401; a request naming another task returns 421 `wrong_task`; stale epochs/generations, missing bundles, binding conflicts and stopped tasks return 409; residency pressure returns 503 `busy`; process loss returns 502 `process_killed`. Malformed requests and `load_failed` return 400. Private request bytes are bounded by `execution.management.bodyBytes`; oversized bodies return 413 `too_large` with the enforced limit.",
    "",
    "Residency `busy` refusals also carry `limits`, an array of observed",
    "`{ limitId, value, peak, configRevision: { deploymentRevision, overrideRevision } }`.",
    "The host retains these supervisor measurements in its request event rather than",
    "substituting the host's limit configuration.",
    ""
  );

  lines.push("## Shapes", "");
  for (const [ref, schema] of Object.entries(components)) {
    lines.push(`### ${shapeName(ref)}`, "", "```", renderShape(schema, 0, false), "```", "");
  }

  return lines.join("\n");

  /**
   * A schema on one line. A named shape is a link in prose and a bare name
   * inside a code block; anything else is spelled out.
   */
  function renderType(schema: JsonSchema, linked = true, arrayElement = false): string {
    if (schema.$ref) {
      const name = shapeName(schema.$ref);
      return linked ? `[${name}](#${name.toLowerCase()})` : name;
    }
    if (schema.anyOf) {
      // The enum-of-non-finite-numbers arm Schema.Number adds is noise on a
      // reference and is dropped.
      const arms = [
        ...new Set(
          schema.anyOf
            .filter((arm) => !isNonFiniteNumberArm(arm))
            .map((arm) => renderType(arm, linked, arrayElement))
        )
      ];
      const rendered = arms.join(" | ");
      return arrayElement && arms.length > 1 ? `(${rendered})` : rendered;
    }
    if (schema.enum) {
      const rendered = schema.enum.map((value) => JSON.stringify(value)).join(" | ");
      return arrayElement && schema.enum.length > 1 ? `(${rendered})` : rendered;
    }
    if (schema.type === "array") {
      return `${renderType(schema.items ?? {}, linked, true)}[]`;
    }
    if (schema.type === "object") return renderShape(schema, 0, linked).replace(/\s+/g, " ");
    if (schema.title === "Timestamp") return "string (ISO-8601)";
    return schema.type ?? "unknown";
  }

  /** An object shape over several lines, optional keys marked `?`. */
  function renderShape(schema: JsonSchema, depth: number, linked: boolean): string {
    if (!schema.properties) {
      if (schema.type !== "object") return renderType(schema, linked);
      if (schema.additionalProperties === false) return "{}";
      const value =
        typeof schema.additionalProperties === "object"
          ? renderType(schema.additionalProperties, linked)
          : "unknown";
      return `{ [key: string]: ${value} }`;
    }
    const indent = "  ".repeat(depth + 1);
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties).map(([name, field]) => {
      const rendered = field.properties
        ? renderShape(field, depth + 1, linked)
        : renderType(field, linked);
      return `${indent}${name}${required.has(name) ? "" : "?"}: ${rendered}`;
    });
    return `{\n${fields.join(",\n")}\n${"  ".repeat(depth)}}`;
  }
}

function isNonFiniteNumberArm(schema: JsonSchema): boolean {
  return schema.type === "string" && (schema.enum?.includes("NaN") ?? false);
}
