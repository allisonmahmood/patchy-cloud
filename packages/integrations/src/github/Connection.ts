import { GithubAccount } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as CredentialKeys from "../CredentialKeys.js";

/**
 * What one GitHub connection is: a set of repositories, by id, on one account's installation of
 * the App. Its sealed credentials hold the installation and the repository ids a token is minted
 * for; its display holds what the pages show and what a call looks a repository's name up in.
 * Both change together, and every change bumps the credential revision.
 */

const Name = Schema.String.check(Schema.isMaxLength(100));

/** One repository in a connection's current set. `left` marks one gone from the installation. */
export const Repository = Schema.Struct({
  id: Schema.Int,
  name: Name,
  private: Schema.Boolean,
  left: Schema.optionalKey(Schema.Literal(true))
});
export type Repository = typeof Repository.Type;

/**
 * Why Patchy paused a connection, to be fixed by an admin: the App was uninstalled, so a
 * Reconnect after reinstalling, or the installation no longer grants exactly what Patchy reads.
 * `by` is the admin whose Test, Refresh or Resume found it; a patch's call names nobody.
 */
export const Attention = Schema.Struct({
  reason: Schema.Literals(["uninstalled", "permissions"]),
  at: Schema.String,
  during: Schema.Literals(["call", "test", "refresh", "reconnect"]),
  by: Schema.optionalKey(Schema.String),
  missing: Schema.optionalKey(Schema.Array(Schema.String)),
  above: Schema.optionalKey(Schema.Array(Schema.String))
});
export type Attention = typeof Attention.Type;

/**
 * Safe to show: the installation and its account, the repositories, how many checks and mints
 * have succeeded (what a stale failure is told apart by), and why Patchy paused it, if it did.
 */
export const Display = Schema.Struct({
  installationId: Schema.Int,
  account: GithubAccount,
  repositories: Schema.Array(Repository),
  successes: Schema.optionalKey(Schema.Int),
  attention: Schema.optionalKey(Attention)
});
export type Display = typeof Display.Type;

/** What the ciphertext holds: the installation and the repositories a token may name. */
export const Credentials = Schema.Struct({
  installationId: Schema.Int,
  repositoryIds: Schema.Array(Schema.Int)
});
export type Credentials = typeof Credentials.Type;

const encodeCredentials = Schema.encodeSync(Schema.fromJsonString(Credentials));
const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(Credentials));

/** Credentials as the keyring seals them. */
export const credentials = (value: Credentials) => Redacted.make(encodeCredentials(value));

/** What an admin submits: repositories by installation and id, as `<installation>/<id>`. */
export const Request = Schema.Struct({
  repositories: Schema.Array(Schema.Struct({ installationId: Schema.Int, id: Schema.Int }))
});
export type Request = typeof Request.Type;
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Request));
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(Request));
export const request = (value: Request) => Redacted.make(encodeRequest(value));

/**
 * What an admin changes on a connection: the repositories it keeps, by id, and any to add, which
 * need a sign-in as someone GitHub shows administering them; or a Reconnect to the account's new
 * installation after the App was reinstalled.
 */
export const Change = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("repositories"),
    keep: Schema.Array(Schema.Int),
    add: Request.fields.repositories
  }),
  Schema.Struct({ action: Schema.Literal("reconnect") })
]);
export type Change = typeof Change.Type;
const encodeChange = Schema.encodeSync(Schema.fromJsonString(Change));
const decodeChange = Schema.decodeUnknownEffect(Schema.fromJsonString(Change));
export const change = (value: Change) => Redacted.make(encodeChange(value));

/** A ticked box's value: the installation and the repository it names. */
export const choiceValue = (installationId: number, id: number) => `${installationId}/${id}`;
/** The boxes a form ticked, as a request; anything that isn't `<installation>/<id>` is dropped. */
export const requestOf = (values: ReadonlyArray<string>): Request => ({
  repositories: values.flatMap((value) => {
    const match = /^(\d{1,15})\/(\d{1,15})$/.exec(value);
    return match === null ? [] : [{ installationId: Number(match[1]), id: Number(match[2]) }];
  })
});

