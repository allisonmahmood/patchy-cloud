/**
 * Email (IMAP): one mailbox, read through operations Patchy writes. Patch code names a folder and
 * plain criteria, never an IMAP command, a search string or a section: Patchy builds every command
 * from these arguments, opens every folder with EXAMINE and fetches with BODY.PEEK, so nothing a
 * patch does changes the mailbox or marks mail as read.
 *
 * A message is named by a ref, `{ connection, folder, uidValidity, uid }`: its UID within the
 * folder under one UIDVALIDITY. A ref from an earlier UIDVALIDITY fails `mailbox_reset`. Message-ID
 * is threading metadata, never identity.
 */
import { registry } from "@patchy/limits/registry";
import * as Schema from "effect/Schema";
import { ImapFolder } from "./imapSnapshot.js";
import { DefinitionName, FileContentType, Upload } from "./schemas.js";

const bound = (id: keyof typeof registry) => registry[id].default;

/** IMAP's nz-number: UIDs and UIDVALIDITY are unsigned 32-bit and never 0. */
export const IMAP_MAX_UID = 4_294_967_295;
const NzNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: IMAP_MAX_UID }));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A folder's full path in UTF-8, as `listFolders` answers it. */
export const ImapFolderPath = Schema.String.check(
  Schema.isBetweenLength(1, bound("imap.text.folder")),
  Schema.makeFilter((path) => !/[\0\r\n]/.test(path) || "A folder path has no NUL, CR or LF.")
);
export const ImapUid = NzNumber;
export const ImapUidValidity = NzNumber;

/**
 * One message: its connection's id, its folder, the folder's UIDVALIDITY when the ref was made,
 * and its UID there. A password change keeps refs valid; deleting and recreating a connection
 * doesn't.
 */
export const ImapMessageRef = Schema.Struct({
  connection: Schema.String.check(Schema.isBetweenLength(1, 128)),
  folder: ImapFolderPath,
  uidValidity: ImapUidValidity,
  uid: ImapUid
});
export type ImapMessageRef = typeof ImapMessageRef.Type;

const isCalendarDay = (day: string) => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year >= 1 && days !== undefined && date >= 1 && date <= days;
};
/** A calendar day, `YYYY-MM-DD`, compared with messages' internal dates as IMAP does. */
export const ImapDay = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((day) => isCalendarDay(day) || "Not a calendar day.")
);
const SearchValue = Schema.String.check(
  Schema.isBetweenLength(1, bound("imap.text.search")),
  Schema.makeFilter((value) => !/[\0-\x1F\x7F]/.test(value) || "A search value has no controls.")
);

/**
 * What a search matches, ANDed. `from`, `to` and `subject` are case-insensitive substring
 * matches on those headers, and `text` on the headers and the body together; `since` is on or
 * after a day and `before` strictly before one, by internal date; `unseen` true matches unread
 * mail and false read mail.
 */
export const ImapCriteria = Schema.Struct({
  from: Schema.optionalKey(SearchValue),
  to: Schema.optionalKey(SearchValue),
  subject: Schema.optionalKey(SearchValue),
  text: Schema.optionalKey(SearchValue),
  since: Schema.optionalKey(ImapDay),
  before: Schema.optionalKey(ImapDay),
  unseen: Schema.optionalKey(Schema.Boolean)
});
export type ImapCriteria = typeof ImapCriteria.Type;

/**
 * One part of a message by its IMAP section, such as `2` or `3.1`, as `getMessages` lists it:
 * numbers joined by dots, so never a raw section such as `HEADER`, `TEXT` or `2.MIME`.
 */
export const ImapSection = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[1-9][0-9]*(?:\.[1-9][0-9]*)*$/)
);

/** Patchy's cursor for the next page, or a scan's checkpoint, passed back as it came. */
const Cursor = Schema.String.check(Schema.isBetweenLength(1, 1024));

// ---------- what reads answer ----------

/** One folder as LIST names it now, with the last level of its path as `name`. */
export const ImapFolderEntry = Schema.Struct({ ...ImapFolder.fields, name: Schema.String });
export type ImapFolderEntry = typeof ImapFolderEntry.Type;

/** One address. A group's name alone, with no address, isn't one. */
export const ImapAddress = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  address: Schema.String
});
export type ImapAddress = typeof ImapAddress.Type;

