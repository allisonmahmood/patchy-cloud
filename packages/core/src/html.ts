import { avatar, menuPost, patchMark, rowMenu, searchField } from "./components.js";
import { fontFaces, fontPreload } from "./fonts.js";
import { appStyles } from "./styles/index.js";
import { button, choiceGroup, field, linkButton, radio, textarea } from "./ui/controls.js";
import { notice } from "./ui/feedback.js";
import { uiScriptTag } from "./ui/enhancer.js";
import { icon, type IconName } from "./ui/icons.js";
import { escapeAttribute, escapeHtml } from "./escape.js";
import { pagePlaces, type Place, places } from "./places.js";
import { latestRelease } from "./whatsNew.js";
import { entriesSince, monthHref, permalink } from "./whatsNewLinks.js";
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

/** One accessible personal shortcut; the hosting adapter supplies its current title and address. */
export interface PinnedPatch {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly href: string;
  readonly tier: number;
}

export interface AppShell {
  readonly viewer: {
    readonly user: { readonly id: string; readonly name: string; readonly email: string };
    /** The viewer's own company; a guest's, too, on another company's page. */
    readonly company: { readonly id: string; readonly name: string };
    /** The newest What's new release the person has seen. */
    readonly whatsNewSeen: number;
    /** Whether patches' single-key shortcuts fire for them; the account menu switches it. */
    readonly singleKeyShortcuts: boolean;
    readonly pins?: ReadonlyArray<PinnedPatch>;
    /** One line naming what their last form did, shown once at the top of the page it lands on. */
    readonly receipt?: string | undefined;
    /** This page's local path, when opening it again shows it: the account menu's forms come back here. */
    readonly page?: string | undefined;
  };
  /**
   * The place the page belongs to, which the sidebar lights and the page's `<title>` names; a
   * Settings page opens Settings around it. `whats-new` is reached from its own button at the
   * sidebar's foot, so no place is lit there. `feedback`, What you sent, lights nothing either:
   * Tell Patchy opens its panel rather than that page.
   */
  readonly section: Place["section"] | "whats-new" | "feedback";
  /**
   * A modal panel over the page, such as Home’s Final step: the frame behind it goes inert
   * and blurs, and the panel carries its own role, label and ways out.
   */
  readonly overlay?: string;
  /** The sidebar search's query, when the page shows its results, so the field keeps it. */
  readonly query?: string;
}

/**
 * An app page's `<title>`: "Heading – Place – Company", the place left out where the heading is
 * its name, as on Home, and on What's new, which is no place.
 */
export const appTitle = (heading: string, app: AppShell): string => {
  const place = pagePlaces.find((candidate) => candidate.section === app.section)?.label;
  return [...new Set([heading, place, app.viewer.company.name])]
    .filter((part) => part !== undefined && part !== "")
    .join(" – ");
};

const plural = (count: number) => `${count} ${count === 1 ? "change" : "changes"}`;

/** How many headlines What's new's panel shows; See all changes has the rest. */
const HEADLINES = 5;

/**
 * What's new, at the foot of the sidebar, opens a panel of headlines: what shipped since the
 * viewer's last visit, or the latest once they are caught up, then See all changes. Each headline
 * is its change's permalink. Opening it clears the dot through `/whats-new/seen`, which
 * `/whats-new/bell.js` posts from the panel's `data-through`; the page loads that script only
 * while there is a dot to clear. Until then its links carry the marker it was drawn with, so the
 * page they open still marks what is new.
 */