/** The repositories a token is minted for: every one in the set that hasn't left. */
export const reachable = (display: Display, sealed: Credentials) => {
  const ids = new Set(sealed.repositoryIds);
  return display.repositories.filter((item) => item.left !== true && ids.has(item.id));
};

/** The repository a call names in the set, by name, ignoring case as GitHub does; none if left. */
export const lookup = (display: Display, sealed: Credentials, name: string) =>
  reachable(display, sealed).find((item) => item.name.toLowerCase() === name.toLowerCase());

// ---------- refusals ----------

const listed = (items: ReadonlyArray<string>) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("GithubInvalidRequest", {
  cause: Schema.optionalKey(Schema.Defect())
}) {
  readonly code = "invalid_request" as const;
  readonly status = 400;
  override get message() {
    return "This form could not be read. Reload the page and try again.";
  }
}
/** Nothing ticked, or nothing GitHub showed this person administering. */
export class NoRepositories extends Schema.TaggedError<NoRepositories>()(
  "GithubNoRepositories",
  {}
) {
  readonly code = "github_no_repositories" as const;
  readonly status = 422;
  override get message() {
    return "Tick at least one repository you administer.";
  }
}
export class OneAccount extends Schema.TaggedError<OneAccount>()("GithubOneAccount", {}) {
  readonly code = "github_one_account" as const;
  readonly status = 422;
  override get message() {
    return "Tick repositories on one account: a connection holds one account's repositories. Connect the other account as its own connection.";
  }
}
export class TooManyRepositories extends Schema.TaggedError<TooManyRepositories>()(
  "GithubTooManyRepositories",
  { max: Schema.Int }
) {
  readonly code = "github_too_many_repositories" as const;
  readonly status = 422;
  override get message() {
    return `A GitHub connection holds at most ${this.max} repositories. Tick fewer, or connect the rest as another connection.`;
  }
}
/**
 * GitHub didn't show this person as an admin of these repositories, by name where Patchy knows
 * it. Only `permissions.admin` exactly true counts; a repository it says nothing about is one too.
 */
export class NotAdmin extends Schema.TaggedError<NotAdmin>()("GithubNotAdmin", {
  repositories: Schema.Array(Schema.String)
}) {
  readonly code = "github_not_admin" as const;
  readonly status = 422;
  override get message() {
    return `GitHub doesn't show you as an admin of ${listed(this.repositories)} where Patchy Cloud is installed. Only someone who administers a repository can add it.`;
  }
}
export class AccountType extends Schema.TaggedError<AccountType>()("GithubAccountType", {}) {
  readonly code = "github_account_type" as const;
  readonly status = 422;
  override get message() {
    return "Patchy connects repositories on a personal account or an organization, and this installation is on neither.";
  }
}
/**
 * Another Patchy company holds the account's installation. Uninstalling and reinstalling the App
 * on GitHub makes a new installation, which nobody holds.
 */
