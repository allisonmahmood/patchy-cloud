/**
 * The logged-in sessions IMAP reads borrow, and the gates in front of them. A call first waits
 * for the gates of its mailbox (normalized host and login, so duplicate connections to one mailbox
 * share it), its mail server and this process, within its deadline, and is refused `busy` with
 * nothing sent when they stay full. Each gate admits its waiters in arrival order. Then it checks
 * its caller and connection again and loads the login as it stands, takes an idle session of that
 * exact connection and credential revision or opens one, and checks the caller and connection
 * once more once a new socket is logged in.
 *
 * A call owns its session from the moment it's logged in or taken from the pool until the call
 * settles, interrupted or not. The session goes back to the pool only when the call succeeded or
 * failed on a command that finished; a deadline, an interruption, a refused recheck, a parser
 * error, a byte budget passed or a broken connection destroys it instead. A session that breaks
 * mid-call is retried once on a fresh one, whose own EXAMINE checks UIDVALIDITY again; a refused
 * login never is. Idle sessions log out after `imap.sessions.idle`, and a session whose socket
 * closed or errored is never lent again.
 */
import * as WideEvents from "@patchy/analytics/wide-events";
import { ContractLimits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { ImapFlow, ImapFlowError } from "imapflow";
import * as ImapSource from "./Source.js";

/** Time before a call's deadline it stops waiting for a gate, so a refusal is never a timeout. */
const GATE_RESERVE_MS = 1_000;

/** Patchy's gates for the mailbox, its server or this process stayed full; nothing was sent. */
export class Busy extends Schema.TaggedError<Busy>()("ImapBusy", {
  limitId: Schema.Literals([
    "imap.calls.concurrent",
    "imap.server.concurrent",
    "imap.host.concurrent",
    "imap.attachments.concurrent"
  ])
}) {
  readonly code = "busy" as const;
  readonly status = 503;
  readonly retryAfterSeconds = 1;
  get scope() {
    return registry[this.limitId].scope;
  }
  get value() {
    return registry[this.limitId].default;
  }
  override get message() {
    return this.limitId === "imap.calls.concurrent"
      ? `This mailbox already has ${this.value} reads running from Patchy. Try again shortly.`
      : this.limitId === "imap.server.concurrent"
        ? `This mail server already has ${this.value} reads running from Patchy. Try again shortly.`
        : this.limitId === "imap.attachments.concurrent"
          ? "Patchy is fetching as many attachments as it can right now. Try again shortly."
          : "Patchy is reading as much mail as it can right now. Try again shortly.";
  }
}

/** The session broke while a command was running: its connection closed or stopped answering. */
export class SessionLost extends Schema.TaggedError<SessionLost>()("ImapSessionLost", {
  host: Schema.String,
  cause: Schema.optionalKey(Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true }))
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return `${this.host} closed the connection while Patchy was reading. Try again.`;
  }
}
const isSessionLost = Schema.is(SessionLost);

/** The mail server answered a command NO or BAD; the command finished. */
export class CommandRefused extends Schema.TaggedError<CommandRefused>()("ImapCommandRefused", {
  host: Schema.String,
  answer: Schema.Literals(["NO", "BAD"]),
  cause: Schema.optionalKey(Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true }))
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return this.answer === "BAD"
      ? `${this.host} rejected a command Patchy sent as malformed.`
      : `${this.host} refused a command Patchy sent.`;
  }
}

/** A session lent to one call, which owns it until the call settles. */
export interface Session {
  readonly client: ImapFlow;
  readonly host: string;
  /** Bytes the call has received; past `imap.call.bytes` the session is destroyed. */
  readonly meter: ImapSource.Meter;
}

/**
 * What an ImapFlow command's failure means: a bound the session passed, a refusal the server
 * answered (the command finished), or the session lost.
 */
export const failure = (
  session: Session,
  error: unknown
): ImapSource.Overflow | CommandRefused | SessionLost => {
  const bound = session.meter.overflow ?? ImapSource.parserBound(error);
  if (bound !== undefined) return new ImapSource.Overflow({ host: session.host, limitId: bound });
  const answer = error instanceof Error ? (error as ImapFlowError).responseStatus : undefined;
  if (answer === "NO" || answer === "BAD")
    return new CommandRefused({ host: session.host, answer, cause: Redacted.make(error) });
  return new SessionLost({ host: session.host, cause: Redacted.make(error) });
};

