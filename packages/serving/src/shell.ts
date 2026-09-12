import { escapeAttribute, escapeHtml, htmlPage } from "@patchy/core/html";

export { brokerScript } from "./generated/broker-script.js";
export * from "./shell-headers.js";

interface PatchPage {
  readonly patch: { readonly id: string; readonly title: string };
  readonly version: {
    readonly id: string;
    readonly versionNumber: number;
    readonly tier: number;
    readonly wireVersion: number;
  };
  readonly html: string;
  /** Trusted host markup; the standalone renderer has no session dependency. */
  readonly head?: string;
  readonly nonce?: string;
  readonly route?: string;
  /** Address prefix, including the version selector on a historical address. */
  readonly base?: string;
}

/** One renderer, selected by the loaded version rather than the patch's current tier. */
export function renderPatchWrapper(options: PatchPage): string {
  const title = escapeHtml(options.patch.title || "Patchy patch");
  const scripted = options.version.tier >= 1;
  if (scripted && (!options.nonce || !options.base))
    throw new Error("A scripted shell needs its document nonce and address base.");
  const content = `/~content/${encodeURIComponent(options.patch.id)}/${encodeURIComponent(options.version.id)}?n=${encodeURIComponent(options.nonce ?? "")}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${options.head ?? ""}
  ${scripted ? '<script defer src="/~shell/broker.js"></script>' : ""}
  <style>
    html, body { height: 100%; margin: 0; background: #ffffff; }
    body { overflow: hidden; }
    .patch-frame { display: block; width: 100%; height: 100%; border: 0; background: #ffffff; }
  </style>
</head>
<body>
  <iframe id="patch" class="patch-frame" title="${title}"
    sandbox="${scripted ? "allow-scripts allow-modals" : ""}" referrerpolicy="no-referrer"
    ${scripted ? 'allow="clipboard-write *"' : ""}
    ${
      scripted
        ? `data-patch-id="${escapeAttribute(options.patch.id)}" data-version-id="${escapeAttribute(options.version.id)}" data-wire="${options.version.wireVersion}" data-nonce="${escapeAttribute(options.nonce)}" data-base="${escapeAttribute(options.base)}" data-route="${escapeAttribute(options.route ?? "/")}" data-content-src="${escapeAttribute(content)}"`
        : `srcdoc="${escapeAttribute(options.html)}"`
    }></iframe>
  <!-- patch:${escapeHtml(options.patch.id)} version:${Number(options.version.versionNumber)} -->
</body>
</html>`;
}

/** Reader-facing copy: what Patchy did, why, and what to do next, in the reader's words. */
const notices = {
  session_expired: {
    kicker: "Session ended",
    title: "Sign in to continue",
    message:
      "Your session ended while this patch was open, so Patchy stopped it. Sign in to pick up where you left off. Anything still in progress was not retried.",
    signIn: true
  },
  principal_changed: {
    kicker: "Account changed",
    title: "Your account changed",
    message:
      "The account signed in to Patchy changed while this patch was open, so Patchy stopped it. Sign in to reopen it as your current account. Anything still in progress was not retried.",
    signIn: true
  },
  access_denied: {
    kicker: "Access changed",
    title: "You no longer have access",
    message:
      "Patchy stopped this patch because it uses something you can no longer access. This is an access change, not a problem with the patch.",
    signIn: false
  },
  shell_outdated: {
    kicker: "Patch stopped",
    title: "This patch could not start",
    message:
      "This version of the patch and Patchy no longer agree, even after a refresh. Ask the patch's owner to rebuild and publish it. Nothing was retried.",
    signIn: false
  },
  bootstrap_failed: {
    kicker: "Patch stopped",
    title: "This patch could not start",
    message: "The patch did not connect to Patchy in time. Open its address again to retry.",
    signIn: false
  },
  needs_rebuild: {
    kicker: "Patch unavailable",
    title: "This patch needs a rebuild",
    message:
      "This version was built for a runtime Patchy has retired. Its owner needs to refresh, rebuild and publish the patch before it opens again.",
    signIn: false
  }
} as const;

export type ShellNotice = keyof typeof notices;
export function isShellNotice(code: string): code is ShellNotice {
  return Object.hasOwn(notices, code);
}

/** First-party notices never render uploaded markup or a patch-controlled error message. */
export function renderShellNotice(code: ShellNotice, returnTo: string): string {
  const notice = notices[code];
  return htmlPage({
    title: notice.title,
    styles: ".auth-card p:last-child { margin-bottom: 0; }",
    body: `<main class="auth-card" data-notice="${code}"><div class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</div><p class="auth-kicker">${escapeHtml(notice.kicker)}</p><h1>${escapeHtml(notice.title)}</h1><p>${escapeHtml(notice.message)}</p>${notice.signIn ? `<a class="auth-action" href="/login?return=${escapeAttribute(encodeURIComponent(returnTo))}">Sign in</a>` : ""}</main>`
  });
}
