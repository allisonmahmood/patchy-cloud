/**
 * The write barrier on every page the grader opens. From its first request
 * and through every reload, a page can read but not write: each write it
 * attempts is held, never forwarded, answered or failed, so it never reaches
 * Patchy and the page never hears back about it, whatever control, timer,
 * retry or mount effect sent it. With no refusal to report, there is
 * nothing a page could log about one, so every error it logs counts. Only a
 * deliberate step a check means to reach Patchy, such as sending a request
 * or Ada's decision, lowers it (`deliberately`), and only until that step's
 * writes have been answered. So the grader never changes data while it only
 * looks, whatever the page's labels say or turn into.
 *
 * A page reaches Patchy through its shell's runtime endpoints under
 * `/api/runtime/`: `call` for operations, PUTs to stage or store files, and
 * GETs and subscriptions to read. What a call does is its operation's: the
 * ones listed in `READ_OPS` read, a `server.call` reads when the handler is a
 * query in the version's published manifest, and everything else writes,
 * including an operation or handler the grader doesn't know: the barrier
 * fails closed.
 *
 * A held write lives as long as its page. The shell gives up on it at its
 * reply deadline (110 s for a server call, 35 s for anything else) and tells
 * the page its reply was lost; an error the page logs then counts, and says
 * a held write timed out. Held writes also take up the shell's outstanding
 * requests (32 a page), and past that it refuses the page's calls itself.
 *
 * Accepted limit: a write that looking schedules for later can land in a
 * following deliberate window. At the network a write can't be traced to
 * the press that scheduled it, so before lowering the barrier only waits
 * until 2 s have passed since the last write it held, and with none yet it
 * lowers at once. A timer of any length set by looking, even one shorter
 * than 2 s, can fire after the barrier is lowered and its write goes through.
 * Pages don't schedule writes like that in practice, and the state checks
 * around each deliberate step still catch a change to a request's decision
 * the step didn't cause.
 */
import { GraderTrouble, type HandlerKind } from "./task.js";

/**
 * The runtime operations that only read, audited against the runtime's own
 * list (`packages/api/src/runtime.ts`) and what it lets a browser call
 * (`packages/runtime/src/Runtime.ts`). Staging, discarding and deleting a
 * file write, even where the runtime files them as reads.
 */
export const READ_OPS = new Set([
  "me",
  "members.list",
  "members.search",
  "members.get",
  "members.getMany",
  "tables.get",
  "tables.getMany",
  "tables.list",
  "shared.get",
  "shared.getMany",
  "shared.list",
  "files.get",
  "files.redeem",
  "files.list",
  "files.stat",
  "files.inspectUpload",
  "shared.files.get",
  "shared.files.list",
  "shared.files.stat"
]);

/**
 * Whether a call a page sends would change data: a server call to a handler
 * its published manifest doesn't list as a query, including one it doesn't
 * list at all, or any operation but a read.
 */
export const writes = (
  op: string,
  handler: string | null,
  handlers: ReadonlyMap<string, HandlerKind>
) =>
  op === "server.call" ? handler === null || handlers.get(handler) !== "query" : !READ_OPS.has(op);

/** How a call's body reads: its operation, and the handler a server call names. */
const callOf = (body: string) => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("op" in parsed)) return undefined;
    const op = typeof parsed.op === "string" ? parsed.op : undefined;
    if (op === undefined) return undefined;
    const args = "args" in parsed ? parsed.args : undefined;
    const handler =
      typeof args === "object" &&
      args !== null &&
      "handler" in args &&
      typeof args.handler === "string"
        ? args.handler
        : null;
    return { op, handler };
  } catch {
    return undefined;
  }
};

/**
 * Whether a request to a runtime endpoint writes: a call by its operation, a
 * file by its method, and a read endpoint (the stream, subscriptions, file
 * GETs) never. Anything else under `/api/runtime/` that isn't a GET writes.
 */
export const requestWrites = (
  request: { readonly url: string; readonly method: string; readonly body: string },
  handlers: ReadonlyMap<string, HandlerKind>
) => {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/api/runtime/call")) {
    const call = callOf(request.body);
    return call === undefined || writes(call.op, call.handler, handlers);
  }
  if (path.endsWith("/api/runtime/subscriptions")) return false;
  return request.method !== "GET";
};

/** How long a deliberate step's writes may take to be answered: an action's 60 s, and a margin. */
const DELIBERATE_MS = 75_000;
/** How long nothing new must happen before a deliberate step counts as done, or looking as quiet. */
const QUIET_MS = 2_000;
/** How long the barrier waits for looking to go quiet before a deliberate step. */
const SETTLE_CAP_MS = 10_000;
const POLL_MS = 100;
/** How soon after a held write timed out an error the page logs is reported as following it. */
const AFTER_MS = 2_000;

/** A request as the barrier reads it. */
export interface Sent {
  url(): string;
  method(): string;
  postData(): string | null;
}

/** What the barrier needs of a page: its runtime requests, routed and followed, and its clock. */
export interface BarrierPage {
  route(
    url: string,
    handler: (route: { request(): Sent; fallback(): Promise<void> }) => Promise<void>
  ): Promise<unknown>;
  on(
    event: "request" | "requestfinished" | "requestfailed",
    listener: (request: Sent) => void
  ): unknown;
  off(
    event: "request" | "requestfinished" | "requestfailed",
    listener: (request: Sent) => void
  ): unknown;
  waitForTimeout(ms: number): Promise<void>;
}

