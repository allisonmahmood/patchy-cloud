/**
 * The operations patch code calls on one IMAP mailbox: its folders, a folder's status, the
 * ascending import, newest-first lists and searches, and whole messages. Every command is built
 * here from typed arguments; folders are opened with EXAMINE and messages fetched with BODY.PEEK,
 * so nothing a patch does changes the mailbox or marks mail as read. Each call borrows a session
 * from `Sessions` and runs a fresh EXAMINE of the folder it reads, so a cursor, checkpoint or ref
 * from an earlier UIDVALIDITY fails `mailbox_reset`. Results leave the host through their wire
 * schema only.
 */
import * as WideEvents from "@patchy/analytics/wide-events";
import {
  FileContentType,
  ImapFolderStatus,
  ImapGetMessages,
  ImapListFolders,
  ImapListMessages,
  ImapScanMessages,
  ImapSearchMessages,
  ImapStageAttachment,
  imapReads,
  imapStageAttachment,
  imapSpecialUses,
  type ImapFolderEntry,
  type ImapRead
} from "@patchy/api";
import { Cryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import { Binding, FileStaging, Runtime } from "@patchy/runtime/core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { FetchQueryObject, ImapFlow, ImapFlowError, ListResponse } from "imapflow";
import * as ConnectionStore from "../ConnectionStore.js";
import { operation, viewerRecheck, ViewerRefusal, type DevRead } from "../definition.js";
import {
  ForeignRef,
  InvalidCheckpoint,
  InvalidCursor,
  MailboxReset,
  ResultTooLarge
} from "./read/Errors.js";
import * as Message from "./read/Message.js";
import * as Plan from "./read/Plan.js";
import { refKey, uidSet } from "./read/Refs.js";
import * as Results from "./read/Results.js";
import { readStructure } from "./read/Structure.js";
import * as Summary from "./read/Summary.js";
import * as Attachments from "./Attachments.js";
import * as Sessions from "./Sessions.js";
import * as ImapSource from "./Source.js";

export class ConnectionNotDeclared extends Schema.TaggedError<ConnectionNotDeclared>()(
  "ImapConnectionNotDeclared",
  {}
) {
  readonly code = "connection_not_declared" as const;
  readonly status = 400;
  override get message() {
    return "This IMAP connection is not declared by this version.";
  }
}

/** The folder couldn't be opened: it's gone, or it holds only other folders. */
export class FolderNotFound extends Schema.TaggedError<FolderNotFound>()("ImapFolderNotFound", {
  folder: Schema.String
}) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return `The mailbox has no folder ${this.folder} that can be opened. listFolders names the ones it has.`;
  }
  get details() {
    return { folder: this.folder };
  }
}

/**
 * The mailbox no longer meets a requirement it met when it was connected, such as its certificate
 * or address. `reason` is the refusal an admin's Test would name.
 */
export class MailboxUnreachable extends Schema.TaggedError<MailboxUnreachable>()(
  "ImapMailboxUnreachable",
  { reason: Schema.String }
) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "The mail server no longer meets what Patchy needs to log in to it. An admin can Test the connection at /company/connections, which names what changed.";
  }
  get details() {
    return { reason: this.reason };
  }
}

export const Errors = Schema.Union([
  ConnectionNotDeclared,
  FolderNotFound,
  MailboxUnreachable,
  InvalidCursor,
  InvalidCheckpoint,
  MailboxReset,
  ForeignRef,
  ResultTooLarge,
  Attachments.MessageNotFound,
  Attachments.PartNotFound,
  Attachments.NotAFile,
  Attachments.AttachmentTooLarge,
  Sessions.Busy,
  Sessions.SessionLost,
  Sessions.CommandRefused,
  ImapSource.LoginRefused,
  ImapSource.ConnectionPaused,
  ImapSource.Unavailable,
  ImapSource.Throttled,
  ImapSource.Timeout,
  ImapSource.Overflow,
  Runtime.InvalidRequest,
  ...ViewerRefusal.members,
  Runtime.TooLarge,
  Runtime.LimitExceeded
]);
const isError = Schema.is(Errors);
/** The connection is gone or disconnected: each door says which, its own way. */
const isAbsent = Schema.is(
  Schema.Union([ConnectionStore.ConnectionNotFound, ConnectionStore.ConnectionNotConnected])
);
/**
 * Failures after which the session's last command had finished, so it can go back to the pool:
 * the server answered, or Patchy refused what it answered.
 */
