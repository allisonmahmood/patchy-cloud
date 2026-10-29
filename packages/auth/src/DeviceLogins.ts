import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Analytics } from "@patchy/analytics";
import { Cryptography } from "@patchy/core";
import { Limits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import { withReportedCommit } from "@patchy/sql";
import * as MachineTokens from "./MachineTokens.js";
import * as SetupLinks from "./SetupLinks.js";

const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const LIFETIME_MS = 10 * 60 * 1_000;

export class DeviceLoginExpired extends Schema.TaggedError<DeviceLoginExpired>()(
  "DeviceLoginExpired",
  {}
) {
  override get message() {
    return "This device login has expired. Run patchy login again.";
  }
}

export class DeviceLoginDenied extends Schema.TaggedError<DeviceLoginDenied>()(
  "DeviceLoginDenied",
  {}
) {
  override get message() {
    return "This device login was denied.";
  }
}

export class DeviceLoginAnswered extends Schema.TaggedError<DeviceLoginAnswered>()(
  "DeviceLoginAnswered",
  {}
) {
  override get message() {
    return "This device login has already been answered.";
  }
}

export class DeviceLoginUnknown extends Schema.TaggedError<DeviceLoginUnknown>()(
  "DeviceLoginUnknown",
  {}
) {
  override get message() {
    return "This device login is unknown. Run patchy login again.";
  }
}

export class DeviceLoginLookupLimited extends Schema.TaggedError<DeviceLoginLookupLimited>()(
  "DeviceLoginLookupLimited",
  { retryAfterSeconds: Schema.Int }
) {
  override get message() {
    return `Too many device login lookups. Try again in ${this.retryAfterSeconds} seconds.`;
  }
}

/**
 * The Final step panel's line no longer lets this login be answered there: it isn't the person's,
 * was contested, retired or ran out, or binds another login. The link the agent printed still works.
 */
export class SetupLineChanged extends Schema.TaggedError<SetupLineChanged>()(
  "SetupLineChanged",
  {}
) {
  override get message() {
    return "This setup line can no longer answer that login here. Use the link your agent printed.";
  }
}

type AnswerError = DeviceLoginExpired | DeviceLoginAnswered | DeviceLoginUnknown;

const decodeOwnLine = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ machineTokenId: Schema.NullOr(Schema.String) }))
);

const LoginRow = Schema.Struct({
  userCode: Schema.String,
  state: Schema.Literals(["pending", "confirmed", "denied"]),
  machineNameHint: Schema.String,
  oldTokenId: Schema.NullOr(Schema.String),
  userId: Schema.NullOr(Schema.String),
  machineName: Schema.NullOr(Schema.String),
  expiresAt: Schema.Date,
  setupLinkId: Schema.NullOr(Schema.String)
});

export const PendingLogin = Schema.Struct({
  userCode: Schema.String,
  machineNameHint: Schema.String,
  oldMachineName: Schema.NullOr(Schema.String),
  expiresAt: Schema.String
});
export type PendingLogin = typeof PendingLogin.Type;

const PollError = Schema.Union([DeviceLoginExpired, DeviceLoginDenied, DeviceLoginUnknown]);
type PollError = typeof PollError.Type;
const isPollError = Schema.is(PollError);

export type PollResult =
  | { readonly status: "pending" | "slow_down" }
  | {
      readonly status: "complete";
      readonly token: string;
      readonly machine: { readonly id: string; readonly name: string };
      readonly company: { readonly handle: string; readonly name: string };
      readonly user: { readonly email: string };
      readonly expiresAt: string;
    };