export interface Barrier {
  /** How many writes the page has tried, and the barrier held, so far. */
  readonly held: () => number;
  /** Whether a held write's shell gave up on it in the last moments, to say so beside an error. */
  readonly heldTimedOut: () => boolean;
  /**
   * Runs a deliberate step with the barrier down, once 2 s have passed since
   * the last write it held. However the step ends, it then waits until every
   * write the page sent meanwhile has been answered and nothing new has been
   * sent for a moment, before raising it again. Writes still unanswered past
   * an action's deadline fail grading as the grader's trouble, since looking
   * on would overlap them. A page that never stops trying to write while the
   * grader looks fails the check, since lowering would let those writes in.
   */
  readonly deliberately: <T>(act: () => Promise<T>) => Promise<T>;
}

/** Raises the barrier on `page` before its first navigation. */
export const raiseBarrier = async (
  page: BarrierPage,
  handlers: ReadonlyMap<string, HandlerKind>
): Promise<Barrier> => {
  let lowered = false;
  let attempts = 0;
  let lastHeld = -Infinity;
  let lastTimeout = -Infinity;
  /** The writes held and still open: never forwarded, answered or failed by the grader. */
  const holding = new Set<Sent>();
  await page.route("**/api/runtime/**", async (route) => {
    const request = route.request();
    const body = request.postData() ?? "";
    if (lowered || !requestWrites({ url: request.url(), method: request.method(), body }, handlers))
      return route.fallback();
    // Held: the route is left as it is, so the write never reaches Patchy and no answer reaches the page.
    attempts++;
    lastHeld = performance.now();
    holding.add(request);
  });
  // The shell gives up on a held write at its reply deadline, or the page goes.
  page.on("requestfailed", (request) => {
    if (holding.delete(request)) lastTimeout = performance.now();
  });
  /**
   * Waits until 2 s have passed since the last write the barrier held, so a
   * write looking keeps retrying is held rather than let into the deliberate
   * step. With none held yet it doesn't wait (see the accepted limit above).
   */
  const quietened = async () => {
    for (let waited = 0; performance.now() - lastHeld < QUIET_MS; waited += POLL_MS) {
      if (waited >= SETTLE_CAP_MS)
        throw new Error(
          "The page kept trying to change data while the grader only looked, so the grader couldn't take its next step without letting those writes through."
        );
      await page.waitForTimeout(POLL_MS);
    }
  };
  return {
    held: () => attempts,
    heldTimedOut: () => performance.now() - lastTimeout < AFTER_MS,
    deliberately: async (act) => {
      await quietened();
      const pending = new Set<Sent>();
      let last = performance.now();
      // A write held while looking is never answered, so it isn't the step's to wait for.
      const counts = (request: Sent) =>
        request.url().includes("/api/runtime/") &&
        request.method() !== "GET" &&
        !holding.has(request);
      const started = (request: Sent) => {
        if (!counts(request)) return;
        pending.add(request);
        last = performance.now();
      };
      const ended = (request: Sent) => {
        if (!pending.delete(request)) return;
        last = performance.now();
      };
      /** Waits until the step's writes are answered and nothing new has been sent for a moment. */
      const drained = async () => {
        // The quiet window starts after the step too, so a write it sends a moment late still counts.
        const from = performance.now();
        last = Math.max(last, from);
        while (pending.size > 0 || performance.now() - last < QUIET_MS) {
          if (performance.now() - from > DELIBERATE_MS)
            throw new GraderTrouble({
              what: "A deliberate step's writes were still unanswered past an action's deadline, so the grader stopped rather than look on beside them."
            });
          await page.waitForTimeout(POLL_MS);
        }
      };
      page.on("request", started);
      page.on("requestfinished", ended);
      page.on("requestfailed", ended);
      lowered = true;
      try {
        return await act();
      } finally {
        // Drained however the step ended: a step that throws after sending a write still waits for it.
        try {
          await drained();
        } finally {
          lowered = false;
          page.off("request", started);
          page.off("requestfinished", ended);
          page.off("requestfailed", ended);
        }
      }
    }
  };
};

/** No barrier, for setup that writes on purpose, such as loading sample data. */
export const noBarrier: Barrier = {
  held: () => 0,
  heldTimedOut: () => false,
  deliberately: (act) => act()
};

/** Where a page's errors come from: its console and its uncaught exceptions. */
export interface ErrorSource {
  on(event: "console", listener: (message: { type(): string; text(): string }) => void): unknown;
  on(event: "pageerror", listener: (error: Error) => void): unknown;
}

/**
 * What a page logs that counts against it: every console error and uncaught
 * exception, with nothing excused. One logged just after a held write timed
 * out says so, since the grader's holding is what made it fail.
 */
export const watchErrors = (page: ErrorSource, barrier: Barrier) => {
  const errors: Array<string> = [];
  const keep = (text: string) =>
    errors.push(
      barrier.heldTimedOut()
        ? `${text} (logged just after a write the grader held while only looking timed out)`
        : text
    );
  page.on("console", (message) => {
    if (message.type() === "error") keep(message.text());
  });
  page.on("pageerror", (error) => keep(error.message));
  return errors;
};