const isReusable = Schema.is(
  Schema.Union([
    FolderNotFound,
    InvalidCursor,
    InvalidCheckpoint,
    MailboxReset,
    ResultTooLarge,
    Runtime.TooLarge,
    Attachments.MessageNotFound,
    Attachments.PartNotFound,
    Attachments.NotAFile
  ])
);

const DEADLINE_MS = registry["integration.deadline"].default;
const MAX_RESULT = registry["runtime.result.bytes"].default;
const MAX_FOLDERS = registry["imap.snapshot.folders"].default;
const MAX_PATH = registry["imap.text.folder"].default;
type Json = typeof Schema.Json.Type;
type Inputs = { readonly [K in ImapRead]: (typeof imapReads)[K]["input"]["Type"] };
type Outputs = { readonly [K in ImapRead]: (typeof imapReads)[K]["output"]["Type"] };
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/** Which connection a call reads, and until when, for a caller its door admitted. */
export interface Target<E = never> {
  readonly companyId: string;
  readonly connection: { readonly id: string; readonly handle: string; readonly revision?: number };
  readonly deadline: number;
  readonly recheck: Effect.Effect<void, E>;
}

// ---------- the mailbox, as one call reads it ----------

/** The result through its operation's wire schema, so nothing outside it leaves the host. */
const result = <K extends ImapRead>(name: K) => {
  const encode = Schema.encodeEffect(imapReads[name].output);
  return (value: Outputs[K]) =>
    Effect.flatMap(
      Effect.mapError(encode(value), (cause) => new Runtime.SourceUnavailable({ cause })),
      (encoded) =>
        Buffer.byteLength(encodeJson(encoded as Json), "utf8") > MAX_RESULT
          ? Effect.fail(
              new Runtime.TooLarge({ maxBytes: MAX_RESULT, limitId: "runtime.result.bytes" })
            )
          : Effect.succeed(encoded as Json)
    );
};

/** One command on the session; its failure says what it means for the session. */
const command = <A>(session: Sessions.Session, work: (client: ImapFlow) => Promise<A>) =>
  Effect.tryPromise({
    try: () => work(session.client),
    catch: (error) => Sessions.failure(session, error)
  });

const refusedNo = (error: unknown) =>
  error instanceof Error && (error as ImapFlowError).responseStatus === "NO";

/**
 * A fresh EXAMINE of `folder`, the call's mailbox boundary: ImapFlow's own lock could reuse a
 * folder already selected without one. A NO means it can't be opened; UIDNEXT comes from STATUS
 * where EXAMINE leaves it out.
 */
const examine = Effect.fnUntraced(function* (session: Sessions.Session, folder: string) {
  const opened = yield* Effect.tryPromise({
    try: () => session.client.mailboxOpen(folder, { readOnly: true }),
    catch: (error) =>
      refusedNo(error) ? new FolderNotFound({ folder }) : Sessions.failure(session, error)
  });
  let uidNext = opened.uidNext;
  if (!Number.isSafeInteger(uidNext) || uidNext < 1) {
    const status = yield* command(session, (client) => client.status(folder, { uidNext: true }));
    uidNext = status === false ? 1 : (status.uidNext ?? 1);
  }
  const mailbox: Plan.Mailbox = {
    uidValidity: Number(opened.uidValidity),
    uidNext,
    messages: opened.exists
  };
  return mailbox;
});

/** What a summary reads of each message: never its body, and only the References header. */
const summaryQuery: FetchQueryObject = {
  uid: true,
  flags: true,
  internalDate: true,
  size: true,
  envelope: true,
  bodyStructure: true,
  headers: ["references"]
};

/** The planners' commands, on the session's examined folder. */
const plannerSource = (
  session: Sessions.Session
): Plan.Source<
  Summary.Fetched,
  ImapSource.Overflow | Sessions.CommandRefused | Sessions.SessionLost,
  never
