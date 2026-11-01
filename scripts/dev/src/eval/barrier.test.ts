// @effect-diagnostics globalTimers:off — The barrier is Playwright Promise code, and the fake page keeps its time on vitest's fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BarrierPage, raiseBarrier, requestWrites, type Sent, writes } from "./barrier.js";
import { isGraderTrouble } from "./task.js";

describe("what the barrier refuses", () => {
  const handlers = new Map([
    ["requests.list", "query"],
    ["requests.setStatus", "mutation"],
    ["requests.cancel", "action"]
  ] as const);

  it("refuses a tier 2 call to anything but a query the published manifest lists", () => {
    expect(writes("server.call", "requests.list", handlers)).toBe(false);
    expect(writes("server.call", "requests.setStatus", handlers)).toBe(true);
    expect(writes("server.call", "requests.cancel", handlers)).toBe(true);
    expect(writes("server.call", "requests.unlisted", handlers)).toBe(true);
    expect(writes("server.call", null, handlers)).toBe(true);
  });

  it("refuses every operation but a read, unknown ones and staged uploads included", () => {
    const none = new Map<string, "query">();
    for (const op of [
      "tables.insert",
      "tables.insertMany",
      "tables.update",
      "tables.delete",
      "files.put",
      "files.stage",
      "files.discard",
      "files.delete",
      "pidgeon.send",
      "postgres.execute",
      "something.new"
    ])
      expect(writes(op, null, none), op).toBe(true);
    for (const op of [
      "tables.get",
      "tables.list",
      "files.get",
      "files.redeem",
      "me",
      "members.list"
    ])
      expect(writes(op, null, none), op).toBe(false);
  });

  it("reads a runtime request by its endpoint, its method and its operation", () => {
    const handlers = new Map([["requests.list", "query"]] as const);
    const at = (path: string, method = "POST", body = "") => ({
      url: `http://x.localhost/api/runtime/${path}`,
      method,
      body
    });
    const call = (op: string, handler?: string) =>
      at("call", "POST", JSON.stringify({ op, args: handler === undefined ? {} : { handler } }));
    expect(requestWrites(call("server.call", "requests.list"), handlers)).toBe(false);
    expect(requestWrites(call("server.call", "requests.approve"), handlers)).toBe(true);
    expect(requestWrites(call("files.discard"), handlers)).toBe(true);
    expect(requestWrites(at("call", "POST", "not json"), handlers)).toBe(true);
    expect(requestWrites(at("subscriptions"), handlers)).toBe(false);
    expect(requestWrites(at("stream", "GET"), handlers)).toBe(false);
    expect(requestWrites(at("files/p1/ver_1/receipts/r.png", "GET"), handlers)).toBe(false);
    expect(requestWrites(at("files/p1/ver_1/receipts/r.png", "PUT"), handlers)).toBe(true);
    expect(requestWrites(at("staged-files/p1/ver_1", "PUT"), handlers)).toBe(true);
    expect(requestWrites(at("something-new", "POST"), handlers)).toBe(true);
  });
});

const HANDLERS = new Map([
  ["requests.list", "query"],
  ["requests.approve", "mutation"]
] as const);
const CALL = "http://x.localhost/api/runtime/call";
const APPROVE = {
  url: CALL,
  method: "POST",
  body: JSON.stringify({ op: "server.call", args: { handler: "requests.approve" } })
};
const DISCARD = {
  url: CALL,
  method: "POST",
  body: JSON.stringify({ op: "files.discard", args: {} })
};
const RECEIPT = {
  url: "http://x.localhost/api/runtime/files/p1/ver_1/receipts/r.png",
  method: "PUT",
  body: ""
};

/**
 * A page as the barrier sees it: a test sends its runtime requests through
 * the barrier's route, and answers the ones that pass by hand.
 */
