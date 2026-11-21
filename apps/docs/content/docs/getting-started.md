---
title: Getting started
description: Get into a company, set up a computer, sign it in, publish a first page and start a patch repo.
---

## Get into a company

Every Patchy user belongs to exactly one company. There are two ways in:

- **An invitation.** A company admin invites your email address with a role. Signing in from the invitation's link, you choose **Join** on the company. An invitation lasts 30 days, and an admin can resend it.
- **The waitlist.** During the private beta, new accounts come only from an invitation's link, and the sign-in page offers **Join the waitlist**. Once you're approved, an email invites you to create your account. Signed in with no company's invitation waiting, you create a company: you name it, choose its handle and become its first admin. A solo builder is a company of one. Someone at Patchy can also send a beta link, which lets one person skip the waitlist.

You sign in with Google, Microsoft or a code sent to your email; there are no passwords. Creating an account means accepting the [terms](https://patchyhq.com/cloud/terms) and the [privacy notice](https://patchyhq.com/cloud/privacy).

A company's handle is 3 to 32 lowercase letters, digits or hyphens, and it can't change later. It is the first part of every patch address, as in `cloud.patchyhq.com/acme/plan`.

## Set up a computer

Patchy is built from a computer with Node.js 22.22.0 or newer and npm. The quickest way to set one up is to give your coding agent, such as Claude Code or Codex, this line:

```text
Set up Patchy using https://cloud.patchyhq.com/llms.txt
```

The portal shows a setup line of your own in its **Final step** dialog after you first sign in, and **Add a computer** on Your agents gives the line again later. The page it names tells the agent how to install the CLI, links Patchy's agent skill so the agent knows how to use it, and starts signing the computer in. The agent then offers the rest of setup, one optional step at a time: in Claude Code, adding Patchy to its auto mode settings as the company's own; for an admin whose company has no look yet, the look its pages start in; then a welcome page and an idea for a first patch.

To install the CLI yourself on macOS or Linux, run the instance's install line:

```sh
work=$(mktemp -d) && curl -fsS 'https://cloud.patchyhq.com/install.mjs' -o "$work/install.mjs" && node "$work/install.mjs"
```

The installer checks the release's integrity before installing it under `~/.patchy/cli`, puts the `patchy` command at `~/.local/bin/patchy`, and links the agent skill into `~/.agents/skills` and `~/.claude/skills`. Switching Node versions keeps the install. Running the line again upgrades it. If `~/.local/bin` isn't on your `PATH`, the installer still installs everything, then stops with the `export PATH` line to add to your shell profile: add it and open a new terminal, or run `~/.local/bin/patchy` directly. On Windows, `https://cloud.patchyhq.com/llms.txt` has the PowerShell line, and the command is `patchy.cmd`.

## Sign the computer in

```sh
patchy login --api-url https://cloud.patchyhq.com
```

`--api-url` names the instance to sign in to. The CLI saves it, so later commands go there without the flag. The CLI prints a URL and a short code, and doesn't open a browser itself. Open the URL in your own signed-in browser, check that it shows the same code as your terminal, give the computer a name such as "Sam's laptop", and confirm. The code lasts ten minutes. **Deny** ends a login you didn't start.

Confirming saves a **publishing key** on the computer. It acts as you, for every agent on that computer, and lasts 90 days, or until it goes 30 days unused, whichever comes first. **Your agents** in the portal lists each computer and disconnects it. `patchy whoami` shows which user, company and computer the CLI is acting as.

## Publish a page

The smallest patch is one HTML file. Save this as `hello.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Team lunch</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        line-height: 1.5;
        max-width: 40rem;
        margin: 3rem auto;
        padding: 0 1rem;
      }
    </style>
  </head>
  <body>
    <h1>Team lunch</h1>
    <p>Orders close at 11:30. Today is <span id="today"></span>.</p>
    <script>
      document.getElementById("today").textContent = new Date().toDateString();
    </script>
  </body>
</html>
```

Check it and publish it:

```sh
patchy validate hello.html
patchy publish hello.html
```

Publish prints the address and who can open it, among other lines:

```text
Published patch
URL: https://cloud.patchyhq.com/acme/hello
Scope: company (signed-in colleagues in your company)
Patch ID: k7f2m9x1a3b8
Tier: 1
Version: 1
…
```

The page is live at once, and everyone in your company can open it at that address. Publishing the same file again updates the same patch with a new version. `--share public` opens it to anyone with the link instead; [Sharing and access](/docs/sharing-and-access) has the other choices.

A page carries everything it uses: inline scripts and styles, with images and fonts as `data:` URLs, up to 10 MiB. Anything loaded from another address is refused at `validate` and at publish. The page runs in a sandboxed frame with no network and no browser storage, so it keeps no data of its own.

## Start a patch repo

A tool that keeps data, enforces rules or reads company systems is built in a **patch repo**. A repo needs pnpm on the computer too, and `init` makes only the repo's own folder, so make its parent first:

```sh
mkdir -p ~/Patchy
patchy init ~/Patchy/team-notes --purpose "Track the team's notes and who owns each"
```

`init` needs the computer signed in. It starts a tier 1 repo; `--tier 2` adds server handlers. It lays down a Preact page, `patchy.config.ts`, a generated typed client and project skills for the agent, and installs what the repo needs. The purpose becomes the patch's first description.

Inside the repo, `pnpm patchy` runs the CLI version the repo pins:

```sh
cd ~/Patchy/team-notes
pnpm patchy dev       # run it locally, with a second URL for a colleague's view
pnpm typecheck
pnpm patchy publish   # build it and publish a version
```

`patchy dev` runs the page and its handlers on your computer, over local data rather than the published patch's; [Integrations](/docs/integrations) says which connections read their real source while you build. [Patches and tiers](/docs/patches-and-tiers) explains what each tier can do, and [The CLI](/docs/cli) lists the commands a repo uses.
