import { decodeError } from "./clientError.js";

/**
 * One Pidgeon inbox's client, the same on a tier 1 page and in a tier 2 action. Patchy writes
 * every Pidgeon request and fills in the inbox, so these methods can't name another one. A
 * connection that only reads gets no write methods; one forced past its types is refused. These
 * types mirror `packages/api/src/pidgeon.ts`, the wire they decode.
 */

export type PidgeonThreadStatus = "open" | "waiting" | "resolved" | "human_review";
/** The one folder a conversation is in. */
export type PidgeonFolder = "inbox" | "archive" | "spam" | "trash";
export interface PidgeonParty {
  readonly email: string;
  readonly name: string | null;
}
export interface PidgeonLabel {
  readonly id: string;
  readonly name: string;
  readonly colour: string;
}
export interface PidgeonThread {
  readonly id: string;
  /** Null while every message in it is held for a person. */
  readonly subject: string | null;
  /** Pidgeon's triage state, shared by everyone who reads the inbox. */
  readonly status: PidgeonThreadStatus;
  readonly folder: PidgeonFolder;
  readonly labels: readonly PidgeonLabel[];
  readonly messageCount: number;
  readonly unreadCount: number;
  readonly lastMessageAt: string | null;
  readonly createdAt: string;
}
/**
 * Pidgeon Firewall's reading of mail: `suspicious` when it tries to steer an AI, imitates a sender
 * or asks for secrets out, with the kinds of what it found. Show it to people.
 */
export interface PidgeonFirewall {
  readonly verdict: "clean" | "suspicious";
  readonly kinds: readonly string[];
}
/** A file a message carried: its metadata only. */
export interface PidgeonAttachment {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  /** Bytes. */
  readonly size: number;
}
export interface PidgeonMessage {
  readonly id: string;
  readonly threadId: string;
  readonly from: PidgeonParty;
  readonly to: readonly PidgeonParty[];
  readonly cc: readonly PidgeonParty[];
  readonly subject: string | null;
  readonly createdAt: string;
  /** Test-mode mail: it never left Pidgeon. */
  readonly test: boolean;
  /**
   * Pidgeon Firewall holds it for a person: its subject, text and attachments stay empty, and it
   * can't be read by id or answered until someone releases it in Pidgeon.
   */
  readonly held: boolean;
  /** Plain text, cleaned by the firewall. Visible instructions aimed at an AI stay in it. */
  readonly text: string;
  /** Null on mail this inbox sent. */
  readonly firewall: PidgeonFirewall | null;
  readonly attachments: readonly PidgeonAttachment[];
}
export interface PidgeonSearchHit {
  readonly messageId: string;
  readonly threadId: string;
  readonly from: PidgeonParty;
  readonly to: readonly string[];
  readonly subject: string | null;
  /** The first 200 characters of the firewall's clean text. */
  readonly preview: string | null;
  readonly hasAttachments: boolean;
  readonly held: boolean;
  readonly createdAt: string;
}
/**
 * What became of one email. Read `status` before treating it as sent: `held` means Pidgeon was
 * keeping it for a member of the account to approve when Patchy last looked, and sending the same
 * draft again looks again.
 */
export interface PidgeonSent {
  readonly status: "sent" | "held";
  readonly messageId: string;
  readonly threadId: string;
  /** This draft key was sent before: its answer, and nothing went out again. */
  readonly replayed: boolean;
}
/**
 * Names one email from when the person starts writing it until a send answers: `crypto.randomUUID()`
 * fits. 8 to 128 of `A–Z a–z 0–9 _ -`. Patchy sends each key's email at most once.
 */
export interface PidgeonDraft {
  readonly idempotencyKey: string;
}

