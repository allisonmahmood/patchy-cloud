import { escapeAttribute, htmlPage } from "@patchy/core";

/** The signed-out door at the root; the server supplies Auth's sign-in destination. */
export function renderHome(options: { signInUrl: string }): string {
  return htmlPage({
    title: "Sign in to Patchy",
    body: `<main class="auth-card"><div class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</div><h1 class="page-heading">Sign in to Patchy</h1><p>Continue to your company.</p><div class="actions"><a class="btn btn-primary" href="${escapeAttribute(options.signInUrl)}">Sign in</a></div></main>`
  });
}

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