> => ({
  esearch: session.client.capabilities.has("ESEARCH"),
  search: (range, criteria) =>
    Effect.flatMap(
      command(session, (client) => client.search(Plan.searchQuery(range, criteria), { uid: true })),
      (found) =>
        Array.isArray(found)
          ? Effect.succeed(found)
          : // ImapFlow answers a refused search `false`: never "no matches".
            Effect.fail(new Sessions.CommandRefused({ host: session.host, answer: "NO" }))
    ),
  searchMin: (range, criteria) =>
    Effect.flatMap(
      command(session, (client) =>
        client.search(Plan.searchQuery(range, criteria), { uid: true, returnOptions: ["MIN"] })
      ),
      (found) =>
        found === false || found === undefined || Array.isArray(found)
          ? Effect.fail(new Sessions.CommandRefused({ host: session.host, answer: "NO" }))
          : Effect.succeed(found.min)
    ),
  uidAt: (sequence) =>
    Effect.map(
      command(session, (client) => client.fetchOne(String(sequence), { uid: true })),
      (found) => (found === false ? undefined : found.uid)
    ),
  fetch: (uids) => {
    const set = uidSet(uids);
    return set === undefined
      ? Effect.succeed([])
      : command(session, (client) => client.fetchAll(set, summaryQuery, { uid: true }));
  }
});

const folderOf = (entry: ListResponse): ImapFolderEntry => {
  const flags = new Set([...entry.flags].map((flag) => flag.toLowerCase()));
  return {
    path: entry.path,
    name: entry.name,
    delimiter: entry.delimiter === "" ? null : (entry.delimiter ?? null),
    specialUse: imapSpecialUses.filter((flag) => flags.has(flag.toLowerCase())),
    selectable: !flags.has("\\noselect") && !flags.has("\\nonexistent")
  };
};

