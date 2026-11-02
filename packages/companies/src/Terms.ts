import * as Schema from "effect/Schema";

/**
 * A terms or privacy notice revision: the "Last updated" date its page prints, one per document
 * per day. Plain ISO dates, so later is greater as a string; the website's archived launch-day
 * ids carry suffixes, are never current and are never recorded.
 */
export const Revision = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));

export interface Revisions {
  readonly terms: string;
  readonly privacy: string;
}

/**
 * The Patchy Cloud terms and privacy notice in force. Moving either is a release: the website
 * publishes the dated page first and makes it current only once that release is live
 * (docs/OPERATIONS.md › Legal consent). Everyone who hasn't accepted these, or later ones, is
 * asked to on their next page in a browser.
 */
export const current = { terms: "2026-11-03", privacy: "2026-11-02" } as const satisfies Revisions;

/** The page holding a revision's exact words, which never change once published. */
export const url = (document: keyof Revisions, revision: string) =>
  `https://patchyhq.com/cloud/${document}/${revision}`;
