// How more than one portal surface presents a patch: its paths, menus and search, confirmation
// parts and the layout every portal page still carries. Surfaces share only through `shared/`.
import type { RequireSession } from "@patchy/auth";
import { escapeAttribute, escapeHtml, menuCopy, menuLink, patchTitle } from "@patchy/core";
import type { Patches } from "@patchy/patches";

/** The portal's page layout, which every portal page carries until it is rebuilt on core's templates. */
export const styles = `
  .portal-card { min-width: 0; max-width: 920px; }
  .portal-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; }
  .portal-card-head > div:nth-child(2) { flex: 1; min-width: min(100%, 240px); }
  .portal-card-head .page-heading { margin: 0; }
  .portal-card-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
  .portal-card-tags .tag { margin: 0; }
  .portal-card-act { display: flex; align-items: center; gap: 6px; }
  .portal-card-act form { margin: 0; }
  .portal-card-tabs { margin: 18px 0 20px; }
  .portal-stop-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .portal-stop-actions > div { display: grid; align-content: start; }
  .portal-address { align-items: center; }
  .portal-subpage { max-width: 760px; margin-inline: auto; }
  .portal-table { overflow-x: auto; }
  .log-filters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) auto; gap: 0 12px; align-items: end; margin: 8px 0 20px; }
  .log-status { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  .log-outcome { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  /* Log cells keep words whole, so on a phone the table scrolls in portal-table rather than splitting "Version". */
  .log-table { min-width: 880px; overflow-wrap: break-word; }
  .log-table time { white-space: nowrap; }
  @media (max-width: 760px) {
    .log-filters { grid-template-columns: minmax(0, 1fr); }
    .log-filters > :last-child { margin-top: 16px; }
  }
  @media (max-width: 480px) {
    .portal-stop-actions { grid-template-columns: minmax(0, 1fr); }
  }
`;

// The index line: text up to the first sentence-ending period or ellipsis, semicolon or spaced
// en dash, bounded to 80 code points. A period inside a token (".NET", "1.2") is not a boundary.
export const firstClause = (description: string): string => {
  const text = description.trim();
  const boundary = text.search(/\.+(?=\s|$)|;| – /u);
  const clause = boundary === -1 ? text : text.slice(0, boundary).trimEnd();
  const points = Array.from(clause);
  return points.length > 80 ? `${points.slice(0, 79).join("").trimEnd()}…` : clause;
};

export const hidden = (name: string, value: string | number | null) =>
  `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value ?? "")}">`;
export const refusal = (notice: string | undefined) =>
  notice === undefined
    ? ""
    : `<div class="note note-refused" role="alert">${escapeHtml(notice)}</div>`;

export const confirmationAcknowledgement = (text: string, checked: boolean): string =>
  `<label class="confirmation-acknowledgement"><input class="field-checkbox" type="checkbox" name="ack" value="1" required${checked ? " checked" : ""}><span>${escapeHtml(text)}</span></label>`;

/** What the card and Needs attention call a patch its guests can't open. */
export const turnedAwayTitle = "Guests can't open this";

const DAY = 86_400_000;
/** How long a patch counts as new to someone who hasn't opened it. */
const RECENT = 7 * DAY;

type Viewer = RequireSession.Viewer["Service"];
const epoch = (iso: string) => Date.parse(iso);

/** A `?q=` as searched: trimmed and cut to 200 code points, never mid-character. */
export const searchQuery = (raw: string | null) =>
  Array.from((raw ?? "").trim())
    .slice(0, 200)
    .join("");

/** A search over live or off patches: case-insensitive, across name, title, description and owner name. */
export const matches = (row: Patches.ReadPatch, query: string): boolean => {
  const needle = query.toLowerCase();
  return [row.patch.name, row.patch.title, row.patch.description, row.owner.name].some((field) =>
    field.toLowerCase().includes(needle)
  );
};

/** Whether the viewer may manage this patch: its owner, or any admin. */
export const manages = (row: Patches.ReadPatch, viewer: Viewer) =>
  viewer.role === "admin" || row.owner.id === viewer.user.id;

/** Created in the last week by someone else, and not yet opened by the viewer. */
export const isNew = (
  row: Patches.ReadPatch,
  viewer: Viewer,
  opens: ReadonlyMap<string, Patches.Open>,
  now: number
) =>
  row.owner.id !== viewer.user.id &&
  now - epoch(row.patch.createdAt) < RECENT &&
  !opens.has(row.patch.id);

/** A patch's card at `/patches/<name>`, or one of its pages under it. */
export const cardPath = (patch: Patches.Patch, action = "") =>
  `/patches/${encodeURIComponent(patch.name)}${action ? `/${action}` : ""}`;

/** The log filtered to its failed entries. */
export const failedLog = (patch: Patches.Patch) =>
  `/patches/${encodeURIComponent(patch.name)}/log?outcome=failed`;

/** A live patch's address, relative to the instance. */
export const patchAddress = (patch: Patches.Patch) =>
  `/${encodeURIComponent(patch.companyHandle)}/${encodeURIComponent(patch.name)}`;

/** `here`, the page a menu is on, with the Share dialog for patch `name` open over it. */
export const shareHref = (here: string, name: string) => {
  const url = new URL(here, "http://patchy.invalid");
  url.searchParams.set("share", name);
  return `${url.pathname}${url.search}`;
};

/**
 * The ways to open a patch, Share… for one the viewer manages, then its card, as a row's menu
 * starts on Home and All patches. Its name already opens a live patch, so the menu offers a new
 * tab, the link and About this patch; the card's own menu is these without About. `here` is the
 * page the menu is on, which the Share dialog opens over.
 */
export const openItems = (
  row: Patches.ReadPatch,
  viewer: Viewer,
  publicBaseUrl: string,
  here: string,
  about = true
) => {
  const { patch } = row;
  const title = patchTitle(patch);
  const live = patch.state === "live";
  return [
    ...(live
      ? [
          `<a class="menu-item" href="${escapeAttribute(patchAddress(patch))}" target="_blank" rel="noopener" aria-label="${escapeAttribute(`Open in a new tab, ${title}`)}">Open in a new tab</a>`,
          menuCopy(
            `${publicBaseUrl.replace(/\/+$/u, "")}${patchAddress(patch)}`,
            "Copy link",
            title
          )
        ]
      : []),
    ...(live && manages(row, viewer)
      ? [menuLink(shareHref(here, patch.name), "Share…", false, title)]
      : []),
    ...(about ? [menuLink(cardPath(patch), "About this patch", false, title)] : [])
  ];
};