export class DeviceLogins extends Context.Service<
  DeviceLogins,
  {
    readonly start: (input: {
      readonly machineNameHint: string;
      readonly previousMachineTokenId?: string;
      /** The `?s=` from the panel's setup line, binding this login to the person's panel. */
      readonly setupLink?: string;
    }) => Effect.Effect<
      {
        readonly deviceCode: string;
        readonly userCode: string;
        readonly interval: 5;
        readonly expiresAt: string;
      },
      SqlError
    >;
    readonly lookup: (
      userCode: string,
      userId: string
    ) => Effect.Effect<PendingLogin, AnswerError | DeviceLoginLookupLimited | SqlError>;
    readonly confirm: (input: {
      readonly userCode: string;
      readonly userId: string;
      readonly machineName: string;
    }) => Effect.Effect<
      void,
      AnswerError | DeviceLoginLookupLimited | MachineTokens.InvalidMachineName | SqlError
    >;
    readonly deny: (
      userCode: string,
      userId: string
    ) => Effect.Effect<void, AnswerError | DeviceLoginLookupLimited | SqlError>;
    /**
     * Confirm from the Final step panel: `confirm`, once the person's own live, uncontested line
     * still binds this login. The same locks in the same order as the mint: the login, the
     * person, then the line.
     */
    readonly confirmInline: (input: {
      readonly userCode: string;
      readonly userId: string;
      readonly machineName: string;
      readonly setupLink: string;
    }) => Effect.Effect<
      void,
      | AnswerError
      | DeviceLoginLookupLimited
      | MachineTokens.InvalidMachineName
      | SetupLineChanged
      | SqlError
    >;
    /**
     * Not me, from the panel, by where the bound login actually is: a pending one is denied, a
     * confirmed one whose terminal hasn't collected its key is cancelled so no key is ever made,
     * and one already minted is reported as connected, for the person to remove on Your agents.
     */
    readonly denyInline: (input: {
      readonly userCode: string;
      readonly userId: string;
      readonly setupLink: string;
    }) => Effect.Effect<
      "denied" | "cancelled" | "connected",
      DeviceLoginLookupLimited | SetupLineChanged | SqlError
    >;
    readonly poll: (deviceCode: string) => Effect.Effect<PollResult, SqlError | PollError>;
  }
>()("@patchy/auth/DeviceLogins") {}

