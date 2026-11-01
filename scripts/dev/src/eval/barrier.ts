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
 */
import type { Page, Request, Route } from "@playwright/test";
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

/** What every refusal says, so the page's own report of one can be told from anything else it logs. */
export const MARKER = "refused by the eval grader's write barrier";

const REFUSAL = JSON.stringify({
  ok: false,
  source: "patchy",
  code: "access_denied",
  error: `This write was ${MARKER}: the grader was only looking.`
});

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
/** How long nothing new must happen before a deliberate step counts as done, or a page as quiet. */
const QUIET_MS = 2_000;
/** How long the barrier waits for a page's own write attempts to die down before a deliberate step. */
const SETTLE_CAP_MS = 10_000;
const POLL_MS = 100;
/** How soon after a refusal an error the page logs is reported as following it. */
const AFTER_MS = 2_000;

export interface Barrier {
  /** How many writes it has refused so far. */
  readonly refused: () => number;
  /**
   * Whether something the page logged is its report of a write the barrier
   * refused: a message carrying the refusal's words, or the browser's own
   * line for a refused file write's URL, each refusal's once.
   */
  readonly excuses: (text: string, url: string | undefined) => boolean;
  /** Whether the barrier refused a write in the last moments, to say so beside an error. */
  readonly justRefused: () => boolean;
  /**
   * Runs a deliberate step with the barrier down, then waits until every
   * write the page sent meanwhile has been answered and nothing new has been
   * sent for a moment, before raising it again. Writes still unanswered past
   * an action's deadline fail grading as the grader's trouble, since looking
   * on would overlap them.
   */
  readonly deliberately: <T>(act: () => Promise<T>) => Promise<T>;
}

/**
 * Raises the barrier on `page` before its first navigation. Refused calls
 * answer as the runtime refuses one, a 200 the shell turns into a refusal;
 * refused file writes answer 403, since a 200 would read as stored.
 */
export const raiseBarrier = async (
  page: Page,
  handlers: ReadonlyMap<string, HandlerKind>
): Promise<Barrier> => {
  let lowered = false;
  let refused = 0;
  let lastRefusal = -Infinity;
  const refusedUrls: Array<string> = [];
  await page.route("**/api/runtime/**", async (route: Route) => {
    const request = route.request();
    const writing =
      !lowered &&
      requestWrites(
        { url: request.url(), method: request.method(), body: request.postData() ?? "" },
        handlers
      );
    if (!writing) return route.fallback();
    refused++;
    lastRefusal = performance.now();
    const call = new URL(request.url()).pathname.endsWith("/api/runtime/call");
    if (!call) refusedUrls.push(request.url());
    await route
      .fulfill({ status: call ? 200 : 403, contentType: "application/json", body: REFUSAL })
      .catch(() => undefined);
  });
  /** Waits until the page hasn't tried to write for a moment, so a write it scheduled lands refused. */
  const quietened = async () => {
    for (let waited = 0; waited < SETTLE_CAP_MS; waited += POLL_MS) {
      if (performance.now() - lastRefusal >= QUIET_MS) return;
      await page.waitForTimeout(POLL_MS);
    }
  };
  return {
    refused: () => refused,
    excuses: (text, url) => {
      if (text.includes(MARKER)) return true;
      const index = url === undefined ? -1 : refusedUrls.indexOf(url);
      if (index === -1 || !/failed to load resource/i.test(text)) return false;
      refusedUrls.splice(index, 1);
      return true;
    },
    justRefused: () => performance.now() - lastRefusal < AFTER_MS,
    deliberately: async (act) => {
      await quietened();
      const pending = new Set<Request>();
      let last = performance.now();
      const counts = (request: Request) =>
        request.url().includes("/api/runtime/") && request.method() !== "GET";
      const started = (request: Request) => {
        if (!counts(request)) return;
        pending.add(request);
        last = performance.now();
      };
      const ended = (request: Request) => {
        if (!pending.delete(request)) return;
        last = performance.now();
      };
      page.on("request", started);
      page.on("requestfinished", ended);
      page.on("requestfailed", ended);
      lowered = true;
      try {
        const value = await act();
        // The quiet window starts after the step too, so a write it sends a moment late still counts.
        const from = performance.now();
        last = Math.max(last, from);
        for (;;) {
          if (pending.size === 0 && performance.now() - last >= QUIET_MS) break;
          if (performance.now() - from > DELIBERATE_MS)
            throw new GraderTrouble({
              what: "A deliberate step's writes were still unanswered past an action's deadline, so the grader stopped rather than look on beside them."
            });
          await page.waitForTimeout(POLL_MS);
        }
        return value;
      } finally {
        lowered = false;
        page.off("request", started);
        page.off("requestfinished", ended);
        page.off("requestfailed", ended);
      }
    }
  };
};

/** No barrier, for setup that writes on purpose, such as loading sample data. */
export const noBarrier: Barrier = {
  refused: () => 0,
  excuses: () => false,
  justRefused: () => false,
  deliberately: (act) => act()
};

/**
 * What a page logs that counts against it: its console errors and uncaught
 * exceptions, less its own reports of a write the barrier refused. One
 * logged just after a refusal still counts, and says so.
 */
export const watchErrors = (page: Page, barrier: Barrier) => {
  const errors: Array<string> = [];
  const keep = (text: string, url: string | undefined) => {
    if (barrier.excuses(text, url)) return;
    errors.push(
      barrier.justRefused()
        ? `${text} (logged just after the grader refused one of the page's writes while only looking)`
        : text
    );
  };
  page.on("console", (message) => {
    if (message.type() === "error") keep(message.text(), message.location().url || undefined);
  });
  page.on("pageerror", (error) => keep(error.message, undefined));
  return errors;
};
