---
name: patchy
description: Publish a static HTML page on Patchy Cloud, start a patch repo with init, read a Patchy link, or run onboarding. Use when the user asks to publish with Patchy, build a Patchy tool, open a patch, or set up Patchy.
---

# Patchy

Use this global skill to publish a static page, start a tool's patch repo, read a
patch, or sign the machine in. Inside a patch repo, its project skills govern building.

## Onboarding

Read `references/onboarding.md` and follow it when the user asks to be walked through
Patchy Cloud's onboarding or asks to redo their Patchy setup.
That reference owns the whole flow —
the one style question, the welcome patch, the probe's key names, and the words to say to
the user, which are the source of truth for user-facing copy anywhere in this skill.

## Building a tool

When the user wants a tool with its own rows, files or company connections,
start a patch repo rather than putting JavaScript into a static-file publish.
Use the instance-installed CLI described under Publishing, settle the instance
and identity, and complete the login handoff below if needed. Then run:

```bash
patchy init ./team-tool --tier 1 --purpose "The user's purpose for this tool" --json
```

Use the user's actual purpose and chosen directory. Initialization authenticates
first; without a key it exits 1 with `Run: patchy login`, not a half-created repo.
It installs the pinned package and generates client, context, fixture stubs and
project skills; it refuses a second initialization there. Do not reinstall.

Inside that repo read `AGENTS.md`, `.agents/skills/patchy-loop/SKILL.md` and
`patchy/_generated/index.json`, then use `pnpm patchy`, the pinned copy.
The project skills teach tables, files and declarations in Patchy's own terms.
`pnpm patchy catalog` shows usable connections and shared tables; `--all` also
shows offered integrations and state. `pnpm patchy add postgres/<handle> --as <alias>`
or `pnpm patchy add shared-table <patchId>/<table> --as <alias>` adds a declaration
and generates its client, context, fixture stub and skill. `pnpm patchy remove <alias>`
reverses it while leaving its fixture. `pnpm patchy refresh` updates the pin,
generated files and present skills transactionally; never manually edit
`patchy/_generated/` or managed project skills.

Publish from the repo root with `pnpm patchy publish [--share company|public]`.
It checks release, declaration stamps, types, the single-file build and tier,
then publishes and records only the patch id in `patchy.json`, preserving its
authoritative instance. On `instance_mismatch`, correct the effective URL
override to match the stored instance; the refusal names both URLs before any
HTTP request. Keep the instance binding and patch id intact.
On `stale_generated`, run `pnpm patchy refresh`; on `invalid_manifest`, fix the
config and its imports. On a build failure, fix the repo rather than publishing
`dist/index.html` as a static file.
`too_large` means reduce the largest contributors reported: the local HTML cap
is 512 KiB at tier 0 and 10 MiB at tier 1. `tier_mismatch` instead means remove
unsupported server code or correct the tier/static-HTML policy violation;
browser code needs tier 1.
Bundle inspection requires embedded resources and inline scripts/styles;
CSS `@import` is unsupported. It is a resource-completeness check, while core's
safe-HTML policy owns tier 0 safety. Fragment, relative and external anchors
have identical acceptance in both tiers; the runtime sandbox still governs
navigation. The local `patchy dev` runtime remains separate work; never
substitute production data for local fixtures.
Use invented local fixture inserts. Every readable row is available to whoever
can open the patch; tier 1 has no outbound access or client storage. The project
skills carry the complete runtime limits and the local-only workflow.

Repo recovery lives under `.patchy/publish/`. Keep it after interruptions or a
failed `patchy.json` write and rerun `pnpm patchy publish` as the same owning user.
Recovery precedes release checks and rebuilding, returning the original result.
`pnpm patchy share public` / `company` and `pnpm patchy delete` use the repo id.
A deleted-patch 404 requires removing `patch` from `patchy.json` before a new create.

## Good fits

- implementation plans
- architecture notes
- design briefs
- stakeholder-facing drafts
- polished reports
- quick visual previews of agent-generated work

For the static-page flow, keep secrets, private URLs, local filesystem paths,
production documentation of record, interactive apps, forms and JavaScript off
the published page. Publish only material the intended audience may read: the
user's company by default, anyone with the link only by explicit choice.

## Publishing

The `patchy` CLI publishes one safe static HTML document and returns its view URL.
New patches default to company scope; use `--share public` only when the user wants
anyone with the link to read the page.

