/**
 * An environment's Pidgeon: the developer's test admin key, checked to be a test key before
 * anything is made with it, the test inboxes `up` made with it, recorded in the environment
 * folder with whether their mail all arrived, and the mail `up` delivers to them. `down` and
 * `reset` delete those inboxes before the folder that names them goes. The Pidgeon account is
 * shared, and holds an inbox that isn't the environment's: only an inbox whose name the
 * environment recorded is ever changed or deleted.
 */
import { PidgeonSource } from "@patchy/integrations";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { readPidgeonTestKey } from "./developerEnv.js";

/** What the environment made in Pidgeon isn't all gone, so nothing was removed and its record stays. */
export class PidgeonLeft extends Schema.TaggedError<PidgeonLeft>()("PidgeonLeft", {
  addresses: Schema.Array(Schema.String),
  why: Schema.String
}) {
  override get message() {
    const named = this.addresses.length > 0 ? ` (${this.addresses.join(", ")})` : "";
    return `Nothing was removed: this environment's Pidgeon test inboxes${named} aren't all taken down, because ${this.why}. Fix that and run this again; the environment keeps its record of them until then.`;
  }
}

/** Pidgeon's shared domain, where every environment's inbox is made. */
export const DOMAIN = "pidgeon.email";
const Page = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  next_cursor: Schema.optionalKey(Schema.NullOr(Schema.String))
});
const decodePage = Schema.decodeUnknownOption(Page);
const Inbox = Schema.Struct({ id: Schema.String, address: Schema.String });
const decodeInbox = Schema.decodeUnknownOption(Inbox);
/**
 * One test inbox `up` made: the scenario connection it's for, its name on pidgeon.email, and
 * whether the scenario's mail all arrived in it.
 */
const Entry = Schema.Struct({
  connection: Schema.NullOr(Schema.String),
  localPart: Schema.String,
  seeded: Schema.Boolean
});
export type Entry = typeof Entry.Type;
// A record from before seeding was recorded names each inbox alone.
const decodeRecorded = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Entry])))
);
const encodeRecorded = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Entry)));

const soon = Effect.map(Clock.currentTimeMillis, (now) => now + 15_000);

/** Whether `key` is a Pidgeon test key, by its prefix. Never says the key. */
export const isTestKey = (key: Redacted.Redacted<string>) =>
  PidgeonSource.isTestToken(Redacted.value(key));

/** Every item of one of Pidgeon's lists that `decode` reads; one it can't read is left out. */
const listed = Effect.fn("listed")(function* <A>(
  key: Redacted.Redacted<string>,
  path: string,
  decode: (item: unknown) => Option.Option<A>,
  query: Readonly<Record<string, string | number>> = {}
) {
  const source = yield* PidgeonSource.Source;
  const items: A[] = [];
  let cursor: string | null = null;
  do {
    const answer = yield* source.call(
      key,
      { method: "GET", path, query: { ...query, ...(cursor === null ? {} : { cursor }) } },
      yield* soon
    );
    const page = decodePage(answer.body);
    if (Option.isNone(page)) return yield* new PidgeonSource.Unavailable({ stage: "response" });
    for (const item of page.value.data) {
      const value = decode(item);
      if (Option.isSome(value)) items.push(value.value);
    }
    const next: string | null = page.value.next_cursor ?? null;
    // A cursor that repeats would never end the list.
    cursor = next === cursor ? null : next;
  } while (cursor !== null);
  return items;
});

/**
 * Makes the environment's test inbox `localPart` on pidgeon.email with the test admin key. The
 * name is recorded before this runs, so `down` finds the inbox even when this answer is lost.
 */
export const makeInbox = Effect.fn("makePidgeonInbox")(function* (
  adminKey: Redacted.Redacted<string>,
  localPart: string,
  displayName: string
) {
  const source = yield* PidgeonSource.Source;
  const made = yield* source.call(
    adminKey,
    {
      method: "POST",
      path: "/email/inboxes",
      body: { name: localPart, kind: "agent", display_name: displayName }
    },
    yield* soon
  );
  return yield* Option.match(decodeInbox(made.body), {
    onNone: () => Effect.fail(new PidgeonSource.Unavailable({ stage: "response" })),
    onSome: Effect.succeed
  });
});