/** One part of a message, from its `BODYSTRUCTURE`. */
export const ImapPart = Schema.Struct({
  /** The IMAP section, such as `1` or `2.1`. */
  part: Schema.String,
  contentType: Schema.String,
  filename: Schema.NullOr(Schema.String),
  /** The part's size on the wire, transfer-encoded: base64 runs about a third over its bytes. */
  encodedSize: Schema.Int,
  disposition: Schema.NullOr(Schema.Literals(["inline", "attachment"])),
  contentId: Schema.NullOr(Schema.String),
  /**
   * Whether the part is what a person reading the mail calls an attachment: one attached by
   * disposition, or one with a filename or of a type other than text that isn't a resource the
   * body embeds (inside `multipart/related` with a Content-ID, such as a logo) or a `message/*`
   * report, such as a bounce's delivery status or a read receipt's. Never the message's body, a
   * signed message's signature or a forwarded message's container; a forwarded message's own
   * files are. `hasAttachments` is true exactly when a part is one.
   */
  attachment: Schema.Boolean
});
export type ImapPart = typeof ImapPart.Type;

export const ImapSummary = Schema.Struct({
  ref: ImapMessageRef,
  from: Schema.Array(ImapAddress),
  to: Schema.Array(ImapAddress),
  cc: Schema.Array(ImapAddress),
  /**
   * Whether From, To, Cc or Reply-To had more addresses than the summary keeps, so a name missing
   * from them may still be on the message.
   */
  recipientsTruncated: Schema.Boolean,
  subject: Schema.NullOr(Schema.String),
  /** The sender's `Date` as ISO 8601, or `null` when it's missing or isn't a date. */
  date: Schema.NullOr(Schema.String),
  /** When the server took the message in, as ISO 8601: what `since` and `before` compare. */
  internalDate: Schema.NullOr(Schema.String),
  /** The whole message's size on the server, in bytes. */
  size: Schema.Int,
  flags: Schema.Array(Schema.String),
  /** Threading metadata, never identity: the ref names the message. */
  messageId: Schema.NullOr(Schema.String),
  inReplyTo: Schema.NullOr(Schema.String),
  references: Schema.Array(Schema.String),
  hasAttachments: Schema.Boolean
});
export type ImapSummary = typeof ImapSummary.Type;

export const ImapMessage = Schema.Struct({
  ...ImapSummary.fields,
  replyTo: Schema.Array(ImapAddress),
  /** Cleaned, lossy plain text of the body. */
  text: Schema.String,
  /** Whether the fetch or the bound left any of the body's text out. */
  truncated: Schema.Boolean,
  parts: Schema.Array(ImapPart),
  /** How the body is encrypted, when it is: its text is then empty, never decrypted. */
  encrypted: Schema.NullOr(Schema.Literals(["smime", "pgp"]))
});
export type ImapMessage = typeof ImapMessage.Type;

/** A ref that didn't read as a message. */
export const ImapUnread = Schema.Struct({
  error: Schema.Literals(["not_found", "malformed", "too_large"])
});
export type ImapUnread = typeof ImapUnread.Type;

const pageFields = {
  ok: Schema.Literal(true),
  messages: Schema.Array(ImapSummary),
  /** Pass back as `cursor` for the next page of this call; `null` once `done`. */
  cursor: Schema.NullOr(Schema.String),
  /** Whether the call has read everything it will; a page can be empty and not done. */
  done: Schema.Boolean
};

