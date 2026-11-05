/**
 * `pnpm beta-links`: make and follow beta links on one Patchy instance's database, run by an
 * operator with that instance's configuration. It never migrates or seeds: the server's own
 * release creates the table.
 *
 *   pnpm beta-links create --for "<company name>" [--days 30]   a new link's URL, printed once
 *   pnpm beta-links list                                        every link and what became of it
 *   pnpm beta-links resend <id>                                 a new invitation for a lost one
 *   pnpm beta-links revoke <id>                                 end a link, withdraw its invitation
 *
 * Each takes `--json`: `{ "ok": true, ... }` or `{ "ok": false, "error" }`, exit 0 or 1; a flag
 * the parser refuses prints usage and the error instead, and exits 1. All
 * read `DATABASE_URL`; create reads `PATCHY_PUBLIC_BASE_URL` for the address, and resend and
 * revoke read `CLERK_SECRET_KEY`, since they ask Clerk.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Argument, CliConfig, CliOutput, Command, Flag, GlobalFlag } from "effect/cli";
import { InviteMail } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import * as Sql from "@patchy/sql";
import * as BetaLinks from "../src/BetaLinks.js";
import * as Session from "../src/Session.js";

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print one JSON object"),
  Flag.withDefault(false)
);

const day = (date: Date | null) => (date === null ? "-" : date.toISOString().slice(0, 10));

/** A link as `--json` prints it. Emails are whole here: only an operator runs this. */
const shown = (link: BetaLinks.BetaLink, now: number, company?: string | null) => ({
  id: link.id,
  for: link.label,
  state: BetaLinks.state(link, now),
  createdAt: link.createdAt.toISOString(),
  expiresAt: link.expiresAt.toISOString(),
  revokedAt: link.revokedAt?.toISOString() ?? null,
  email: link.email,
  invitedAt: link.invitedAt?.toISOString() ?? null,
  signedInAt: link.signedInAt?.toISOString() ?? null,
  ...(company === undefined ? {} : { company })
});

/** One line per link: what it is for, where it stands, and who it went to. */
const line = (link: BetaLinks.BetaLink, now: number, company: string | null) =>
  [
    link.id,
    link.label,
    BetaLinks.state(link, now),
    link.email ?? "no email yet",
    company === null ? null : `company ${company}`,
    `made ${day(link.createdAt)}, takes an email until ${day(link.expiresAt)}`,
    link.invitedAt === null ? null : `invited ${day(link.invitedAt)}`,
    link.signedInAt === null ? null : `signed in ${day(link.signedInAt)}`,
    link.revokedAt === null ? null : `revoked ${day(link.revokedAt)}`
  ]
    .filter((part) => part !== null)
    .join("  ·  ");

class ClerkUnanswered extends Schema.TaggedError<ClerkUnanswered>()("ClerkUnanswered", {
  id: Schema.String,
  operation: Schema.Literals(["resend", "revoke"])
}) {
  override get message() {
    return this.operation === "revoke"
      ? `Revoked ${this.id}, but Clerk didn't withdraw its invitation. Run revoke again.`
      : `Clerk didn't make a new invitation for ${this.id}. Run resend again.`;
  }
}

/**
 * Prints a command's result, or its failure as one line (JSON with `--json`) and exit 1. A
 * Postgres failure names its cause, such as a table this instance's release doesn't have yet.
 */
const report = <A, E extends { readonly message: string; readonly _tag: string }, R>(
  asJson: boolean,
  command: Effect.Effect<A, E, R>,
  text: (value: A) => string,
  data: (value: A) => object
) =>
  command.pipe(
    Effect.provide(Sql.layer),
    Effect.flatMap((value) =>
      Console.log(asJson ? JSON.stringify({ ok: true, ...data(value) }, null, 2) : text(value))
    ),
    Effect.catch((error) =>
      Effect.gen(function* () {
        const cause = "cause" in error && error.cause instanceof Error ? error.cause.message : "";
        const message = (
          error._tag === "SqlError" && cause !== "" ? `Postgres: ${cause}` : error.message
        ).replace(/\s+/gu, " ");
        yield* asJson
          ? Console.log(JSON.stringify({ ok: false, error: message }))
          : Console.error(message);
        process.exitCode = 1;
      })
    )
  );