/** Each operation on a session the call owns. */
const runners: {
  readonly [K in ImapRead]: (
    session: Sessions.Session,
    connectionId: string,
    input: Inputs[K]
  ) => Effect.Effect<
    Json,
    | ImapSource.Overflow
    | Sessions.CommandRefused
    | Sessions.SessionLost
    | FolderNotFound
    | InvalidCursor
    | InvalidCheckpoint
    | MailboxReset
    | ResultTooLarge
    | ForeignRef
    | Runtime.InvalidRequest
    | Runtime.SourceUnavailable
    | Runtime.TooLarge,
    Cryptography.Cryptography
  >;
} = {
  listFolders: (session) =>
    Effect.gen(function* () {
      const listed = yield* command(session, (client) => client.list({ listOnly: true }));
      const kept = listed.filter((entry) => entry.path.length <= MAX_PATH);
      return yield* result("listFolders")({
        ok: true,
        folders: kept.slice(0, MAX_FOLDERS).map(folderOf),
        truncated: kept.length > MAX_FOLDERS || kept.length < listed.length
      });
    }),
  folderStatus: (session, _connection, input) =>
    Effect.gen(function* () {
      // STATUS of a folder this session had open answers from that view: a folder deleted and
      // recreated since would keep its old UIDVALIDITY. A fresh EXAMINE first makes it current.
      yield* examine(session, input.folder);
      const status = yield* Effect.tryPromise({
        try: () =>
          session.client.status(input.folder, {
            messages: true,
            unseen: true,
            uidValidity: true,
            uidNext: true
          }),
        catch: (error) =>
          refusedNo(error)
            ? new FolderNotFound({ folder: input.folder })
            : Sessions.failure(session, error)
      });
      if (status === false || status.uidValidity === undefined)
        return yield* new FolderNotFound({ folder: input.folder });
      return yield* result("folderStatus")({
        ok: true,
        messages: status.messages ?? 0,
        unseen: status.unseen ?? 0,
        uidValidity: Number(status.uidValidity),
        uidNext: Math.max(1, status.uidNext ?? 1)
      });
    }),
  scanMessages: (session, connection, input) =>
    Effect.gen(function* () {
      const mailbox = yield* examine(session, input.folder);
      const page = yield* Plan.scanMessages({
        connection,
        folder: input.folder,
        ...(input.since === undefined ? {} : { since: input.since }),
        ...(input.after === undefined ? {} : { after: input.after }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        mailbox,
        source: plannerSource(session)
      });
      const folder = { connection, folder: input.folder, uidValidity: mailbox.uidValidity };
      return yield* result("scanMessages")({
        ok: true,
        messages: page.messages.map((message) => Summary.summarize(message, folder)),
        cursor: page.cursor,
        checkpoint: page.checkpoint,
        done: page.done
      });
    }),
  listMessages: (session, connection, input) =>
    Effect.gen(function* () {
      const mailbox = yield* examine(session, input.folder);
      const page = yield* Plan.listMessages({
        connection,
        folder: input.folder,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        mailbox,
        source: plannerSource(session)
      });
      const folder = { connection, folder: input.folder, uidValidity: mailbox.uidValidity };
      return yield* result("listMessages")({
        ok: true,
        messages: page.messages.map((message) => Summary.summarize(message, folder)),
        cursor: page.cursor,
        done: page.done
      });
    }),
  searchMessages: (session, connection, input) =>
    Effect.gen(function* () {
      const { folder: path, cursor, ...criteria } = input;
      const mailbox = yield* examine(session, path);
      const page = yield* Plan.searchMessages({
        connection,
        folder: path,
        criteria,
        ...(cursor === undefined ? {} : { cursor }),
        mailbox,
        source: plannerSource(session)
      });
      const folder = { connection, folder: path, uidValidity: mailbox.uidValidity };
      return yield* result("searchMessages")({
        ok: true,
        messages: page.messages.map((message) => Summary.summarize(message, folder)),
        cursor: page.cursor,
        done: page.done
      });
    }),
  getMessages: (session, connection, input) =>
    Effect.gen(function* () {
      const reads = yield* Effect.fromResult(Results.planGetMessages(input.refs, connection));
      const found = new Map<string, Results.Outcome>();
      for (const read of reads) {
        const mailbox = yield* examine(session, read.folder);
        if (mailbox.uidValidity !== read.uidValidity)
          return yield* new MailboxReset({ folder: read.folder });
        const folder = { connection, folder: read.folder, uidValidity: read.uidValidity };
        const fetched = yield* plannerSource(session).fetch(read.uids);
        // Messages whose text parts are the same fetch together: most bodies are part 1.
        const texts = new Map<
          string,
          { fetches: ReadonlyArray<Message.TextFetch>; uids: number[] }
        >();
        for (const message of fetched) {
          const fetches = Message.textFetches(message);
          if (fetches.length === 0) continue;
          const group = encodeJson(fetches.map((fetch) => [fetch.part, fetch.maxLength]));
          const entry = texts.get(group) ?? { fetches, uids: [] };
          entry.uids.push(message.uid);
          texts.set(group, entry);
        }
        const answered = new Map<number, Message.FetchedText>();
        for (const { fetches, uids } of texts.values()) {
          const set = uidSet(uids)!;
          const rows = yield* command(session, (client) =>
            client.fetchAll(
              set,
              {
                uid: true,
                bodyParts: fetches.map((fetch) => ({
                  key: fetch.part,
                  start: 0,
                  maxLength: fetch.maxLength
                }))
              },
              { uid: true }
            )
          );
          for (const row of rows) answered.set(row.uid, row);
        }
        for (const message of fetched)
          if (read.uids.includes(message.uid))
            found.set(
              refKey({ ...folder, uid: message.uid }),
              Message.readMessage(message, folder, answered.get(message.uid) ?? {})
            );
      }
      const answers = yield* Effect.fromResult(Results.answerGetMessages(input.refs, found));
      return yield* result("getMessages")({ ok: true, messages: answers });
    })
};

// ---------- the call, through the pool ----------

/** The company's connected IMAP connection by this id and handle, as it stands now. */
const current = Effect.fn("ImapOperations.current")(function* (
  companyId: string,
  declared: Target["connection"]
) {
  const connections = yield* ConnectionStore.ConnectionStore;
  const connection = yield* connections.get(companyId, declared.id);
  if (
    connection.companyId !== companyId ||
    connection.integration !== "imap" ||
    connection.mode !== "company" ||
    connection.handle !== declared.handle
  )
    return yield* new ConnectionStore.ConnectionNotFound({
      companyId,
      lookup: { id: declared.id }
    });
  if (connection.status !== "connected")
    return yield* new ConnectionStore.ConnectionNotConnected({});
  return connection;
});

/** The door refused its caller once the call held its gates; `atMailbox` hands on what it said. */
class CallerRefused extends Schema.TaggedError<CallerRefused>()("ImapCallerRefused", {}) {
  override get message() {
    return "The caller was refused once the call held its gates; nothing was sent.";
  }
}

/** A Test refusal met during a call, as the runtime names it: the mailbox stopped meeting one. */
const unreachable = (error: ImapSource.OpenError) =>
  error._tag === "ImapLoginRefused" ||
  error._tag === "ImapUnavailable" ||
  error._tag === "ImapThrottled" ||
  error._tag === "ImapTimeout" ||
  error._tag === "ImapOverflow"
    ? error
    : new MailboxUnreachable({ reason: error.code });

/**
 * One operation on the mailbox its door admitted, through a session from the pool. A login the
 * server refuses pauses the connection, with the logins it read before logging in, so no host
 * process logs in again until an admin's Test or Replace password succeeds. Refusals come back as
 * the wire says them, and the door's refusal of its caller and the connection's absence as they
 * are, for the door to say. Anything else is Patchy's side being unavailable.
 */
const onMailbox = Effect.fnUntraced(function* <A, E>(
  target: Target<E>,
  use: (
    session: Sessions.Session,
    connection: string
  ) => Effect.Effect<A, typeof Errors.Type, Cryptography.Cryptography>
) {
  const caller = yield* Ref.make(Option.none<E>());
  const connections = yield* ConnectionStore.ConnectionStore;
  const sessions = yield* Sessions.Sessions;
  const recheck = target.recheck.pipe(
    Effect.tapError((error) => Ref.set(caller, Option.some(error))),
    Effect.mapError(() => new CallerRefused({}))
  );
  return yield* Effect.gen(function* () {
    const first = yield* current(target.companyId, target.connection);
    let admitted: { readonly credentialRevision: number; readonly logins: number } | undefined;
    const lease: Sessions.Lease<
      | CallerRefused
      | ConnectionStore.ConnectionNotFound
      | ConnectionStore.ConnectionNotConnected
      | ConnectionStore.ConnectionChanged
      | ConnectionStore.ConnectionError
      | ImapSource.ConnectionPaused
      | ImapSource.InvalidCredentials
    > = {
      companyId: target.companyId,
      connectionId: first.id,
      host: first.display.host,
      username: first.display.username,
      deadline: target.deadline,
      admit: Effect.gen(function* () {
        // The caller or the connection may have changed while the call waited.
        yield* recheck;
        const now = yield* current(target.companyId, target.connection);
        if (
          now.display.host !== first.display.host ||
          now.display.username !== first.display.username
        )
          return yield* new ConnectionStore.ConnectionChanged({});
        const secret = yield* connections.poolCredentials(
          target.companyId,
          {
            kind: "imap",
            id: now.id,
            handle: now.handle,
            revision: target.connection.revision ?? now.metadataRevision
          },
          now.credentialRevision
        );
        const credentials = yield* ImapSource.parseCredentials(secret);
        admitted = { credentialRevision: now.credentialRevision, logins: now.display.logins ?? 0 };
        return {
          credentialRevision: now.credentialRevision,
          settings: ImapSource.settings(credentials)
        };
      }).pipe(Effect.provideService(ConnectionStore.ConnectionStore, connections)),
      opened: Effect.gen(function* () {
        yield* recheck;
        const now = yield* current(target.companyId, target.connection);
        if (now.credentialRevision !== admitted?.credentialRevision)
          return yield* new ConnectionStore.ConnectionChanged({});
      }).pipe(Effect.provideService(ConnectionStore.ConnectionStore, connections)),
      reusable: isReusable
    };
    return yield* sessions
      .lease(lease, (session) => use(session, first.id))
      .pipe(
        Effect.catchTags({
          // A pause that can't be saved is tried once more, then logged: the caller still
          // hears `auth_failed`, and the next call may log in once more and pause it then.
          ImapLoginRefused: (refused) =>
            Effect.andThen(
              admitted === undefined
                ? Effect.void
                : connections
                    .pauseLogin({
                      companyId: target.companyId,
                      id: first.id,
                      credentialRevision: admitted.credentialRevision,
                      logins: admitted.logins,
                      reply: refused.reply
                    })
                    .pipe(
                      Effect.retry({ times: 1 }),
                      Effect.catch((error) =>
                        Effect.andThen(
                          Effect.logError(
                            "The mail server refused the login, and pausing the connection failed.",
                            error
                          ).pipe(Effect.annotateLogs({ connectionId: first.id })),
                          WideEvents.enrich({ imapPauseFailed: true })
                        )
                      )
                    ),
              Effect.fail(refused)
            ),
          ImapHostNotFound: (error) => Effect.fail(unreachable(error)),
          ImapPrivateAddress: (error) => Effect.fail(unreachable(error)),
          ImapPortNotAllowed: (error) => Effect.fail(unreachable(error)),
          ImapTlsFailed: (error) => Effect.fail(unreachable(error)),
          ImapCertificateUntrusted: (error) => Effect.fail(unreachable(error)),
          ImapCertificateMismatch: (error) => Effect.fail(unreachable(error)),
          ImapStartTlsUnavailable: (error) => Effect.fail(unreachable(error)),
          ImapNotImap4: (error) => Effect.fail(unreachable(error)),
          ImapLoginDisabled: (error) => Effect.fail(unreachable(error)),
          ImapPreauthenticated: (error) => Effect.fail(unreachable(error))
        })
      );
  }).pipe(
    Effect.catch((error) =>
      Effect.flatMap(Ref.get(caller), (refused) =>
        Effect.fail(
          Option.isSome(refused)
            ? refused.value
            : isError(error) || isAbsent(error)
              ? error
              : new Runtime.SourceUnavailable({ cause: Redacted.make(error) })
        )
      )
    )
  );
});

/** One read on the mailbox its door admitted, through a session from the pool. */
export const atMailbox = <K extends ImapRead, E>(target: Target<E>, name: K, input: Inputs[K]) =>
  Effect.gen(function* () {
    // Refused before any session: refs to another connection, or one folder under two values.
    if (name === "getMessages")
      yield* Effect.fromResult(
        Results.planGetMessages((input as Inputs["getMessages"]).refs, target.connection.id)
      );
    return yield* onMailbox(target, (session, connection) =>
      runners[name](session, connection, input)
    );
  });

type StageInput = typeof imapStageAttachment.input.Type;
const isContentType = Schema.is(FileContentType);

/**
 * The part a stage names, found in the message's structure as it is now, and its bytes. A ref to
 * another connection is refused before any session; a forwarded message's container isn't a file.
 */
export const downloadAttachment = <E>(target: Target<E>, input: StageInput) =>
  Effect.gen(function* () {
    if (input.ref.connection !== target.connection.id) return yield* new ForeignRef({});
    const bounds = yield* Effect.all({
      maxBytes: ContractLimits.get("files.stage.bytes"),
      chunkSize: ContractLimits.get("imap.download.chunk")
    });
    return yield* onMailbox(target, (session) =>
      Effect.gen(function* () {
        const mailbox = yield* examine(session, input.ref.folder);
        if (mailbox.uidValidity !== input.ref.uidValidity)
          return yield* new MailboxReset({ folder: input.ref.folder });
        const fetched = yield* command(session, (client) =>
          client.fetchOne(String(input.ref.uid), { uid: true, bodyStructure: true }, { uid: true })
        );
        if (fetched === false) return yield* new Attachments.MessageNotFound({});
        const structure = readStructure(fetched.bodyStructure);
        const part = Result.isSuccess(structure)
          ? structure.success.parts.find((each) => each.part === input.part)
          : undefined;
        if (part === undefined) return yield* new Attachments.PartNotFound({ part: input.part });
        if (part.contentType === "message/rfc822")
          return yield* new Attachments.NotAFile({ part: input.part });
        const bytes = yield* Attachments.download(session, input.ref.uid, part.part, bounds);
        return {
          bytes,
          // A media type a file can carry, or bytes of no stated kind.
          contentType: isContentType(part.contentType)
            ? part.contentType
            : "application/octet-stream",
          filename: part.filename
        };
      })
    );
  });

const encodeStaged = Schema.encodeEffect(imapStageAttachment.output);
const isStagingRefusal = Schema.is(
  Schema.Union([
    Runtime.TooLarge,
    Runtime.LimitExceeded,
    Runtime.AccessDenied,
    Runtime.SourceUnavailable
  ])
);

/**
 * One part of a message staged as an Upload for the call's viewer, patch and version. The call
 * holds one of the process's attachment places from before its download until the bytes are
 * staged, so the attachments a process buffers at once stay bounded.
 */
export const stageAttachmentAt = <E>(target: Target<E>, input: StageInput) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions.Sessions;
    const staging = yield* FileStaging.FileStaging;
    return yield* sessions.buffered(target.deadline)(
      Effect.gen(function* () {
        const found = yield* downloadAttachment(target, input);
        // The page's staging refusals as they are: the bound, a quota, the viewer. Anything else
        // is Patchy's side being unavailable.
        const staged = yield* staging
          .stage(found.bytes, found.contentType)
          .pipe(
            Effect.mapError((error) =>
              isStagingRefusal(error) ? error : new Runtime.SourceUnavailable({ cause: error })
            )
          );
        yield* WideEvents.add({ stagedBytes: staged.upload.size });
        return yield* encodeStaged({
          ok: true,
          upload: staged.upload,
          size: staged.upload.size,
          sha256: staged.sha256,
          contentType: staged.upload.contentType,
          filename: found.filename
        }).pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
      })
    );
  });

