# Onboarding

Agent-led first-time setup: capture how the user's pages should look, then publish their
welcome draft. One question, then a live link.

The user's own words for it are "my welcome page" — that is what to say out loud.
_Welcome draft_ is the term for it here.

Onboarding is always optional. It makes later publishing nicer; publishing works fine
without it.

## When to run

**Primary trigger — the user asks for it.** Some wording of

> Walk me through Patchy Cloud's onboarding: set up how my pages should look and publish
> my welcome page.

Those are the skill's onboarding triggers; nothing else starts this conversation on its
own. Installing or wiring up the skill runs nothing.

**Lazy fallback — after a mint announcement.** An `upload` just printed a mint
announcement and onboarding has never run. Offer it once — "Want me to spend two minutes
setting up how your pages look?" — and drop it if declined.

**On request.** "Redo my Patchy setup" re-runs the conversation. It overwrites
`style.md` with the new answers and leaves the publishing key untouched.

Those are the only three. There is no per-session first-run check: if none of them fires,
onboarding never happens, and that is the correct outcome.

## Probe before asking

Run the onboarding probe once, at the start:

```bash
patchy status --json
```

It is local-only and answers rather than passes or fails. All seven keys, and what each one
settles:

| Key               | Values                                                | Use it to                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instanceUrl`     | the resolved instance URL                             | Know where the welcome draft would go. Trust it only when `instanceSource` is not `default`.                                                                                                                                                                                                                                                 |
| `instanceSource`  | `flag` \| `dev-env` \| `env` \| `config` \| `default` | Settle step 2. `config` is a saved choice — confirm it, do not ask. `dev-env` is this checkout's own `pnpm dev` instance, chosen for as long as it runs. `env` and `flag` came from this session's environment and will not persist, so say that. `default` means nothing has been chosen: the URL shown is only the local fallback, so ask. |
| `hasToken`        | boolean                                               | `true` → they already publish. The welcome upload reuses that key, so nothing is minted and there is no announcement to relay.                                                                                                                                                                                                               |
| `tokenSource`     | `mint` \| `auth-set` \| `null`                        | Tell a key this machine minted (`mint`) from one saved by hand from the operator (`auth-set`). `null` with `hasToken: true` means the key comes from the environment, not the state dir — say so rather than promising the saved-file story.                                                                                                 |
| `stateDir`        | absolute path                                         | Locate `style.md` — it goes in this directory.                                                                                                                                                                                                                                                                                               |
| `hasDefaultStyle` | boolean                                               | `true` → onboarding already ran. Say what the current default look is and ask keep-or-redo instead of asking cold.                                                                                                                                                                                                                           |
| `cliVersion`      | version string                                        | Only worth mentioning if something later misbehaves.                                                                                                                                                                                                                                                                                         |

## The conversation

One question at a time. The user is not technical. _Token_, _instance_, _mint_, and _API_
never reach them outside the operator-token path; the credential is their **publishing key**.

### 1. Style — the only question

Offer exactly two options:

1. **The Patchy look** (the default): warm paper, bold ink, hand-built and friendly.
   Describe it in one sentence.
2. **Match my website**: ask for the URL, then capture it by the method in
   `style-file.md`. Play the read back in one line before saving ("deep forest green,
   cream, serif headings, plain-spoken — sound right?") and fold in corrections until
   they agree.

Either answer writes `style.md` into the state dir, in the shape `style-file.md`
specifies. Writing it for the default answer too is what stops every later session from
re-asking. A project's own house style still overrides it.

### 2. Where pages live — settled from the probe, asked only if it must be

Pages go to Patchy Cloud, or to the dev instance of a checkout; the CLI bakes in no
address, so one has to be chosen. The probe already answered this in most cases, so read
it before opening your mouth:

- `instanceSource` is `config` — a saved choice. Confirm it in passing ("your pages go to
  `pages.example.com` — each gets its own shareable link") and move on.
- `instanceSource` is `dev-env` — the local dev instance of this checkout. Its pages are
  for the developer's own eyes; say so and move on.
- `instanceSource` is `env` or `flag` — chosen for this session only. Say so, and offer to
  save it with `--api-url` so it sticks.
- `instanceSource` is `default` — nothing has been chosen. Ask, once: which address should
  their pages be published to? If they are running the server themselves on this machine,
  the fallback the probe printed is the right answer and no token step is needed.

Once the address is known and the user holds an operator-issued token, operator
vocabulary is correct for this step: save the token through a hidden prompt with
`patchy auth set --api-url`, and confirm it with `patchy whoami` before continuing. See
the operator-token section of `SKILL.md`. With no token, the first upload mints one if the
instance allows it; if it does not, that is a question for Patchy Cloud's operator — do not
guess at one, and do not publish somewhere else instead.

### 3. Publish the welcome draft

Write `welcome.html` from `welcome-draft.html` in this directory, restyled to the chosen
look — the structure and copy are the deliverable, the styling is theirs — then:

```bash
patchy validate './welcome.html' && patchy upload './welcome.html'
```

That upload is what creates their publishing key. Onboarding has no separate key step:
the CLI mints on the first upload, prints the mint announcement, and continues. Relay the
announcement in plain words rather than pasting it:

> "That created your publishing key — it's saved on this machine, and it's what lets you
> update or delete your pages later. To publish from another computer with the same
> rights, copy that file across; I can help when the time comes."

If the probe reported `hasToken: true`, nothing is minted and there is nothing to relay —
and check `tokenSource` before describing what they hold: `mint` or `auth-set` means the key
is a file in the state dir, `null` means it came from the environment or the dev env, so the
copy-the-file story does not apply.

Then hand over the URL with the one fact that matters: **anyone with the link can see it,
and it isn't listed anywhere.**

### 4. Sign-off

Close with what to say next time, in their words: "publish this with patchy", "publish
this plan", "update my page", "take that page down". One line, not a manual.

## Sample transcripts

Hosts below are placeholders. Use whatever address the probe or the user actually gives
you; never invent one, and never carry these into a real session.

### Fast path — an instance is already saved

> **Agent**: Skill installed. One quick question and I'll publish your first page. Looks:
> pages can use the Patchy look — warm paper, bold ink, friendly — or I can match your own
> website's style. Which would you like?
>
> **User**: default is fine
>
> **Agent**: Done. Your pages go to `pages.example.com`, which is already set up here.
> Publishing your welcome page now… Here it is: `https://pages.example.com/d/a1b2c3` —
> anyone with that link can see it, and it isn't listed anywhere. That first publish also
> created your publishing key, saved on this machine; it's what lets you edit or delete
> your pages later. Next time you want a page, just say "publish this with patchy".

### Custom path — style from a website, and nowhere to publish yet

> **Agent**: One quick question — looks. The Patchy look, or match your website?
>
> **User**: match my site, it's greenfieldpottery.com
>
> **Agent**: Reading your site… I see deep forest green on cream, serif headings, generous
> space, and plain-spoken copy. I'll use that as your default look — sound right?
>
> **User**: yes but the green should be darker, like the footer
>
> **Agent**: Got it — footer green it is. Saved. Last thing: nothing here says where your
> pages should be published. What's the Patchy Cloud address you were given?
>
> **User**: pages.greenfield.internal, and IT gave me a token
>
> **Agent**: Perfect. I'll take the token in a hidden prompt so it never lands in the
> chat… Verified against pages.greenfield.internal. Publishing your welcome page there
> now…