export const make = Effect.gen(function* () {
  const cryptography = yield* Cryptography.Cryptography;
  const sql = yield* SqlClient.SqlClient;
  const tokens = yield* MachineTokens.MachineTokens;
  const limits = yield* Limits.Limits;
  const analytics = yield* Analytics.Analytics;
  const columns = sql`user_code AS "userCode", state, machine_name_hint AS "machineNameHint",
    old_token_id AS "oldTokenId", user_id AS "userId", machine_name AS "machineName",
    expires_at AS "expiresAt", setup_link_id AS "setupLinkId"`;
  const byUserCode = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: LoginRow,
    execute: (userCode) => sql`
      SELECT ${columns} FROM device_logins WHERE user_code = ${userCode} FOR UPDATE`
  });
  const byDeviceCode = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: LoginRow,
    execute: (hash) => sql`
      SELECT ${columns} FROM device_logins WHERE device_code_hash = ${hash} FOR UPDATE`
  });
  const oldMachine = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.NullOr(Schema.String), userId: Schema.String }),
    Result: Schema.Struct({ name: Schema.String }),
    execute: ({ id, userId }) => sql`
      SELECT name FROM machine_tokens WHERE id = ${id} AND user_id = ${userId}`
  });
  // Deactivation and Disconnect everything end each confirmation at or before the user's
  // credentials_ended_at, compared at the database's precision. One a release before
  // confirmed_at left unstamped has no time on that clock, so any ending ends it. The
  // user lock is the one mint and the endings take.
  const confirmationEnded = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ ended: Schema.Boolean }),
    execute: (userCode) => sql`
      SELECT (u.credentials_ended_at >= COALESCE(d.confirmed_at, '-infinity')) IS TRUE AS ended
      FROM device_logins d JOIN users u ON u.id = d.user_id
      WHERE d.user_code = ${userCode} FOR UPDATE OF u`
  });
  const confirmingIdentity = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({
      companyId: Schema.String,
      companyHandle: Schema.String,
      companyName: Schema.String,
      email: Schema.String
    }),
    execute: (userId) => sql`
      SELECT c.id AS "companyId", c.handle AS "companyHandle", c.name AS "companyName", u.email
      FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ${userId}`
  });

  // Page visits leave expired rows for the terminal to consume as expired.
  const readPending = Effect.fn("DeviceLogins.readPending")(function* (userCode: string) {
    const found = yield* byUserCode(userCode).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    if (Option.isNone(found)) return yield* new DeviceLoginUnknown({});
    const row = found.value;
    if (row.expiresAt.getTime() <= (yield* Clock.currentTimeMillis)) {
      return yield* new DeviceLoginExpired({});
    }
    if (row.state !== "pending") return yield* new DeviceLoginAnswered({});
    return row;
  });

  const start = Effect.fn("DeviceLogins.start")(
    (input: {
      readonly machineNameHint: string;
      readonly previousMachineTokenId?: string;
      readonly setupLink?: string;
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const expires = now + LIFETIME_MS;
          // The terminal's hint prefills the name, so it keeps the 64 characters a name may have:
          // a longer one could push the confirmation's Deny past the form's size cap.
          const hint = Array.from(input.machineNameHint).slice(0, 64).join("");
          // Lines whose bound login runs out unanswered end expired before the login goes. The
          // logins lock first, in one order, as every answer locks its login before its line.
          const ran = yield* sql<{ readonly setup_link_id: string | null }>`
            SELECT setup_link_id FROM device_logins
            WHERE expires_at <= to_timestamp(${now / 1_000})
            ORDER BY user_code FOR UPDATE`;
          yield* SetupLinks.expired(
            ran.flatMap((row) => (row.setup_link_id === null ? [] : [row.setup_link_id]))
          ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          yield* sql`DELETE FROM device_logins WHERE expires_at <= to_timestamp(${now / 1_000})`;
          while (true) {
            const code = yield* cryptography.randomString(CODE_ALPHABET, 8);
            const userCode = `${code.slice(0, 4)}-${code.slice(4)}`;
            const deviceCode = yield* cryptography.token(32);
            const inserted = yield* sql`
            INSERT INTO device_logins (user_code, device_code_hash, state, machine_name_hint,
              old_token_id, expires_at, created_at)
            VALUES (${userCode}, ${yield* cryptography.sha256(deviceCode)}, 'pending', ${hint},
              (SELECT id FROM machine_tokens WHERE id = ${input.previousMachineTokenId ?? null}),
              to_timestamp(${expires / 1_000}), to_timestamp(${now / 1_000}))
            ON CONFLICT DO NOTHING RETURNING user_code`;
            if (inserted.length !== 0) {
              // The first login a live setup line starts binds to it; a later one contests it.
              const link = SetupLinks.parse(input.setupLink);
              if (
                link !== null &&
                (yield* SetupLinks.bind(link, userCode).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql)
                ))
              )
                yield* sql`UPDATE device_logins SET setup_link_id = ${link}
                  WHERE user_code = ${userCode}`;
              return {
                deviceCode,
                userCode,
                interval: 5 as const,
                expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expires))
              };
            }
          }
        })
      )
  );

  const consumeLookup = Effect.fn("DeviceLogins.consumeLookup")(function* (userId: string) {
    const limit = yield* limits.consume({
      key: `device-login-lookup:${userId}`,
      limit: registry["rate.deviceLookup.perMinute"].default,
      window: "1 minute"
    });
    if (!limit.allowed) {
      return yield* new DeviceLoginLookupLimited({ retryAfterSeconds: limit.retryAfterSeconds });
    }
  });

  const lookup = Effect.fn("DeviceLogins.lookup")(function* (userCode: string, userId: string) {
    yield* consumeLookup(userId);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* readPending(userCode);
        const old = yield* oldMachine({ id: row.oldTokenId, userId }).pipe(
          Effect.catchTags({ SchemaError: Effect.die })
        );
        return {
          userCode: row.userCode,
          machineNameHint: row.machineNameHint,
          oldMachineName: Option.isSome(old) ? old.value.name : null,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(row.expiresAt))
        };
      })
    );
  });

  const confirm = Effect.fn("DeviceLogins.confirm")(function* (input: {
    readonly userCode: string;
    readonly userId: string;
    readonly machineName: string;
  }) {
    yield* consumeLookup(input.userId);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* readPending(input.userCode);
        yield* MachineTokens.validateMachineName(input.machineName);
        // Under the user lock the endings take, and on the database's clock they stamp
        // with: a confirmation that commits before an ending is always older than it.
        yield* sql`SELECT id FROM users WHERE id = ${input.userId} FOR SHARE`;
        yield* sql`
          UPDATE device_logins SET state = 'confirmed', user_id = ${input.userId},
            machine_name = ${input.machineName}, confirmed_at = clock_timestamp()
          WHERE user_code = ${input.userCode}`;
      })
    );
  });

  const ownLine = (setupLink: string, userId: string, userCode: string) =>
    sql`
      SELECT machine_token_id AS "machineTokenId" FROM setup_links
      WHERE id = ${setupLink} AND user_id = ${userId} AND user_code = ${userCode}
      FOR UPDATE`.pipe(
      Effect.flatMap(decodeOwnLine),
      Effect.catchTags({ SchemaError: Effect.die })
    );

  const confirmInline = Effect.fn("DeviceLogins.confirmInline")(function* (input: {
    readonly userCode: string;
    readonly userId: string;
    readonly machineName: string;
    readonly setupLink: string;
  }) {
    yield* consumeLookup(input.userId);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* readPending(input.userCode);
        yield* MachineTokens.validateMachineName(input.machineName);
        yield* sql`SELECT id FROM users WHERE id = ${input.userId} FOR SHARE`;
        // Lock the line, then check it: the wait for its lock can outlast the line, and now()
        // stays at the transaction's start.
        yield* sql`SELECT 1 FROM setup_links WHERE id = ${input.setupLink} FOR UPDATE`;
        const line = yield* sql`
          SELECT 1 FROM setup_links
          WHERE id = ${input.setupLink} AND user_id = ${input.userId}
            AND user_code = ${input.userCode} AND outcome = 'pending'
            AND retired_at IS NULL AND expires_at > clock_timestamp()`;
        if (line.length === 0 || row.setupLinkId !== input.setupLink)
          return yield* new SetupLineChanged({});
        yield* sql`
          UPDATE device_logins SET state = 'confirmed', user_id = ${input.userId},
            machine_name = ${input.machineName}, confirmed_at = clock_timestamp()
          WHERE user_code = ${input.userCode}`;
      })
    );
  });

  const denyInline = Effect.fn("DeviceLogins.denyInline")(function* (input: {
    readonly userCode: string;
    readonly userId: string;
    readonly setupLink: string;
  }) {
    yield* consumeLookup(input.userId);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const found = yield* byUserCode(input.userCode).pipe(
          Effect.catchTags({ SchemaError: Effect.die })
        );
        const [line] = yield* ownLine(input.setupLink, input.userId, input.userCode);
        if (line === undefined) return yield* new SetupLineChanged({});
        const endLine = sql`UPDATE setup_links SET outcome = 'denied'
          WHERE id = ${input.setupLink} AND outcome = 'pending'`;
        const login =
          Option.isSome(found) && found.value.setupLinkId === input.setupLink
            ? found.value
            : undefined;
        if (login === undefined) {
          // The login is gone: its key was collected, or it expired or was denied.
          if (line.machineTokenId !== null) return "connected" as const;
          yield* endLine;
          return "denied" as const;
        }
        if (login.state === "confirmed") {
          // Confirmed but not collected: deleting it means the terminal's next poll finds nothing.
          yield* sql`DELETE FROM device_logins WHERE user_code = ${input.userCode}`;
          yield* endLine;
          return "cancelled" as const;
        }
        if (login.state === "pending")
          yield* sql`UPDATE device_logins SET state = 'denied' WHERE user_code = ${input.userCode}`;
        yield* endLine;
        return "denied" as const;
      })
    );
  });

  const deny = Effect.fn("DeviceLogins.deny")(function* (userCode: string, userId: string) {
    yield* consumeLookup(userId);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* readPending(userCode);
        yield* sql`UPDATE device_logins SET state = 'denied' WHERE user_code = ${userCode}`;
        if (row.setupLinkId !== null)
          yield* SetupLinks.denied(row.setupLinkId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql)
          );
      })
    );
  });

  const poll = Effect.fn("DeviceLogins.poll")(function* (deviceCode: string) {
    const hash = yield* cryptography.sha256(deviceCode);
    // The mint reports with its commit, so a poll interrupted then still reports it.
    const result = yield* withReportedCommit(
      Effect.gen(function* (): Effect.fn.Return<
        { readonly reply: PollResult | PollError; readonly event?: Analytics.AnalyticsEvent },
        SqlError
      > {
        // Lock before limiting: the poll that loses a completed row answers unknown,
        // not slow_down, even when both requests arrived in the same interval.
        const found = yield* byDeviceCode(hash).pipe(Effect.catchTags({ SchemaError: Effect.die }));
        if (Option.isNone(found)) {
          return { reply: new DeviceLoginUnknown({}) };
        }
        const row = found.value;
        const remove = sql`DELETE FROM device_logins WHERE user_code = ${row.userCode}`;
        if (row.expiresAt.getTime() <= (yield* Clock.currentTimeMillis)) {
          if (row.setupLinkId !== null)
            yield* SetupLinks.expired([row.setupLinkId]).pipe(
              Effect.provideService(SqlClient.SqlClient, sql)
            );
          yield* remove;
          return { reply: new DeviceLoginExpired({}) };
        }
        if (row.state === "denied") {
          yield* remove;
          return { reply: new DeviceLoginDenied({}) };
        }
        const limit = yield* limits.consume({
          key: `device-login-poll:${hash}`,
          limit: registry["rate.devicePoll.attempts"].default,
          window: registry["rate.devicePoll.window"].default
        });
        if (!limit.allowed) return { reply: { status: "slow_down" } };
        if (row.state === "pending") return { reply: { status: "pending" } };
        if (row.userId === null || row.machineName === null) {
          return yield* Effect.die(new Error("Confirmed device login has no user or machine name"));
        }
        // An ending either committed before this locked read or waits, then revokes this mint.
        const { ended } = yield* confirmationEnded(row.userCode).pipe(
          Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die })
        );
        // mint re-reads the user and refuses a deactivated one; catching its refusal
        // here lets deletion commit.
        const minted = ended
          ? null
          : yield* tokens.mint({ userId: row.userId, name: row.machineName }).pipe(
              Effect.catchTags({
                UserUnavailable: () => Effect.succeed(null),
                InvalidMachineName: Effect.die
              })
            );
        if (minted === null) {
          yield* remove;
          return { reply: new DeviceLoginUnknown({}) };
        }
        // mint's user lock remains held until this receipt and the token commit together.
        const identity = yield* confirmingIdentity(row.userId).pipe(
          Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die })
        );
        let replaced = false;
        if (row.oldTokenId !== null) {
          const old = yield* tokens
            .revokeOwned({ id: row.oldTokenId, userId: row.userId })
            .pipe(Effect.catchTags({ MachineTokenNotFound: () => Effect.succeed(null) }));
          // Replacement records re-login succession, not newly performed revocations:
          // an owned expired or already-revoked predecessor still counts.
          replaced = old !== null;
        }
        const setupId =
          row.setupLinkId === null
            ? Option.none()
            : yield* SetupLinks.minted({
                linkId: row.setupLinkId,
                tokenId: minted.id,
                userId: row.userId
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        yield* remove;
        return {
          reply: {
            status: "complete",
            token: minted.token,
            machine: { id: minted.id, name: minted.name },
            company: { handle: identity.companyHandle, name: identity.companyName },
            user: { email: identity.email },
            expiresAt: minted.expiresAt
          },
          event: {
            name: "token.minted",
            principalId: row.userId,
            companyId: identity.companyId,
            properties: {
              tokenId: minted.id,
              replaced,
              ...(Option.isSome(setupId) ? { setupId: setupId.value } : {}),
              ...(yield* Analytics.CurrentCli)
            }
          }
        };
      }),
      (result) => (result.event === undefined ? Effect.void : analytics.track(result.event))
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    // Terminal failures are values until the transaction commits their deletion.
    if (isPollError(result.reply)) return yield* result.reply;
    return result.reply;
  });

  return DeviceLogins.of({ start, lookup, confirm, deny, confirmInline, denyInline, poll });
});

export const layer = Layer.effect(DeviceLogins, make);
