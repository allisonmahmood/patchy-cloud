import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { type LogEntry, PatchLog } from "@patchy/api";
import { render } from "./logs.js";

type Step = LogEntry["steps"][number];

const step = (id: string, parentId: string, fields: Partial<Step> = {}): Step => ({
  type: "invocation",
  id,
  parentId,
  at: "2026-10-19T10:00:00.000Z",
  name: id,
  kind: "mutation",
  resource: null,
  connection: null,
  effectivePrincipal: "patch",
  outcome: "success",
  code: null,
  durationMs: 1,
  attempts: 1,
  rowCount: null,
  logLines: [],
  ...fields
});

const page = (steps: ReadonlyArray<Step>, next: string | null = null) =>
  new PatchLog({
    ok: true,
    patchId: "abcdefghijkl",
    entries: [
      {
        id: "inv_top",
        correlationId: "cor_top",
        startedAt: "2026-10-19T10:00:00.000Z",
        settledAt: "2026-10-19T10:00:00.100Z",
        version: 3,
        handler: "orders.import",
        kind: "action",
        viewer: { id: "usr_ben", name: "Ben" },
        outcome: "handler_error",
        code: "bad_row",
        durationMs: 100,
        guestMs: 80,
        dbMs: 10,
        callbacks: 4,
        attempts: 1,
        replyDelivered: true,
        logLines: [],
        steps,
        stepsTruncated: false
      }
    ],
    next,
    windowEnded: false
  });

const options = { failed: false, patch: Option.none<string>() };

describe("patchy logs text", () => {
  it("prints each step under the handler that made it, though steps arrive shallowest first", () => {
    const call = { type: "call", kind: null, rowCount: 1 } as const;
    const lines = render(
      page([
        step("orders.create", "inv_top"),
        step("orders.notify", "inv_top"),
        step("call_a", "orders.create", { ...call, name: "tables.insert", resource: "orders" }),
        step("call_b", "orders.notify", { ...call, name: "tables.insert", resource: "outbox" })
      ]),
      options
    );
    expect(lines.slice(2)).toEqual([
      "  - orders.create (mutation) · as the patch · success · 1 ms",
      "    - tables.insert orders · as the patch · success · 1 ms · 1 rows",
      "  - orders.notify (mutation) · as the patch · success · 1 ms",
      "    - tables.insert outbox · as the patch · success · 1 ms · 1 rows"
    ]);
  });

  it("stops a page's text near 2 MiB and still says how to read on", () => {
    // Fifty nested handlers, each logging a long stack, indent far past the page's wire size.
    const stack = "    at handler (server.js:1:1)\n".repeat(1_000);
    const nested = Array.from({ length: 50 }, (_, depth) =>
      step(`nested_${depth}`, depth === 0 ? "inv_top" : `nested_${depth - 1}`, {
        logLines: [{ message: "failed", details: { stack } }]
      })
    );
    const lines = render(page(nested, "inv_top"), options);
    const bytes = lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
    expect(bytes).toBeLessThan(2 * 1024 * 1024 + 1_024);
    expect(lines.slice(-3)).toEqual([
      "… the rest of this page is longer than text shows; read it all with --json.",
      "",
      "Older entries: patchy logs --before inv_top"
    ]);
  });
});