function whatsNew(seen: number, current: boolean): string {
  const unseen = entriesSince(seen);
  const shown = (unseen.length > 0 ? unseen : entriesSince(0)).slice(0, HEADLINES);
  const since = unseen.length > 0 ? seen : undefined;
  const label =
    unseen.length > 0 ? `What’s new: ${plural(unseen.length)} since your last visit` : "What’s new";
  const summary =
    unseen.length > 0 ? `${plural(unseen.length)} since your last visit` : "You’re all caught up";
  const list = shown.length
    ? `<ul class="app-headlines">${shown.map(({ release, n, change }) => `<li><a class="app-headline" href="${escapeAttribute(permalink(release, n, since))}"><span class="app-headline-kind">${change.kind}</span><span>${escapeHtml(change.title)}</span></a></li>`).join("")}</ul>`
    : "";
  return `<button type="button" class="app-place whats-new-bell" popovertarget="whats-new" aria-label="${label}"${current ? ' aria-current="page"' : ""}>${icon("bell")}What’s new${unseen.length > 0 ? '<span class="whats-new-dot"></span>' : ""}</button><div id="whats-new" class="menu app-foot-menu app-whats-new" popover role="dialog" aria-labelledby="whats-new-heading" data-through="${latestRelease}"><p class="menu-head"><strong id="whats-new-heading">What’s new</strong>${summary}</p>${list}<hr class="menu-rule"><a class="menu-item" href="${escapeAttribute(monthHref(undefined, since))}">See all changes${icon("chevronRight")}</a></div>${unseen.length > 0 ? '<script defer src="/whats-new/bell.js"></script>' : ""}`;
}

/** Where Tell Patchy's panel script is served; every app page loads it. */
export const tellPatchyScriptPath = "/feedback/tell.js";
/** The id of Tell Patchy's panel, which any page's button may open with `popovertarget`. */
export const tellPatchyPanel = "tell-patchy";
/**
 * The composer's own address, `kind` picked: a dialog over What you sent, which works without
 * script. A page's link to it, such as Ask for an integration, opens the panel in place instead
 * once the panel's script runs, the kind taken from the link.
 */
export const tellPatchyHref = (kind: "request" | "feedback") => `/feedback/new?kind=${kind}`;

/**
 * Tell Patchy's fields: Request or Feedback, `kind` picked, and the one text field. The panel's
 * form holds them, and so does the composer at `/feedback/new` that a person without the panel's
 * script reaches, under its own `id` so both fit on one page. A refused send draws them again with
 * `error` on the field and the kind as sent, never the text, which stays in the person's own
 * field. The field has no `maxlength`: it would count UTF-16 units and cut an emoji the store,
 * counting characters, accepts. `autofocus` puts focus in the field where a dialog opens.
 */
export const tellPatchyFields = (
  spec: {
    readonly id?: string;
    readonly kind?: "request" | "feedback";
    readonly error?: string;
    readonly autofocus?: boolean;
  } = {}
) => {
  const id = spec.id ?? tellPatchyPanel;
  const kind = spec.kind ?? "request";
  const kinds = choiceGroup({
    id: `${id}-kind`,
    legend: "Request or feedback",
    hideLegend: true,
    choices: (aria) =>
      `${radio({ name: "kind", value: "request", label: "Request", checked: kind === "request", aria })}${radio({ name: "kind", value: "feedback", label: "Feedback", checked: kind === "feedback", aria })}`
  });
  const text = field({
    id: `${id}-text`,
    label: "What to tell Patchy",
    hideLabel: true,
    error: spec.error,
    control: (aria) =>
      textarea(aria, {
        name: "text",
        rows: 4,
        autofocus: spec.autofocus === true || spec.error !== undefined
      })
  });
  return `${kinds}${text}`;
};

/** The panel's form: its fields and Send, posting to `/feedback`. */
export const tellPatchyForm = (
  spec: { readonly kind?: "request" | "feedback"; readonly error?: string } = {}
) =>
  `<form class="app-tell-form" method="post" action="/feedback" novalidate data-tell="compose">${tellPatchyFields(spec)}${button("Send", { kind: "primary", block: true })}</form>`;

/**
 * Tell Patchy, at the foot of the sidebar between What's new and the account, opens a panel in
 * the frame What's new's uses for sending Patchy a request or feedback. A page's link to the
 * composer's own address (`tellPatchyHref`) opens it too, beside that link, with its kind picked,
 * and opens the composer as a dialog without script; a button with `popovertarget="tell-patchy"`
 * opens it as the foot's does. The panel sits outside the menu, which a narrow window hides until Menu opens it, and a
 * popover inside a hidden menu can't show. `/feedback/tell.js` sends in place and shows the
 * answer; when it can't tell whether a send was saved it puts the note that points to What you
 * sent, inert in a template until then, into a live slot, so no page carries a second notice.
 * Without the script the form posts and lands on What you sent.
 */
