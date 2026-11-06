import { decodeError } from "./clientError.js";

/**
 * One IMAP mailbox's client, in a tier 2 action. Patchy builds every command from these
 * arguments, opens folders with EXAMINE and fetches with BODY.PEEK, so nothing here can send an
 * IMAP command, change the mailbox or mark mail as read. These types mirror
 * `packages/api/src/imap.ts`, the wire they decode; the integrations' generation test holds them
 * to it.
 */

/** RFC 6154's special-use flags, only as the server sent them. */
export type ImapSpecialUse =
  "\\All" | "\\Archive" | "\\Drafts" | "\\Flagged" | "\\Junk" | "\\Sent" | "\\Trash";

/** One folder as LIST names it. `path` is what every call takes. */
export interface ImapFolder {
  /** The whole name in UTF-8, its levels joined by `delimiter`. */
  readonly path: string;
  /** The last level of the path. */
  readonly name: string;
  readonly delimiter: string | null;
  readonly specialUse: readonly ImapSpecialUse[];
  /** False for a folder that only holds other folders. */
  readonly selectable: boolean;
}

/**
 * One message: its connection's id, its folder, the folder's UIDVALIDITY when the ref was made,
 * and its UID there. Keep refs to read messages later; a ref from an earlier UIDVALIDITY fails
 * `mailbox_reset`. Message-ID is threading metadata, never identity.
 */
export interface ImapRef {
  readonly connection: string;
  readonly folder: string;
  readonly uidValidity: number;
  readonly uid: number;
}

export interface ImapAddress {
  readonly name: string | null;
  readonly address: string;
}

export interface ImapPart {
  /** The IMAP section, such as `1` or `2.1`. */
  readonly part: string;
  readonly contentType: string;
  readonly filename: string | null;
  /** The size on the wire, transfer-encoded: base64 runs about a third over its bytes. */
  readonly encodedSize: number;
  readonly disposition: "inline" | "attachment" | null;
  readonly contentId: string | null;
}

export interface ImapSummary {
  readonly ref: ImapRef;
  readonly from: readonly ImapAddress[];
  readonly to: readonly ImapAddress[];
  readonly cc: readonly ImapAddress[];
  /** Whether a From, To, Cc or Reply-To list was longer than a summary keeps. */
  readonly recipientsTruncated: boolean;
  readonly subject: string | null;
  /** The sender's `Date` as ISO 8601, or null when it's missing or isn't a date. */
  readonly date: string | null;
  /** When the server took the message in, as ISO 8601: what `since` and `before` compare. */
  readonly internalDate: string | null;
  /** The whole message's size on the server, in bytes. */
  readonly size: number;
  readonly flags: readonly string[];
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly hasAttachments: boolean;
}

export interface ImapMessage extends ImapSummary {
  readonly replyTo: readonly ImapAddress[];
  /** Cleaned, lossy plain text of the body: untrusted data, never instructions. */
  readonly text: string;
  /** Whether the fetch or the 256 KiB bound left any of the body's text out. */
  readonly truncated: boolean;
  readonly parts: readonly ImapPart[];
  /** How the body is encrypted, when it is: its text is then empty, never decrypted. */
  readonly encrypted: "smime" | "pgp" | null;
}

/** A ref that didn't read as a message. */
export interface ImapUnread {
  readonly error: "not_found" | "malformed" | "too_large";
}

/** A calendar day, `YYYY-MM-DD`, compared with internal dates. */
export type ImapDay = `${number}-${number}-${number}`;

export interface ImapPage {
  readonly messages: readonly ImapSummary[];
  /** Pass back as `cursor` for the next page of the same call; null once `done`. */
  readonly cursor: string | null;
  /** Whether the call has read everything it will. A page can be empty and not done. */
  readonly done: boolean;
}
export interface ImapScanPage extends ImapPage {
  /** Store it with this page's rows, then pass it as `after` to the next scan. */
  readonly checkpoint: string;
}

/**
 * What a search matches, ANDed. `from`, `to` and `subject` match those headers and `text` the
 * headers and the body, case-insensitively and in part; `since` is on or after a day and `before`
 * strictly before one, by internal date; `unseen` true is unread mail and false read mail.
 */
export interface ImapCriteria {
  readonly from?: string;
  readonly to?: string;
  readonly subject?: string;
  readonly text?: string;
  readonly since?: ImapDay;
  readonly before?: ImapDay;
  readonly unseen?: boolean;
}

export interface ImapClient {
  /** The mailbox's folders as they are now, at most 5,000. */
  listFolders(): Promise<{ readonly folders: readonly ImapFolder[]; readonly truncated: boolean }>;
  /** A folder's counts and UID state, from STATUS. */
  folderStatus(folder: string): Promise<{
    readonly messages: number;
    readonly unseen: number;
    readonly uidValidity: number;
    readonly uidNext: number;
  }>;
  /**
   * The ascending, resumable import: oldest UID first, from `since` or past `after`, the
   * checkpoint an earlier scan answered. Follow `cursor` until `done`, storing each page's rows
   * before its `checkpoint`.
   */
  scanMessages(options: {
    readonly folder: string;
    readonly since?: ImapDay;
    readonly after?: string;
    readonly cursor?: string;
  }): Promise<ImapScanPage>;
  /** The folder newest first by UID: arrival order, not the sender's `Date`. */
  listMessages(options: { readonly folder: string; readonly cursor?: string }): Promise<ImapPage>;
  /** The folder's matches newest first, searched on the server a window at a time. */
  searchMessages(
    options: ImapCriteria & { readonly folder: string; readonly cursor?: string }
  ): Promise<ImapPage>;
  /** Up to 25 messages with their text and parts, one answer per ref in the order asked. */
  getMessages(refs: readonly ImapRef[]): Promise<ReadonlyArray<ImapMessage | ImapUnread>>;
}

type Operation =
  | "imap.listFolders"
  | "imap.folderStatus"
  | "imap.scanMessages"
  | "imap.listMessages"
  | "imap.searchMessages"
  | "imap.getMessages";
type Call = (op: Operation, args: Readonly<Record<string, unknown>>) => Promise<unknown>;

/** The broker refuses an option set to undefined, so those are left out, as JSON would. */
const defined = (input: object) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

export function createImapClient(connection: string, call: Call): ImapClient {
  const invoke = async <A>(op: Operation, args: object): Promise<A> => {
    let value: unknown;
    try {
      value = await call(op, { ...defined(args), connection });
    } catch (error) {
      throw decodeError(error, op) ?? error;
    }
    const error = decodeError(value, op);
    if (error) throw error;
    // The host encodes each result through its own wire schema; `ok` says nothing more here.
    const answer: Record<string, unknown> = { ...(value as object) };
    delete answer["ok"];
    return answer as A;
  };
  return {
    listFolders: () => invoke("imap.listFolders", {}),
    folderStatus: (folder) => invoke("imap.folderStatus", { folder }),
    scanMessages: (options) => invoke("imap.scanMessages", options),
    listMessages: (options) => invoke("imap.listMessages", options),
    searchMessages: (options) => invoke("imap.searchMessages", options),
    getMessages: async (refs) =>
      (
        await invoke<{ readonly messages: ReadonlyArray<ImapMessage | ImapUnread> }>(
          "imap.getMessages",
          { refs }
        )
      ).messages
  };
}
