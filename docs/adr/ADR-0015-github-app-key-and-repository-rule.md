# ADR-0015 — GitHub through one App, its key the secret that matters

Patchy reaches GitHub through one public GitHub App per environment, owned by Patchy's organization: production "Patchy Cloud", with development and CI Apps beside it. Webhooks are off, user authorization during installation is off, and the App asks for read on metadata, Actions, checks, commit statuses, contents, deployments, issues and pull requests, never an organization permission. A connection is a set of repositories, by numeric id, on one account's installation of the App; Patchy mints a token for those ids when a call needs one ([#1440](https://github.com/allisonmahmood/patchy-cloud/issues/1440)).

**The App's private key needs no stored ciphertext to be useful.** Unlike every other integration, a connection holds no secret of its own: its sealed credentials name an installation and repository ids. Whoever holds the App's key can list every installation of the App and mint a token for any repository any account has granted it, connected to Patchy or not. The key is host configuration (`PATCHY_GITHUB_APP_PRIVATE_KEY` among five `PATCHY_GITHUB_APP_*` settings), never in the database, and the server refuses to start with the App half configured.

**A connection reads a repository only because a person GitHub showed to administer it, at that moment, added it to that connection.** The only authority is the person's own listing, read with the token their sign-in to GitHub gave Patchy, carrying `permissions.admin` exactly true; anything it doesn't show fails closed. Installing the App, and adding repositories to it, are steps on GitHub that prove nothing to Patchy. Since GitHub lets any token read any public repository, the connection's current set, checked before GitHub is asked, is the boundary for public ones, and every request names a repository by id, which a namesake can't take over. An organization's installation is held by the first Patchy company that connects from it, as rows a single check limits to one, so admitting a second later is an owner's approval, not a migration.

This is hard to reverse, because companies' grants are to the App, and surprising, because no other integration has a secret that outranks its connections'.

## Considered options

- **A pasted personal or fine-grained token per connection.** Rejected: it acts as a person, ends when they leave, can't be narrowed to read on the repositories alone, and puts a long-lived token in Patchy's hands for each company.
- **An OAuth App.** Rejected: its tokens act as the person across everything they can reach, with no per-repository grant an account's owner controls.
- **Trusting the installation's repository selection.** Rejected: an installation can hold repositories the person connecting can only read, and GitHub confines nothing among public repositories.

## Consequences

**Rotation.** Add a second key to the App, deploy it, let hosts on the old key drain, then delete the old key on GitHub.

**Compromise.** Deleting a key stops new mints and revokes nothing: tokens already minted with it live out their hour (shown on [#1439](https://github.com/allisonmahmood/patchy-cloud/issues/1439)). The runbook in `docs/OPERATIONS.md` › GitHub App › A leaked key gives the two choices, an hour of exposure or an hour of the integration suspended everywhere, and what neither covers.

**Failures read the mint.** Its answers are distinct: 404 the App was uninstalled, a confirmed 403 suspended, 422 a repository or permission gone, 401 Patchy's own key, so a connection says which and a suspension heals by itself.
