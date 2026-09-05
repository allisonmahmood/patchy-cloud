import { escapeAttribute, escapeHtml, htmlPage } from "@patchy/core";
import type { Patches } from "@patchy/patches";

export function renderHome(options: { publicBaseUrl: string }): string {
  const publicBaseUrl = escapeHtml(options.publicBaseUrl);
  const shellPublicBaseUrl = escapeHtml(quoteShellArgument(options.publicBaseUrl));

  return htmlPage({
    title: "Patchy",
    body: `
      <main class="wrap">
        <header class="doc-head">
          <div class="head-line">
            <span class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</span>
            <span class="kicker">Live patch host</span>
          </div>
          <h1>Upload-gated HTML patch hosting.</h1>
          <p class="lede">Patchy Cloud turns one validated static HTML file into a public review link. Publishing is authenticated by default; viewing is public and unlisted.</p>
          <div class="meta">
            <span class="pill pill-progress">Upload auth</span>
            <span class="pill pill-done">Sandboxed view</span>
            <span>Endpoint: <code>${publicBaseUrl}</code></span>
          </div>
        </header>

        <section class="panel">
          <div>
            <h2>Publish a patch</h2>
            <p>Requires the <code>patchy</code> CLI on Node.js 22 or newer.</p>
            <p>Provide <code>PATCHY_SETUP_TOKEN</code> through a secret environment. This scoped workflow pins this endpoint, clears inherited credential overrides, and verifies the stored token before validation or upload.</p>
          </div>
          <pre><code data-patchy-quick-start>(
  set +x
  set -eu
  PATCHY_API_URL=${shellPublicBaseUrl}
  export PATCHY_API_URL
  unset PATCHY_API_TOKEN
  unset TOKEN
  : "\${PATCHY_SETUP_TOKEN:?Set PATCHY_SETUP_TOKEN to a Patchy Cloud API token}"
  ARTIFACT_PATH='./plan.html'

  printf '%s' "$PATCHY_SETUP_TOKEN" | patchy auth set --token-stdin --api-url "$PATCHY_API_URL"
  unset PATCHY_SETUP_TOKEN
  patchy whoami &amp;&amp;
    patchy validate "$ARTIFACT_PATH" &amp;&amp;
    patchy upload "$ARTIFACT_PATH"
)</code></pre>
        </section>

        <section class="grid">
          <article class="task">
            <h3><span class="num">1</span> Safe artifact <span class="pill pill-done">Validated</span></h3>
            <p>Patch uploads reject scripts, forms, frames, unsafe URL schemes, and other constructs that do not belong in a static review document.</p>
          </article>
          <article class="task">
            <h3><span class="num">2</span> Review link <span class="pill pill-progress">Public</span></h3>
            <p>Anyone with the patch URL can view it. Use Patchy Cloud for material that is acceptable as an unlisted public link.</p>
          </article>
        </section>

        <div class="note note-warn">
          <span class="note-title">Visibility rule</span>
          <p>Upload controls govern publishing; they do not make served patches private.</p>
        </div>

        <p class="foot">Health check: <a href="/healthz">/healthz</a>.</p>
      </main>
    `
  });
}

/**
 * The served-patch page: the uploaded document in a sandboxed frame, and
 * nothing else. No chrome, no brand credit, no script — this is someone else's
 * published page, and the wrapper's only job is to sandbox it.
 */
export function renderPatchWrapper(options: {
  patch: Patches.Patch;
  version: Patches.PatchVersion;
  html: string;
}): string {
  const title = escapeHtml(options.patch.title || "Patchy patch");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    html,
    body {
      height: 100%;
      margin: 0;
      background: #ffffff;
    }

    body {
      overflow: hidden;
    }

    .patch-frame {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: #ffffff;
    }
  </style>
</head>
<body>
  <iframe
    class="patch-frame"
    title="${title}"
    sandbox=""
    referrerpolicy="no-referrer"
    srcdoc="${escapeAttribute(options.html)}"></iframe>
  <!-- patch:${escapeHtml(options.patch.id)} version:${Number(options.version.versionNumber)} -->
</body>
</html>`;
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

function quoteShellArgument(value: unknown): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