const create = Command.make(
  "create",
  {
    label: Flag.String("for").pipe(
      Flag.withDescription(
        "The company's name, which the link's page shows and its company starts with"
      ),
      Flag.withSchema(BetaLinks.Label)
    ),
    days: Flag.Int("days").pipe(
      Flag.withDescription("How many days the link takes an email"),
      Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }))),
      Flag.withDefault(BetaLinks.DEFAULT_DAYS)
    ),
    json
  },
  Effect.fn(function* ({ label, days, json: asJson }) {
    const command = Effect.gen(function* () {
      const base = yield* Session.publicUrlConfig;
      const { link, secret } = yield* BetaLinks.create({ label, days });
      return {
        link,
        url: new URL(`/join/${secret}`, base).href,
        now: yield* Clock.currentTimeMillis
      };
    });
    yield* report(
      asJson,
      command,
      ({ link, url }) =>
        `${link.id} for ${link.label}, takes an email until ${day(link.expiresAt)}\n${url}`,
      ({ link, url, now }) => ({ link: shown(link, now), url })
    );
  })
).pipe(Command.withDescription("Make a link that lets one person past the waitlist"));

const list = Command.make(
  "list",
  { json },
  Effect.fn(function* ({ json: asJson }) {
    const command = Effect.all({ links: BetaLinks.list, now: Clock.currentTimeMillis });
    yield* report(
      asJson,
      command,
      ({ links, now }) =>
        links.length === 0
          ? "No beta links yet."
          : links.map((link) => line(link, now, link.company)).join("\n"),
      ({ links, now }) => ({ links: links.map((link) => shown(link, now, link.company)) })
    );
  })
).pipe(Command.withDescription("Every link, newest first, and what became of each"));

const id = Argument.String("id").pipe(Argument.withDescription("The link's id, bln_..."));

const invitationText: Record<BetaLinks.Outcome["invitation"], string> = {
  sent: "Clerk emailed a new invitation",
  withdrawn: "its invitation is withdrawn",
  accepted: "its person already accepted the invitation and has an account",
  none: "it had no invitation to change",
  unconfirmed:
    "Clerk never confirmed an invitation for it, but may hold one whose answer was lost; to be sure, revoke any pending invitation for its email in Clerk's dashboard",
  failed: "Clerk didn't answer"
};

const resend = Command.make(
  "resend",
  { id, json },
  Effect.fn(function* ({ id, json: asJson }) {
    const command = BetaLinks.resend(id).pipe(
      Effect.filterOrFail(
        ({ invitation }) => invitation !== "failed",
        () => new ClerkUnanswered({ id, operation: "resend" })
      ),
      Effect.provide(InviteMail.layer),
      Effect.zip(Clock.currentTimeMillis)
    );
    yield* report(
      asJson,
      command,
      ([{ link, invitation }, now]) =>
        `${link.id} for ${link.label}: ${invitationText[invitation]}. Now ${BetaLinks.state(link, now)}.`,
      ([{ link, invitation }, now]) => ({ link: shown(link, now), invitation })
    );
  })
).pipe(Command.withDescription("Withdraw a link's invitation and email its address a new one"));

const revoke = Command.make(
  "revoke",
  { id, json },
  Effect.fn(function* ({ id, json: asJson }) {
    const command = BetaLinks.revoke(id).pipe(
      Effect.filterOrFail(
        ({ invitation }) => invitation !== "failed",
        () => new ClerkUnanswered({ id, operation: "revoke" })
      ),
      Effect.provide(InviteMail.layer),
      Effect.zip(Clock.currentTimeMillis)
    );
    yield* report(
      asJson,
      command,
      ([{ link, invitation }, now]) =>
        `${link.id} for ${link.label} is revoked: ${invitationText[invitation]}. Now ${BetaLinks.state(link, now)}.`,
      ([{ link, invitation }, now]) => ({ link: shown(link, now), invitation })
    );
  })
).pipe(
  Command.withDescription("End a link and withdraw its invitation; running it again retries Clerk")
);

Command.make("beta-links").pipe(
  Command.withDescription("Links that let one person each past the waitlist"),
  Command.withSubcommands([create, list, resend, revoke]),
  Command.run({ version: "0.0.0" }),
  Effect.provide([
    NodeCryptography.layer,
    NodeServices.layer,
    CliConfig.layer({ builtIns: [GlobalFlag.Help] }),
    CliOutput.layer({ ...CliOutput.defaultFormatter(), formatError: (error) => error.message })
  ]),
  NodeRuntime.runMain
);
