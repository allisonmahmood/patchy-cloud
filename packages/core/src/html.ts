import { avatar, searchField } from "./components.js";
import { fontFaces, fontPreload } from "./fonts.js";
import { appStyles } from "./styles/index.js";
import { uiScriptTag } from "./ui/enhancer.js";
import { escapeAttribute, escapeHtml } from "./escape.js";
import { places, whatsNewPath } from "./places.js";
import { changesSince, type ChangeKind, latestRelease, tally } from "./whatsNew.js";
import { relayScript, relayScriptHash } from "./generated/relay-script.js";
import { switcherDigest } from "./generated/switcher-script.js";

export { servedStyles } from "./served-styles.js";
export { appStyles } from "./styles/index.js";

/**
 * The switcher relay as a document carries it: the inline script that claims Mod+Shift+K before
 * any other script can hear it (`switcher/relay.ts`). Every first-party page and patch shell has
 * it at the top of its `<head>`, and Serving inserts it ahead of a patch's own code.
 */
export const switcherRelay = `<script>${relayScript}</script>`;
/** The CSP source that admits the relay, and only it, wherever a page's policy allows no inline script. */
export const SWITCHER_RELAY_SOURCE = relayScriptHash;

/** Where every host serves the switcher (`switcher/main.ts`), as `/~shell/broker.js` is served. */
export const SWITCHER_PATH = "/~shell/switcher.js";

/**
 * The switcher's script on a signed-in page: app pages, notices, company shells and a public
 * shell shown to a member of the patch's company. It names the viewer the page was rendered for,
 * so the switcher keeps only that person's list, and `v` names its bytes. A notice about one
 * patch, such as its needs-rebuild notice, also names that patch, which the menu then treats as
 * the patch on screen, as a shell's frame names it. Put it before Clerk's and the session's
 * scripts, so the menu never waits behind Clerk.
 */
export const switcherTag = (viewer: {
  readonly userId: string;
  readonly companyId: string;
  readonly patchId?: string | undefined;
}) =>
  `<script defer src="${SWITCHER_PATH}?v=${switcherDigest}" data-viewer="${escapeAttribute(viewer.userId)}" data-company="${escapeAttribute(viewer.companyId)}"${viewer.patchId === undefined ? "" : ` data-patch="${escapeAttribute(viewer.patchId)}"`}></script>`;

export interface AppShell {
  readonly viewer: {
    readonly user: { readonly id: string; readonly name: string; readonly email: string };
    /** The viewer's own company; a guest's, too, on another company's page. */
    readonly company: { readonly id: string; readonly name: string };
    /** The newest What's new release the person has seen. */
    readonly whatsNewSeen: number;
    /** One line naming what their last form did, shown once at the top of the page. */
    readonly receipt?: string | undefined;
  };
  /** The place the page belongs to; `whats-new` is reached from its own button, so no place is lit there. */
  readonly section: (typeof places)[number]["items"][number]["section"] | "whats-new";
  /**
   * A modal panel over the page, such as Home’s Final step: the frame behind it goes inert
   * and blurs, and the panel carries its own role, label and ways out.
   */
  readonly overlay?: string;
  /** The sidebar search's query, when the page shows its results, so the field keeps it. */
  readonly query?: string;
}

/** A change's kind as a pill: New green, Improved blue, Fixed plain. */
export const whatsNewKind = (kind: ChangeKind): string =>
  `<span class="pill${kind === "New" ? " pill-done" : kind === "Improved" ? " pill-progress" : ""}">${kind}</span>`;

const plural = (count: number) => `${count} ${count === 1 ? "change" : "changes"}`;

/**
 * What's new, at the foot of the sidebar, opens a panel of what shipped since the viewer's last
 * visit, or the latest few once they are caught up. Opening it clears the dot through
 * `/whats-new/seen`; the page loads that script only while there is a dot to clear.
 */