/**
 * Takes down what an environment made in Pidgeon, with the test admin key: the inboxes on
 * pidgeon.email named exactly `localParts`. It refuses a key that isn't a test key before anything
 * else, and deletes nothing else. An inbox already gone counts as done; a recorded name Pidgeon
 * has no inbox by comes back as `missing`. Fails, naming the inboxes, when any of it doesn't happen.
 */
export const takeDown = Effect.fn("takeDownPidgeonInboxes")(function* (
  adminKey: Redacted.Redacted<string>,
  localParts: ReadonlyArray<string>
) {
  const left = (why: string) => new PidgeonLeft({ addresses: localParts, why });
  if (!isTestKey(adminKey)) return yield* left("PIDGEON_TEST_ADMIN_KEY isn't a Pidgeon test key");
  const source = yield* PidgeonSource.Source;
  const wanted = new Set(localParts.map((localPart) => `${localPart}@${DOMAIN}`));
  const inboxes = (yield* listed(adminKey, "/email/inboxes", decodeInbox, { limit: 100 }).pipe(
    Effect.mapError((error) => left(`Pidgeon didn't answer (${error.message})`))
  )).filter((inbox) => wanted.has(inbox.address));
  for (const inbox of inboxes)
    yield* Effect.flatMap(soon, (deadline) =>
      source.call(
        adminKey,
        { method: "DELETE", path: `/email/inboxes/${encodeURIComponent(inbox.id)}` },
        deadline
      )
    ).pipe(
      // Gone already: done all the same.
      Effect.catchTags({ PidgeonNotFound: () => Effect.void }),
      Effect.mapError((error) => left(`Pidgeon didn't delete ${inbox.address} (${error.message})`))
    );
  const found = new Set(inboxes.map((inbox) => inbox.address));
  return {
    deleted: inboxes.length,
    missing: localParts.filter((localPart) => !found.has(`${localPart}@${DOMAIN}`))
  };
});

/** What `down` says it did in Pidgeon. */
export const told = (done: {
  readonly deleted: number;
  readonly missing: ReadonlyArray<string>;
}) => [
  ...done.missing.map(
    (localPart) => `  Pidgeon: ${localPart}@${DOMAIN} isn't in Pidgeon any more, or never was.`
  ),
  `  Pidgeon: deleted ${done.deleted} test inbox${done.deleted === 1 ? "" : "es"} this environment made.`
];

const colours = ["slate", "red", "amber", "green", "teal", "blue", "violet", "pink"] as const;
/**
 * Mail a scenario delivers to its test inbox: its labels, then conversations, each delivered as
 * mail from outside, through Pidgeon's `POST /email/test/inbound`, with the desk's replies
 * (`from: "me"`) sent from the inbox and a customer's follow-ups threaded after them, then
 * labelled and moved to its `status`. `hidden` is text a person can't see, which Pidgeon Firewall
 * holds for a person. There are no attachments: test inbound mail carries none.
 */
export const Mail = Schema.Struct({
  labels: Schema.Array(
    Schema.Struct({ name: Schema.NonEmptyString, colour: Schema.Literals(colours) })
  ),
  threads: Schema.Array(
    Schema.Struct({
      subject: Schema.NonEmptyString,
      labels: Schema.optionalKey(Schema.Array(Schema.String)),
      status: Schema.optionalKey(Schema.Literals(["open", "waiting", "resolved", "human_review"])),
      messages: Schema.NonEmptyArray(
        Schema.Struct({
          from: Schema.NonEmptyString,
          text: Schema.NonEmptyString,
          hidden: Schema.optionalKey(Schema.NonEmptyString)
        })
      )
    })
  )
});
export type Mail = typeof Mail.Type;
export const decodeMail = Schema.decodeUnknownEffect(Schema.fromJsonString(Mail));