/**
 * The call a loaded version's door admitted, on its declared connection as its viewer. A viewer who
 * may no longer call it, or a connection that stopped working, while the call waited sends nothing.
 */
const admitted = <A, R>(
  connection: string,
  run: (
    target: Target<typeof ViewerRefusal.Type>
  ) => Effect.Effect<
    A,
    | typeof Errors.Type
    | ConnectionStore.ConnectionNotFound
    | ConnectionStore.ConnectionNotConnected,
    R
  >
) =>
  Effect.gen(function* () {
    const binding = yield* Binding.Binding;
    const declaration = binding.manifest.uses[connection];
    if (!Object.hasOwn(binding.manifest.uses, connection) || declaration?.kind !== "imap")
      return yield* new ConnectionNotDeclared({});
    const { identity, principal, companyId } = binding;
    if (
      binding.scope !== "company" ||
      identity === null ||
      principal === null ||
      identity.company.id !== companyId ||
      identity.user.id !== principal.userId
    )
      return yield* new Runtime.AccessDenied({});
    // The caller's own deadline bounds the wait for a gate, so a refused wait is never a timeout.
    const deadline = binding.deadline ?? (yield* Clock.currentTimeMillis) + DEADLINE_MS;
    return yield* run({
      companyId,
      connection: {
        id: declaration.id,
        handle: declaration.handle,
        revision: declaration.revision
      },
      deadline,
      recheck: viewerRecheck(binding)
    });
  }).pipe(
    Effect.catchTags({
      ConnectionNotFound: (cause) => Effect.fail(new Runtime.AccessDenied({ cause })),
      ConnectionNotConnected: (cause) => Effect.fail(new Runtime.AccessDenied({ cause }))
    })
  );
