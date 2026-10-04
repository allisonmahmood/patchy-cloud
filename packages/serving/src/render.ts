import { htmlPage } from "@patchy/core";

export function renderNotFound(): string {
  return htmlPage({
    title: "Patch not found",
    body: `
      <main class="wrap compact">
        <header class="doc-head">
          <div class="head-line">
            <span class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</span>
            <span class="kicker">Missing patch</span>
          </div>
          <h1>Patch not found.</h1>
          <p class="lede">The requested patch is unavailable. It may have been disabled, deleted, or mistyped.</p>
        </header>
      </main>
    `
  });
}