const Made = Schema.Struct({ id: Schema.String });
const decodeMade = Schema.decodeUnknownOption(Made);
const Delivered = Schema.Struct({
  message_id: Schema.NullOr(Schema.String),
  outcome: Schema.String
});
const decodeDelivered = Schema.decodeUnknownOption(Delivered);
const Message = Schema.Struct({ id: Schema.String, thread_id: Schema.String });
const decodeMessage = Schema.decodeUnknownOption(Message);
const LabelItem = Schema.Struct({ id: Schema.String, name: Schema.String });
const decodeLabels = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.Array(LabelItem) }));
const Received = Schema.Struct({
  data: Schema.Struct({
    message_id: Schema.optionalKey(Schema.String),
    rfc_message_id: Schema.optionalKey(Schema.String)
  })
});
const decodeReceived = Schema.decodeUnknownOption(Received);

/**
 * The scenario's inbox couldn't be made or filled. Its record says its mail didn't all arrive, so
 * the next `up` replaces it, and `down` still takes it down.
 */
export class MailFailed extends Schema.TaggedError<MailFailed>()("PidgeonMailFailed", {
  step: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return `The scenario's Pidgeon mail stopped at ${this.step}. The next \`pnpm dev up\` replaces its inbox with a new one and starts again, and \`pnpm dev down\` takes it down.`;
  }
}

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** `Name <address>`, as mail headers write a sender, or a bare address. */
const sender = (from: string) => {
  const named = /^(.*?)\s*<([^>]+)>$/.exec(from);
  return named === null
    ? { from }
    : { from: named[2]!, ...(named[1]!.trim() === "" ? {} : { from_name: named[1]!.trim() }) };
};

/**
 * Delivers all of `mail` to a test inbox `up` just made, with the test admin key, from the start.
 * Pidgeon doesn't dedupe, so it never runs twice on one inbox: an `up` cut short leaves the inbox
 * recorded unfinished, and the next makes a new one (`readyInbox`). A customer's follow-up names
 * their first message's RFC Message-ID, from the event log, which is what threads it. A 429 is
 * waited out, a few times.
 */
