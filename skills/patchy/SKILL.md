---
name: patchy
description: Publish content as a polished, shareable HTML page on a Patchy Cloud instance and run Patchy Cloud's onboarding. Use when the user says "patchy", "publish this with patchy", "patchy page", "walk me through Patchy Cloud's onboarding", or asks for a "shareable HTML page".
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

Keep secrets, confidential material, private URLs, local filesystem paths, production
documentation of record, interactive apps, forms, JavaScript, and anything needing viewer
authentication off any published page.

## Publishing

The `patchy` CLI uploads one safe static HTML document and returns a public, unlisted
view URL.

Requires Node.js 22 or newer, and the `patchy` CLI on `PATH` — built from the
patchy-cloud repo with `pnpm --filter @patchy/cli build`.

```bash
patchy validate './plan.html' && patchy upload './plan.html'
```

Behavior:

- Pages go to Patchy Cloud, or to the `pnpm dev` instance of a checkout. The CLI bakes in
  no address for either: publishing always goes to the instance named through
  `--api-url`, the `.local/dev/env` a `pnpm dev` wrote in this checkout, the
  `PATCHY_API_URL` environment variable, or the saved config — in that order. With none of those set the CLI tries
  `http://localhost:3000`, which only works if a server is running locally. Settle the
  instance before uploading — `status --json` says which one is resolved and where that
  came from, and `upload` prints it before publishing.
- Every upload carries a publishing key. With no key, run
  `patchy auth set --api-url <url>` to save one the user already holds;
  upload exits `1` (`local`) until a key is configured. Keep the key out of chat.
- A rejected stored or environment key is a hard error. Save a working key for
  the same user to keep editing that user's pages.
- Call the credential the user's **publishing key**; local validation runs before upload.
- Re-uploading the same local file updates the patch it already created on that instance.
  Pass `--new` to force a fresh patch, or `--patch` to update a known patch only.
- Patch view URLs are public and unlisted: anyone holding the link can read the page, and
  the page is listed nowhere. Say that when handing over a link.
- "Take that page down" is `patchy delete './plan.html'` — the file it was published
  from — or `patchy delete --patch <id>`. It is irreversible and only the owner
  user can do it, through any of their machine tokens; confirm before running it.
- CLI state lives in the state dir, `~/.patchy` by default. The `status --json` probe
  reports what this machine already holds, without touching the network; its seven keys
  and their values are tabled in `references/onboarding.md`.
- The exit code says who has to act, so branch on it before reading the message: `1` is
  yours to fix without the network (arguments, the file, validation, local state), `2`
  means the instance answered and said no (a rejected key, a missing update or delete
  target, a quota), `3` means there was no usable answer (network, a 5xx) — try later or tell the
  operator. `130` is an interruption.
- Every command takes `--json`: one JSON document on stdout on success, `{ "ok": false,
"error", "kind" }` on stderr on failure, where `kind` is `local`, `rejected` or
  `unreachable` and matches the exit code. `upload --json` prints the instance's response
  as it is on the wire (`patchId`, `publicUrl`, `versionNumber`, `warnings`, …).
  Stderr carries failures only.
  `delete --json` prints `{ "ok": true }`. Prefer it when the URL or the patch id is going
  into a script rather than to the user.

## Saving a publishing key

When no key is configured, save a key the user already holds through a hidden prompt:

```bash
patchy auth set --api-url 'https://pages.example.com'
```

Use the actual URL, never the placeholder. For automation, pass the key through
`--token-stdin` from a secret environment variable, not a positional argument.
Confirm the user and company with `patchy whoami` before publishing.

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
4. Upload; with no key, run `patchy auth set --api-url <url>` before retrying.
5. Return the URL, and say that the link is public but unlisted.

## Pitfalls

- A publishing key gates ownership and editing, never readability. Do not tell the user a
  key makes a page private.
- Publish sensitive or confidential material only when public-link visibility is
  acceptable.
- Keep tokens out of positional arguments. Use the hidden prompt for a person, explicit
  `--token-stdin` for automation.
- A publishing key acts as its user. Losing or revoking a key does not change
  ownership; another machine token for that user can still update or delete their pages.
- Patchy Cloud is not a social scheduler. This flow hosts static HTML pages.
- Hand over a link or a local file rather than pasting giant HTML into chat.