const tellPatchyButton = `<button type="button" class="app-place tell-patchy-button" popovertarget="${tellPatchyPanel}">${icon("message")}Tell Patchy</button>`;
const tellPatchy = () =>
  `<div id="${tellPatchyPanel}" class="menu app-foot-menu app-tell-patchy" popover role="dialog" aria-labelledby="tell-patchy-heading"><p class="menu-head"><strong id="tell-patchy-heading">Tell Patchy</strong></p><div class="app-tell-body">${tellPatchyForm()}<div class="app-tell-answer" data-tell="answer" tabindex="-1" hidden></div><div data-tell="unsure" aria-live="assertive"></div><template data-tell="unsure-note">${notice({ tone: "warning", title: "Patchy couldn’t confirm that", body: '<p>It may have gone through. Check <a href="/feedback">What you sent</a> before you try again.</p>' })}</template></div><hr class="menu-rule"><a class="menu-item" href="/feedback">What you sent${icon("chevronRight")}</a></div><script defer src="${tellPatchyScriptPath}"></script>`;

/**
 * The signed-in person: their name opens a menu with who they are, Your agents, the single-key
 * shortcut switch and Sign out. The switch is a form, so it needs no script. It posts the value it
 * switches to, never a flip, to `POST /api/me/shortcuts`, which brings the person back here with a
 * receipt.
 */
function account(viewer: AppShell["viewer"]): string {
  const { user, singleKeyShortcuts: on } = viewer;
  const back =
    viewer.page === undefined
      ? ""
      : `<input type="hidden" name="return" value="${escapeAttribute(viewer.page)}">`;
  const shortcuts = `<form method="post" action="/api/me/shortcuts"><input type="hidden" name="value" value="${on ? "off" : "on"}">${back}<button class="menu-item" type="submit" role="switch" aria-checked="${on}">${icon("keyboard")}Single-key shortcuts<span class="switch" aria-hidden="true"></span></button></form>`;
  return `<button type="button" class="app-place app-account" popovertarget="account-menu">${avatar(user.email, user.name)}<span class="app-account-name">${escapeHtml(user.name)}</span>${icon("chevronUpDown")}</button><div class="menu app-foot-menu app-account-menu" id="account-menu" popover aria-label="Account"><p class="menu-head"><strong>${escapeHtml(user.name)}</strong>${escapeHtml(user.email)}</p><hr class="menu-rule"><a class="menu-item" href="/agents">${icon("bot")}Your agents</a>${shortcuts}<hr class="menu-rule"><form method="post" action="/logout"><button class="menu-item" type="submit">${icon("logout")}Sign out</button></form></div>`;
}

/** The icon each of the sidebar's places wears. */
const placeIcons: Readonly<Record<(typeof places)[number]["section"], IconName>> = {
  home: "home",
  patches: "grid",
  agents: "bot",
  settings: "gear"
};

/**
 * The sidebar's places, `section`'s lit. Settings opens on any of its pages, showing them under
 * it with that page lit; elsewhere it is one place that leads to People.
 */
function nav(section: AppShell["section"]): string {
  const lit = (place: Place) => (place.section === section ? ' aria-current="page"' : "");
  return places
    .map((place) => {
      if (!("children" in place))
        return `<a class="app-place" href="${place.href}"${lit(place)}>${icon(placeIcons[place.section])}${place.label}</a>`;
      const open = place.children.some((child) => child.section === section);
      const children = open
        ? `<div class="app-subnav" role="group" aria-label="${place.label}">${place.children.map((child) => `<a class="app-place" href="${child.href}"${lit(child)}>${child.label}</a>`).join("")}</div>`
        : "";
      return `<a class="app-place${open ? " app-place-open" : ""}" href="${place.href}">${icon(placeIcons[place.section])}${place.label}<span class="app-place-end">${icon(open ? "chevron" : "chevronRight")}</span></a>${children}`;
    })
    .join("");
}

