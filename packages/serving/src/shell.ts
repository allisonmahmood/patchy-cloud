import {
  escapeAttribute,
  escapeHtml,
  faviconLink,
  htmlPage,
  servedStyles,
  switcherRelay,
  switcherTag
} from "@patchy/core/html";
import { doorCard, doorPage, headStart, linkButton } from "@patchy/core";
import type { HandlerKind, Manifest } from "@patchy/api";
import { brokerDigest } from "./generated/broker-script.js";

export { brokerScript, brokerDigest } from "./generated/broker-script.js";
export * from "./shell-headers.js";

/**
 * A patch's document as Patchy serves it: its own bytes with the switcher relay first in its
 * `<head>`, ahead of any script of its own, so no listener of the patch's hears Mod+Shift+K. The
 * relay is the same in every document and carries no viewer data, so one body still serves every
 * viewer; the stored artifact and its digest are untouched.
 */
export function withSwitcherRelay(html: string): string {
  const at = headStart(html);
  return `${html.slice(0, at)}${switcherRelay}${html.slice(at)}`;
}

/**
 * The broker as a scripted shell loads it. `v` names its bytes, so a host serving those bytes
 * lets the browser keep them; any host, of any release, answers the path.
 */
export const brokerSrc = `/~shell/broker.js?v=${brokerDigest}`;

interface PatchPage {
  readonly patch: { readonly id: string; readonly title: string };
  readonly version: {
    readonly id: string;
    readonly versionNumber: number;
    readonly tier: number;
    readonly wireVersion: number;
  };
  readonly scope: "company" | "public" | "local";
  /**
   * Whom the shell is rendered for. A company or local shell pins them as its frame's viewer; a
   * public shell pins no one, and names them only to load their switcher.
   */
  readonly viewerId?: string;
  /**
   * Their own company, a guest's included. With it, a company shell, or a public one rendered for
   * a member of the patch's company, loads their switcher.
   */
  readonly companyId?: string;
  /**
   * The viewer's single-key shortcut setting, which names the frame `patchy:shortcuts=on` or
   * `=off` for `patchy/hotkeys` to read as its document starts, and whether to tell them this
   * version's shortcuts ignore it. Only a company or local shell, rendered for its viewer and
   * never cached for another, carries it. A public shell is everyone's document, a member's
   * included, so its shortcuts stay on.
   */
  readonly shortcuts?: { readonly on: boolean; readonly note: boolean };
  readonly handlerKinds?: Readonly<Record<string, HandlerKind>>;
  /** Trusted host markup; the standalone renderer has no session dependency. */
  readonly head?: string;
  readonly nonce: string;
  readonly route?: string;
  /** Address prefix, including the version selector on a historical address. */
  readonly base: string;
}

/**
 * The switcher of the person a shell is rendered for, at their own company: always on a company
 * shell, on a public one only when it names them, and never in `patchy dev`.
 */
const switcherOf = ({ scope, viewerId, companyId }: PatchPage) => {
  if (scope === "local") return "";
  if (scope === "company" && (!viewerId || !companyId))
    throw new Error("A company shell needs its viewer's company.");
  return viewerId && companyId ? switcherTag({ userId: viewerId, companyId }) : "";
};

/**
 * One renderer: the shell frames the loaded version's content URL, whatever the patch serves now.
 * Its one inline script is the switcher relay, which its CSP admits by hash. A company shell also
 * loads the switcher, ahead of the session's scripts, as does a public one rendered for a member
 * of the patch's company; its frame then says `data-switcher`. Any other public or local shell
 * only claims the key.
 */
export function renderPatchWrapper(options: PatchPage): string {
  const title = escapeHtml(options.patch.title || "Patchy patch");
  if (options.scope !== "public" && !options.viewerId)
    throw new Error("A company or local shell needs its admitted viewer.");
  const switcher = switcherOf(options);
  if (options.scope === "public" && options.shortcuts)
    throw new Error(
      "A public shell is the same document for every reader, so it carries no viewer's setting."
    );
  // The name is an attribute the parser sets as it creates the frame, before the frame's browsing
  // context exists, so it reaches the sandboxed document; one set after insertion doesn't.
  const shortcuts =
    options.shortcuts === undefined
      ? ""
      : ` name="patchy:shortcuts=${options.shortcuts.on ? "on" : "off"}"${options.shortcuts.note ? " data-shortcuts-note" : ""}`;
  const content = `/~content/${encodeURIComponent(options.patch.id)}/${encodeURIComponent(options.version.id)}?n=${encodeURIComponent(options.nonce)}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  ${switcherRelay}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${faviconLink}
  ${switcher}
  ${options.head ?? ""}
  <script defer src="${brokerSrc}"></script>
  <style>
    ${servedStyles}
    html, body { height: 100%; margin: 0; background: #ffffff; }
    body { overflow: hidden; }
    .patch-frame { display: block; width: 100%; height: 100%; border: 0; background: #ffffff; }
    /* Until its document can claim Mod+Shift+K, the frame takes no click or Tab: its empty first
       document would hand the key to the browser. The relay at the top of this page shows it
       once the frame's relay says hello, or a document without one loads. */
    .patch-frame[data-waiting] { visibility: hidden; }
  </style>
</head>
<body>
  <iframe id="patch" class="patch-frame" title="${title}" data-waiting${shortcuts}
    sandbox="allow-scripts allow-modals" referrerpolicy="no-referrer"
    allow="clipboard-write *"
    data-patch-id="${escapeAttribute(options.patch.id)}" data-version-id="${escapeAttribute(options.version.id)}" data-tier="${options.version.tier}" data-scope="${options.scope}"${options.scope !== "public" ? ` data-viewer-id="${escapeAttribute(options.viewerId)}"` : ""}${switcher ? " data-switcher" : ""} data-wire="${options.version.wireVersion}" data-nonce="${escapeAttribute(options.nonce)}" data-base="${escapeAttribute(options.base)}" data-route="${escapeAttribute(options.route ?? "/")}" data-content-src="${escapeAttribute(content)}"
    ${options.version.tier === 2 ? `data-handler-kinds="${escapeAttribute(JSON.stringify(options.handlerKinds ?? {}))}"` : ""}></iframe>
  <!-- patch:${escapeHtml(options.patch.id)} version:${Number(options.version.versionNumber)} -->
</body>
</html>`;
}