Requires Node.js 22.18 or newer and the `patchy` CLI on `PATH`. If the CLI is
missing or its release differs from the intended instance, install from that
instance, not a registry. For a new install, use the instance URL the user
supplied; ask where to publish only if no destination is known.
Fetch its unauthenticated `GET /api/release`, download the exact
`package.tarball` URL as `patchy.tgz`, and verify the downloaded bytes against
the SHA-512 `package.integrity` before installing:

```bash
npm install --global --ignore-scripts ./patchy.tgz
```

The package bundles its dependencies; installation needs no lifecycle scripts.
Check that `patchy --version` matches the reported release before continuing.
The installed skill lives at `node_modules/patchy/skills/patchy/SKILL.md`.
Contributors in a source checkout may instead run `pnpm --filter patchy build`
and symlink `packages/patchy/dist/index.js` as `patchy` into a directory on `PATH`.

Settle the instance and available key before login or publish:

```bash
patchy status --json
```

Use the reported instance if it matches the user's intended destination. If
`instanceSource` is `default`, no choice is saved: use the address the user gave
or ask where to publish; the localhost fallback needs a running server.
Carry a chosen `--api-url <url>` on subsequent commands. `hasToken` means a key
is available, not that it acts as the person: run `patchy whoami --json` when a
key is present and check the user and company against the intended publisher.
A dev seed such as **Dev Machine** is a development identity, not proof of the
person's company membership. For publishing as the person, finish `patchy login`
even when the seed works, unless `whoami` already identifies the intended user
and company. Use the seed directly only for an intentional seed-owned dev check.
With no key or a different publishing identity, run `patchy login --json` for
the chosen instance and follow the handoff. Resolve an overriding
`PATCHY_API_TOKEN` first; saving a login cannot override it.

### Login handoff

