import { render } from "patchy/preact";
import { App } from "./App.js";
import "./styles.css";

// Only under `vite` serve; `patchy dev` and publish both run `vite build`, so this never ships.
if (import.meta.env.DEV) await import("preact/debug");

// e2e/scenario.mjs sets VITE_E2E=1 in .env.local to call handlers directly as either person and
// check server-side refusals. Unset (the default, and at publish) the build drops this branch.
if (import.meta.env.VITE_E2E === "1") {
  const { patchy } = await import("../patchy/_generated/client.js");
  Object.assign(window, { patchy });
}

render(<App />, document.getElementById("root")!);
