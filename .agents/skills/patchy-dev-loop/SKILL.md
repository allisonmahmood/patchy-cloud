---
name: patchy-dev-loop
description: Run a change against this worktree's local Patchy Cloud instance. Use when asked to check that a change works for real, to start or stop the dev instance, to drive the patchy CLI locally, to see a page as a signed-in person, or when a dev instance is reported unhealthy.
metadata:
  internal: "true"
---

# The dev loop

`pnpm dev` runs one complete Patchy Cloud per git worktree, and people sign in
as dev personas, so nothing needs an account. [DEVELOPMENT](../../../docs/DEVELOPMENT.md)
is the reference; its **What to exercise for a change** section says what to
watch for each area.

## 1. Start

```sh
pnpm dev                 # one instance with the seeded Patchy Dev company
pnpm dev up [scenario]   # an environment: a scenario's company, people and patches
```

Use an environment for anything with more than one person (live sync,
assignments, admin-only rules, invitations) and for demos. Use the URL each
start prints; ports can change between starts. A failed start names its log:
read `pnpm dev logs`.

Done when `pnpm dev status` exits 0.

## 2. Exercise the change

- **The CLI.** `pnpm patchy …` runs from source and publishes as **Dev
  Machine**, `dev@patchy.local`, the admin of Patchy Dev. For login or logout
  checks, keep `PATCHY_API_TOKEN` unset and set
  `PATCHY_STATE_DIR="$PWD/.local/cli-check"` on every command.
- **A server-rendered page as a person.** Sign in with a cookie jar, then fetch:

  ```sh
  curl -s -c /tmp/jar -o /dev/null "$url/dev/sign-in?as=<email>&return=/"
  curl -s -b /tmp/jar -i "$url/<path>"
  ```

- **What a person sees, patch frames included.** `pnpm dev shot <person> <path>`
  writes a full-page PNG and prints the final URL, status and the browser's
  errors. Read the PNG to look at it. `<person>` is any email, or an
  environment person's key or first name.
- **A patch repo.** Follow DEVELOPMENT's **A patch repo against this worktree**.
- **Clerk sign-in, its handshake or real invitation mail.** These need
  `pnpm dev --clerk`, the person's Clerk keys and their browser; follow
  DEVELOPMENT's **Signing in with Clerk** and ask the person for each sign-in.

## 3. Verify

Done when a response, page or screenshot shows the behaviour you changed and
you have quoted it: the status line and headers, or the PNG's path and what it
shows. A successful publish or a bare 200 says nothing about who can see a page
or what it shows.

## 4. After a code change

The server is not watched: `pnpm dev stop && pnpm dev`. Data survives the
restart. `pnpm dev reset` wipes it, for a rewritten baseline migration or
suspect data.

## 5. Stop

Stop what you started: `pnpm dev stop` keeps the data, `pnpm dev down` deletes
the instance or environment. Stop `pnpm patchy dev` sessions before the cloud.
An instance that was already running when you arrived belongs to whoever
started it; leave it up.

Before calling a change ready to ship, run `pnpm verify`.