const perform = <K extends ImapRead>(connection: string, name: K, input: Inputs[K]) =>
  admitted(connection, (target) => atMailbox(target, name, input));

const listFolders = operation({
  input: ImapListFolders,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection }: typeof ImapListFolders.Type) => perform(connection, "listFolders", {})
});
const folderStatus = operation({
  input: ImapFolderStatus,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection, ...input }: typeof ImapFolderStatus.Type) =>
    perform(connection, "folderStatus", input)
});
const scanMessages = operation({
  input: ImapScanMessages,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection, ...input }: typeof ImapScanMessages.Type) =>
    perform(connection, "scanMessages", input)
});
const listMessages = operation({
  input: ImapListMessages,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection, ...input }: typeof ImapListMessages.Type) =>
    perform(connection, "listMessages", input)
});
const searchMessages = operation({
  input: ImapSearchMessages,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection, ...input }: typeof ImapSearchMessages.Type) =>
    perform(connection, "searchMessages", input)
});
const getMessages = operation({
  input: ImapGetMessages,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection, ...input }: typeof ImapGetMessages.Type) =>
    perform(connection, "getMessages", input)
});
const stageAttachment = operation({
  input: ImapStageAttachment,
  output: Schema.Json,
  errors: Errors,
  run: ({ connection, ...input }: typeof ImapStageAttachment.Type) =>
    admitted(connection, (target) => stageAttachmentAt(target, input))
});

