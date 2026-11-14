/**
 * What Patchy keeps about one GitHub connection when it connects or refreshes: the account whose
 * App installation holds its repositories, and each repository by id with what discovery read of
 * it. Never code, a run or a pull request.
 *
 * A snapshot describes; it never decides what a call may reach. That is the connection's current
 * set, which can change after a snapshot is taken, as when a repository leaves the installation.
 */
import * as Schema from "effect/Schema";
import { registry } from "@patchy/limits/registry";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const repositories = registry["github.connection.repositories"].default;

/** The kinds of account an installation may sit on; anything else is refused at connect. */
export const githubAccountTypes = ["User", "Organization"] as const;
export const GithubAccountType = Schema.Literals(githubAccountTypes);
export type GithubAccountType = typeof GithubAccountType.Type;

/** A GitHub account by its numeric id, which never changes, with the login it had when read. */
export const GithubAccount = Schema.Struct({
  id: Schema.Int,
  login: Text(100),
  type: GithubAccountType
});
export type GithubAccount = typeof GithubAccount.Type;

/**
 * One repository by its numeric id, which survives a rename and a namesake, with the name and
 * default branch discovery read. `left` marks one Patchy found no longer in the installation: a
 * call refuses it until a Refresh finds it back.
 */
export const GithubRepository = Schema.Struct({
  id: Schema.Int,
  name: Text(100),
  defaultBranch: Text(255),
  private: Schema.Boolean,
  archived: Schema.Boolean,
  disabled: Schema.Boolean,
  left: Schema.optionalKey(Schema.Literal(true))
});
export type GithubRepository = typeof GithubRepository.Type;

/** One account's repositories as a GitHub connection holds them, at most its bound. */
export const GithubSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  account: GithubAccount,
  repositories: Schema.Array(GithubRepository).check(
    Schema.makeFilter(
      (items: ReadonlyArray<unknown>) =>
        (items.length > 0 && items.length <= repositories) ||
        `A GitHub connection holds 1 to ${repositories} repositories.`
    )
  )
});
export type GithubSnapshot = typeof GithubSnapshot.Type;
