import { decodeError } from "./clientError.js";

/**
 * One Pidgeon address's client, the same on a tier 1 page and in a tier 2 action. Patchy writes
 * every Pidgeon request and fills in the address, so these methods can't name another one. A
 * connection whose key only reads gets no write methods; one forced past its types is refused.
 * These types mirror `packages/api/src/pidgeon.ts`, the wire they decode.
 */

export type PidgeonThreadStatus = "open" | "waiting" | "resolved" | "human_review";
export interface PidgeonParty {
  readonly email: string;
  readonly name: string | null;
}
export interface PidgeonThread {
  readonly id: string;
  readonly subject: string | null;
  /** Pidgeon's triage state, shared by everyone who reads the address. */
  readonly status: PidgeonThreadStatus;
  /** Who sent the newest message. */
  readonly from: PidgeonParty | null;
  /** The first line of the newest message. */
  readonly preview: string | null;
  readonly messageCount: number;
  readonly hasAttachments: boolean;
  readonly lastMessageAt: string | null;
  readonly createdAt: string;
}
export interface PidgeonLabel {
  readonly id: string;
  readonly name: string;
  readonly colour: string;
}
/**
 * Pidgeon Firewall's reading of mail: `suspicious` when it tries to steer an AI, imitates a sender
 * or asks for secrets out, with the kinds of what it found. Show it to people.
 */
export interface PidgeonFirewall {
  readonly verdict: "clean" | "suspicious";
  readonly kinds: readonly string[];
}
export interface PidgeonAttachment {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  /** Bytes. */
  readonly size: number;
}
/** What happened to mail the address sent: the worst any recipient reached, such as `bounced`. */
export interface PidgeonDelivery {
  readonly state: string;
  readonly deliveredAt: string | null;
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
   * can't be read or answered until someone releases it in Pidgeon.
   */
  readonly held: boolean;
  /** Plain text, cleaned by the firewall. Visible instructions aimed at an AI stay in it. */
  readonly text: string;
  /** Null on mail this address sent. */
  readonly firewall: PidgeonFirewall | null;
  readonly attachments: readonly PidgeonAttachment[];
  /** Null on mail that arrived, and on a send nobody has reported on yet. */
  readonly delivery: PidgeonDelivery | null;
}
export interface PidgeonSearchHit {
  readonly messageId: string;
  readonly threadId: string;
  readonly from: PidgeonParty;
  readonly to: readonly string[];
  readonly subject: string | null;
  readonly preview: string | null;
  readonly hasAttachments: boolean;
  readonly held: boolean;
  readonly createdAt: string;
}
export interface PidgeonAttachmentText {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  /** Cleaned by the firewall. */
  readonly text: string;
  /** The file ran past 200,000 characters and the rest was cut. */
  readonly truncated: boolean;
  readonly firewall: PidgeonFirewall | null;
}
/**
 * What Pidgeon did with one email. Read `status` before treating it as sent: `pending_approval`
 * sent nothing, and waits as a draft for a person to approve in Pidgeon.
 */
export type PidgeonSent =
  | {
      readonly status: "sent";
      readonly messageId: string;
      readonly threadId: string;
      /** Recipients the mail provider refused; the rest were sent to. */
      readonly rejected: readonly { readonly address: string; readonly reason: string }[];
      /** This draft was sent before: the first send's answer, and nothing went out again. */
      readonly replayed: boolean;
      /** A test-mode send: it never left Pidgeon. */
      readonly test: boolean;
    }
  | {
      readonly status: "pending_approval";
      readonly draftId: string;
      readonly threadId: string;
      readonly approval: {
        /**
         * `first_contact`: the address asks a person before writing to someone new.
         * `risky_thread`: mail in the conversation tried to give the agent instructions.
         */
        readonly reason: "first_contact" | "risky_thread";
        /** It expires unsent at this time if nobody decides. */
        readonly expiresAt: string;
      };
      readonly replayed: boolean;
      readonly test: boolean;
    };
/**
 * Names one email from when the person starts writing it until it sends: `crypto.randomUUID()`
 * fits. 8 to 128 of `A–Z a–z 0–9 _ -`. Sending the same draft again within 24 hours is one email.
 */
export interface PidgeonDraft {
  readonly idempotencyKey: string;
}

export interface PidgeonReader {
  readonly threads: {
    /** The address's conversations, newest first. */
    list(options?: {
      readonly status?: PidgeonThreadStatus;
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
    get(id: string): Promise<PidgeonMessage>;
    /** The address's mail by relevance, through Pidgeon's 1,000 best matches. */
    search(options?: {
      readonly text?: string;
      readonly from?: string;
      readonly to?: string;
      readonly labelId?: string;
      readonly hasAttachment?: boolean;
      readonly folder?: "inbox" | "sent" | "archive" | "spam";
      readonly limit?: number;
      readonly cursor?: string;
    }): Promise<{ readonly hits: readonly PidgeonSearchHit[]; readonly nextCursor: string | null }>;
  };
  readonly labels: { list(): Promise<readonly PidgeonLabel[]> };
  readonly attachments: {
    /** A text attachment's contents, cleaned by the firewall. Other files are metadata only. */
    text(id: string): Promise<PidgeonAttachmentText>;
  };
}
export interface PidgeonSender extends PidgeonReader {
  readonly threads: PidgeonReader["threads"] & {
    update(id: string, change: { readonly status: PidgeonThreadStatus }): Promise<PidgeonThread>;
    /** The thread's labels after the change. */
    label(id: string, labelId: string): Promise<readonly PidgeonLabel[]>;
    unlabel(id: string, labelId: string): Promise<readonly PidgeonLabel[]>;
  };
  readonly messages: PidgeonReader["messages"] & {
    /** Answers the message's sender in its thread. */
    reply(
      id: string,
      draft: { readonly text: string; readonly cc?: readonly string[] } & PidgeonDraft
    ): Promise<PidgeonSent>;
    /** A new conversation from the address; its send policy may refuse it whole. */
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
      search: (options = {}) => read("messages.search", options)
    },
    labels: { list: async () => (await read<Labels>("labels.list")).labels },
    attachments: { text: (id) => read("attachments.text", { id }) }
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
    labels: reader.labels,
    attachments: reader.attachments
  };
  return sender;
}
