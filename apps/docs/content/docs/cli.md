---
title: The CLI
description: The patchy commands people and agents use most, and the contract an agent can branch on.
---

`patchy` is one package: the CLI, the config builders, the browser client and the local dev runtime. Each Patchy Cloud instance serves its own release of it; [Getting started](/docs/getting-started) has the install line. Outside a patch repo the command is `patchy`; inside one it is `pnpm patchy`, the copy the repo pins.

## Signing in

| Command                                             | What it does                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patchy login --api-url https://cloud.patchyhq.com` | Prints a URL and a code to confirm in your signed-in browser, then saves this computer's publishing key and the instance, which later commands use. |
| `patchy whoami`                                     | Shows the user, company, role and computer the CLI acts as.                                                                                         |
| `patchy status`                                     | Shows the instance and whether a key is available, without touching the network.                                                                    |
| `patchy logout`                                     | Forgets this computer's key and revokes it.                                                                                                         |

## Publishing a page

| Command                                                          | What it does                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `patchy validate page.html`                                      | Checks that the file carries everything it uses.                                                        |
| `patchy publish page.html`                                       | Publishes it as a tier 1 page, or a new version of the page it published before.                        |
| `patchy publish page.html --share public`                        | Publishes and sets who can open it: `company`, `public`, or `teams` with `--team <name>` for each team. |
| `patchy publish page.html --name lunch-orders --description "…"` | Sets the page's name and description.                                                                   |
| `patchy share page.html company`                                 | Changes who can open it without publishing.                                                             |
| `patchy share page.html --add jo@pine.example`                   | Shares it with a guest at another company; `--remove` and `--list` too.                                 |

## Working in a patch repo

| Command                                          | What it does                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `patchy init <dir> --purpose "<what it's for>"`  | Starts a tier 1 repo; `--tier 2` adds server handlers.                                                                                 |
| `pnpm patchy dev`                                | Runs the patch locally over local data, with URLs for you, a colleague and a guest. `dev stop`, `dev logs` and `dev reset` control it. |
| `pnpm patchy dev agent [<tool> '<json>']`        | Lists a tier 2 patch's agent tools, or calls one as an agent would.                                                                    |
| `pnpm patchy add <integration>/<handle>`         | Declares a company connection, such as `postgres/warehouse`, and generates its client.                                                 |
| `pnpm patchy add shared-table <patchId>/<table>` | Declares another patch's shared table; `shared-store` for a file store.                                                                |
| `pnpm patchy add members`                        | Declares the company's member directory.                                                                                               |
| `pnpm patchy remove <alias>`                     | Removes a declaration and its generated files.                                                                                         |
| `pnpm patchy refresh`                            | Brings the repo's pins and generated files to the instance's current release, and the computer's CLI with them.                        |
| `pnpm patchy publish`                            | Typechecks, builds and publishes a version. `--dry-run` checks without building or sending.                                            |
| `patchy pull <patch> [dir]`                      | Copies the repo a patch's current version was published from into a new folder, ready for `patchy dev`.                                |

## Finding tools and data

| Command                                          | What it does                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `patchy list`                                    | Lists the patches you can open, yours first, then the company's connections.         |
| `patchy list <patch>`                            | Shows one patch's description, tables, stores and what it reads.                     |
| `patchy list <patch> <table>`                    | Shows one table's columns, indexes and sharing, never its rows.                      |
| `patchy list connections`                        | Lists the company's connections; `--all` adds the integrations on offer.             |
| `patchy list connections <integration>/<handle>` | Shows what one connection holds, such as a database's tables or a mailbox's folders. |

`--state retired` lists retired patches instead, and `--state all` lists every patch you can open, deleted ones not yet reclaimed included.

## Managing a patch

Inside a published repo these act on its patch. Elsewhere, `patchy logs` takes `--patch <id>`, and the others take the HTML file the page was published from or `--patch <id>`.

| Command                    | What it does                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `patchy logs`              | Prints a page of a tier 2 patch's log, newest first; `--failed` keeps only failures. |
| `patchy describe "<text>"` | Changes the description.                                                             |
| `patchy rollback <n>`      | Serves version `n` again.                                                            |
| `patchy retire`            | Takes the patch off its address, keeping everything.                                 |
| `patchy delete --yes`      | Takes it off for a 30-day recovery window.                                           |
| `patchy restore`           | Brings a retired or deleted patch back.                                              |

Retiring or deleting a patch that other live patches read is refused, naming them, until `--force` accepts the breakage.

## The company look

| Command                                    | What it does                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `patchy look`                              | Shows the company's current look revision, its earlier revisions and the admins who can change it. |
| `patchy look preview <dir>`                | Writes a sample page styled by a look, to check before publishing.                                 |
| `patchy look publish <dir> --note "<why>"` | Admins only: publishes a new revision of the look.                                                 |
| `patchy look restore <n>`                  | Admins only: makes an earlier revision current again.                                              |

## Telling Patchy's team

| Command                                                       | What it does                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `patchy request "<what Patchy should do>" --why "<the need>"` | Asks for something Patchy can't do yet, and shows up to three similar requests. |
| `patchy feedback "<what you ran, expected, and got>"`         | Reports something Patchy did wrong or made hard.                                |

Both are sent as you. `patchy request list` and `patchy feedback list` show what you sent, and `withdraw <id>` under either deletes one.

## For agents

Every command takes `--json` and prints one result document on stdout. A failure prints `{ ok: false, error, kind, code?, … }` on stderr. The exit code says who has to act:

| Code | Kind          | Meaning                                                                                       |
| ---- | ------------- | --------------------------------------------------------------------------------------------- |
| 0    | ok            | The command's act succeeded.                                                                  |
| 1    | `local`       | Fix the call, the files or local state, such as bad arguments, a failed validation or no key. |
| 2    | `rejected`    | The instance refused, with a `code` such as `not_owner` or `rate_limited`.                    |
| 3    | `unreachable` | No usable answer from the instance; try again later.                                          |
| 130  | interrupted   | SIGINT or SIGTERM.                                                                            |

`--api-url <url>` picks an instance other than the saved one. `PATCHY_API_TOKEN` supplies a publishing key from the environment, and takes precedence over a saved login.
