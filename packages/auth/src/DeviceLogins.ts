// @effect-diagnostics nodeBuiltinImport:off -- Device codes require cryptographic randomness; Effect Random is not a CSPRNG.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Analytics } from "@patchy/analytics";
import { randomToken, sha256 } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as MachineTokens from "./MachineTokens.js";

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

const AnswerError = Schema.Union([DeviceLoginExpired, DeviceLoginAnswered, DeviceLoginUnknown]);
type AnswerError = typeof AnswerError.Type;

const LoginRow = Schema.Struct({
  userCode: Schema.String,
  state: Schema.Literals(["pending", "confirmed", "denied"]),
  machineNameHint: Schema.String,
  oldTokenId: Schema.NullOr(Schema.String),
  userId: Schema.NullOr(Schema.String),
  machineName: Schema.NullOr(Schema.String),
  expiresAt: Schema.Date
});

export const PendingLogin = Schema.Struct({
  state: Schema.Literal("pending"),
  userCode: Schema.String,
  machineNameHint: Schema.String,
  oldMachineName: Schema.NullOr(Schema.String),
  expiresAt: Schema.String
});
export type PendingLogin = typeof PendingLogin.Type;

const AnswerReceipt = Schema.Struct({
  userCode: Schema.String,
  userId: Schema.String,
  state: Schema.Literals(["confirmed", "denied"]),
  expiresAt: Schema.Int,
  signature: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
});
const decodeReceipt = Schema.decodeUnknownOption(Schema.fromJsonString(AnswerReceipt));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(AnswerReceipt));

const PollError = Schema.Union([DeviceLoginExpired, DeviceLoginDenied, DeviceLoginUnknown]);
type PollError = typeof PollError.Type;
const isPollError = Schema.is(PollError);

export type PollResult =
  | { readonly status: "pending" | "slow_down" }
  | {
      readonly status: "complete";
      readonly token: string;
      readonly machine: { readonly id: string; readonly name: string };
      readonly expiresAt: string;
    };