1. On `status: "awaiting_confirmation"`, relay **both** `verificationUrl` and
   `userCode`, using the handoff wording in
   [onboarding step 3](references/onboarding.md#3-log-in-then-publish-the-welcome-patch),
   including its first-sign-in and wrong-account guidance. Read that wording
   when login is needed without starting the optional style/onboarding flow.
   **Never open a browser for a login handoff.**
2. After relaying the handoff, run the returned `next` command **with `--json`
   appended** (`patchy login --complete <userCode> --json`, retaining any returned
   `--api-url`). `next` does not include `--json` itself. Completion waits up to
   a minute; `pending` is exit 0, not failure. Relay that it is still waiting and
   reuse the same completion command when the person is ready. A rerun of
   `login --json` polls the live code once and reports its status,
   not another handoff; keep the original URL/code. An explicit foreign code is
   a local refusal. An unanswered request at the wait deadline is exit 3, not
   `pending`: the outcome is unknown, so reuse the same completion command.
   Denied, expired or unknown is exit 2: relay the refusal and start again only
   when the person wants to.
3. Continue only on `logged_in`, which names the instance, company, user and machine
   and confirms the publishing key was saved. Run `patchy whoami --json` for the
   same instance before publishing, including when a key was already available.
   Name the user, company and machine it reports. A successful login does not
   override `PATCHY_API_TOKEN`; completion reports that override in `warnings`.
   Relay any warning and resolve an unintended identity before publishing.
   Then resume the requested operation: `init` for a tool, or validate and publish a static page:

```bash
patchy validate './plan.html' && patchy publish './plan.html' --json
```

Skip login only when `whoami` already identifies the intended publisher, then
validate and publish. A person running `patchy login` at a real terminal with no
agent variables and no `--json` gets the handoff but waits in one command;
an agent always uses the two-step flow.
`--api-url <url>` on login saves the instance choice and stays in `next`.
Keep that flag on subsequent publishing commands when overriding a worktree
or environment-selected instance; both outrank saved config.

Call the credential the user's **publishing key**: it is this machine's user-owned
machine token, not the browser's sign-in. Say **sign in** for the person in their
browser and **log this machine in** for publishing. Signing in uses Google,
Microsoft or an emailed code. The poll mints the key after browser confirmation;
it works for 90 days or 30 idle days, whichever comes first, and can be revoked
on **Your machines** at `/machines`. Re-login replaces the saved login key only
when it belongs to the same user, without changing ownership of their pages.

To log this machine out, run `patchy logout`. It forgets the stored publishing key
and pending login first, then tries to revoke only that deleted key. A failed
courtesy revocation is exit 0 with a warning, not a failed logout. Relay warnings:
a worktree still publishes with its seeded key, and an environment key is not the
CLI's to remove. `logout --json` returns `{ ok, instanceUrl, revoked, warnings }`;
browser sign-out is a separate control on **Your machines**.

### Publishing behavior

- For file mode and `init`, instance selection follows `--api-url`, the
  `.local/dev/env` a `pnpm dev` wrote in this checkout, `PATCHY_API_URL`, then
  saved config. With none set, the CLI tries `http://localhost:3000`, requiring
  a running local server. Repo commands instead bind to `patchy.json`'s
  instance: select the effective override in flag > dev env > environment
  order, then require it to match the stored URL after normalization.
  `instance_mismatch` refuses before HTTP; ignored lower-precedence settings
  do not conflict. Without an override the repo has source `project`;
  matching overrides retain their source and credential behavior.
  Settle the instance before publishing — `status --json` reports its own
  resolved target and source, and text-mode `publish` prints the publish target.
- Publish, share, delete and whoami require a publishing key. With no key, they exit
  `1` (`local`), `Run: patchy login`; follow the login handoff above, then retry the
  original command. A local-state error needs the named repair first; `status`
  can report no key when a credential file is unreadable or malformed.
  No command starts a login on the caller's behalf.
- Publish, share, delete, whoami and `status` use the same credential chain:
  `PATCHY_API_TOKEN`, then the key stored for this instance (`login` or `auth-set`),
  then the dev env's seeded key.
  A login outranks the seed; an environment key overrides both.
  The seed is available only with `instanceSource: "dev-env"`; explicitly passing
  `--api-url` does not carry it along, even when the URL is the same.
- A rejected key is a hard error. Log in again as the same user to keep editing
  that user's pages; if an environment key overrides it, resolve that override.
- A new publish checks the executing CLI against `GET /api/release`, then validates the file.
  A `release_mismatch` names both releases: install the exact package reported
  by that endpoint using the integrity check above. Inside a patch repo, use `pnpm patchy refresh`.
  File mode synthesises a tier 0 manifest with no resources. Repo mode admits tiers
  0 and 1 with tables, stores, shared tables and Postgres declarations.
  If the instance returns `has_primitives`, publish from the patch's repo, not a
  file: omitted definitions still count as inventory.
- An interrupted file publish keeps the complete attempt under the state dir;
  repo publish keeps it under `.patchy/publish/`. Rerun `publish`
  with the same instance, state and owning user: it authenticates that user before
  resending the saved content, then applies the original result without another version.
  After moving a repo with its `.patchy/`, recover from its new root. Creates and
  updates record only the returned patch id, preserving the stored instance
  spelling. A conflicting patch id or late instance edit retains the attempt:
  restore an unintended target edit before retrying, rather than rebinding
  the repo to apply a result.
  A replacement token for the same user works; another account is refused locally.
  Authentication, rate-limit and quota failures retain the attempt. Preserve the state
  directory until recovery succeeds, including after a killed process. Atomic
  selection of the nonempty `attempt/` directory chooses one complete request;
  concurrent publishes resend it after checking its original owner.
  Success or a definitive payload refusal unlinks only that publish key's file,
  so a stale response leaves a newer attempt intact. For the complete conditions
  that clear rather than retain an attempt, read
  [definitive publish refusals](https://github.com/allisonmahmood/patchy-cloud/blob/main/docs/adr/ADR-0004-cli-contract-for-agents.md#definitive-publish-refusals):
  decoded 413s, selected 422s or 422s carrying `errors`, selected 409s and the
  matching unavailable-update 404. A decoded 413 needs a smaller fresh payload.
  `patch_not_openable` is definitive (exit 2): correct the shared-table declaration
  or restore source access before publishing a fresh attempt.
  `connection_not_connected` and `stale_generated` are also definitive (exit 2).
  An admin reconnects at `/company/connections`; a stale declaration needs a
  regenerated snapshot stamp. Connection strings belong only in the person's
  browser connect/rotate form, never in CLI arguments or an agent transcript.
- Republishing the same local file updates the patch it already created on that instance
  and preserves its sharing scope unless `--share company` or `--share public` is supplied.
  Pass `--new` to force a fresh patch, or `--patch` to update a known patch only.
- Use `--name quarterly-plan` to set or rename a patch: 3–32 lowercase letters,
  digits or hyphens, no leading or trailing hyphen. Without it, a new patch derives
  its name from the filename and adds a suffix on collision; republishing keeps it.
  `name_taken` is a definitive refusal (exit 2): choose another name and retry.
  Renaming leaves a 308 redirect until another patch takes the old name; deleting
  frees every name. Names never select the patch to update; the file cache or id does.
- Set sharing during publish with `patchy publish './plan.html' --share public` or
  `--share company`. Change it without publishing a version with
  `patchy share './plan.html' public` or `patchy share './plan.html' company`;
  `patchy share --patch <id> public` (or `company`) selects an id instead of the cached
  file, exactly one target. Only the owner user may change sharing, through any of
  their machine tokens; another user's patch answers 404.
- Announce the returned `scope`, not an assumed default: `company` means signed-in
  colleagues in the user's company can open the link; `public` means anyone with
  the link can open it without signing in. Text output names both scope and readership.
  Publish returns `name` and `address`; `publicUrl` equals the address, not a grant of public access.
- Only the current version of a public patch is public; older versions stay behind the company door.
  The current version is public at both `/<company>/<name>` and `/<company>/<name>/~v/<current n>`.
  Older versions, and all versions after taking a patch back to company, have origin responses
  of `private, no-store` and answer 401 without a session. Previously public copies may remain
  cached for up to 60 seconds; already downloaded copies cannot be recalled.
- "Take that page down" is `patchy delete './plan.html'` — the file it was published
  from — or `patchy delete --patch <id>`. It is irreversible and only the owner
  user can do it, through any of their machine tokens; confirm before running it.
  The origin stops serving it immediately, but a public copy may remain cached
  for up to 60 seconds; downloaded copies cannot be recalled.
- CLI state lives in the state dir, `~/.patchy` by default. The `status --json` probe
  reports what this machine already holds, without touching the network; its seven keys
  and their values are tabled in `references/onboarding.md`.
- The exit code says who has to act, so branch on it before reading the message: `1` is
  yours to fix without the network (arguments, the file, validation, local state), `2`
  means the instance answered and said no (a rejected key, a missing update, share or delete
  target, a quota), `3` means there was no usable answer (network, a 5xx) — try later
  or contact Patchy about the unavailable instance. `130` is an interruption.
- Every command takes `--json`: one JSON document on stdout on success, `{ "ok": false,
"error", "kind", "code"? }` on stderr on failure, where `kind` is `local`, `rejected` or
  `unreachable` and matches the exit code. Branch on `kind`/exit first, then
  `code` when present. Repo checks emit local `instance_mismatch`,
  `release_mismatch`, `stale_generated`, `invalid_manifest`, `too_large` and
  `tier_mismatch` (exit 1); the same code from the instance is `rejected`
  (exit 2). Other local failures may have no code. For machine-branching remedies,
  read the [local-code contract](https://github.com/allisonmahmood/patchy-cloud/blob/main/docs/adr/ADR-0004-cli-contract-for-agents.md#local-repo-refusal-codes).
  `publish --json` prints the instance's response as it is on the wire
  (`patchId`, `name`, `address`, `publicUrl`, `scope`, `tier`, `versionNumber`, `schemaRevision`,
  `provisioned`, `unused`, `warnings`, …).
  `share --json` prints `{ "ok": true, "patchId", "scope", "publicUrl" }`.
  Stderr carries failures only.
  `delete --json` prints `{ "ok": true }`. Prefer it when the URL or the patch id is going
  into a script rather than to the user.
  Check the exit code first: argument parse failures can put usage on stdout,
  which is not a success document.

## Reading a patch

Open the returned `address`: `/<company>/<name>`, or append `/~v/<n>` for a version.
Read company pages and older versions of public patches through the user's signed-in browser.
Only the current version of a public patch can be fetched directly by address; a publishing key
never opens a patch page. Old names may redirect with 308; follow the destination using the
same browser access. `/~content/<patchId>/<versionId>` is internal, not a sharing link;
the former `/d/*` URLs are gone. If browser access is unavailable, say so and ask
the user to open the link or supply the content.

Tier 1 pages run inside the sandboxed frame. Use the browser to read and interact
with that frame, not the outer shell's HTML or the internal content URL. Deep
links and back/forward use `client.route.get()`, `set(path)` and `subscribe(listener)`,
including on public patches. Own-file images use blob URLs and downloads use
`client.files.<store>.download(name)`. The patch has no outbound fetch, popups,
`target=_blank`, top navigation, in-frame downloads, localStorage, IndexedDB,
cookies, workers, camera, microphone, geolocation or external links. Clipboard
writes must be user-triggered and show a visible failure when unavailable.
Async clipboard permission can still be denied for an opaque frame. A user-triggered
`copy` event via `document.execCommand("copy")` is a compatibility fallback; if both
paths fail, show selectable text and a visible error rather than claiming success.
A public tier 1 patch renders signed out: `me` is null, and company-data operations
reject with `not_available_on_public`, even for a signed-in reader. Patch code handles
that error; it does not replace the page or disable local routing.

Runtime notices belong to Patchy, not the uploaded document. `session_expired`
and `principal_changed` require the notice's Sign in link and a whole-page reload;
never replay an unanswered write. `access_denied` has no reload offer: report the
access restriction. A needs-rebuild door requires the owner to refresh, rebuild
and publish. A shell mismatch refreshes once automatically; a terminal mismatch
is a visible failure to report, not an invitation to keep refreshing.

When a page refuses access, report the refusal rather than treating its HTML as the patch:

- **401, Sign in**: "This patch needs your browser sign-in. Open its Sign in link,
  then I'll read it through your browser." Use the door's link (also in
  `x-patchy-sign-in-url`); it returns to the patch. Do not send a publishing key or
  copy session cookies into a URL fetch.
- **303 to `/join`**: "Sign-in worked; finish creating or joining your company in
  the browser, then return to the patch."
- **403, deactivated**: "Your Patchy user is deactivated. Ask a company admin to
  reactivate it." Repeated sign-in will not restore access.
- **404**: "I can't open this patch with your current access. It may be missing or
  belong to another company." Those cases are deliberately indistinguishable;
  do not claim which occurred or offer a request-access control that does not exist.

## Style

Before writing a page, settle which style applies, in this order:

1. The project's own house style, if it declares one. It always wins.
2. The user's default style, `style.md` in the state dir, written during onboarding. Read
   it and apply it as written — it carries everything needed to style a page, except that
   it may defer to `references/patchy-plan-style.md`, which ships beside it. Its shape is
   documented in `references/style-file.md`.
3. The bundled plan-doc style in `references/patchy-plan-style.md`: warm paper, faint
   grid/noise, heavy near-black ink, 2px borders, hard offset shadows, 8px cards, pill
   badges, CSS-only glyph, builder-to-builder copy.

## HTML safety rules

Produce one complete static HTML file.

Allowed:

- semantic HTML
- inline CSS in one `<style>` block
- normal metadata: charset, viewport, title
- HTTPS links when useful
- data images only when needed for tiny CSS textures

Blocked or unsafe:

- `<script>`
- `<form>` and `<input>`
- `<iframe>`, `<embed>`, `<object>`, and `<applet>`
- `<link>` and `<base>`
- `javascript:`, `vbscript:`, and `file:` URLs
- inline event handlers such as `onclick`
- meta refresh redirects
- unsafe inline CSS patterns
- secrets, private URLs, and local paths

## Output pattern

1. Settle the style by the order above, so you know which one you are writing to before
   you write.
2. Write the artifact locally as one `.html` file, complete and self-contained. For a
   restrained technical report, that means clear sections, tables, and diagrams where
   they clarify the work.
3. Run `validate` until it passes.
4. Publish with `--json` so the response gives the actual scope; set `--share` only for
   an explicit sharing choice. With no key, finish the login handoff above before retrying.
5. Return `publicUrl` and announce who can open it from the returned `scope`, as above.

## Pitfalls

- Sharing scope controls readership; a publishing key controls publishing, not browser
  access. Confirm the user's company before publishing sensitive company material.
- Keep publishing keys and private device codes out of chat, command arguments and
  output. Login saves the key itself; relay only the handoff's URL and user code.
- A publishing key acts as its user. Losing or revoking a key does not change
  ownership; another machine token for that user can still update, share or delete their pages.
- Patchy Cloud is not a social scheduler. This flow hosts static HTML pages.
- Hand over a link or a local file rather than pasting giant HTML into chat.
