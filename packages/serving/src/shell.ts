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
    ${
      scripted
        ? `data-patch-id="${escapeAttribute(options.patch.id)}" data-version-id="${escapeAttribute(options.version.id)}" data-wire="${options.version.wireVersion}" data-nonce="${escapeAttribute(options.nonce)}" data-base="${escapeAttribute(options.base)}" data-route="${escapeAttribute(options.route ?? "/")}" data-content-src="${escapeAttribute(content)}"`
        : `srcdoc="${escapeAttribute(options.html)}"`
    }></iframe>
  <!-- patch:${escapeHtml(options.patch.id)} version:${Number(options.version.versionNumber)} -->
</body>
</html>`;
}

const notices = {
  session_expired: {
    title: "Sign in to continue",
    message:
      "Your session ended. Sign in to reopen this patch. Unanswered operations have not been retried.",
    signIn: true
  },
  principal_changed: {
    title: "Your account changed",
    message:
      "This patch stopped because your signed-in account changed. Sign in to reopen it with your current account. Unanswered operations have not been retried.",
    signIn: true
  },
  access_denied: {
    title: "Access unavailable",
    message:
      "You no longer have access to a resource this patch uses. This is an access restriction, not a problem with the patch.",
    signIn: false
  },
  not_available_on_public: {
    title: "Company data is unavailable here",
    message:
      "A public patch cannot use company tables, files or connections, even when you are signed in.",
    signIn: false
  },
  shell_outdated: {
    title: "This patch could not start",
    message:
      "The shell and this bundle still disagree after refreshing. Contact the patch's owner. No operations have been retried.",
    signIn: false
  },
  bootstrap_failed: {
    title: "This patch could not start",
    message:
      "The patch did not establish its secure connection to Patchy. Reopen its address to try again.",
    signIn: false
  },
  needs_rebuild: {
    title: "This patch needs a rebuild",
    message:
      "This version uses a retired runtime wire. Its owner needs to refresh, rebuild and publish the patch before it can run again.",
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
    body: `<main class="auth-card" data-notice="${code}"><div class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</div><h1>${escapeHtml(notice.title)}</h1><p>${escapeHtml(notice.message)}</p>${notice.signIn ? `<a class="auth-action" href="/login?return=${escapeAttribute(encodeURIComponent(returnTo))}">Sign in</a>` : ""}</main>`
  });
}
