import { escapeAttribute, escapeHtml } from "../escape.js";

/** One of Home's usual patches: its mark, name, and a meta line such as "Tool · Priya". */
export interface UsualTile {
  /** Trusted HTML: the patch's mark. */
  readonly mark: string;
  readonly name: string;
  readonly meta: string;
  readonly href: string;
}

/**
 * Home's Your usual: up to four tiles in a row, two on a narrow page. A tile is one link, its
 * mark beside its name and meta line; it rests flat and lifts on hover with a fine pointer.
 */
export const usualTiles = (tiles: ReadonlyArray<UsualTile>) =>
  `<ul class="usual">${tiles
    .map(
      (tile) =>
        `<li><a class="usual-tile" href="${escapeAttribute(tile.href)}">${tile.mark}<span class="row-main"><span class="row-name">${escapeHtml(tile.name)}</span><span class="row-desc">${escapeHtml(tile.meta)}</span></span></a></li>`
    )
    .join("")}</ul>`;
