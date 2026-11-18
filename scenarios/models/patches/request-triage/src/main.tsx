import { render } from "patchy/preact";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";
import { App } from "./App.js";
import "./styles.css";

render(<App />, document.getElementById("root")!);

/** How one call ended and how long it took, as this page saw it. */
const timed = async (call: () => Promise<unknown>) => {
  const started = performance.now();
  try {
    await call();
    return { ms: performance.now() - started, code: "ok" };
  } catch (error) {
    const ms = performance.now() - started;
    if (!isPatchyError(error))
      return { ms, code: "thrown", message: error instanceof Error ? error.message : String(error) };
    return {
      ms,
      code: error.code,
      limitId: error.limitId,
      scope: error.scope,
      details: error.details,
      retryAfter: error.retryAfter,
      message: error.message
    };
  }
};

// PROTOTYPE: the slot load driver (scripts/dev/load-models.mjs) calls these through Playwright.
Object.assign(globalThis, {
  patchyLoad: {
    model: (args: Parameters<typeof patchy.server.load.model>[0]) =>
      timed(() => patchy.server.load.model(args)),
    quick: () => timed(() => patchy.server.load.quick({}))
  }
});