export class DeviceLogins extends Context.Service<
  DeviceLogins,
  {
    readonly start: (input: {
      readonly machineNameHint: string;
      readonly previousMachineTokenId?: string;
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
      userId: string,
      receipt?: string
    ) => Effect.Effect<
      PendingLogin | { readonly state: "confirmed" | "denied"; readonly userCode: string },
      AnswerError | DeviceLoginLookupLimited | SqlError
    >;
    readonly confirm: (input: {
      readonly userCode: string;
      readonly userId: string;
      readonly machineName: string;
    }) => Effect.Effect<
      { readonly receipt: string },
      AnswerError | DeviceLoginLookupLimited | MachineTokens.InvalidMachineName | SqlError
    >;
    readonly deny: (
      userCode: string,
      userId: string
    ) => Effect.Effect<
      { readonly receipt: string },
      AnswerError | DeviceLoginLookupLimited | SqlError
    >;
    readonly poll: (deviceCode: string) => Effect.Effect<PollResult, SqlError | PollError>;
  }
>()("@patchy/auth/DeviceLogins") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tokens = yield* MachineTokens.MachineTokens;
  const limits = yield* Limits.Limits;
  const analytics = yield* Analytics.Analytics;
  // Informational browser receipts survive row consumption, not service restarts.
  // They never authorize a confirmation, denial, or token mint.
  const receiptSecret = randomBytes(32);
  const signReceipt = (receipt: Omit<typeof AnswerReceipt.Type, "signature">) =>
    createHmac("sha256", receiptSecret)
      .update(JSON.stringify([receipt.userCode, receipt.userId, receipt.state, receipt.expiresAt]))
      .digest();
  const issueReceipt = (
    row: typeof LoginRow.Type,
    userId: string,
    state: "confirmed" | "denied"
  ) => {
    const receipt = { userCode: row.userCode, userId, state, expiresAt: row.expiresAt.getTime() };
    return {
      receipt: encodeReceipt({ ...receipt, signature: signReceipt(receipt).toString("hex") })
    };
  };
  const columns = sql`user_code AS "userCode", state, machine_name_hint AS "machineNameHint",
    old_token_id AS "oldTokenId", user_id AS "userId", machine_name AS "machineName",
    expires_at AS "expiresAt"`;
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

  // Page visits leave expired rows for the terminal to consume as expired.
  const readLogin = Effect.fn("DeviceLogins.readLogin")(function* (userCode: string) {
    const found = yield* byUserCode(userCode).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    if (Option.isNone(found)) return yield* new DeviceLoginUnknown({});
    const row = found.value;
    if (row.expiresAt.getTime() <= (yield* Clock.currentTimeMillis)) {
      return yield* new DeviceLoginExpired({});
    }
    return row;
  });
  const readPending = Effect.fn("DeviceLogins.readPending")(function* (userCode: string) {
    const row = yield* readLogin(userCode);
    if (row.state !== "pending") return yield* new DeviceLoginAnswered({});
    return row;
  });

  const start = Effect.fn("DeviceLogins.start")(
    (input: { readonly machineNameHint: string; readonly previousMachineTokenId?: string }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const expires = now + LIFETIME_MS;
          yield* sql`DELETE FROM device_logins WHERE expires_at <= to_timestamp(${now / 1_000})`;
          while (true) {
            let code = "";
            for (let index = 0; index < 8; index++) {
              code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
            }
            const userCode = `${code.slice(0, 4)}-${code.slice(4)}`;
            const deviceCode = randomToken(32);
            const inserted = yield* sql`
            INSERT INTO device_logins (user_code, device_code_hash, state, machine_name_hint,
              old_token_id, expires_at, created_at)
            VALUES (${userCode}, ${sha256(deviceCode)}, 'pending', ${input.machineNameHint},
              (SELECT id FROM machine_tokens WHERE id = ${input.previousMachineTokenId ?? null}),
              to_timestamp(${expires / 1_000}), to_timestamp(${now / 1_000}))
            ON CONFLICT DO NOTHING RETURNING user_code`;
            if (inserted.length !== 0) {
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
      limit: 10,
      window: "1 minute"
    });
    if (!limit.allowed) {
      return yield* new DeviceLoginLookupLimited({ retryAfterSeconds: limit.retryAfterSeconds });
    }
  });

  const lookup = Effect.fn("DeviceLogins.lookup")(function* (
    userCode: string,
    userId: string,
    receipt?: string
  ) {
    yield* consumeLookup(userId);
    if (receipt !== undefined) {
      const decoded = decodeReceipt(receipt);
      if (Option.isSome(decoded)) {
        const proof = decoded.value;
        if (
          proof.userCode === userCode &&
          proof.userId === userId &&
          proof.expiresAt > (yield* Clock.currentTimeMillis) &&
          timingSafeEqual(Buffer.from(proof.signature, "hex"), signReceipt(proof))
        ) {
          return { state: proof.state, userCode };
        }
      }
    }
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* readLogin(userCode);
        if (row.state !== "pending") {
          if (row.userId !== userId) return yield* new DeviceLoginAnswered({});
          return { state: row.state, userCode: row.userCode };
        }
        const old = yield* oldMachine({ id: row.oldTokenId, userId }).pipe(
          Effect.catchTags({ SchemaError: Effect.die })
        );
        return {
          state: "pending" as const,
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
    const row = yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* readPending(input.userCode);
        yield* MachineTokens.validateMachineName(input.machineName);
        yield* sql`
          UPDATE device_logins SET state = 'confirmed', user_id = ${input.userId},
            machine_name = ${input.machineName} WHERE user_code = ${input.userCode}`;
        return row;
      })
    );
    return issueReceipt(row, input.userId, "confirmed");
  });

  const deny = Effect.fn("DeviceLogins.deny")(function* (userCode: string, userId: string) {
    yield* consumeLookup(userId);
    const row = yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* readPending(userCode);
        yield* sql`UPDATE device_logins SET state = 'denied', user_id = ${userId}
          WHERE user_code = ${userCode}`;
        return row;
      })
    );
    return issueReceipt(row, userId, "denied");
  });

  const poll = Effect.fn("DeviceLogins.poll")(function* (deviceCode: string) {
    const hash = sha256(deviceCode);
    const result = yield* sql.withTransaction(
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
          yield* remove;
          return { reply: new DeviceLoginExpired({}) };
        }
        if (row.state === "denied") {
          yield* remove;
          return { reply: new DeviceLoginDenied({}) };
        }
        const limit = yield* limits.consume({
          key: `device-login-poll:${hash}`,
          limit: 1,
          window: "5 seconds"
        });
        if (!limit.allowed) return { reply: { status: "slow_down" } };
        if (row.state === "pending") return { reply: { status: "pending" } };
        if (row.userId === null || row.machineName === null) {
          return yield* Effect.die(new Error("Confirmed device login has no user or machine name"));
        }
        // mint locks and re-reads the user under this transaction, serializing
        // with deactivation; catching its refusal here lets deletion commit.
        const minted = yield* tokens.mint({ userId: row.userId, name: row.machineName }).pipe(
          Effect.catchTags({
            UserUnavailable: () => Effect.succeed(null),
            InvalidMachineName: Effect.die
          })
        );
        if (minted === null) {
          yield* remove;
          return { reply: new DeviceLoginUnknown({}) };
        }
        let replaced = false;
        if (row.oldTokenId !== null) {
          const old = yield* tokens
            .revokeOwned({ id: row.oldTokenId, userId: row.userId })
            .pipe(Effect.catchTags({ MachineTokenNotFound: () => Effect.succeed(null) }));
          // Replacement records re-login succession, not newly performed revocations:
          // an owned expired or already-revoked predecessor still counts.
          replaced = old !== null;
        }
        yield* remove;
        return {
          reply: {
            status: "complete",
            token: minted.token,
            machine: { id: minted.id, name: minted.name },
            expiresAt: minted.expiresAt
          },
          event: {
            name: "token.minted",
            principalId: row.userId,
            properties: { tokenId: minted.id, replaced }
          }
        };
      })
    );
    // Terminal failures are values until the transaction commits their deletion.
    if (isPollError(result.reply)) return yield* result.reply;
    if (result.event) yield* analytics.track(result.event);
    return result.reply;
  });

  return DeviceLogins.of({ start, lookup, confirm, deny, poll });
});

export const layer = Layer.effect(DeviceLogins, make);