function whatsNewButton(seen: number, current: boolean): string {
  const unseen = changesSince(seen);
  const shown = unseen.length > 0 ? unseen.slice(0, 6) : changesSince(0).slice(0, 3);
  const label =
    unseen.length > 0 ? `What’s new: ${plural(unseen.length)} since your last visit` : "What’s new";
  const summary =
    unseen.length > 0
      ? `${plural(unseen.length)} since your last visit · ${tally(unseen)}`
      : "You’re all caught up. The latest:";
  const list = shown.length
    ? `<ul class="list list-compact">${shown.map((change) => `<li class="list-row whats-new-change">${whatsNewKind(change.kind)}<span>${escapeHtml(change.title)}</span></li>`).join("")}</ul>`
    : "";
  const more =
    unseen.length > shown.length
      ? `<p class="supporting-text">and ${unseen.length - shown.length} more</p>`
      : "";
  return `<button type="button" class="app-place whats-new-bell" popovertarget="whats-new" aria-label="${label}"${current ? ' aria-current="page"' : ""}>What’s new${unseen.length > 0 ? '<span class="whats-new-dot"></span>' : ""}</button><div id="whats-new" class="whats-new-panel" popover role="dialog" aria-labelledby="whats-new-heading" data-through="${latestRelease}"><h2 class="section-heading" id="whats-new-heading">What’s new</h2><p class="supporting-text">${summary}</p>${list}${more}<a class="btn btn-primary" href="${whatsNewPath}">See all changes</a></div>${unseen.length > 0 ? '<script defer src="/whats-new/bell.js"></script>' : ""}`;
}

const chevron =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const menuIcon =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke-linecap="round"/></svg>';

/** The signed-in person: their name opens a menu with who they are and Sign out. */
function account(user: AppShell["viewer"]["user"]): string {
  return `<button type="button" class="app-place app-account" popovertarget="account-menu">${avatar(user.email, user.name)}<span class="app-account-name">${escapeHtml(user.name)}</span>${chevron}</button><div class="menu app-account-menu" id="account-menu" popover aria-label="Account"><p class="menu-head"><strong>${escapeHtml(user.name)}</strong><br>${escapeHtml(user.email)}</p><hr class="menu-rule"><form method="post" action="/logout"><button class="menu-item" type="submit">Sign out</button></form></div>`;
}

/**
 * Every signed-in page's frame: a sidebar of `places` beside the page. On a phone the sidebar
 * folds into a bar whose Menu button opens the same markup as a popover, so there is one nav and
 * no script. A page's `overlay` sits over the whole frame, which goes inert behind it.
 */
function appBody(app: AppShell, body: string): string {
  const place = (item: (typeof places)[number]["items"][number]) =>
    `<a class="app-place" href="${item.href}"${item.section === app.section ? ' aria-current="page"' : ""}>${item.label}</a>`;
  const nav = places
    .map((group) =>
      group.label === undefined
        ? group.items.map(place).join("")
        : `<div class="app-group" role="group" aria-labelledby="app-group-${group.label.toLowerCase()}"><p class="app-group-label" id="app-group-${group.label.toLowerCase()}">${group.label}</p>${group.items.map(place).join("")}</div>`
    )
    .join("");
  const search = searchField({
    action: "/",
    id: "app-search",
    query: app.query ?? "",
    placeholder: "Search patches",
    label: "Search patches",
    className: "app-search"
  });
  return `<div class="app"${app.overlay === undefined ? "" : " inert"}><aside class="app-side"><div class="app-side-inner"><a class="brand" href="/"><span class="glyph" aria-hidden="true"></span><span>${escapeHtml(app.viewer.company.name)}</span></a><button type="button" class="btn btn-quiet app-menu-button" popovertarget="app-menu">${menuIcon}Menu</button><div class="app-menu" id="app-menu" popover>${search}<nav class="app-nav" aria-label="Primary">${nav}</nav><div class="app-foot">${whatsNewButton(app.viewer.whatsNewSeen, app.section === "whats-new")}${account(app.viewer.user)}</div></div></div></aside><main class="app-page">${app.viewer.receipt === undefined ? "" : `<p class="note note-ok app-receipt" role="status">${escapeHtml(app.viewer.receipt)}</p>`}${body}</main></div>${app.overlay === undefined ? "" : `<div class="modal-scrim"></div>${app.overlay}`}`;
}

