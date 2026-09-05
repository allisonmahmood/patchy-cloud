import { sessionScripts, type SessionShell } from "@patchy/auth";
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
          <h1>Static pages for your company.</h1>
          <p class="lede">Publish one validated HTML file and send your colleagues its link. Sign in once to open your company's patches.</p>
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
            <p>First log this machine in. Open the returned URL in your own browser, sign in and join or create a company if needed, then check the code, company and email before confirming. Agents relay the URL and code; they never open the browser for you.</p>
          </div>
          <pre><code>unset PATCHY_API_TOKEN
patchy login --api-url ${shellPublicBaseUrl} --json</code></pre>
          <p>After confirmation, replace <code>&lt;userCode&gt;</code> below with the returned code. Continue only when completion reports <code>logged_in</code>, then check that <code>whoami</code> names the user and company you intend to publish as.</p>
          <pre><code>patchy login --complete &lt;userCode&gt; --api-url ${shellPublicBaseUrl} --json
patchy whoami --api-url ${shellPublicBaseUrl} --json
patchy validate './plan.html' &amp;&amp;
  patchy upload './plan.html' --api-url ${shellPublicBaseUrl} --json</code></pre>
          <p>Open the upload's URL in that same signed-in browser. Company sharing is the default; choose <code>--share public</code> only when anyone with the link should be able to read it.</p>
        </section>

        <section class="grid">
          <article class="task">
            <h3><span class="num">1</span> Safe artifact <span class="pill pill-done">Validated</span></h3>
            <p>Patch uploads reject scripts, forms, frames, unsafe URL schemes, and other constructs that do not belong in a static review document.</p>
          </article>
          <article class="task">
            <h3><span class="num">2</span> Company link <span class="pill pill-progress">Sign-in required</span></h3>
            <p>Colleagues in your company can open the patch. People outside the company cannot view it.</p>
          </article>
        </section>

        <div class="note note-warn">
          <span class="note-title">Visibility rule</span>
          <p>New patches are company-only. Reading a company patch requires a browser session; a machine token only authorizes the CLI.</p>
        </div>

        <p class="foot">Health check: <a href="/healthz">/healthz</a>.</p>
      </main>
    `
  });
}

/**
 * The uploaded document stays script-free in its sandboxed frame. Only a
 * company patch's outer shell loads the session scripts; public pages load none.
 */
export function renderPatchWrapper(
  options: {
    patch: Patches.Patch;
    version: Patches.PatchVersion;
    html: string;
  },
  shell?: SessionShell
): string {
  const title = escapeHtml(options.patch.title || "Patchy patch");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${shell ? sessionScripts(shell) : ""}
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
