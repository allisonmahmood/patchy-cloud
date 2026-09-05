# Onboarding

Agent-led first-time setup: capture how the user's pages should look, log the machine
in if it has no publishing key, then publish their welcome patch.

The user's own words for it are "my welcome page" — that is what to say out loud.
_Welcome patch_ is the term for it here.

Onboarding is always optional. It makes later publishing nicer; publishing works fine
without it.

## When to run

**Primary trigger — the user asks for it.** Some wording of

> Walk me through Patchy Cloud's onboarding: set up how my pages should look and publish
> my welcome page.

Those are the skill's onboarding triggers; nothing else starts this conversation on its
own. Installing or wiring up the skill runs nothing.

**On request.** "Redo my Patchy setup" re-runs the conversation. It overwrites
`style.md` with the new answers and reuses a working publishing key.

Those are the only triggers. There is no per-session first-run check: if neither fires,
onboarding never happens, and that is the correct outcome.

## Probe before asking

Run the onboarding probe at the start; repeat it only if the instance choice changes:

```bash
patchy status --json
```

It is local-only and answers rather than passes or fails. All seven keys, and what each one
settles:

| Key               | Values                                                | Use it to                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instanceUrl`     | the resolved instance URL                             | Know where the welcome patch would go. Trust it only when `instanceSource` is not `default`.                                                                                                                                                                                                                                                 |
| `instanceSource`  | `flag` \| `dev-env` \| `env` \| `config` \| `default` | Settle step 2. `config` is a saved choice — confirm it, do not ask. `dev-env` is this checkout's own `pnpm dev` instance, chosen for as long as it runs. `env` and `flag` came from this session's environment and will not persist, so say that. `default` means nothing has been chosen: the URL shown is only the local fallback, so ask. |
| `hasToken`        | boolean                                               | `true` means a key is available; verify who it acts as with `whoami`. If false, step 3 logs this machine in before publishing.                                                                                                                                                                                                               |
| `tokenSource`     | `login` \| `auth-set` \| `null`                       | `login` is a saved device-login key; `auth-set` is a saved existing key. `null` with a key means environment, dev env or an older entry without provenance.                                                                                                                                                                                  |
| `stateDir`        | absolute path                                         | Locate `style.md` — it goes in this directory.                                                                                                                                                                                                                                                                                               |
| `hasDefaultStyle` | boolean                                               | `true` means `style.md` exists. Read it, say what the current default look is and ask keep-or-redo instead of asking cold.                                                                                                                                                                                                                   |
| `cliVersion`      | version string                                        | Only worth mentioning if something later misbehaves.                                                                                                                                                                                                                                                                                         |

`hasToken` and `tokenSource` follow the publishing credential chain:
`PATCHY_API_TOKEN`, then the stored key for this instance, then the dev env's
seeded key. A saved login outranks the seed, but an environment key overrides
both. The probe never proves a key is still accepted by the instance.
If a credential file is unreadable or malformed, the probe can also answer
`hasToken: false`. Follow a later command's local-state repair instruction;
repeated login attempts do not repair a state file login cannot read.

## The conversation

One question at a time. Call the machine token the user's **publishing key**.
Say **sign in** for the person's browser session and **log this machine in**
for the step that lets it publish as them.

### 1. Style

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

Pages go to the selected Patchy Cloud instance, or to the dev instance of a checkout.
The CLI's fallback is localhost, not a deployed destination. The probe already
answered the choice in most cases:

- `instanceSource` is `config` — a saved choice. Confirm it in passing ("your pages go to
  `pages.example.com` — each gets its own shareable link") and move on.
- `instanceSource` is `dev-env` — the local dev instance of this checkout, not a deployed
  company instance; say so and move on. The upload's scope still determines readership.
- `instanceSource` is `env` or `flag` — chosen for this session only. Say so, and offer to
  save that choice with `login --api-url <url>` if step 3 needs a login.
- `instanceSource` is `default` — nothing has been chosen. Ask, once: which address should
  their pages be published to? The local fallback works only with a running server
  and, before publishing, a completed login or an available publishing key.

Use the actual URL, never a placeholder. Carry an explicit `--api-url` choice
on login, completion, `whoami`, upload, share and logout. Login saves that choice
and retains the flag in `next`; keep using the flag when overriding a worktree
or environment-selected instance, since either outranks saved config. The dev
seed is available only with `instanceSource: "dev-env"`, not through an explicit
`--api-url` flag, even when the URL is the same.

### 3. Log in, then publish the welcome patch

If step 2 chose a different instance, run `patchy status --api-url <url> --json`
for that choice first; a key found for the old instance says nothing about it.
With no key, run `patchy login --json` for the chosen instance, retaining any
`--api-url`. On `status: "awaiting_confirmation"`, say:

> To publish as you, this machine needs to be logged in. Open `<verificationUrl>`
> in your own browser and check that it shows `<userCode>`. Sign in if needed
> with Google, Microsoft or an emailed code. If you reach create-or-join, check
> the email: join an invited company or create one with a name and handle if
> there is no invitation, then return here. Check the code, company and email,
> name this machine, then confirm. I'll finish logging it in here.

Show both the returned URL and code. **Never open a browser for the person.**
If the email is wrong, direct them to **Not you? Sign out** before they create
a company. **Deny** ends a login they did not request or no longer want.
After relaying the handoff, run the returned `next` command **with `--json`
appended**, retaining its `--api-url` if present. `next` does not include `--json`
itself. It waits up to a minute; `status: "pending"` is exit 0, not a failure.
Say **"Still waiting for your confirmation; the same link and code work until
`<expiresAt>`."** Run that same completion command again when they are ready.
A rerun of `login --json` resumes by polling once, rather than giving another
handoff; retain the original URL and code. Denied, expired or unknown is exit 2:
relay the refusal, and start again only if they want to.
An unanswered request at the wait deadline is exit 3 (`unreachable`), not
confirmation still pending. The local login record is retained: retry the same
completion command rather than starting another code.

The poll mints the key after confirmation; only `status: "logged_in"` means
it was saved. Say:

> This machine is logged in to `<company.name>` as `<user.email>`, named
> "`<machine.name>`". Its publishing key is saved here. It lasts 90 days or
> 30 idle days, whichever comes first; you can revoke it on Your machines
> at `/machines`.

If a key was already available, skip login. In either path, run
`patchy whoami --json` for the chosen instance before publishing and name
the returned user, company, role and machine. A login receipt names the saved
key, while `whoami` checks the credential chain upload actually uses:
`PATCHY_API_TOKEN` can still override that login. Resolve an unintended identity
before publishing. Describe an existing key as saved on this machine only for
`tokenSource: "login"` or `"auth-set"`; environment and dev-env keys do not imply
a saved credential file. A rejected key needs a fresh login, not repeated
uploads; an environment override must be resolved separately.

Write `welcome.html` from `welcome-patch.html` in this directory, restyled to the chosen
look — the structure and copy are the deliverable, the styling is theirs — then:

```bash
patchy validate './welcome.html' && patchy upload './welcome.html' --json
```

Uploading never starts a login or creates a key. If it says `Run: patchy login`,
finish the handoff above and retry this upload.

A new welcome patch defaults to `company`. Redoing onboarding updates the cached patch
and preserves its current scope; pass `--share company` or `--share public` only when
the user explicitly chooses that audience. The welcome page's copy explains the
company default and the owner's public option, rather than assuming its current scope.

Hand over `publicUrl` and announce the **returned `scope`**:

- `company`: **"Signed-in colleagues in your company can open it; people outside the
  company cannot."** Read it through the user's signed-in browser.
- `public`: **"Anyone with the link can open it, without signing in."** Only public
  patches can be fetched directly by URL.

The field name `publicUrl` is not proof of anonymous access. If browser access is
unavailable for a company patch, ask the user to open the link or supply its content;
a publishing key does not open the page.

To change the audience afterward, the owner can run `patchy share './welcome.html' public`
or `patchy share './welcome.html' company`; `patchy share --patch <id> public` (or
`company`) selects an id instead of the cached file. Announce the scope that command
returns too. Taking it back to company makes origin responses `private, no-store`,
but a public copy may remain cached for 60 seconds at either latest or version URL,
and downloaded copies cannot be recalled.

To undo the machine login, run `patchy logout`: it forgets the stored key and
pending login before courtesy revocation. Relay its warnings even though the
local logout succeeded. A worktree can still publish with its seeded key, and
`PATCHY_API_TOKEN` is not the CLI's to remove. This does not sign the browser
out; **Sign out** on **Your machines** does that.

### 4. Sign-off

Close with what to say next time, in their words: "publish this with patchy", "publish
this plan", "update my page", "take that page down". One line, not a manual.

## Sample transcripts

Hosts below are placeholders. Use whatever address the probe or the user actually gives
you; never invent one, and never carry these into a real session.

### Fast path — an instance and working key are already available

> **Agent**: One quick question and I'll publish your welcome page. Looks:
> pages can use the Patchy look — warm paper, bold ink, friendly — or I can match your own
> website's style. Which would you like?
>
> **User**: default is fine
>
> **Agent**: Done. Your pages go to `pages.example.com`, which is already set up here.
> You're publishing as alex@example.com at Acme, from "Work laptop".
> Publishing your welcome page now… Here it is: `https://pages.example.com/d/a1b2c3` —
> signed-in colleagues in your company can open it. It was published
> with your configured publishing key. Next time you want a page, just say
> "publish this with patchy".

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
> **User**: pages.greenfield.internal
>
> **Agent**: To publish as you, this machine needs to be logged in. Open
> `https://pages.greenfield.internal/login/device?code=BCDF-GHJK` in your own browser
> and check that it shows `BCDF-GHJK`. Sign in if needed, check the company and
> email, name this machine, then confirm. I'll finish logging it in here.
>
> **User**: confirmed
>
> **Agent**: This machine is logged in to Greenfield Pottery as
> alex@greenfieldpottery.com, named "Studio laptop". Its publishing key is saved
> here. Publishing your welcome page now… Here it is:
> `https://pages.greenfield.internal/d/a1b2c3` — signed-in colleagues in your
> company can open it. Next time, just say "publish this with patchy".
