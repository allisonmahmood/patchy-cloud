---
name: patchy
description: Publish content as a polished, shareable HTML page on a Patchy Cloud instance, read a Patchy page, and run Patchy Cloud's onboarding. Use when the user says "patchy", "publish this with patchy", "patchy page", asks to read a Patchy link, "walk me through Patchy Cloud's onboarding", or asks for a "shareable HTML page".
---

# Patchy

Use this skill when the user wants a plan, proposal, architecture note, briefing, visual
mockup, or report as a shareable web page.

The static-page publishing flow is inspired by Postplan, the static HTML draft publishing
tool created by Theo — credit him for the original agent-friendly posting pattern.

## Onboarding

Read `references/onboarding.md` and follow it when the user asks to be walked through
Patchy Cloud's onboarding or asks to redo their Patchy setup.
That reference owns the whole flow —
the one style question, the welcome patch, the probe's key names, and the words to say to
the user, which are the source of truth for user-facing copy anywhere in this skill.

## Good fits

- implementation plans
- architecture notes
- design briefs
- stakeholder-facing drafts
- polished reports
- quick visual previews of agent-generated work

Keep secrets, private URLs, local filesystem paths, production documentation of record, interactive
apps, forms, and JavaScript off any published page. Publish only material the intended
audience may read: the user's company by default, anyone with the link only by explicit choice.

## Publishing

The `patchy` CLI uploads one safe static HTML document and returns its view URL.
New patches default to company scope; use `--share public` only when the user wants
anyone with the link to read the page.

Requires Node.js 22 or newer, and the `patchy` CLI on `PATH` — built from the
patchy-cloud repo with `pnpm --filter @patchy/cli build`, then symlinked from
`packages/cli/dist/index.js` as `patchy` into a directory on `PATH`.

Settle the instance and available key before login or upload:

```bash
patchy status --json
```

Use the reported instance if it matches the user's intended destination. If
`instanceSource` is `default`, no choice is saved: use the address the user gave
or ask where to publish; the localhost fallback needs a running server.
Carry a chosen `--api-url <url>` on subsequent commands. With no key, run
`patchy login --json` for that instance and follow the handoff.

### Login handoff

1. On `status: "awaiting_confirmation"`, show the person **both** `verificationUrl`
   and `userCode`. Ask them to open the URL in their own browser, sign in if needed,
   check the code, company and email, name the machine, and confirm. A first
   sign-in may reach create-or-join: they join an invited company or create one
   with a name and handle if no invitation exists, then return to confirmation.
   A wrong email calls for **Not you? Sign out**; an unwanted login calls for
   **Deny**. **Never open a browser for a login handoff.** The user-facing words
   are in onboarding step 3.
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
   override `PATCHY_API_TOKEN`; resolve an unintended identity before uploading.
   Then publish:

```bash
patchy validate './plan.html' && patchy upload './plan.html' --json
```

With a working key already configured, skip login, check `whoami`, then validate
and upload. A person running `patchy login` at a real terminal with no agent variables and no `--json`
gets the same handoff but waits in one command; an agent always uses the two-step flow.
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

- Pages go to the selected Patchy Cloud instance, or to the `pnpm dev` instance
  of a checkout. Instance selection follows `--api-url`, the `.local/dev/env`
  a `pnpm dev` wrote in this checkout, the `PATCHY_API_URL` environment variable,
  or the saved config — in that order. With none of those set the CLI tries
  `http://localhost:3000`, which only works if a server is running locally. Settle the
  instance before uploading — `status --json` says which one is resolved and where that
  came from, and `upload` prints it before publishing.
- Upload, share, delete and whoami require a publishing key. With no key, they exit
  `1` (`local`), `Run: patchy login`; follow the login handoff above, then retry the
  original command. A local-state error needs the named repair first; `status`
  can report no key when a credential file is unreadable or malformed.
  No command starts a login on the caller's behalf.
- Upload, share, delete, whoami and `status` use the same credential chain:
  `PATCHY_API_TOKEN`, then the key stored for this instance (`login` or `auth-set`),
  then the dev env's seeded key.
  A login outranks the seed; an environment key overrides both.
  The seed is available only with `instanceSource: "dev-env"`; explicitly passing
  `--api-url` does not carry it along, even when the URL is the same.
- A rejected key is a hard error. Log in again as the same user to keep editing
  that user's pages; if an environment key overrides it, resolve that override.
- Local validation runs before upload.
- Re-uploading the same local file updates the patch it already created on that instance
  and preserves its sharing scope unless `--share company` or `--share public` is supplied.
  Pass `--new` to force a fresh patch, or `--patch` to update a known patch only.
- Set sharing during upload with `patchy upload './plan.html' --share public` or
  `--share company`. Change it without publishing a version with
  `patchy share './plan.html' public` or `patchy share './plan.html' company`;
  `patchy share --patch <id> public` (or `company`) selects an id instead of the cached
  file, exactly one target. Only the owner user may change sharing, through any of
  their machine tokens; another user's patch answers 404.
- Announce the returned `scope`, not an assumed default: `company` means signed-in
  colleagues in the user's company can open the link; `public` means anyone with
  the link can open it without signing in. Text output names both scope and readership.
  The response field is still named `publicUrl`; that name does not make the page public.
- Taking a public patch back to company changes origin responses to `private, no-store`.
  Public copies may remain cached for up to 60 seconds at both latest and version URLs;
  already downloaded copies cannot be recalled.
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
  target, a quota), `3` means there was no usable answer (network, a 5xx) — try later or tell the
  operator. `130` is an interruption.
- Every command takes `--json`: one JSON document on stdout on success, `{ "ok": false,
"error", "kind" }` on stderr on failure, where `kind` is `local`, `rejected` or
  `unreachable` and matches the exit code. `upload --json` prints the instance's response
  as it is on the wire (`patchId`, `publicUrl`, `scope`, `versionNumber`, `warnings`, …).
  `share --json` prints `{ "ok": true, "patchId", "scope", "publicUrl" }`.
  Stderr carries failures only.
  `delete --json` prints `{ "ok": true }`. Prefer it when the URL or the patch id is going
  into a script rather than to the user.
  Check the exit code first: argument parse failures can put usage on stdout,
  which is not a success document.

## Reading a patch

Read a company patch through the user's signed-in browser. Only public patches can be
fetched directly by URL; a publishing key never opens a `/d/*` page. If browser access
is unavailable, say so and ask the user to open the link or supply the content.

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
4. Upload with `--json` so the response gives the actual scope; set `--share` only for
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
