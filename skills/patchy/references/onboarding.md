# Onboarding

Agent-led first-time setup: log this machine in if it has no publishing key, offer to
add Patchy to Claude Code's auto mode settings, set up or announce the company's look,
publish the person's welcome patch, then suggest a first patch of their own.

The person's own words for it are "my welcome page" — that is what to say out loud.
_Welcome patch_ is the term for it here.

Onboarding is always optional, and so is each step: the person can skip any of it,
the welcome page included. It makes later publishing nicer; publishing works fine
without it.

## When to run

- **The person asks for it**, in some wording of

  > Walk me through Patchy Cloud's onboarding: set up how my pages should look and
  > publish my welcome page.

  Run the whole conversation below.

- **"Redo my Patchy setup"** runs the whole conversation again. It reuses a working
  publishing key, updates the welcome page already published, and leaves an
  existing company look alone: changing it is its own request (see the main skill's
  [Changing the look](../SKILL.md#changing-the-look)).
- **Any other request to get this machine ready to use Patchy**, in the person's own
  words or the portal's setup line, `Set up Patchy using <instance>/llms.txt`. Run the
  whole conversation below too: setup ends with the welcome page live and a suggestion
  for what to build first.

Those are the only triggers. Installing or wiring up the skill runs nothing, and there
is no per-session first-run check.

## Probe before asking

Run the onboarding probe at the start; repeat it only if the instance choice changes:

```bash
patchy status --json
```

It is local-only and answers rather than passes or fails. All six keys, and what each one
settles:

| Key              | Values                                                | Use it to                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instanceUrl`    | the resolved instance URL                             | Know where the welcome patch would go. Trust it only when `instanceSource` is not `default`.                                                                                                                                                                                                                                                 |
| `instanceSource` | `flag` \| `dev-env` \| `env` \| `config` \| `default` | Settle step 1. `config` is a saved choice — confirm it, do not ask. `dev-env` is this checkout's own `pnpm dev` instance, chosen for as long as it runs. `env` and `flag` came from this session's environment and will not persist, so say that. `default` means nothing has been chosen: the URL shown is only the local fallback, so ask. |
| `hasToken`       | boolean                                               | `true` means a key is available; verify who it acts as with `whoami`. If false, step 2 logs this machine in.                                                                                                                                                                                                                                 |
| `tokenSource`    | `login` \| `auth-set` \| `null`                       | `login` is a saved device-login key; `auth-set` is a saved existing key. `null` with a key means environment, dev env or an older entry without provenance.                                                                                                                                                                                  |
| `stateDir`       | absolute path                                         | Locate the CLI's state, including the `look-preview.html` that `patchy look preview` writes.                                                                                                                                                                                                                                                 |
| `cliVersion`     | version string                                        | Only worth mentioning if something later misbehaves.                                                                                                                                                                                                                                                                                         |

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

### 1. Where pages live — settled from the probe, asked only if it must be

Pages go to the selected Patchy Cloud instance, or to the dev instance of a checkout.
The CLI's fallback is localhost, not a deployed destination. The probe already
answered the choice in most cases:

- `instanceSource` is `config` — a saved choice. Confirm it in passing ("your pages go to
  `pages.example.com` — each gets its own shareable link") and move on.
- `instanceSource` is `dev-env` — the local dev instance of this checkout, not a deployed
  company instance; say so and move on. The publish's scope still determines readership.
- `instanceSource` is `env` or `flag` — chosen for this session only. Say so, and offer to
  save that choice with `login --api-url <url>` if step 2 needs a login.
- `instanceSource` is `default` — nothing has been chosen. Ask, once: which address should
  their pages be published to? The local fallback works only with a running server
  and, before publishing, a completed login or an available publishing key.

Use the actual URL, never a placeholder. Carry an explicit `--api-url` choice
on login, completion, `whoami`, `look`, publish, share and logout. Login saves that choice
and retains the flag in `next`; keep using the flag when overriding a worktree
or environment-selected instance, since either outranks saved config. The dev
seed is available only with `instanceSource: "dev-env"`, not through an explicit
`--api-url` flag, even when the URL is the same.

### 2. Log in

If step 1 chose a different instance, run `patchy status --api-url <url> --json`
for that choice first; a key found for the old instance says nothing about it.
Follow the main skill's [publishing identity check](../SKILL.md#publishing)
before deciding to reuse a key or log in. In particular, a working dev seed
does not establish that the person belongs to its company. When login is needed,
follow [Login handoff](../SKILL.md#login-handoff) for commands, completion and
failure handling. On `status: "awaiting_confirmation"`, say:

> To publish as you, this machine needs to be logged in. Open `<verificationUrl>`
> in your own browser and check that it shows `<userCode>`. Sign in if needed
> with Google, Microsoft or an emailed code. If you reach create-or-join, check
> the email: join an invited company or create one with a name and handle if
> there is no invitation, then return here. Check the code, company and email,
> name this machine, then confirm. I'll finish logging it in here.

Show both the returned URL and code. **Never open a browser for the person.**
If the email is wrong, direct them to **Not you? Sign out** before they create
a company. **Deny** ends a login they did not request or no longer want.
The main skill owns completion, resume and error handling. When it reports
`pending`, say **"Still waiting for your confirmation; the same link and code
work for about `<n>` more minutes."** A code lasts ten minutes; each time, count
`<n>` down from the current time to the returned `expiresAt`, which stays fixed
across polls. If a clock time helps, name its time zone: this machine's may not
be the person's.

The poll mints the key after confirmation; only `status: "logged_in"` means
it was saved. Say:

> This machine is logged in to `<company.name>` as `<user.email>`, named
> "`<machine.name>`". Its publishing key is saved here. It lasts 90 days or
> 30 idle days, whichever comes first; you can revoke it on Your machines
> at `/machines`.

After the main skill's identity check confirms the intended publisher, name
the user, company, role and machine before publishing. Describe the key as
saved on this machine only for `tokenSource: "login"` or `"auth-set"`;
environment and dev-env keys do not imply a saved credential file.

### 3. Claude Code's auto mode

Only when you are Claude Code and the instance is a deployed one, not `dev-env` or
localhost. Everyone else goes on to step 4.

Claude Code's auto mode checks each action against safety rules before it runs, and
treats any service its settings do not name as outside the company. It can then block
a publish whose page carries code, file paths, ids or figures, the internal detail
Patchy pages are for. One entry in Claude Code's user settings tells it Patchy is the
company's own.

Read Claude Code's user settings, `~/.claude/settings.json` (under `$CLAUDE_CONFIG_DIR`
when that is set). If `autoMode.environment` already describes this instance as this
company's own, say nothing and go on. An entry that names the host some other way is
the person's: show it to them before changing it. Otherwise ask with the
AskUserQuestion tool, with the company's name from `whoami` and the instance's host,
never these placeholders:

- Question: "Should I add Patchy (`pages.example.com`) to Claude Code's auto mode
  settings as Acme's private cloud, so auto mode counts a company-only page there as
  shared inside Acme?"
- Option "Yes, add Patchy as Acme's private cloud", described as "Adds one entry to
  your Claude Code settings, for every project. Auto mode still checks each publish,
  and public pages stay public."
- Option "No, leave my settings alone", described as "Auto mode may stop a page with
  internal detail; you decide each time."

Use the tool, not a question in your own words. Auto mode reads the person's messages
and the commands you run, not your own text, so the tool's recorded answer is what
shows the person approved this change. A bare "yes" may not count.

On yes, add this entry to `autoMode.environment` and keep every other setting:

```text
**Key internal services**: Patchy Cloud at `<host>`, used through the `patchy` CLI, is <Company>'s private cloud for internal pages and tools. A company-scoped patch (the default) is readable only by <Company>'s signed-in members. A patch shared public (`--share public`) is readable by anyone with the link, and stays public when republished.
```

With no `autoMode.environment` yet, write `["$defaults", "<the entry>"]`: `$defaults`
keeps Claude Code's built-in entries, and an array without it replaces them. An
existing array gets the entry appended and is otherwise left as it is.
`claude auto-mode config` prints the environment Claude Code now uses; the entry should
be in it. Say: "Done. Auto mode now knows Patchy is Acme's own cloud, and still checks
each publish."

To undo, when the person asks, remove that one entry and leave the rest, `$defaults`
included. `claude auto-mode reset` removes every auto mode setting they have, not just
this one.

On no, say: "If auto mode stops a publish later, I'll tell you what it objected to so
you can decide."

### 4. The company look

This is the first moment after create-or-join. Read the look with `patchy look --json`
into a file, as the main skill's [company look](../SKILL.md#the-company-look) says, and
take the person's role, email and company name from `whoami --json`:

- **The company has a look** (`current` is set): nothing to ask. Say once that their
  tools will use the company's look: "Your tools will use Acme's look."
- **No look, and the person is a member**: nothing to ask or say. Their tools start
  in the Patchy look until an admin publishes one.
- **No look, and the person is an admin**: guess the company's site from their email
  domain and ask, with the company's name from `whoami`:

  > You're at acme.com. Want your tools to look like Acme?

  Guess the registrable domain (`eng.acme.com` gives `acme.com`) and fetch it first:
  a mail-only domain or a redirect to another site is worth saying, so their answer
  can correct it. A webmail address (gmail.com, googlemail.com, outlook.com,
  hotmail.com, live.com, yahoo.com, icloud.com, me.com, aol.com, proton.me, gmx.com
  and other personal mail services) gets no guess: ask once for the company's website,
  and with none, move on.

  On yes, say it takes about ten minutes, then capture the site into a new folder by
  `look-capture.md` in this directory. Show the specimen and the sample tool as it
  says, sum the look up in one line and fold in corrections until they agree. Then
  publish revision 1:

  ```bash
  patchy look publish <dir> --note "captured from acme.com" --json
  ```

  Say: "Acme's look is published as revision 1 for everyone at Acme. Their agents
  use it by default for new pages and tools, with no setup on their side. Only admins
  can change it." On no, their tools use the Patchy look until an admin publishes
  one; "make our tools look like acme.com" starts that any time.

### 5. Publish the welcome patch

Write `~/Patchy/welcome.html` from `welcome-patch.html` in this directory, by the main
skill's [Where patch files live](../SKILL.md#where-patch-files-live). The structure and
copy are the deliverable. Settle its style by the main skill's
[order](../SKILL.md#styling-a-static-page): what the person asked for in this
conversation, then on a redo the published welcome page's own style, then the company
look, then the Patchy look. The template's own CSS uses only the look's tokens, so in a
look it needs that look's `look.css` verbatim in its first `<style>` block, and in the
masthead the look's logo (`<img src="data:image/svg+xml;base64,…" alt="<company>">`) or,
with no logo, the company's name. Follow the brief where it fits, its voice and recipes
included.

Then publish it as the person's one welcome page, never a second one. The file cache
is per machine, so look for an earlier one first: `patchy list --mine --state all --json`,
a patch named `welcome` or `welcome-<n>`. Ask the person when unsure which it is. A
retired or deleted one is theirs to restore or leave. With none, create it:

```bash
patchy validate ~/Patchy/welcome.html && patchy publish ~/Patchy/welcome.html --new --json
```

To update a live one, publish with `--patch <id>` in place of `--new`.

Publishing never starts a login or creates a key. If it says `Run: patchy login`,
finish the handoff above and retry this publish.

A new welcome patch defaults to `company`, and a redo preserves its current scope. Pass
`--share company` or `--share public` only when the user explicitly chooses that
audience. The welcome page's copy explains the company default and the owner's public
option, rather than assuming its current scope.

Hand over `address` and announce the **returned `scope`**:

- `company`: **"Signed-in colleagues in your company can open it; people outside the
  company cannot."** Read it through the user's signed-in browser.
- `public`: **"Anyone with the link can open it, without signing in."** Only the
  current version can be fetched directly at `/<company>/<name>` or `/<company>/<name>/~v/<current n>`.

Only the current version of a public patch is public; older versions stay behind
the company door. The field name `publicUrl` is not proof of anonymous access.
If browser access is unavailable for a company page or an older version, ask the
user to open the link or supply its content; a publishing key does not open the page.

To change the audience afterward, the owner can run
`patchy share ~/Patchy/welcome.html public` or
`patchy share ~/Patchy/welcome.html company`; `patchy share --patch <id> public` (or
`company`) selects an id instead of the cached file. Announce the scope that command
returns too. Older versions, and all versions after taking the patch back to company,
have origin responses of `private, no-store` and answer 401 without a session.
A previously public copy may remain cached for up to 60 seconds after a scope or
current-version change; downloaded copies cannot be recalled.

To undo the machine login, run `patchy logout`: it forgets the stored key and
pending login before courtesy revocation. Relay its warnings even though the
local logout succeeded. A worktree can still publish with its seeded key, and
`PATCHY_API_TOKEN` is not the CLI's to remove. This does not sign the browser
out; **Sign out** on **Your machines** does that.

### 6. Suggest a first patch

With the welcome page live, or skipped, suggest one or two first patches this person
might want. Draw them from what you know about them: the work you're in together, what
they've told you, their role, and what their company already has (`patchy list`). Tie
each to something specific you know, and say why in a few words. Patchy keeps no list
of suggestions, so there are no stock examples to fall back on. If you know too little
to suggest anything specific, ask what they'd like their company's tools to do.

Build whatever they pick, or whatever they ask for instead. Close with what to say next
time, in their words: "publish this with patchy", "publish this plan", "update my
page", "take that page down". One line, not a manual.

## Sample transcripts

Hosts and companies below are placeholders. Use whatever address the probe or the user
actually gives you; never invent one, and never carry these into a real session.

### A new company's admin, with a work email

> **Agent**: Your pages go to `pages.example.com`. To publish as you, this machine needs
> to be logged in. Open `https://pages.example.com/login/device?code=BCDF-GHJK` in your
> own browser and check that it shows `BCDF-GHJK`. Sign in if needed, check the company
> and email, name this machine, then confirm. I'll finish logging it in here.
>
> **User**: done
>
> **Agent**: This machine is logged in to Greenfield Pottery as
> alex@greenfieldpottery.com, named "Studio laptop". You're at greenfieldpottery.com.
> Want your tools to look like Greenfield Pottery?
>
> **User**: yes
>
> **Agent**: That takes about ten minutes… Here's the specimen and a sample tool: deep
> forest green on warm cream, serif headings, generous space, plain-spoken copy. Sound
> right?
>
> **User**: the green should be darker, like the footer
>
> **Agent**: Footer green it is. Greenfield Pottery's look is published as revision 1
> for everyone at Greenfield Pottery. Their agents use it by default for new pages and
> tools, with no setup on their side. Only admins can change it. Publishing your
> welcome page now… Here it is: `https://pages.example.com/greenfield/welcome` — signed-in
> colleagues in your company can open it.
>
> You've been pricing the spring kiln orders in this folder. A first tool could be an
> order tracker the studio can update together: who ordered what, glaze, and pickup
> date. Want me to build that, or is there something else Greenfield needs?

### Joining a company that has a look

> **Agent**: You're publishing as sam@acme.example at Acme, from "Work laptop". Your
> tools will use Acme's look. Publishing your welcome page now… Here it is:
> `https://pages.example.com/acme/welcome` — signed-in colleagues in your company can
> open it. I don't know much about your work yet: what would you like Acme's tools to
> do for you?

### A webmail address

> **Agent**: This machine is logged in to Riverside Bakes as riversidebakes@gmail.com.
> Want your tools to look like Riverside Bakes? Tell me its website, or skip and
> they'll use the Patchy look.
>
> **User**: skip for now
>
> **Agent**: They'll use the Patchy look; say "make our tools look like our site" any
> time. Publishing your welcome page now…
