/**
 * The write barrier on every page the grader opens. From its first request
 * and through every reload, a page can read but not write: each write it
 * attempts is refused before it reaches Patchy, whatever control, timer,
 * retry or mount effect sent it. Only a deliberate step a check means to
 * reach Patchy, such as sending a request or Ada's decision, lowers it
 * (`deliberately`), and only until that step's writes have been answered.
 * So the grader never changes data while it only looks, whatever the page's
 * labels say or turn into.
 *
 * A page reaches Patchy through its shell's runtime endpoints under
 * `/api/runtime/`: `call` for operations, PUTs to stage or store files, and
 * GETs and subscriptions to read. What a call does is its operation's: the
 * ones listed in `READ_OPS` read, a `server.call` reads when the handler is a
 * query in the version's published manifest, and everything else writes,
 * including an operation or handler the grader doesn't know: the barrier
 * fails closed.
 *
 * Accepted limit: a write that looking schedules for later can land in a
 * following deliberate window. At the network a write can't be traced to
 * the press that scheduled it, so before lowering the barrier only waits
 * until 2 s have passed since its last refusal, and with no refusal yet it
 * lowers at once. A timer of any length set by looking, even one shorter
 * than 2 s, can fire after the barrier is lowered and its write goes through.
 * Pages don't schedule writes like that in practice, and the state checks
 * around each deliberate step still catch a change to a request's decision
 * the step didn't cause.
 */
import type { Page } from "@playwright/test";
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

/** What every refusal says, beside which write it was. */
export const MARKER = "refused by the eval grader's write barrier";

/** A token new to one refusal, so its words can be told from anything a page writes itself. */
const nonce = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

/** The message a refused write's error carries: its number, what it refused, and its own token. */
const refusalMessage = (id: number, what: string) =>
  `Write #${id} (${what}) ${MARKER} [eval-refusal ${nonce()}]: the grader was only looking.`;

/** What a refused write answers, as the runtime refuses one. */
const refusal = (message: string) =>
  JSON.stringify({ ok: false, source: "patchy", code: "access_denied", error: message });

/**
 * A stack frame as V8 prints one, and only the frame: a console line joins
 * the next error's words onto the last frame of the one before, and those
 * stay. A frame of any other shape stays too, and so counts.
 */
const FRAME = String.raw`[ \t]*at (?:(?:async |new )?[^\s()]+(?: \[as [^\]\n]+\])? \([^()\n]*\)|[^\s()]+:\d+:\d+)`;
const ANY_FRAME = new RegExp(`^${FRAME}`, "gm");
/** Where a refused write stands in what a page logged beside it. */
const REFUSED = "[a write the grader refused]";
/** How long after a refusal the page's report of it still counts as one. */
const REPORT_MS = 5_000;

/**
 * One refusal's own text wherever a page prints it: its message, the error
 * class printed right before it (`PatchyError: `), and the stack frames
 * right after it. Nothing else is its.
 */
const ownText = (message: string) =>
  new RegExp(
    String.raw`(?:[\w$]*Error: )?${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\n${FRAME})*`,
    "g"
  );

/**
 * Reads something a page logged for the refusals in `live`, the messages of
 * refusals the barrier made moments ago: each one's own text stands as a
 * placeholder. Undefined when it reports none of them. `only` when nothing
 * but whitespace and punctuation is left beside them: then the whole entry
 * is the page's report of those refusals, and anything else in it counts.
 * `rest` is the entry as a failure shows it, on one line without its frames.
 */
export const refusalReport = (text: string, live: ReadonlyArray<string>) => {
  let quoted = false;
  const marked = live.reduce(
    (entry, message) =>
      entry.replace(ownText(message), () => {
        quoted = true;
        return REFUSED;
      }),
    text
  );
  if (!quoted) return undefined;
  return {
    only: /^[\s\p{P}]*$/u.test(marked.replaceAll(REFUSED, "")),
    rest: marked.replace(ANY_FRAME, "").replace(/\s+/g, " ").trim()
  };
};

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
/** How soon after a refusal an error the page logs is reported as following it. */
const AFTER_MS = 2_000;
/** The browser's own line for a request answered 403, which a refused file write is, and nothing else. */
const FORBIDDEN_LINE =
  /^Failed to load resource: the server responded with a status of 403(?: \([^()\n]*\))?$/;

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
    handler: (route: {
      request(): Sent;
      fallback(): Promise<void>;
      fulfill(response: { status: number; contentType: string; body: string }): Promise<void>;
    }) => Promise<void>
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
  /** How many writes it has refused so far. */
  readonly refused: () => number;
  /**
   * What of something the page logged counts against it: nothing when it is
   * wholly the page's report of writes the barrier refused moments before, or
   * the browser's own line for a refused file write's URL, each refusal's
   * once. Anything else counts, a refusal it also reports standing as a
   * placeholder, and says so when it came just after a refusal.
   */
  readonly counted: (text: string, url: string | undefined) => string | undefined;
  /**
   * Runs a deliberate step with the barrier down, once 2 s have passed
   * since the last refusal. However the step ends, it then waits until every write the page
   * sent meanwhile has been answered and nothing new has been sent for a
   * moment, before raising it again. Writes still unanswered past an
   * action's deadline fail grading as the grader's trouble, since looking on
   * would overlap them. A page that never stops trying to write while the
   * grader looks fails the check, since lowering would let those writes in.
   */
  readonly deliberately: <T>(act: () => Promise<T>) => Promise<T>;
}

