/**
 * What Patchy keeps about one IMAP mailbox when it connects: where it logs in, the capabilities
 * the server advertised once logged in, and its folders. Never a message.
 *
 * The folders are hints for generation and an agent's context, not limits on calls: a patch may
 * name a folder made after the snapshot, and one that's gone fails when it's opened.
 */
import * as Schema from "effect/Schema";
import { registry } from "@patchy/limits/registry";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** `tls` opens TLS at once, on 993; `starttls` upgrades before logging in, on 143. */
export const imapSecurities = ["tls", "starttls"] as const;
export const ImapSecurity = Schema.Literals(imapSecurities);
export type ImapSecurity = typeof ImapSecurity.Type;
/** The ports Patchy logs in on, each with its one security mode. */
export const ImapPort = Schema.Literals([993, 143]);
export type ImapPort = typeof ImapPort.Type;

/** The special-use flags of RFC 6154, as a server marks its folders with them. */
export const imapSpecialUses = [
  "\\All",
  "\\Archive",
  "\\Drafts",
  "\\Flagged",
  "\\Junk",
  "\\Sent",
  "\\Trash"
] as const;
export const ImapSpecialUse = Schema.Literals(imapSpecialUses);
export type ImapSpecialUse = typeof ImapSpecialUse.Type;

/**
 * One folder as LIST names it. `path` is the whole name in UTF-8, its levels joined by
 * `delimiter` (null for a server with one level). `specialUse` holds only the flags the server
 * sent, never one guessed from a name. A folder that isn't `selectable` holds other folders only.
 */
export const ImapFolder = Schema.Struct({
  path: Text(1024),
  delimiter: Schema.NullOr(Text(8)),
  specialUse: Schema.Array(ImapSpecialUse),
  selectable: Schema.Boolean
});
export type ImapFolder = typeof ImapFolder.Type;

const folders = registry["imap.snapshot.folders"].default;

/**
 * One mailbox login and its folders. `truncated` marks a mailbox with more folders than the
 * snapshot keeps; the rest are still there to read.
 */
export const ImapSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  host: Text(253),
  port: ImapPort,
  security: ImapSecurity,
  username: Text(320),
  capabilities: Schema.Array(Text(128)).check(Schema.isMaxLength(256)),
  folders: Schema.Array(ImapFolder).check(
    Schema.makeFilter(
      (items: ReadonlyArray<unknown>) =>
        items.length <= folders || `An IMAP snapshot keeps at most ${folders} folders.`
    )
  ),
  truncated: Schema.Boolean
});
export type ImapSnapshot = typeof ImapSnapshot.Type;
