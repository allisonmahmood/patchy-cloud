import * as Schema from "effect/Schema";
import { attioReads } from "./attio.js";
import { githubReads } from "./github.js";
import { imapReads, imapStageAttachment } from "./imap.js";
import { ModelsDecideArgs, ModelsDevDeadline, ModelsGenerateArgs } from "./models.js";
import { FileContentType } from "./schemas.js";
import { PidgeonDevRead } from "./pidgeon.js";
import { PostHogDevQuery } from "./posthog.js";

/** Where `patchy dev` sends a read, under the instance's `/api`. */
export const DEV_READ_PATH = "/connections/dev-read";
/** Where `patchy dev` fetches an attachment's bytes, under the instance's `/api`. */
export const DEV_ATTACHMENT_PATH = "/connections/dev-attachment";
/** The response header carrying a dev attachment's `DevAttachmentMeta`, as base64url JSON. */
export const DEV_ATTACHMENT_HEADER = "patchy-attachment";

/**
 * A `patchy dev` read of an integration that dev reads live (ADR-0013). The repo's manifest only
 * routed it to this connection: the machine token decides the company and the person, and the
 * instance checks the connection itself.
 */
const DevReadConnection = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  handle: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  /**
   * The snapshot revision the repo was generated from, for an integration that decodes by it:
   * the instance reads that snapshot of that connection, so a client generated before a Refresh
   * decodes as generated.
   */
  revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))
});

/** What the instance reads before logging the call, so a refused operation or argument is logged too. */
export const DevReadEnvelope = Schema.Struct({
  op: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{0,31}\.[A-Za-z]{1,32}$/)),
  connection: DevReadConnection,
  args: Schema.Unknown,
  /** A model call's remaining action time, in milliseconds; every other read has 15 seconds. */
  deadlineMs: Schema.optionalKey(Schema.Int)
}).annotate({ identifier: "DevReadEnvelope" });
export type DevReadEnvelope = typeof DevReadEnvelope.Type;

/** An Attio read, whose connection carries the revision the repo's client decodes by. */
const attio = <const Name extends keyof typeof attioReads>(name: Name) =>
  Schema.Struct({
    op: Schema.Literal(`attio.${name}`),
    connection: DevReadConnection,
    args: attioReads[name].input
  });

/** An IMAP read: the mailbox as it is now, so the connection needs no revision. */
const imap = <const Name extends keyof typeof imapReads>(name: Name) =>
  Schema.Struct({
    op: Schema.Literal(`imap.${name}`),
    connection: DevReadConnection,
    args: imapReads[name].input
  });

/** A GitHub read: the connection's current set, so the connection needs no revision. */
const github = <const Name extends keyof typeof githubReads>(name: Name) =>
  Schema.Struct({
    op: Schema.Literal(`github.${name}`),
    connection: DevReadConnection,
    args: githubReads[name].input
  });

/**
 * A model call (PROTOTYPE): a real call on the company's provider as the token's person, given
 * what's left of the local action rather than the 15-second integration deadline.
 */
const models = <const Name extends "decide" | "generate", Args extends Schema.Struct.Fields>(
  name: Name,
  args: Schema.Struct<Args>
) =>
  Schema.Struct({
    op: Schema.Literal(`models.${name}`),
    connection: DevReadConnection,
    args,
    deadlineMs: ModelsDevDeadline
  });

/** Every operation an integration lets dev read live, with its exact arguments. Never a write. */
export const DevRead = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("posthog.query"),
    connection: DevReadConnection,
    args: PostHogDevQuery
  }),
  Schema.Struct({
    op: Schema.Literal("pidgeon.read"),
    connection: DevReadConnection,
    args: PidgeonDevRead
  }),
  attio("listRecords"),
  attio("getRecord"),
  attio("getManyRecords"),
  attio("listEntries"),
  attio("getEntry"),
  attio("listMembers"),
  imap("listFolders"),
  imap("folderStatus"),
  imap("scanMessages"),
  imap("listMessages"),
  imap("searchMessages"),
  imap("getMessages"),
  github("listRepos"),
  github("getRepo"),
  github("listWorkflows"),
  github("listRuns"),
  github("getRun"),
  github("listJobs"),
  github("getJobLog"),
  github("listChecks"),
  github("listPulls"),
  github("getPull"),
  github("listPullFiles"),
  github("listPullReviews"),
  models("decide", ModelsDecideArgs),
  models("generate", ModelsGenerateArgs)
]).annotate({ identifier: "DevRead" });
export type DevRead = typeof DevRead.Type;

/**
 * A `patchy dev` attachment: the instance downloads the part as a published stage does and answers
 * its bytes, at most `files.stage.bytes`, for the dev daemon to stage in its own store.
 */
export const DevAttachment = Schema.Struct({
  op: Schema.Literal("imap.stageAttachment"),
  connection: DevReadConnection,
  args: imapStageAttachment.input
}).annotate({ identifier: "DevAttachment" });
export type DevAttachment = typeof DevAttachment.Type;

/** What the instance says of the bytes it answers, so the daemon can tell a cut transfer. */
export const DevAttachmentMeta = Schema.Struct({
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  contentType: FileContentType,
  filename: Schema.NullOr(Schema.String)
});
export type DevAttachmentMeta = typeof DevAttachmentMeta.Type;