/** Each operation's arguments, without the alias, and its result. */
export const imapReads = {
  // No arguments: an empty Struct would let any key through, so this one refuses every key.
  listFolders: {
    input: Schema.Record(Schema.String, Schema.Never),
    output: Schema.Struct({
      ok: Schema.Literal(true),
      folders: Schema.Array(ImapFolderEntry),
      /** Whether the mailbox has more folders than one answer holds. */
      truncated: Schema.Boolean
    })
  },
  folderStatus: {
    input: Schema.Struct({ folder: ImapFolderPath }),
    output: Schema.Struct({
      ok: Schema.Literal(true),
      messages: Count,
      unseen: Count,
      uidValidity: ImapUidValidity,
      uidNext: NzNumber
    })
  },
  /**
   * The ascending, resumable import: oldest UID first, from `since` or past `after`, the
   * checkpoint an earlier scan answered. `checkpoint` is what this page's rows bring the patch to.
   */
  scanMessages: {
    input: Schema.Struct({
      folder: ImapFolderPath,
      since: Schema.optionalKey(ImapDay),
      after: Schema.optionalKey(Cursor),
      cursor: Schema.optionalKey(Cursor)
    }),
    output: Schema.Struct({ ...pageFields, checkpoint: Schema.String })
  },
  /** The folder newest first by UID: arrival order, not the sender's `Date`. */
  listMessages: {
    input: Schema.Struct({ folder: ImapFolderPath, cursor: Schema.optionalKey(Cursor) }),
    output: Schema.Struct(pageFields)
  },
  /** The folder's matches newest first, searched on the server window by window. */
  searchMessages: {
    input: Schema.Struct({
      folder: ImapFolderPath,
      ...ImapCriteria.fields,
      cursor: Schema.optionalKey(Cursor)
    }),
    output: Schema.Struct(pageFields)
  },
  /** One answer per ref, in the order asked. */
  getMessages: {
    input: Schema.Struct({
      refs: Schema.Array(ImapMessageRef).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(bound("imap.getMessages.refs"))
      )
    }),
    output: Schema.Struct({
      ok: Schema.Literal(true),
      messages: Schema.Array(Schema.Union([ImapMessage, ImapUnread]))
    })
  }
} as const;
export type ImapRead = keyof typeof imapReads;

/**
 * Stages one part of a message, decoded from its transfer encoding, as an Upload bound to the
 * caller, which the action adopts once with `ctx.files.<store>.put(name, upload)`. `size` is the
 * staged bytes' true size and `sha256` their digest; `filename` is display text, never a name to
 * store under. A message/rfc822 part is a container: its own parts are what stage.
 */
export const imapStageAttachment = {
  input: Schema.Struct({ ref: ImapMessageRef, part: ImapSection }),
  output: Schema.Struct({
    ok: Schema.Literal(true),
    upload: Upload,
    size: Count,
    sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
    contentType: FileContentType,
    filename: Schema.NullOr(Schema.String)
  })
} as const;
export const imapOperationNames = [
  "listFolders",
  "folderStatus",
  "scanMessages",
  "listMessages",
  "searchMessages",
  "getMessages"
] as const satisfies ReadonlyArray<ImapRead>;

/** An operation's arguments on a declared connection: its alias beside the input. */
const withAlias = <F extends Schema.Struct.Fields>(input: Schema.Struct<F>) =>
  Schema.Struct({ connection: DefinitionName, ...input.fields });
export const ImapListFolders = Schema.Struct({ connection: DefinitionName });
export const ImapFolderStatus = withAlias(imapReads.folderStatus.input);
export const ImapScanMessages = withAlias(imapReads.scanMessages.input);
export const ImapListMessages = withAlias(imapReads.listMessages.input);
export const ImapSearchMessages = withAlias(imapReads.searchMessages.input);
export const ImapGetMessages = withAlias(imapReads.getMessages.input);
export const ImapStageAttachment = withAlias(imapStageAttachment.input);

const operation = <const Op extends string, Args extends Schema.Top, Output extends Schema.Top>(
  op: Op,
  args: Args,
  response: Output
) =>
  ({
    request: Schema.Struct({ op: Schema.Literal(op), args }),
    response,
    kind: "integration"
  }) as const;

/**
 * The runtime operations, flat as the runtime and dev-read grammar take them. Each result encodes
 * through its operation's own schema, so a field outside it never leaves the host.
 */
export const imapOperations = {
  "imap.listFolders": operation("imap.listFolders", ImapListFolders, imapReads.listFolders.output),
  "imap.folderStatus": operation(
    "imap.folderStatus",
    ImapFolderStatus,
    imapReads.folderStatus.output
  ),
  "imap.scanMessages": operation(
    "imap.scanMessages",
    ImapScanMessages,
    imapReads.scanMessages.output
  ),
  "imap.listMessages": operation(
    "imap.listMessages",
    ImapListMessages,
    imapReads.listMessages.output
  ),
  "imap.searchMessages": operation(
    "imap.searchMessages",
    ImapSearchMessages,
    imapReads.searchMessages.output
  ),
  "imap.getMessages": operation("imap.getMessages", ImapGetMessages, imapReads.getMessages.output),
  "imap.stageAttachment": operation(
    "imap.stageAttachment",
    ImapStageAttachment,
    imapStageAttachment.output
  )
} as const;
export type ImapOperation = keyof typeof imapOperations;