/**
 * Raises the barrier on `page` before its first navigation. Refused calls
 * answer as the runtime refuses one, a 200 the shell turns into a refusal;
 * refused file writes answer 403, since a 200 would read as stored.
 */
export const raiseBarrier = async (
  page: BarrierPage,
  handlers: ReadonlyMap<string, HandlerKind>
): Promise<Barrier> => {
  let lowered = false;
  let lastRefusal = -Infinity;
  /** Each refusal: when it was made, and the message its error carries. */
  const refusals: Array<{ readonly at: number; readonly message: string }> = [];
  const refusedFiles: Array<{ readonly url: string; readonly at: number }> = [];
  await page.route("**/api/runtime/**", async (route) => {
    const request = route.request();
    const body = request.postData() ?? "";
    if (lowered || !requestWrites({ url: request.url(), method: request.method(), body }, handlers))
      return route.fallback();
    const id = refusals.length + 1;
    lastRefusal = performance.now();
    const call = new URL(request.url()).pathname.endsWith("/api/runtime/call");
    const sent = call ? callOf(body) : undefined;
    const what = sent?.handler ?? sent?.op ?? (call ? "a call" : "a file");
    const message = refusalMessage(id, what);
    refusals.push({ at: lastRefusal, message });
    if (!call) refusedFiles.push({ url: request.url(), at: lastRefusal });
    await route
      .fulfill({
        status: call ? 200 : 403,
        contentType: "application/json",
        body: refusal(message)
      })
      .catch(() => undefined);
  });
  /**
   * Waits until 2 s have passed since the barrier's last refusal, so a write
   * looking keeps retrying lands refused rather than in the deliberate step.
   * With no refusal yet it doesn't wait (see the accepted limit above).
   */
  const quietened = async () => {
    for (let waited = 0; performance.now() - lastRefusal < QUIET_MS; waited += POLL_MS) {
      if (waited >= SETTLE_CAP_MS)
        throw new Error(
          "The page kept trying to change data while the grader only looked, so the grader couldn't take its next step without letting those writes through."
        );
      await page.waitForTimeout(POLL_MS);
    }
  };
  return {
    refused: () => refusals.length,
    counted: (text, url) => {
      const now = performance.now();
      if (url !== undefined && FORBIDDEN_LINE.test(text)) {
        const index = refusedFiles.findIndex(
          (file) => file.url === url && now - file.at <= REPORT_MS
        );
        if (index !== -1) {
          refusedFiles.splice(index, 1);
          return undefined;
        }
      }
      const live = refusals
        .filter((made) => made.at <= now && now - made.at <= REPORT_MS)
        .map((made) => made.message);
      const report = refusalReport(text, live);
      if (report?.only === true) return undefined;
      const shown = report?.rest ?? text;
      return now - lastRefusal < AFTER_MS
        ? `${shown} (logged just after the grader refused one of the page's writes while only looking)`
        : shown;
    },
    deliberately: async (act) => {
      await quietened();
      const pending = new Set<Sent>();
      let last = performance.now();
      const counts = (request: Sent) =>
        request.url().includes("/api/runtime/") && request.method() !== "GET";
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
  refused: () => 0,
  counted: (text) => text,
  deliberately: (act) => act()
};

/**
 * What a page logs that counts against it: its console errors and uncaught
 * exceptions, less its own reports of writes the barrier refused (`counted`).
 */
export const watchErrors = (page: Page, barrier: Barrier) => {
  const errors: Array<string> = [];
  const keep = (text: string, url: string | undefined) => {
    const counted = barrier.counted(text, url);
    if (counted !== undefined) errors.push(counted);
  };
  page.on("console", (message) => {
    if (message.type() === "error") keep(message.text(), message.location().url || undefined);
  });
  page.on("pageerror", (error) => keep(error.message, undefined));
  return errors;
};
