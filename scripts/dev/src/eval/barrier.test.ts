// @effect-diagnostics globalTimers:off — The barrier is Playwright Promise code, and the fake page keeps its time on vitest's fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BarrierPage,
  type ErrorSource,
  raiseBarrier,
  requestWrites,
  type Sent,
  watchErrors,
  writes
} from "./barrier.js";
import { checkResult } from "./grade.js";
import { isGraderTrouble } from "./task.js";

describe("what the barrier holds", () => {
  const handlers = new Map([
    ["requests.list", "query"],
    ["requests.setStatus", "mutation"],
    ["requests.cancel", "action"]
  ] as const);

  it("holds a tier 2 call to anything but a query the published manifest lists", () => {
    expect(writes("server.call", "requests.list", handlers)).toBe(false);
    expect(writes("server.call", "requests.setStatus", handlers)).toBe(true);
    expect(writes("server.call", "requests.cancel", handlers)).toBe(true);
    expect(writes("server.call", "requests.unlisted", handlers)).toBe(true);
    expect(writes("server.call", null, handlers)).toBe(true);
  });

  it("holds every operation but a read, unknown ones and staged uploads included", () => {
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

/**
 * A page as the barrier sees it: a test sends its runtime requests through
 * the barrier's route as a browser does, and answers or fails the ones that
 * go on by hand. A held request is neither forwarded nor answered.
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
  /** Sends a request: the browser announces it, then routes it. Whether it went on to Patchy. */
  const send = async (sent: { url: string; method: string; body: string }) => {
    const request: Sent = {
      url: () => sent.url,
      method: () => sent.method,
      postData: () => sent.body
    };
    emit("request", request);
    let passed = false;
    await routed?.({
      request: () => request,
      fallback: async () => {
        passed = true;
      }
    });
    return { passed, request };
  };
  return {
    page,
    send,
    answer: (request: Sent) => emit("requestfinished", request),
    fail: (request: Sent) => emit("requestfailed", request)
  };
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

  it("goes through after a looking write was held, which never does", async () => {
    const { page, send, answer } = fakePage();
    const barrier = await raiseBarrier(page, HANDLERS);
    const looking = await send(APPROVE);
    expect(looking.passed).toBe(false);
    expect(barrier.held()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    let deliberate = false;
    const step = barrier.deliberately(async () => {
      const sent = await send(APPROVE);
      deliberate = sent.passed;
      setTimeout(() => answer(sent.request), 300);
    });
    await vi.advanceTimersByTimeAsync(2_500);
    await step;
    expect(deliberate).toBe(true);
    expect(barrier.held()).toBe(1);
    expect((await send(APPROVE)).passed).toBe(false);
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

  it("waits 2 s after the last held write, and never lowers while a page keeps trying to write", async () => {
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

describe("what a page logs", () => {
  /** A page's console and uncaught exceptions, as a test reports them. */
  const fakeSource = () => {
    type Logged = { type(): string; text(): string } & Error;
    const listeners: Array<{ event: string; listener: (value: Logged) => void }> = [];
    const source: ErrorSource = {
      on: (event: "console" | "pageerror", listener: (value: Logged) => void) =>
        listeners.push({ event, listener })
    };
    const emit = (event: string, text: string) => {
      const value = Object.assign(new Error(text), { type: () => "error", text: () => text });
      for (const each of listeners) if (each.event === event) each.listener(value);
    };
    return {
      source,
      log: (text: string) => emit("console", text),
      raise: (message: string) => emit("pageerror", message)
    };
  };
  /** The receipt check's result had it worked, with what its page logged and the writes it held. */
  const receipt = (logged: ReadonlyArray<string>, held = 0) =>
    checkResult("Ben asks with a receipt, and Ada opens it", { ok: true }, logged, held);
  // As Chromium printed them when the barrier still answered refusals: nothing in them is excused now.
  const REFUSAL =
    "Write #1 (files.discard) refused by the eval grader's write barrier [eval-refusal 7f3a9c0d1e2b4a5f]: the grader was only looking.";
  const FRAME = "\n    at answer (about:srcdoc:14:42)";

  it("counts every console error and uncaught exception, whatever it says", async () => {
    const watched = async () => {
      const { page } = fakePage();
      const { source, log, raise } = fakeSource();
      return { errors: watchErrors(source, await raiseBarrier(page, HANDLERS)), log, raise };
    };
    for (const [entry, text] of [
      ["Sol's AggregateError", `AggregateError: ${REFUSAL}${FRAME}`],
      ["Sol's cause chain", `Error: ${REFUSAL}${FRAME}`],
      ["an empty Error() beside a refusal", `Error${FRAME} PatchyError: ${REFUSAL}${FRAME}`],
      [
        'Error("access_denied") beside a refusal',
        `Error: access_denied${FRAME} PatchyError: ${REFUSAL}${FRAME}`
      ],
      ["a refusal alone", `PatchyError: ${REFUSAL}${FRAME}`]
    ] as const) {
      const { errors, log } = await watched();
      log(text);
      expect(receipt(errors), entry).toMatchObject({ status: "fail" });
    }
    const { errors, raise } = await watched();
    raise(REFUSAL);
    expect(receipt(errors)).toMatchObject({ status: "fail" });
  });

  it("is quiet for a lone held write, so the check passes", async () => {
    const { page, send } = fakePage();
    const barrier = await raiseBarrier(page, HANDLERS);
    const { source } = fakeSource();
    const errors = watchErrors(source, barrier);
    expect((await send(DISCARD)).passed).toBe(false);
    expect(receipt(errors, barrier.held())).toMatchObject({ status: "pass" });
  });

  it("says when an error came just after a held write timed out, and that the grader held it", async () => {
    const { page, send, fail } = fakePage();
    const barrier = await raiseBarrier(page, HANDLERS);
    const { source, log } = fakeSource();
    const errors = watchErrors(source, barrier);
    const { request } = await send(DISCARD);
    fail(request);
    log("PatchyError: The runtime reply was lost.");
    expect(receipt(errors, barrier.held())).toMatchObject({
      status: "fail",
      detail:
        "It worked, but the page logged: PatchyError: The runtime reply was lost. (logged just after a write the grader held while only looking timed out) (While only looking, the grader held 1 write the page tried; it never reached Patchy and the page never heard back.)"
    });
  });
});
