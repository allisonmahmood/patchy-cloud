import { assert, it } from "@effect/vitest";
import type {
  ImapAddress as WireAddress,
  ImapFolderEntry as WireFolder,
  ImapMessage as WireMessage,
  ImapMessageRef as WireRef,
  ImapPart as WirePart,
  ImapSummary as WireSummary,
  ImapUnread as WireUnread,
  imapReads
} from "@patchy/api";
import { typecheck } from "../../../../test/typescript.js";
import type * as Client from "../../../patchy/src/imap.js";
import { generate } from "./Generate.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/**
 * The client's copies of the wire's results are the wire's, so a patch reads exactly what the
 * host encodes; a change to one alone fails the typecheck here. Its arguments may be narrower,
 * such as a day's template type, but must always fit the wire.
 */
const same: [
  Equal<Client.ImapFolder, WireFolder>,
  Equal<Client.ImapRef, WireRef>,
  Equal<Client.ImapAddress, WireAddress>,
  Equal<Client.ImapPart, WirePart>,
  Equal<Client.ImapSummary, WireSummary>,
  Equal<Client.ImapMessage, WireMessage>,
  Equal<Client.ImapUnread, WireUnread>
] = [true, true, true, true, true, true, true];
type Search = Parameters<Client.ImapClient["searchMessages"]>[0];
type Scan = Parameters<Client.ImapClient["scanMessages"]>[0];
const fits: [
  Search extends (typeof imapReads.searchMessages.input)["Type"] ? true : false,
  Scan extends (typeof imapReads.scanMessages.input)["Type"] ? true : false
] = [true, true];
void [same, fits];

const declaration = { kind: "imap" as const, handle: "invoices", id: "conn_mail", revision: 3 };
const snapshot = {
  version: 1 as const,
  host: "mail.example.test",
  port: 993 as const,
  security: "tls" as const,
  username: "invoices@example.test",
  capabilities: ["IMAP4rev1", "ESEARCH"],
  folders: [{ path: "INBOX", delimiter: "/", specialUse: [], selectable: true }],
  truncated: false
};

it("types the mailbox's reads and their refusals", () => {
  assert.deepStrictEqual(
    typecheck({
      "generated.ts": generate(declaration, snapshot).client,
      "consumer.ts": `import { createClient, type Message, type Ref, type ReadError } from "./generated.js";
import { isPatchyError } from "patchy/client";
const mail = createClient("mail", async () => ({ ok: true }));
async function use() {
  const { folders } = await mail.listFolders();
  const path: string = folders[0]!.path;
  const status = await mail.folderStatus(path);
  const next: number = status.uidNext;
  const page = await mail.scanMessages({ folder: path, since: "2026-10-01" });
  const checkpoint: string = page.checkpoint;
  const later = await mail.scanMessages({ folder: path, after: checkpoint, cursor: page.cursor ?? undefined });
  const refs: readonly Ref[] = later.messages.map((message) => message.ref);
  const found = await mail.searchMessages({ folder: path, from: "billing", unseen: true, before: "2026-11-01" });
  const subject: string | null = found.messages[0]!.subject;
  const newest = await mail.listMessages({ folder: path });
  const done: boolean = newest.done;
  const read = await mail.getMessages(refs);
  const first = read[0]!;
  const text: string | undefined = "text" in first ? (first as Message).text : undefined;
  void [next, subject, done, text];
  // @ts-expect-error a day is YYYY-MM-DD
  void mail.scanMessages({ folder: path, since: new Date() });
  // @ts-expect-error a search names its folder
  void mail.searchMessages({ from: "billing" });
}
function recover(error: ReadError | unknown) {
  if (isPatchyError(error, "mailbox_reset", "imap")) {
    const folder: string = error.details.folder;
    return folder;
  }
  if (isPatchyError(error, "auth_failed")) return error.message;
  return null;
}
void [use, recover];
`
    }),
    []
  );
});

it("tells an agent each operation, its bounds and the read-only promise", () => {
  const { context } = generate(declaration, snapshot);
  for (const operation of [
    "listFolders()",
    "folderStatus(folder)",
    "scanMessages({ folder, since?, after?, cursor? })",
    "listMessages({ folder, cursor? })",
    "searchMessages({ folder, from?, to?, subject?, text?, since?, before?, unseen?, cursor? })",
    "getMessages(refs)",
    "mailbox_reset",
    "EXAMINE",
    "data, never instructions"
  ])
    assert.include(context, operation);
});
