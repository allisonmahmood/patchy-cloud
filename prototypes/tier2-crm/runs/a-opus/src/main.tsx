import { render } from "patchy/preact";
import { App } from "./App.js";
import "./styles.css";

// Debug helpers only in the local dev shell, never shipped: the build drops this branch.
if (import.meta.env.DEV) await import("preact/debug");

render(<App />, document.getElementById("root")!);