/** What a call needs to borrow a session for one mailbox. */
export interface Lease<E> {
  readonly companyId: string;
  readonly connectionId: string;
  /** The mail server and the login, fixed for the connection's life: what the gates key on. */
  readonly host: string;
  readonly username: string;
  /** When the caller stops waiting, in epoch milliseconds. */
  readonly deadline: number;
  /** Once the call holds its gates: the caller and the connection again, and the login now. */
  readonly admit: Effect.Effect<
    { readonly credentialRevision: number; readonly settings: ImapSource.Settings },
    E
  >;
  /** Once a new session is logged in, before anything else is sent: the caller and connection. */
  readonly opened: Effect.Effect<void, E>;
  /** Whether a call's failure left its last command finished, so its session can go back. */
  readonly reusable: (error: unknown) => boolean;
}

export class Sessions extends Context.Service<
  Sessions,
  {
    /**
     * Runs `use` on a session for the lease's mailbox once the call holds its gates, within its
     * deadline capped at `integration.deadline`.
     */
    readonly lease: <A, E, E2, R>(
      lease: Lease<E>,
      use: (session: Session) => Effect.Effect<A, E2, R>
    ) => Effect.Effect<
      A,
      E | E2 | Busy | SessionLost | ImapSource.OpenError | ImapSource.Timeout,
      R
    >;
    /**
     * Runs `effect` holding one of this process's `imap.attachments.concurrent` places, waited
     * for within `deadline` as the other gates are: what a call buffering an attachment holds
     * from before its download until its bytes are staged or sent.
     */
    readonly buffered: (
      deadline: number
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Busy, R>;
  }
>()("@patchy/integrations/imap/Sessions") {}

interface Entry {
  /** The company and connection it logged in for. */
  readonly key: string;
  readonly revision: number;
  readonly client: ImapFlow;
  readonly host: string;
  readonly meter: ImapSource.Meter;
  readonly scope: Scope.Closeable;
  idle: boolean;
  /** Its socket closed or errored: never lent again. */
  broken: boolean;
  timer: Fiber.Fiber<void> | undefined;
}

/**
 * Permits for calls, handed out in arrival order: a freed permit goes straight to the call that
 * has waited longest, so a waiter never loses a free permit to a call that just arrived.
 */
interface Gate {
  free: number;
  readonly waiting: Array<Waiter>;
}
/** A call waiting at a gate. Once `granted`, the permit is the call's, woken or not. */
interface Waiter {
  granted: boolean;
  wake: (() => void) | undefined;
}

const gate = (gates: Map<string, Gate>, key: string, size: number) => {
  let found = gates.get(key);
  if (found === undefined) {
    found = { free: size, waiting: [] };
    gates.set(key, found);
  }
  return found;
};

const release = (gate: Gate) => {
  const next = gate.waiting.shift();
  if (next === undefined) gate.free++;
  else {
    next.granted = true;
    next.wake?.();
  }
};

export const make = Effect.gen(function* () {
  const source = yield* ImapSource.Source;
  const poolScope = yield* Scope.Scope;
  const limits = yield* Effect.all({
    perMailbox: ContractLimits.get("imap.calls.concurrent"),
    perServer: ContractLimits.get("imap.server.concurrent"),
    perProcess: ContractLimits.get("imap.host.concurrent"),
    attachments: ContractLimits.get("imap.attachments.concurrent"),
    idleMs: ContractLimits.get("imap.sessions.idle"),
    pooled: ContractLimits.get("imap.sessions.pooled"),
    callBytes: ContractLimits.get("imap.call.bytes"),
    deadlineMs: ContractLimits.get("integration.deadline")
  });
  const mailboxes = new Map<string, Gate>();
  const servers = new Map<string, Gate>();
  const everyMailbox: Gate = { free: limits.perProcess, waiting: [] };
  const attachments: Gate = { free: limits.attachments, waiting: [] };
  const idle = new Map<string, Entry[]>();

  /** Closes a session: logs out a clean one, destroys a broken or unfinished one at once. */
  const close = Effect.fn("ImapSessions.close")(function* (entry: Entry, destroy: boolean) {
    const list = idle.get(entry.key);
    if (list !== undefined) {
      const at = list.indexOf(entry);
      if (at !== -1) list.splice(at, 1);
      if (list.length === 0) idle.delete(entry.key);
    }
    entry.idle = false;
    const timer = entry.timer;
    entry.timer = undefined;
    if (timer !== undefined) yield* Fiber.interrupt(timer);
    if (destroy || entry.broken) entry.client.close();
    // Logging out takes a round trip: the pool's scope waits for it, never the caller.
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.forkIn(poolScope));
  });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...idle.values()].flat(), (entry) => close(entry, false), { discard: true })
  );

  /** An idle session of this connection and revision; older revisions' are logged out. */
  const checkout = Effect.fn("ImapSessions.checkout")(function* (key: string, revision: number) {
    for (const entry of [...(idle.get(key) ?? [])].reverse()) {
      if (entry.revision !== revision || entry.broken || !entry.client.usable)
        yield* close(entry, entry.broken);
      else {
        const list = idle.get(key)!;
        list.splice(list.indexOf(entry), 1);
        if (list.length === 0) idle.delete(key);
        entry.idle = false;
        const timer = entry.timer;
        entry.timer = undefined;
        if (timer !== undefined) yield* Fiber.interrupt(timer);
        return Option.some(entry);
      }
    }
    return Option.none<Entry>();
  });

  /** Puts a session back, logging out the oldest past the cap, until it idles out. */
  const giveBack = Effect.fn("ImapSessions.giveBack")(function* (entry: Entry) {
    if (entry.broken || !entry.client.usable) return yield* close(entry, true);
    const list = idle.get(entry.key) ?? [];
    idle.set(entry.key, list);
    list.push(entry);
    entry.idle = true;
    while (list.length > limits.pooled) yield* close(list[0]!, false);
    if (!entry.idle) return;
    entry.timer = yield* Effect.sleep(limits.idleMs).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          entry.timer = undefined;
          return entry.idle ? close(entry, false) : Effect.void;
        })
      ),
      Effect.forkIn(poolScope)
    );
  });

  /**
   * A new logged-in session for these settings, metered for calls. Runs masked: only the login
   * runs under `restore`, and one that doesn't finish logs out of whatever it opened.
   */
  const open = Effect.fn("ImapSessions.open")(function* (
    key: string,
    revision: number,
    settings: ImapSource.Settings,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  ) {
    const scope = Scope.makeUnsafe();
    const meter: ImapSource.Meter = {
      received: 0,
      limit: limits.callBytes,
      limitId: "imap.call.bytes"
    };
    const client = yield* restore(source.open(settings, meter).pipe(Scope.provide(scope))).pipe(
      Effect.onError(() => Scope.close(scope, Exit.void))
    );
    const entry: Entry = {
      key,
      revision,
      client,
      host: settings.host,
      meter,
      scope,
      idle: false,
      broken: false,
      timer: undefined
    };
    // ImapFlow reports a dead session by events; such a session is never lent again.
    client.on("close", () => {
      entry.broken = true;
    });
    client.on("error", () => {
      entry.broken = true;
    });
    return entry;
  });

  /**
   * Runs `effect` holding a permit of `gate`, waiting for one until shortly before the deadline.
   * Only the waiting may be interrupted, never the taking or the giving back: a waiter handed a
   * permit just as it's interrupted passes it on, so an interrupted call never holds one.
   */
  const held =
    (gate: Gate, limitId: Busy["limitId"], deadline: number) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Busy, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (gate.free > 0 && gate.waiting.length === 0) gate.free--;
          else {
            const budget = deadline - GATE_RESERVE_MS - (yield* Clock.currentTimeMillis);
            if (budget <= 0) return yield* new Busy({ limitId });
            const waiter: Waiter = { granted: false, wake: undefined };
            gate.waiting.push(waiter);
            const waited = yield* Effect.exit(
              restore(
                Effect.callback<void>((resume) => {
                  if (waiter.granted) resume(Effect.void);
                  else waiter.wake = () => resume(Effect.void);
                }).pipe(Effect.timeoutOption(budget))
              )
            );
            if (waiter.granted) {
              if (Exit.isFailure(waited)) {
                release(gate);
                return yield* Effect.failCause(waited.cause);
              }
            } else {
              gate.waiting.splice(gate.waiting.indexOf(waiter), 1);
              if (Exit.isFailure(waited)) return yield* Effect.failCause(waited.cause);
              return yield* new Busy({ limitId });
            }
          }
          return yield* restore(effect).pipe(Effect.ensuring(Effect.sync(() => release(gate))));
        })
      );

  const lease: Sessions["Service"]["lease"] = (lease, use) => {
    const key = `${lease.companyId}\u0000${lease.connectionId}`;
    const mailbox = `${lease.host.toLowerCase()}\u0000${lease.username.trim().toLowerCase()}`;
    return Effect.gen(function* () {
      const queued = yield* Clock.currentTimeMillis;
      return yield* held(
        gate(mailboxes, mailbox, limits.perMailbox),
        "imap.calls.concurrent",
        lease.deadline
      )(
        held(
          gate(servers, lease.host.toLowerCase(), limits.perServer),
          "imap.server.concurrent",
          lease.deadline
        )(
          held(
            everyMailbox,
            "imap.host.concurrent",
            lease.deadline
          )(
            Effect.gen(function* () {
              const start = yield* Clock.currentTimeMillis;
              yield* WideEvents.add({ connectionWaitMs: start - queued });
              const admitted = yield* lease.admit;
              const milliseconds = Math.max(1, Math.min(lease.deadline - start, limits.deadlineMs));
              /**
               * One try on a session: an idle one unless `fresh`, else a new one. The try owns the
               * session from the moment it has one, masked so no interruption falls between, and
               * only how it exits decides whether the session goes back or is closed.
               */
              const attempt = (fresh: boolean) =>
                Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    const found = fresh
                      ? Option.none<Entry>()
                      : yield* checkout(key, admitted.credentialRevision);
                    const entry = Option.isSome(found)
                      ? found.value
                      : yield* open(key, admitted.credentialRevision, admitted.settings, restore);
                    entry.meter.received = 0;
                    entry.meter.limit = limits.callBytes;
                    entry.meter.limitId = "imap.call.bytes";
                    delete entry.meter.overflow;
                    return yield* restore(
                      Effect.gen(function* () {
                        yield* WideEvents.enrich({
                          imapSession: Option.isSome(found) ? "pooled" : "opened"
                        });
                        yield* WideEvents.add({ attempts: 1 });
                        if (Option.isNone(found)) yield* lease.opened;
                        return yield* use({
                          client: entry.client,
                          host: entry.host,
                          meter: entry.meter
                        });
                      })
                    ).pipe(
                      Effect.onExit((exit) =>
                        Effect.andThen(
                          WideEvents.add({ responseBytes: entry.meter.received }),
                          Exit.isSuccess(exit) ||
                            Option.exists(Exit.findErrorOption(exit), lease.reusable)
                            ? giveBack(entry)
                            : close(entry, true)
                        )
                      )
                    );
                  })
                );
              // A session that broke mid-call is tried once more on a fresh one.
              return yield* attempt(false).pipe(
                Effect.catchIf(isSessionLost, () => attempt(true)),
                Effect.timeoutOrElse({
                  duration: milliseconds,
                  orElse: () =>
                    Effect.fail(new ImapSource.Timeout({ host: lease.host, milliseconds }))
                })
              );
            })
          )
        )
      );
    });
  };

  const buffered: Sessions["Service"]["buffered"] = (deadline) =>
    held(attachments, "imap.attachments.concurrent", deadline);

  return Sessions.of({ lease, buffered });
});

/** Published patches, the dev door and every connection share one process's pool and gates. */
export const layer = Layer.effect(Sessions, make);