export const deliverMail = Effect.fn("deliverPidgeonMail")(function* (
  adminKey: Redacted.Redacted<string>,
  inbox: { readonly id: string },
  mail: Mail
) {
  const source = yield* PidgeonSource.Source;
  const failed = (step: string) => (cause: unknown) => new MailFailed({ step, cause });
  const call = (step: string, request: PidgeonSource.Request) =>
    Effect.flatMap(soon, (deadline) => source.call(adminKey, request, deadline)).pipe(
      Effect.catchTags({
        PidgeonRateLimited: (limited) =>
          Effect.sleep(Duration.seconds(Math.min(limited.retryAfterSeconds ?? 5, 60))).pipe(
            Effect.andThen(Effect.fail(limited))
          )
      }),
      Effect.retry({ times: 3, while: (error) => error._tag === "PidgeonRateLimited" }),
      Effect.mapError(failed(step))
    );
  const path = `/email/inboxes/${encodeURIComponent(inbox.id)}`;
  const labels = new Map(
    Option.match(
      decodeLabels(
        (yield* call("reading its labels", { method: "GET", path: `${path}/labels` })).body
      ),
      {
        onNone: () => [],
        onSome: (listedLabels) => listedLabels.data.map((label) => [label.name, label.id] as const)
      }
    )
  );
  for (const label of mail.labels) {
    if (labels.has(label.name)) continue;
    const made = decodeMade(
      (yield* call(`label ${label.name}`, {
        method: "POST",
        path: `${path}/labels`,
        body: { name: label.name, colour: label.colour }
      })).body
    );
    if (Option.isNone(made)) return yield* new MailFailed({ step: `label ${label.name}` });
    labels.set(label.name, made.value.id);
  }
  /** The RFC Message-ID Pidgeon gave a received message, as its event log keeps it. */
  const rfcOf = Effect.fnUntraced(function* (messageId: string, step: string) {
    for (let tries = 0; tries < 10; tries++) {
      const events = yield* call(step, {
        method: "GET",
        path: "/events",
        query: { type: "message.received", limit: 100 }
      });
      const page = decodePage(events.body);
      for (const event of Option.isSome(page) ? page.value.data : []) {
        const received = decodeReceived(event);
        if (Option.isSome(received) && received.value.data.message_id === messageId)
          return received.value.data.rfc_message_id;
      }
      yield* Effect.sleep(Duration.seconds(1));
    }
    return undefined;
  });
  let delivered = 0;
  let messages = 0;
  for (const thread of mail.threads) {
    let threadId: string | undefined;
    let last: string | undefined;
    let customer: string | undefined;
    let first: string | undefined;
    for (const [step, message] of thread.messages.entries()) {
      const where = `"${thread.subject}", message ${step + 1}`;
      if (message.from === "me") {
        if (last === undefined || customer === undefined)
          return yield* new MailFailed({ step: `${where}: a reply to nothing` });
        const sent = decodeMessage(
          (yield* call(where, {
            method: "POST",
            path: `${path}/messages`,
            body: {
              to: [customer],
              subject: `Re: ${thread.subject}`,
              text: message.text,
              reply_to: last
            }
          })).body
        );
        if (Option.isNone(sent)) return yield* new MailFailed({ step: where });
        last = sent.value.id;
        threadId ??= sent.value.thread_id;
      } else {
        const from = sender(message.from);
        customer ??= from.from;
        const inReplyTo =
          first === undefined ? undefined : yield* rfcOf(first, `${where}: threading it`);
        if (first !== undefined && inReplyTo === undefined)
          return yield* new MailFailed({ step: `${where}: threading it` });
        const answer = decodeDelivered(
          (yield* call(where, {
            method: "POST",
            path: "/email/test/inbound",
            body: {
              inbox_id: inbox.id,
              ...from,
              subject: step === 0 ? thread.subject : `Re: ${thread.subject}`,
              text: message.text,
              ...(message.hidden === undefined
                ? {}
                : {
                    html: `<p>${escape(message.text)}</p><div style="display:none">${escape(message.hidden)}</div>`
                  }),
              ...(inReplyTo === undefined ? {} : { in_reply_to: inReplyTo })
            }
          })).body
        );
        if (
          Option.isNone(answer) ||
          (answer.value.outcome !== "delivered" && answer.value.outcome !== "held") ||
          answer.value.message_id === null
        )
          return yield* new MailFailed({ step: where });
        last = answer.value.message_id;
        first ??= answer.value.message_id;
        // A held message can't be read, so its conversation can't be named by it.
        if (answer.value.outcome === "delivered" && threadId === undefined) {
          const read = decodeMessage(
            (yield* call(where, {
              method: "GET",
              path: `/email/messages/${encodeURIComponent(answer.value.message_id)}`
            })).body
          );
          if (Option.isNone(read)) return yield* new MailFailed({ step: where });
          threadId = read.value.thread_id;
        }
      }
      messages++;
    }
    if ((thread.labels !== undefined || thread.status !== undefined) && threadId === undefined)
      return yield* new MailFailed({
        step: `"${thread.subject}": a held conversation can't be triaged`
      });
    const conversation = `/email/threads/${encodeURIComponent(threadId ?? "")}`;
    for (const name of thread.labels ?? []) {
      const id = labels.get(name);
      if (id === undefined)
        return yield* new MailFailed({ step: `"${thread.subject}": label ${name}` });
      yield* call(`"${thread.subject}": label ${name}`, {
        method: "POST",
        path: `${conversation}/labels`,
        body: { label_id: id }
      });
    }
    if (thread.status !== undefined)
      yield* call(`"${thread.subject}": ${thread.status}`, {
        method: "PATCH",
        path: conversation,
        body: { status: thread.status }
      });
    delivered++;
  }
  return { conversations: delivered, messages };
});

/** The inboxes recorded in `file`: none when there is no file. */
const recorded = Effect.fn("recordedPidgeon")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return Option.none<ReadonlyArray<Entry>>();
  const read = decodeRecorded(yield* fs.readFileString(file));
  if (Option.isNone(read))
    return yield* new PidgeonLeft({ addresses: [], why: `${file} couldn't be read` });
  return Option.some(
    read.value.map((entry): Entry =>
      typeof entry === "string" ? { connection: null, localPart: entry, seeded: false } : entry
    )
  );
});

/**
 * Writes `entries` as the record: beside the old and renamed over it, so a write cut short never
 * loses what was recorded before.
 */