/** Pins share the folding navigation; only the list scrolls when it grows past five rows. */
function pinnedNavigation(viewer: AppShell["viewer"]): string {
  if (!viewer.pins?.length) return "";
  const items = viewer.pins.map((patch) => {
    const fields = `<input type="hidden" name="user" value="${escapeAttribute(viewer.user.id)}"><input type="hidden" name="return" value="${escapeAttribute(viewer.page ?? "/")}">`;
    return `<li class="app-pin"><a class="app-pin-link" href="${escapeAttribute(patch.href)}">${patchMark(patch.name, patch.tier)}<span>${escapeHtml(patch.title)}</span></a>${rowMenu(`pin-${patch.id}`, patch.title, [menuPost(`/patches/${encodeURIComponent(patch.id)}/unpin`, "Unpin patch", fields, false, patch.title)])}</li>`;
  });
  return `<section class="app-pins" aria-labelledby="pinned-heading"><h2 id="pinned-heading">Pinned</h2><ul class="app-pin-list" tabindex="0" aria-label="Pinned patches">${items.join("")}</ul></section>`;
}

/**
 * Every signed-in page's frame: a sidebar beside the page, holding the brand, the patch search,
 * New patch, the places and, at its foot, What's new, Tell Patchy and the account. Below 1024px it folds into
 * a top bar of the brand, the search and Menu, which opens the rest of the same markup as a
 * popover, so there is one nav and no script. A page's `overlay` sits over the whole frame,
 * which goes inert behind it.
 */
function appBody(app: AppShell, body: string): string {
  // The search is All patches', whose results show its query as a chip.
  const search = searchField({
    action: "/patches",
    id: "app-search",
    query: app.query ?? "",
    placeholder: "Search patches",
    label: "Search patches",
    className: "app-search"
  });
  // New patch's dialog is Home's, at `/?new`.
  const newPatch = linkButton("New patch", "/?new", { icon: "plus", size: "sm", block: true });
  const menuButton = `<button type="button" class="btn btn-quiet btn-sm app-menu-button" popovertarget="app-menu"><span class="app-menu-closed">${icon("menu")}Menu</span><span class="app-menu-opened">${icon("close")}Close</span></button>`;
  const foot = `<div class="app-foot">${whatsNew(app.viewer.whatsNewSeen, app.section === "whats-new")}${tellPatchyButton}${account(app.viewer)}</div>`;
  const receipt =
    app.viewer.receipt === undefined
      ? ""
      : `<p class="note note-ok app-receipt" role="status">${escapeHtml(app.viewer.receipt)}</p>`;
  return `<div class="app"${app.overlay === undefined ? "" : " inert"}><aside class="app-side"><div class="app-side-inner"><a class="brand" href="/"><span class="glyph" aria-hidden="true"></span><span class="brand-name">${escapeHtml(app.viewer.company.name)}</span></a>${search}${menuButton}<div class="app-menu" id="app-menu" popover>${newPatch}<nav class="app-nav" aria-label="Primary">${nav(app.section)}</nav>${pinnedNavigation(app.viewer)}${foot}</div>${tellPatchy()}</div></aside><main class="app-page">${receipt}${body}</main></div>${app.overlay === undefined ? "" : `<div class="modal-scrim"></div>${app.overlay}`}`;
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
 * A first-party page: the app's fonts, styles and, with `app`, the signed-in frame. It takes no
 * styles of its own: a page fills a template's slots and the app's stylesheet draws it. A running
 * patch's shell is Serving's own document, on `servedStyles`. Every one carries the switcher
 * relay, so its response's CSP admits `SWITCHER_RELAY_SOURCE`; an app page also loads the
 * switcher, from its own origin.
 */
export function htmlPage(options: {
  title: string;
  body: string;
  head?: string;
  app?: AppShell;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  ${switcherRelay}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.app === undefined ? options.title : appTitle(options.title, options.app))}</title>
  ${faviconLink}
  ${fontPreload}
  ${options.app ? switcherTag({ userId: options.app.viewer.user.id, companyId: options.app.viewer.company.id }) : ""}
  ${options.head ?? ""}
  <style>
    ${appStyles}
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