const fakePage = () => {
  let routed: Parameters<BarrierPage["route"]>[1] | undefined;
  const listeners = new Map<string, Set<(request: Sent) => void>>();
  const page: BarrierPage = {
    route: async (_url, handler) => {
      routed = handler;
    },
    on: (event, listener) =>
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
    off: (event, listener) => listeners.get(event)?.delete(listener),
    waitForTimeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
  const emit = (event: string, request: Sent) => {
    for (const listener of listeners.get(event) ?? []) listener(request);
  };
  /** Sends a request as the page's shell would: whether it went on to Patchy, and how it was answered if not. */
  const send = async (sent: { url: string; method: string; body: string }) => {
    const request: Sent = {
      url: () => sent.url,
      method: () => sent.method,
      postData: () => sent.body
    };
    let passed = false;
    let answer: string | undefined;
    await routed?.({
      request: () => request,
      fallback: async () => {
        passed = true;
      },
      fulfill: async (response) => {
        answer = response.body;
      }
    });
    if (passed) emit("request", request);
    return { passed, request, answer };
  };
  return { page, send, answer: (request: Sent) => emit("requestfinished", request) };
};

describe("a deliberate step", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"]
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for its writes to be answered even when it throws, before the barrier rises", async () => {
    const { page, send, answer } = fakePage();
    const barrier = await raiseBarrier(page, HANDLERS);
    let ended: string | undefined;
    void barrier
      .deliberately(async () => {
        const approve = await send(APPROVE);
        expect(approve.passed).toBe(true);
        setTimeout(() => answer(approve.request), 1_300);
        throw new Error("The next press failed.");
      })
      .catch((error: Error) => {
        ended = error.message;
      });
    // Answered at 1.3 s, then quiet for 2 s.
    await vi.advanceTimersByTimeAsync(3_100);
    expect(ended).toBeUndefined();
    await vi.advanceTimersByTimeAsync(400);
    expect(ended).toBe("The next press failed.");
    expect((await send(APPROVE)).passed).toBe(false);
  });

  it("ends grading as the grader's trouble when a write it sent is still unanswered at the deadline, however it ended", async () => {
    const { page, send } = fakePage();
    const barrier = await raiseBarrier(page, HANDLERS);
    const ended = barrier
      .deliberately(async () => {
        await send(APPROVE);
        throw new Error("The next press failed.");
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(76_000);
    expect(isGraderTrouble(await ended)).toBe(true);
  });

  it("waits for looking to go quiet, and never lowers while a page keeps trying to write", async () => {
    const { page, send } = fakePage();
    const barrier = await raiseBarrier(page, HANDLERS);
    await send(DISCARD);
    let ran = 0;
    const quiet = barrier.deliberately(async () => {
      ran++;
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(ran).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    await quiet;
    expect(ran).toBe(1);

    const retrying = setInterval(() => void send(DISCARD), 150);
    await vi.advanceTimersByTimeAsync(1_000);
    const busy = barrier
      .deliberately(async () => {
        ran++;
      })
      .catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(11_000);
    clearInterval(retrying);
    expect(await busy).toMatch(/kept trying to change data while the grader only looked/);
    expect(ran).toBe(1);
  });
});

describe("what a page logs beside a refused write", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  /** A barrier that has just refused one discard (#1) and nothing else. */
  const refusedOnce = async (sent = DISCARD) => {
    const { page, send } = fakePage();
    const barrier = await raiseBarrier(page, HANDLERS);
    const { answer } = await send(sent);
    return { barrier, answer };
  };
  // As Chromium prints them: errors logged together share a line, the second after the first's last frame.
  const REPORT =
    "PatchyError: Write #1 (files.discard) refused by the eval grader's write barrier: the grader was only looking.\n    at answer (about:srcdoc:14:42)";
  const BROKEN =
    "Error: Broken request view: undefined.render\n    at HTMLButtonElement.<anonymous> (about:srcdoc:20:62)";

  it("answers a refused call with words that say which write it was", async () => {
    const { answer } = await refusedOnce();
    expect(JSON.parse(answer ?? "{}")).toMatchObject({
      ok: false,
      source: "patchy",
      code: "access_denied",
      error:
        "Write #1 (files.discard) refused by the eval grader's write barrier: the grader was only looking."
    });
  });

  it("excuses only the page's own report of the refusal, however it prints", async () => {
    const { barrier } = await refusedOnce();
    expect(barrier.counted(REPORT, undefined)).toBeUndefined();
    expect(barrier.counted(`Uncaught (in promise) ${REPORT}`, undefined)).toBeUndefined();
    expect(barrier.counted(`files.discard: ${REPORT}`, undefined)).toBeUndefined();
  });

  it("counts an unrelated failure reported with the refusal, in either order, and says what it was", async () => {
    const { barrier } = await refusedOnce();
    for (const mixed of [`${BROKEN} ${REPORT}`, `${REPORT} ${BROKEN}`]) {
      const counted = barrier.counted(mixed, undefined);
      expect(counted).toContain("Broken request view: undefined.render");
      expect(counted).toContain("[a write the grader refused]");
    }
    expect(barrier.counted(`Couldn't mark it seen: ${REPORT}`, undefined)).toContain(
      "Couldn't mark it seen"
    );
  });

  it("counts a report of a refusal the barrier didn't make, or made for another write, or long ago", async () => {
    const { barrier } = await refusedOnce();
    expect(barrier.counted(REPORT.replace("#1", "#2"), undefined)).toBeDefined();
    expect(
      barrier.counted(REPORT.replace("files.discard", "requests.approve"), undefined)
    ).toBeDefined();
    vi.useFakeTimers({ toFake: ["performance"] });
    const late = await refusedOnce();
    vi.advanceTimersByTime(6_000);
    expect(late.barrier.counted(REPORT, undefined)).toBeDefined();
  });

  it("excuses the browser's own line for a refused file write once, by its URL", async () => {
    const { barrier } = await refusedOnce(RECEIPT);
    const line = "Failed to load resource: the server responded with a status of 403 (Forbidden)";
    expect(
      barrier.counted(line, "http://x.localhost/api/runtime/files/p1/ver_1/other.png")
    ).toBeDefined();
    expect(barrier.counted(line, RECEIPT.url)).toBeUndefined();
    expect(barrier.counted(line, RECEIPT.url)).toBeDefined();
  });
});
