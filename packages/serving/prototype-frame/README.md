# PROTOTYPE — the sandboxed frame and the shell broker (wayfinder #175)

Throwaway. Answers one question: does a tier 1 patch rendered in a sandboxed
frame on the same host, with the SDK reaching Patchy only through the shell over
`postMessage`, hold up in real browsers on the ergonomics that matter, and does
the broker's envelope carry to tier 2?

Nothing here is production code. It is a plain Node server with in-memory
fixtures; no Effect, no database, no tests beyond the click-through script.

## Run it

```sh
pnpm proto:frame            # serves http://localhost:4175
pnpm proto:frame:click      # drives the click-through in every installed Playwright browser
```

Open <http://localhost:4175>, pick who you are, then open a patch.

## What is on the host

| Path | What |
| --- | --- |
| `/login?as=ada` / `?as=bob` / `/logout` | ada is in acme, bob is in globex; a `session` cookie, `SameSite=Lax`, `HttpOnly` |
| `/acme/inventory[/route]` | the shell for a company-scoped tier 1 patch: door, `<iframe sandbox="allow-scripts">`, broker |
| `/acme/deck[/route]` | the shell for a public tier 1 patch |
| `/acme/probe` | same as inventory but the content CSP allows `connect-src`, so patch code can try to reach the API directly |
| `/<company>/<patch>/~content` | the content response: patch HTML plus the SDK, `Content-Security-Policy: sandbox allow-scripts; ...` |
| `/api/<company>/<patch>/tables/<t>/rows` | GET reads, POST inserts; POST requires the exact shell `Origin` |
| `/api/<company>/<patch>/files/<name>` | GET bytes |
| `/_log` | what the API saw per request: origin, cookie, `Sec-Fetch-Site` |

## The envelope

The broker lives on a `MessageChannel`. The shell posts one window-level message
to the first document the frame loads, `{ v: 1, kind: "bootstrap", route }`,
with the port attached; every request and reply after that rides the port. A
document that replaces the first one (self-navigation, a redirect) gets no port,
no in-flight replies and no second handshake; only reloading the shell issues a
new one.

Request from the frame: `{ v: 1, id, op, args }`. Reply from the shell:
`{ v: 1, id, kind: "result" | "error" }` today; the lifecycle the contract
reserves for tier 2 is `chunk*` then exactly one `end | error` for streams, and
`{ v: 1, id, kind: "cancel" }` from the frame, best effort. Shell events:
`{ v: 1, kind: "event", event, data }`. Resource names in `args` are identifiers
(`[a-z][a-z0-9_]*` for tables), never path fragments. See `sdk.ts` and `shell.js`.

## What the click-through found

`pnpm proto:frame:click` prints the table. The resolution comment on
[#175](https://github.com/allisonmahmood/patchy-cloud/issues/175) carries the
findings and astra's review.