/**
 * Whether a version's single-key shortcuts may ignore the viewer's setting, as D1 decided: it is
 * from 0.33.0 on, when `patchy/hotkeys` first shipped, and its manifest doesn't record that the
 * CLI built it with an SDK that obeys. Recorded imports without `patchy/hotkeys` clear it. A single
 * HTML file records none, and may carry an older SDK bundled inline, so only its release counts.
 * Its shell tells a viewer who turned them off, until they dismiss it.
 */
export function ignoresShortcutSetting(version: {
  readonly release: string;
  readonly manifest: Pick<typeof Manifest.Type, "sdkImports" | "shortcutSetting">;
}): boolean {
  const [major = 0, minor = 0] = version.release.split(".").map(Number);
  return (
    version.manifest.shortcutSetting === undefined &&
    (version.manifest.sdkImports?.includes("patchy/hotkeys") ?? true) &&
    (major > 0 || minor >= 33)
  );
}

/** Reader-facing copy: what Patchy did, why, and what to do next, in the reader's words. */
const notices = {
  revoked: {
    kicker: "Version revoked",
    title: "This version has been stopped",
    message:
      "This version is no longer available, so Patchy stopped it. Open the patch's current address to use an available version. Anything still in progress was not retried.",
    signIn: false
  },
  stream_replaced: {
    kicker: "Document stopped",
    title: "This document was replaced",
    message:
      "Another connection replaced this document, so Patchy stopped it. Open the patch's address again to continue. Anything still in progress was not retried.",
    signIn: false
  },
  stream_limit: {
    kicker: "Document limit",
    title: "Too many open copies",
    message:
      "You have too many copies of this patch open, so Patchy stopped this one. Close another copy, then open this patch's address again. Anything still in progress was not retried.",
    signIn: false
  },
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
    message: "The patch did not connect to Patchy. Open its address again to retry.",
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

/**
 * The active signed-in viewer a top-level notice is rendered for: it loads their switcher, then
 * `session`, the session's scripts, as trusted host markup. Anyone else's notice has neither.
 */
export interface NoticeViewer {
  readonly userId: string;
  /** Their own company, a guest's included, which keys the switcher's list. */
  readonly companyId: string;
  /** The patch a needs-rebuild notice is about, which the switcher treats as the one on screen. */
  readonly patchId?: string | undefined;
  readonly session: string;
}

/**
 * First-party notices never render uploaded markup or a patch-controlled error message. Only a
 * top-level notice has a `viewer`; a framed one keeps the relay alone, never a nested menu.
 */
export function renderShellNotice(
  code: ShellNotice,
  returnTo: string,
  viewer?: NoticeViewer
): string {
  const { signIn, ...copy } = notices[code];
  return renderNoticePage({
    ...copy,
    code,
    action: signIn
      ? { label: "Sign in", href: `/login?return=${encodeURIComponent(returnTo)}` }
      : undefined,
    head: viewer && `${switcherTag(viewer)}${viewer.session}`
  });
}

/**
 * The shared notice: a door with its kicker, title, one message and at most one link. The shell
 * notices and the 404 compose it; a stopping notice is marked with its code.
 */
export function renderNoticePage(notice: {
  readonly kicker: string;
  readonly title: string;
  readonly message: string;
  /** Marks a stopping notice, which the browser tests look for; the 404 has none. */
  readonly code?: ShellNotice;
  readonly action?: { readonly label: string; readonly href: string } | undefined;
  /** Trusted host markup: a signed-in viewer's switcher and session scripts. */
  readonly head?: string | undefined;
}): string {
  return htmlPage({
    title: notice.title,
    head: notice.head,
    body: doorCard(
      doorPage({
        kicker: notice.kicker,
        title: notice.title,
        body: `<p>${escapeHtml(notice.message)}</p>`,
        ...(notice.action === undefined
          ? {}
          : {
              actions: linkButton(notice.action.label, notice.action.href, {
                kind: "primary",
                block: true
              })
            })
      }),
      notice.code === undefined ? {} : { data: { notice: notice.code } }
    )
  });
}