export interface PidgeonReader {
  readonly threads: {
    /** The inbox's conversations, newest first. */
    list(options?: {
      readonly status?: PidgeonThreadStatus;
      readonly folder?: PidgeonFolder;
      readonly labelId?: string;
      readonly limit?: number;
      readonly cursor?: string;
    }): Promise<{ readonly threads: readonly PidgeonThread[]; readonly nextCursor: string | null }>;
    /** One conversation, its labels and a page of its messages, oldest first. */
    get(
      id: string,
      options?: { readonly cursor?: string }
    ): Promise<{
      readonly thread: PidgeonThread;
      readonly labels: readonly PidgeonLabel[];
      readonly messages: readonly PidgeonMessage[];
      readonly nextCursor: string | null;
    }>;
  };
  readonly messages: {
    /** One message; a held one answers `not_found`. */
    get(id: string): Promise<PidgeonMessage>;
    /**
     * The inbox's mail by words, newest first: plain words, `"phrases"`, `or` and `-word`, 1 to
     * 200 characters. Held mail is never found.
     */
    search(options: {
      readonly text: string;
      readonly limit?: number;
      readonly cursor?: string;
    }): Promise<{ readonly hits: readonly PidgeonSearchHit[]; readonly nextCursor: string | null }>;
  };
  readonly labels: { list(): Promise<readonly PidgeonLabel[]> };
}
export interface PidgeonSender extends PidgeonReader {
  readonly threads: PidgeonReader["threads"] & {
    update(id: string, change: { readonly status: PidgeonThreadStatus }): Promise<PidgeonThread>;
    /** The thread's labels after the change. */
    label(id: string, labelId: string): Promise<readonly PidgeonLabel[]>;
    unlabel(id: string, labelId: string): Promise<readonly PidgeonLabel[]>;
  };
  readonly messages: PidgeonReader["messages"] & {
    /** Answers a message in its thread: its sender, or, for one this inbox sent, its recipients. */
    reply(
      id: string,
      draft: { readonly text: string; readonly cc?: readonly string[] } & PidgeonDraft
    ): Promise<PidgeonSent>;
    /** A new conversation from the inbox. */
    send(
      draft: {
        readonly to: string | readonly string[];
        readonly cc?: readonly string[];
        readonly subject: string;
        readonly text: string;
      } & PidgeonDraft
    ): Promise<PidgeonSent>;
  };
}

type Call = (
  op: "pidgeon.read" | "pidgeon.write",
  args: { readonly connection: string; readonly operation: string; readonly input: object }
) => Promise<unknown>;

/** The broker refuses an option set to undefined, so those are left out, as JSON would. */
const defined = (input: object) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

export function createPidgeonClient(connection: string, call: Call, access: "read"): PidgeonReader;
export function createPidgeonClient(connection: string, call: Call, access: "send"): PidgeonSender;
export function createPidgeonClient(
  connection: string,
  call: Call,
  access: "read" | "send"
): PidgeonReader | PidgeonSender {
  const invoke = async <A>(
    op: "pidgeon.read" | "pidgeon.write",
    operation: string,
    input: object
  ): Promise<A> => {
    let value: unknown;
    try {
      value = await call(op, { connection, operation, input: defined(input) });
    } catch (error) {
      throw decodeError(error, op) ?? error;
    }
    const error = decodeError(value, op);
    if (error) throw error;
    // The host encodes each result through its own wire schema.
    return value as A;
  };
  const read = <A>(operation: string, input: object = {}) =>
    invoke<A>("pidgeon.read", operation, input);
  const write = <A>(operation: string, input: object) =>
    invoke<A>("pidgeon.write", operation, input);
  type Labels = { readonly labels: readonly PidgeonLabel[] };
  const reader: PidgeonReader = {
    threads: {
      list: (options = {}) => read("threads.list", options),
      get: (id, options = {}) => read("threads.get", { ...options, id })
    },
    messages: {
      get: (id) => read("messages.get", { id }),
      search: (options) => read("messages.search", options)
    },
    labels: { list: async () => (await read<Labels>("labels.list")).labels }
  };
  if (access === "read") return reader;
  const sender: PidgeonSender = {
    threads: {
      ...reader.threads,
      update: (id, change) => write("threads.update", { id, status: change.status }),
      label: async (id, labelId) => (await write<Labels>("threads.label", { id, labelId })).labels,
      unlabel: async (id, labelId) =>
        (await write<Labels>("threads.unlabel", { id, labelId })).labels
    },
    messages: {
      ...reader.messages,
      reply: (id, { text, cc, idempotencyKey }) =>
        write("messages.reply", { id, text, cc, idempotencyKey }),
      send: ({ to, cc, subject, text, idempotencyKey }) =>
        write("messages.send", {
          to: typeof to === "string" ? [to] : to,
          cc,
          subject,
          text,
          idempotencyKey
        })
    },
    labels: reader.labels
  };
  return sender;
}