const write = Effect.fn("writePidgeonRecord")(function* (
  file: string,
  entries: ReadonlyArray<Entry>
) {
  const fs = yield* FileSystem.FileSystem;
  const next = `${file}.next`;
  yield* fs.writeFileString(next, encodeRecorded(entries));
  yield* fs.rename(next, file);
});
const entries = (file: string) =>
  Effect.map(
    recorded(file),
    Option.getOrElse((): ReadonlyArray<Entry> => [])
  );

/** The inbox `up` recorded as `localPart` in `file`: one it made, never one connected by hand. */
export const recordedInbox = Effect.fn("recordedPidgeonInbox")(function* (
  file: string,
  localPart: string
) {
  return Option.fromNullishOr(
    (yield* entries(file)).find((entry) => entry.localPart === localPart)
  );
});

/** Records `entry` in `file`, in place of any entry by its name. */
export const recordInbox = Effect.fn("recordPidgeonInbox")(function* (file: string, entry: Entry) {
  const before = yield* entries(file);
  yield* write(file, [...before.filter((item) => item.localPart !== entry.localPart), entry]);
});

/**
 * The test inbox `up` connects for the scenario's connection `connection`, made and filled before
 * it's connected, so its snapshot holds the scenario's labels. The record says whether its mail
 * all arrived. If so it is used as it is, and nothing is delivered. If not, Patchy can't tell
 * what's there, so the inbox is deleted and a new one made, at a new address since Pidgeon never
 * gives a deleted one out again, and filled from the start. Each inbox is recorded before Pidgeon
 * is asked to make it, so `down` finds it whatever happens next. `delivered` is none when the mail
 * had all arrived before.
 */
export const readyInbox = Effect.fn("readyPidgeonInbox")(function* (input: {
  readonly file: string;
  readonly adminKey: Redacted.Redacted<string>;
  readonly connection: string;
  /** The scenario's name for the inbox; a code of this environment's follows it. */
  readonly localPart: string;
  readonly displayName: string;
  readonly mail: Mail | undefined;
}) {
  const before = (yield* entries(input.file)).find(
    (entry) => entry.connection === input.connection
  );
  if (before?.seeded === true)
    return {
      localPart: before.localPart,
      delivered: Option.none<{ readonly conversations: number; readonly messages: number }>()
    };
  if (before !== undefined) {
    yield* takeDown(input.adminKey, [before.localPart]);
    yield* write(
      input.file,
      (yield* entries(input.file)).filter((entry) => entry.localPart !== before.localPart)
    );
  }
  const localPart = `${input.localPart}-${(yield* Random.next).toString(36).slice(2, 8)}`;
  const entry: Entry = { connection: input.connection, localPart, seeded: false };
  yield* recordInbox(input.file, entry);
  const inbox = yield* makeInbox(input.adminKey, localPart, input.displayName).pipe(
    Effect.mapError((cause) => new MailFailed({ step: "making its inbox", cause }))
  );
  const delivered =
    input.mail === undefined
      ? { conversations: 0, messages: 0 }
      : yield* deliverMail(input.adminKey, inbox, input.mail);
  yield* recordInbox(input.file, { ...entry, seeded: true });
  return { localPart, delivered: Option.some(delivered) };
});

/**
 * For `down` and `reset`: takes down the test inboxes recorded in `file` with the developer's test
 * admin key, then drops the record. Nothing recorded, nothing to do, and no call to Pidgeon.
 */
export const takeDownRecorded = Effect.fn("takeDownRecordedPidgeon")(function* (
  file: string,
  devEnvFile: string
) {
  const localParts = Option.map(yield* recorded(file), (found) =>
    found.map((entry) => entry.localPart)
  );
  if (Option.isNone(localParts) || localParts.value.length === 0) return;
  const adminKey = yield* readPidgeonTestKey(devEnvFile);
  if (Option.isNone(adminKey))
    return yield* new PidgeonLeft({
      addresses: localParts.value,
      why: `there's no PIDGEON_TEST_ADMIN_KEY in the environment or ${devEnvFile}`
    });
  const done = yield* takeDown(adminKey.value, localParts.value).pipe(
    Effect.provide(PidgeonSource.layer)
  );
  for (const line of told(done)) yield* Console.error(line);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(file);
});
