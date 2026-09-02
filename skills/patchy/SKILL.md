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
Patchy Cloud's onboarding, asks to redo their Patchy setup, or has just seen a mint
announcement and onboarding has never run. That reference owns the whole flow —
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
- Every upload carries a publishing key. When no key is stored for the resolved instance,
  the first `upload` mints one, prints a mint announcement — which instance, the file the
  key was saved to, and how to keep an existing identity instead — and continues with the
  upload. The plaintext key is never printed.
- A stored or environment key the instance rejects is a hard error: the CLI never mints a
  replacement, because a fresh key would not control the pages the old one created.
- Relay the mint announcement to the user in plain words — their publishing key is saved
  on this machine, and copying that file to another computer is how they publish from
  there with the same editing rights. _Token_, _instance_, and _mint_ are vocabulary for
  you, not for them: off the operator-token path the user hears **publishing key**, and
  nothing is a token, an instance, or a mint. `references/onboarding.md` §3 has the
  wording.
- Local validation runs before any mint, so invalid HTML never costs a key.
- Re-uploading the same local file updates the patch it already created on that instance.
  Pass `--new` to force a fresh patch, or `--patch` to update a known patch only.
- Patch view URLs are public and unlisted: anyone holding the link can read the page, and
  the page is listed nowhere. Say that when handing over a link.
- CLI state lives in the state dir, `~/.patchy` by default. The `status --json` probe
  reports what this machine already holds, without touching the network; its seven keys
  and their values are tabled in `references/onboarding.md`.
- The exit code says who has to act, so branch on it before reading the message: `1` is
  yours to fix without the network (arguments, the file, validation, local state), `2`
  means the instance answered and said no (a rejected key, a missing update target, a
  quota), `3` means there was no usable answer (network, a 5xx) — try later or tell the
  operator. `130` is an interruption.
- Every command takes `--json`: one JSON document on stdout on success, `{ "ok": false,
"error", "kind" }` on stderr on failure, where `kind` is `local`, `rejected` or
  `unreachable` and matches the exit code. `upload --json` prints the instance's response
  as it is on the wire (`patchId`, `publicUrl`, `versionNumber`, `warnings`, …); the mint
  announcement, when there is one, goes to stderr so stdout stays one document. Prefer it
  when the URL or the patch id is going into a script rather than to the user.

## Publishing with an operator-issued token

Take this path when the user was handed a token by Patchy Cloud's operator instead of
minting one: when self-service minting is off, or when they were issued a named
credential. Operator vocabulary — instance, token, API URL — is correct here and nowhere
else. Ask the user for the token, then set it with a hidden prompt:

```bash
patchy auth set --api-url 'https://pages.example.com'
```

For automation, put the token in a secret environment variable and run the scoped
workflow. Do not shorten it: pin the intended origin, clear inherited credential
overrides, store the setup token through stdin, verify it with `whoami`, and only then
validate and upload.

```bash
(
  set +x
  set -eu
  PATCHY_API_URL='https://pages.example.com'
  export PATCHY_API_URL
  unset PATCHY_API_TOKEN
  unset TOKEN
  : "${PATCHY_SETUP_TOKEN:?Set PATCHY_SETUP_TOKEN to a Patchy Cloud API token}"
  ARTIFACT_PATH='./plan.html'

  printf '%s' "$PATCHY_SETUP_TOKEN" | patchy auth set --token-stdin --api-url "$PATCHY_API_URL"
  unset PATCHY_SETUP_TOKEN
  patchy whoami &&
    patchy validate "$ARTIFACT_PATH" &&
    patchy upload "$ARTIFACT_PATH"
)
```

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
4. Upload, and read the output for a mint announcement to relay.
5. Return the URL, and say that the link is public but unlisted.

## Pitfalls

- A publishing key gates ownership and editing, never readability. Do not tell the user a
  key makes a page private.
- Publish sensitive or confidential material only when public-link visibility is
  acceptable.
- Keep tokens out of positional arguments. Use the hidden prompt for a person, explicit
  `--token-stdin` for automation.
- The key file is the user's whole identity on an instance. Losing it means losing the
  ability to edit or delete the pages it created; the pages stay up.
- Patchy Cloud is not a social scheduler. This flow hosts static HTML pages.
- Hand over a link or a local file rather than pasting giant HTML into chat.