/**
 * Patchy's mark from patchyhq.com, the one icon on every first-party page and patch tab. It is
 * inline, so it needs no route and passes every one of those pages' `img-src data:`.
 */
export const faviconLink = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect x="114" y="110" width="286" height="286" rx="82" fill="#15130F" transform="rotate(-6 257 253) translate(22 22)"/><rect x="114" y="110" width="286" height="286" rx="82" fill="#91DD5A" stroke="#15130F" stroke-width="30" transform="rotate(-6 257 253)"/><path d="M256 180H326V250" fill="none" stroke="#15130F" stroke-width="30" stroke-linecap="round" stroke-linejoin="round" transform="rotate(-6 291 215)"/></svg>'
)}">`;

/**
 * A document as a `srcdoc` frame receives it, led by the frame's own base URL so its same-page
 * links (`href="#totals"`) scroll instead of loading the embedding page into the frame. Patch
 * pages are framed by URL; `patchy look preview --compare` frames each look this way.
 *
 * A srcdoc document's URL is `about:srcdoc`, but without a base of its own its relative URLs
 * resolve against the embedder's: `#totals` names the embedding page. Against this base it names
 * the framed document, so following it is a scroll, with no request. Any other relative URL stops
 * resolving; absolute URLs are unaffected. A srcdoc document inherits its embedder's CSP, which
 * must admit this base with `base-uri about:`.
 *
 * The base leads everything, doctype included: the first base with an `href` is the one that
 * counts, so nothing in the page can displace it. A srcdoc document never renders in quirks mode,
 * so the doctype it displaces changes nothing. Its one casualty is the attributes of the page's own
 * `<head>` tag, which the parser drops once the base has implied a head. A leading byte order mark
 * goes first: behind the base it would be text and end the head early.
 */
export const framedDocument = (html: string): string =>
  `<base href="about:srcdoc">${html.replace(/^\uFEFF/, "")}`;

/**
 * A first-party page: the app's fonts, styles and, with `app`, the signed-in frame. A running
 * patch's shell is Serving's own document, on `servedStyles`. Every one carries the switcher
 * relay, so its response's CSP admits `SWITCHER_RELAY_SOURCE`; an app page also loads the
 * switcher, from its own origin.
 */
export function htmlPage(options: {
  title: string;
  body: string;
  head?: string;
  styles?: string;
  app?: AppShell;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  ${switcherRelay}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  ${faviconLink}
  ${fontPreload}
  ${options.app ? switcherTag({ userId: options.app.viewer.user.id, companyId: options.app.viewer.company.id }) : ""}
  ${options.head ?? ""}
  <style>
    ${appStyles}
    ${options.styles ?? ""}
  </style>
</head>
<body>${options.app ? appBody(options.app, options.body) : options.body}</body>
</html>`;
}
/**
 * A first-party document without the app's fonts and enhancer, for one drawn under a policy that
 * refuses them, such as a refusal at a content URL inside the frame's sandbox. Its text falls
 * back to the system fonts the stack names after Geist, and it works without script as every
 * page does.
 */
export const withoutAppAssets = (html: string) =>
  html.replace(fontPreload, "").replace(fontFaces, "").replace(uiScriptTag, "");
export { escapeAttribute, escapeHtml } from "./escape.js";
/** "a, b and c", escaped, as when a page names a company's admins. */
export const sentenceList = (items: readonly string[]): string => {
  const escaped = items.map(escapeHtml);
  return escaped.length < 2
    ? escaped.join("")
    : `${escaped.slice(0, -1).join(", ")} and ${escaped.at(-1)}`;
};