export const operations = {
  listFolders,
  folderStatus,
  scanMessages,
  listMessages,
  searchMessages,
  getMessages,
  stageAttachment
};

const connectionId = (args: unknown, binding: Binding.Binding["Service"]): string | null => {
  if (
    !Predicate.isObject(args) ||
    typeof args.connection !== "string" ||
    !Object.hasOwn(binding.manifest.uses, args.connection)
  )
    return null;
  const declaration = binding.manifest.uses[args.connection];
  return declaration?.kind === "imap" ? declaration.id : null;
};

/**
 * How a call reads in recent calls: how many folders or messages it answered, and nothing else.
 * Never a folder, a subject, an address, a search value or a body.
 */
const counted = (field: "folders" | "messages") => ({
  resource: (): string | null => null,
  rowCount: (value: unknown): number | null =>
    Predicate.isObject(value) && Array.isArray(value[field]) ? value[field].length : null
});
export const recorded = {
  listFolders: counted("folders"),
  folderStatus: { resource: (): string | null => null, rowCount: (): number | null => null },
  scanMessages: counted("messages"),
  listMessages: counted("messages"),
  searchMessages: counted("messages"),
  getMessages: counted("messages"),
  // Its size and outcome: never the filename or the Upload's token.
  stageAttachment: {
    resource: (): string | null => null,
    rowCount: (): number | null => null,
    bytes: (value: unknown): number | null =>
      Predicate.isObject(value) && typeof value.size === "number" ? value.size : null
  }
} satisfies { readonly [K in ImapRead | "stageAttachment"]: unknown };