export class InstallationClaimed extends Schema.TaggedError<InstallationClaimed>()(
  "GithubInstallationClaimed",
  { account: Schema.String }
) {
  readonly code = "github_installation_claimed" as const;
  readonly status = 409;
  override get message() {
    return `${this.account} is connected to another Patchy company. An owner of ${this.account} can uninstall Patchy Cloud on GitHub and install it again, which starts fresh, then connect it here.`;
  }
}
/** The App's installation on the account is gone: uninstalled, so nothing can be minted. */
export class InstallationGone extends Schema.TaggedError<InstallationGone>()(
  "GithubInstallationGone",
  { account: Schema.String }
) {
  readonly code = "github_installation_gone" as const;
  readonly status = 409;
  override get message() {
    return `Patchy Cloud is no longer installed on ${this.account}. Install it again on GitHub, then Reconnect.`;
  }
}
/** The installation lacks a permission Patchy reads with, or holds one above read. */
export class PermissionsChanged extends Schema.TaggedError<PermissionsChanged>()(
  "GithubPermissionsChanged",
  {
    account: Schema.String,
    missing: Schema.Array(Schema.String),
    above: Schema.Array(Schema.String)
  }
) {
  readonly code = "github_permissions" as const;
  readonly status = 409;
  override get message() {
    const missing =
      this.missing.length === 0 ? "" : ` It doesn't grant ${listed(this.missing)} read.`;
    const above =
      this.above.length === 0 ? "" : ` It grants more than read on ${listed(this.above)}.`;
    return `Patchy Cloud's installation on ${this.account} doesn't grant exactly what Patchy reads.${missing}${above} An owner of ${this.account} accepts the App's permissions on GitHub, then Resume here.`;
  }
}
/** A mint at connect named a repository the installation doesn't hold (shown: it answers 422). */
export class NotInInstallation extends Schema.TaggedError<NotInInstallation>()(
  "GithubNotInInstallation",
  { account: Schema.String }
) {
  readonly code = "github_not_in_installation" as const;
  readonly status = 409;
  override get message() {
    return `Some of these repositories aren't in Patchy Cloud's installation on ${this.account} any more. Sign in to GitHub again to see what's there now.`;
  }
}
/** The admin's sign-in to GitHub for this page is gone: expired, used, or never made. */
export class SignInRequired extends Schema.TaggedError<SignInRequired>()(
  "GithubSignInRequired",
  {}
) {
  readonly code = "github_sign_in_required" as const;
  readonly status = 409;
  override get message() {
    return "Sign in to GitHub again: your sign-in for choosing repositories expired or was already used.";
  }
}
/** A Reconnect's sign-in found no installation on the connection's own account. */
export class OtherAccount extends Schema.TaggedError<OtherAccount>()("GithubOtherAccount", {
  account: Schema.String
}) {
  readonly code = "github_other_account" as const;
  readonly status = 409;
  override get message() {
    return `Patchy Cloud isn't installed on ${this.account} where you can see it. Install it on ${this.account} again on GitHub, then Reconnect: a connection stays on its account.`;
  }
}
/** Remove would leave the connection with nothing to read. */
export class LastRepository extends Schema.TaggedError<LastRepository>()(
  "GithubLastRepository",
  {}
) {
  readonly code = "github_last_repository" as const;
  readonly status = 422;
  override get message() {
    return "A connection keeps at least one repository. Disconnect it instead.";
  }
}
/**
 * A call named a repository outside the connection's current set, or one that left it. Refused
 * before GitHub is asked: for a public repository, this is the boundary (shown).
 */
export class RepositoryNotFound extends Schema.TaggedError<RepositoryNotFound>()(
  "GithubRepositoryNotFound",
  { repository: Schema.String.check(Schema.isMaxLength(200)) }
) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return `${this.repository} isn't one of this connection's repositories. An admin adds repositories on the connection's page.`;
  }
  get details() {
    return { resource: "repository" as const };
  }
}

export type ConnectError =
  | InvalidRequest
  | NoRepositories
  | OneAccount
  | TooManyRepositories
  | NotAdmin
  | AccountType
  | InstallationClaimed
  | InstallationGone
  | PermissionsChanged
  | NotInInstallation
  | SignInRequired
  | OtherAccount
  | LastRepository;

/** An admin's submitted repositories, decoded from the secret the page built. */
export const parseRequest = (value: Redacted.Redacted<string>) =>
  decodeRequest(Redacted.value(value)).pipe(
    Effect.mapError((cause) => new InvalidRequest({ cause }))
  );
/** An admin's change to a connection, decoded from the secret its dialog built. */
export const parseChange = (value: Redacted.Redacted<string>) =>
  decodeChange(Redacted.value(value)).pipe(
    Effect.mapError((cause) => new InvalidRequest({ cause }))
  );
/** A connection's sealed credentials, once the keyring opened them; anything else reads as unopenable. */
export const parseCredentials = (value: Redacted.Redacted<string>) =>
  decodeCredentials(Redacted.value(value)).pipe(
    Effect.mapError(() => new CredentialKeys.CredentialDecryptionFailed({}))
  );