/**
 * One read the definition's `live` names, for `patchy dev` through the instance's dev door
 * (ADR-0013): the caller is the door's, never a loaded version's, and the alias stays in the repo.
 */
const devRead = <K extends ImapRead>(
  name: K,
  input: Schema.Decoder<Inputs[K]>
): DevRead<Sessions.Sessions | Cryptography.Cryptography> => {
  const decode = Schema.decodeUnknownEffect(input, { onExcessProperty: "error" });
  return {
    ...recorded[name],
    run: (target, args) =>
      decode(args).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })),
        Effect.flatMap((decoded) => atMailbox(target, name, decoded))
      )
  };
};
export const devReads = {
  "imap.listFolders": devRead("listFolders", imapReads.listFolders.input),
  "imap.folderStatus": devRead("folderStatus", imapReads.folderStatus.input),
  "imap.scanMessages": devRead("scanMessages", imapReads.scanMessages.input),
  "imap.listMessages": devRead("listMessages", imapReads.listMessages.input),
  "imap.searchMessages": devRead("searchMessages", imapReads.searchMessages.input),
  "imap.getMessages": devRead("getMessages", imapReads.getMessages.input)
};

/** Published patches and the dev door share one pool, so a mailbox's gates span them all. */
export const makeHandlers = Effect.gen(function* () {
  const sessions = yield* Sessions.Sessions;
  const connections = yield* ConnectionStore.ConnectionStore;
  const cryptography = yield* Cryptography.Cryptography;
  const staging = yield* FileStaging.FileStaging;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Sessions.Sessions, sessions),
      Effect.provideService(ConnectionStore.ConnectionStore, connections),
      Effect.provideService(Cryptography.Cryptography, cryptography),
      Effect.provideService(FileStaging.FileStaging, staging)
    );
  const handler = <I extends Schema.Top & Schema.Codec<unknown, unknown>>(
    definition: {
      readonly input: I;
      readonly output: typeof Schema.Json;
      readonly run: (
        args: I["Type"]
      ) => Effect.Effect<
        Json,
        Runtime.RuntimeError,
        | Binding.Binding
        | Sessions.Sessions
        | ConnectionStore.ConnectionStore
        | Cryptography.Cryptography
        | FileStaging.FileStaging
      >;
    },
    record: (typeof recorded)[ImapRead | "stageAttachment"]
  ) =>
    Runtime.handler({ kind: "integration", ...definition, ...record, connectionId }, (args) =>
      provide(definition.run(args))
    );
  return {
    "imap.listFolders": handler(listFolders, recorded.listFolders),
    "imap.folderStatus": handler(folderStatus, recorded.folderStatus),
    "imap.scanMessages": handler(scanMessages, recorded.scanMessages),
    "imap.listMessages": handler(listMessages, recorded.listMessages),
    "imap.searchMessages": handler(searchMessages, recorded.searchMessages),
    "imap.getMessages": handler(getMessages, recorded.getMessages),
    "imap.stageAttachment": handler(stageAttachment, recorded.stageAttachment)
  };
});
