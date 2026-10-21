# Connect Patchy MCP locally over HTTP

This is the walkthrough for **0.4.2**. It runs on your computer and uses your own
Patchy sign-in. You need Node.js **22.22.0+**, npm, a local OAuth-capable MCP client
(the commands below were tested with Codex CLI **0.163.0**), and access to an existing local Patchy Cloud.
You do **not** need the Patchy CLI for HTTP.

Ask the Cloud owner for the exact local Cloud URL and an existing Page or Tool you
can open. Installing this connector does not start Cloud or create content. The
Cloud must support device sign-in, `/api/me`, and the Page/Tool APIs in README.
For a disposable Cloud using dev personas, select your assigned test person in
its sign-in page. Never copy another person's login or credentials.

| Address                                        | Used for                                                        |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `PATCHY_CLOUD_URL` supplied by the Cloud owner | Patchy sign-in and existing company content                     |
| `http://127.0.0.1:38143/mcp`                   | This connector; enter this URL in your MCP client               |
| `http://127.0.0.1:38143/healthz`               | Running connector version, build fingerprint and selected Cloud |

`127.0.0.1` refers to the computer running the client. A hosted client cannot reach
it. Keep client and listener on the same computer. No hosting or tunnel is needed.
Port **38141 is commonly used by the local Cloud's Postgres**; don't use it here.
If 38143 is occupied, choose one unused port and change it in **all** listener and
client commands. Keep the chosen port and Cloud URL stable across restarts.

## 1. Install the supplied archive

Obtain `patchy-mcp-0.4.2.tgz`, its `.sha256` file, and this guide from the connector
maintainer. Run from the directory containing those files. There is no public npm
installation or hosted download URL for this build.

```sh
node --version
shasum -a 256 -c patchy-mcp-0.4.2.tgz.sha256
export PATCHY_CONNECTOR_PREFIX="$HOME/.local/share/patchy-mcp/versions/0.4.2"
export PATCHY_CONNECTOR_STATE="$HOME/.local/state/patchy-mcp/local-http"
export PATCHY_CLOUD_URL='<exact-local-cloud-url-from-owner>'
mkdir -p "$PATCHY_CONNECTOR_PREFIX"
mkdir -p -m 700 "$PATCHY_CONNECTOR_STATE"
npm install --global --prefix "$PATCHY_CONNECTOR_PREFIX" \
  --ignore-scripts --omit=dev --no-audit --no-fund \
  --registry http://127.0.0.1:1 "$PWD/patchy-mcp-0.4.2.tgz"
"$PATCHY_CONNECTOR_PREFIX/bin/patchy-mcp" --version
"$PATCHY_CONNECTOR_PREFIX/bin/patchy-mcp" --build-info
```

Replace the Cloud placeholder before continuing. Expected version: `0.4.2`.
The SHA-256 verifies the archive; `--build-info` identifies its code, dependency
lock and shipped instructions. The package bundles compiled code and runtime
dependencies. The unreachable registry demonstrates an offline archive install;
no sudo, global npm prefix change, source checkout or TypeScript tools are needed.

## 2. Start the listener

Keep this terminal open:

```sh
"$PATCHY_CONNECTOR_PREFIX/bin/patchy-mcp" serve \
  --api-url "$PATCHY_CLOUD_URL" --port 38143 \
  --state-dir "$PATCHY_CONNECTOR_STATE"
```

Startup prints the version, fingerprint, MCP URL, Cloud URL and state directory.
In a second terminal, check the running build:

```sh
curl --fail http://127.0.0.1:38143/healthz
```

Expect `ok: true`, version `0.4.2`, the same fingerprint as `--build-info`, and the
intended Cloud. `/healthz` identifies the listener; the first MCP call below checks
that Cloud and your login actually work. Opening `/mcp` without a bearer returns
401; that is expected OAuth protection.

The state directory holds dedicated Cloud credentials and hashed MCP tokens.
It must remain private (directory mode 700, file mode 600), outside your source
checkout and installed package. Keep it between upgrades. Only one listener may
use it at a time. HTTP ignores saved Patchy CLI logins and `PATCHY_API_TOKEN`.

## 3. Connect and sign in as yourself

In the second terminal, check that `codex` selects a compatible CLI, then add
one connection:

```sh
command -v codex
codex --version
codex mcp add patchy-local-http --url http://127.0.0.1:38143/mcp
```

Codex 0.163.0 starts browser sign-in automatically when adding this connection.
Complete that flow once. If your client only saved the connection without
starting sign-in, run:

```sh
codex mcp login patchy-local-http --scopes patchy:tools,patchy:write
```

After sign-in:

```sh
codex mcp get patchy-local-http --json
```

Older clients may not forward the required OAuth `resource` on both authorization
and token requests. Codex 0.135.0 was incompatible in the local check; use the
tested CLI or a compatible newer one rather than weakening server validation.

Use an unused name if `patchy-local-http` already exists; keep that name in all
following commands. These commands leave an existing `patchy` connection alone.
Do not set a bearer-token environment variable for this OAuth connection.

The client opens **Connect to Patchy** (or prints a URL to open):

1. Check the client name and Cloud URL. Choose **Read only** (the default), or
   **Read and write** if this connection should change data. Requesting the write
   scope alone does not approve it.
2. Click **Sign in to Patchy**. It opens Patchy's sign-in/confirmation page directly
   in a new tab, with the connection code already supplied. Sign in as yourself
   and approve the dedicated **MCP: …** connection. There is no code to copy or
   intermediate page with another mandatory sign-in link.
3. Leave the original connecting tab open. It finishes automatically after you
   approve; the CLI reports successful login. You can close the confirmation tab.
   Cancel returns a denial; an expired code requires starting login again.

If JavaScript is disabled, a link-and-code fallback remains available. If a new
tab did not open, the waiting page's **Reopen Patchy sign-in** link recovers it.

Read only permits inventory, Pages, operation metadata and queries. The server
refuses mutations even if the client invokes the advertised `run_mutation` tool.
Read and write additionally permits declared mutations, including deletion when
that Tool actually declares it. Both modes obey the person's existing Cloud and
Tool rules. Neither grants publishing, code editing or arbitrary database access.
For a client requesting only `patchy:tools`, consent offers only Read only.

Codex keeps its OAuth credentials in its configured credential store; the MCP
registration contains a URL, not another person's Cloud login. See the
[official client instructions](https://learn.chatgpt.com/docs/extend/mcp).

## 4. First use

Start a new Codex session (`codex`), or reconnect/reload MCP in your client.
Use the new connection explicitly if you have more than one Patchy connection:

- “Use patchy-local-http to list the Pages and Tools I can access.”
- “Read `<an-existing-page-name-from-that-list>` and summarize it.”
- “Show the operations and required inputs for `<an-existing-tool-from-that-list>`.”
- “Use that Tool to answer `<a-question-covered-by-one-of-its-queries>`.”

Check tool activity: `list_patches`, then `read_page`, or `list_queries` and
`run_query`. Empty inventory can be a valid result. An error is not empty data.
Use names returned by your own inventory; no hardcoded demo content is required.

For an authorized change, inspect `list_operations` first and review the declared
handler and inputs. A read-only connection will refuse `run_mutation`; that is
expected. Change connection permission by revoking and signing in again below.
A Tool without a delete mutation cannot delete through MCP. An uncertain write
must retain its original request and mutation key; never automatically retry it.

## 5. Restart, update and roll back

**Restart:** press Ctrl-C in the listener terminal, then run the exact `serve`
command from step 2 again, with the same state directory, port and Cloud URL.
Reconnect/reload the client or start a new session. Completed sign-ins survive;
a browser sign-in interrupted before completion must start again.

Access tokens last at most one hour. An OAuth client uses its rotating refresh
token automatically. A connection lasts at most **30 days from sign-in**, capped
by the original Cloud credential expiry; refreshing does not extend that limit.
A Cloud revocation or identity change stops access and refresh. If your client
cannot refresh, use the reconnect steps below when its access token expires.
No token is permanent.

**Update:** retain the old archive, checksum and version prefix. Verify the new
archive and install it into a **new version prefix**, repeating step 1 with the
new version in the filename and prefix. Stop the old listener, select the new
`PATCHY_CONNECTOR_PREFIX`, then start step 2 with the **same state directory**.
Check `--build-info` and `/healthz` match the new version/fingerprint; reconnect and
repeat the inventory call. Updating files alone does not replace a running process.
Updates are manual; nothing polls for, downloads or launches an update.

**Roll back:** stop the listener, select the retained previous version prefix,
and repeat step 2. Check `/healthz` and inventory. Keep the **current** OAuth state;
restoring an older state backup could revive a revoked connection. Format 1 is
this build's persistent-state contract. A future build must document a format
change before upgrade; an incompatible state file is refused without overwriting
it. Keep the current archive too so you can return to it.

The earlier **0.3.1** build has no persistence, refresh or connection-permission
enforcement. It cannot retain this build's connections or read-only guarantees.
Do not silently roll a read-only installation back to 0.3.1: revoke its dedicated
Cloud logins first and arrange a fresh connection under that build's capabilities.

## 6. Reconnect or change permission

For a normal listener restart, simply reconnect/reload MCP; no new browser sign-in
is needed while the connection remains valid. For an expired/revoked connection,
a permission change, or a client reporting `invalid_grant`:

1. Revoke the old dedicated **MCP: …** machine in Cloud's **Your machines** page.
   This guarantees server revocation even if the client only forgets credentials.
2. Clear the client's saved OAuth login, then sign in afresh:

```sh
codex mcp logout patchy-local-http
codex mcp login patchy-local-http --scopes patchy:tools,patchy:write
```

Choose the desired permission on the new consent page. Reconnect/reload MCP or
start a new session, then repeat the inventory call. Never repair authentication
by copying a token, deleting the server state, or sharing a developer login.

## 7. Disconnect and revoke

Revoke this connection's dedicated machine in Cloud's **Your machines** page,
then remove only this client connection:

```sh
codex mcp logout patchy-local-http
codex mcp remove patchy-local-http
codex mcp get patchy-local-http --json
```

The final command should report that the connection is absent. Close any old
client session using it. Stop the listener with Ctrl-C if it is no longer needed.
Removing a registration, stopping a listener or uninstalling is not revocation.
An OAuth client that supports revocation can instead call the advertised
`POST /oauth/revoke` with its own client authentication and access or refresh token;
this invalidates the whole local connection and attempts Cloud self-revocation.
If Cloud was unavailable, finish cleanup in **Your machines**.

Optional uninstall of the selected version:

```sh
npm uninstall --global --prefix "$PATCHY_CONNECTOR_PREFIX" \
  --ignore-scripts --no-audit --no-fund patchy-mcp
```

This keeps separate state and other installed versions. Revoke before deleting
state; keep it if any other connection still uses the listener.

## Troubleshooting

| Symptom                            | Next step                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Listener cannot bind               | Check the chosen port; don't stop another service. Change it everywhere and use a new state directory for a new listener URL.      |
| State already in use               | Stop the listener owning that directory. A crashed process's lock is recovered automatically; never remove a live listener's lock. |
| Invalid state, origin or Cloud URL | Restore the original port/Cloud selection and current state; don't reset credentials to repair a build.                            |
| Client cannot reach MCP            | Confirm the listener is running and client is on the same computer. Check `/healthz`.                                              |
| 401 or `invalid_grant`             | Reconnect/revoke and sign in again as above. Check the original Cloud login was not revoked or expired.                            |
| Read-only refusal                  | Revoke and sign in again, explicitly approving Read and write.                                                                     |
| 403 / business refusal             | Cloud or the Tool denied the operation under its own rules. More connector permission does not override them.                      |
| 404                                | Missing/inaccessible content, wrong Cloud URL, or a Cloud build without the requested route. Check with the Cloud owner.           |
| 409                                | Tool state/version changed; inspect fresh metadata before a new intended change.                                                   |
| Cloud unavailable                  | Check the selected local Cloud is running; do not substitute a public endpoint.                                                    |

## Maintainers: build the archive

Only maintainers need this source checkout and build tools:

```sh
npm ci
npm test
npm run test:packed
```

`test:packed` produces the archive/checksum and versioned guide in `artifacts/`,
installs offline with a fresh cache, and checks current/legacy MCP protocols.
`npm run release` does the packaging alone; it uploads nothing. Each changed
release needs a new version in **both** package.json and package-lock.json.
Packaging refuses to replace an existing version's archive with different bytes.
The manifest `patchy-mcp-<version>.json` records version, build fingerprint and
archive SHA-256. Retain archive, checksum, manifest and `INSTALL-<version>.md`
together. Never distribute a state directory or client credentials.

`npm test` includes local HTTP OAuth lifecycle, refresh/replay, restart, permission
and two-user isolation fixtures. The opt-in `test:http-cloud` uses a fresh device
login against an explicitly selected disposable local Cloud, reads existing
inventory and revokes that login. See README for its environment variables.

## Existing stdio connections

Stdio is a separate compatibility path. It requires the matching Patchy CLI and
its own saved login, and does not use HTTP OAuth or its consent permissions.
Do not run these commands as part of the HTTP walkthrough.

```sh
patchy-mcp login --api-url '<selected-cloud-url>' --json
# Complete the returned device-login command after browser approval.
patchy-mcp doctor --api-url '<selected-cloud-url>'
patchy-mcp setup codex --api-url '<selected-cloud-url>' --name patchy-stdio-test
# Later: remove this registration and revoke its separate CLI login.
patchy-mcp remove codex --name patchy-stdio-test
patchy-mcp logout --api-url '<selected-cloud-url>' --json
```

`PATCHY_STATE_DIR` selects stdio's separate CLI state; it is unrelated to HTTP's
`--state-dir`. Stdio uses the saved person's Cloud rights. Setup records absolute
Node/package paths; rerun it if those move. HTTP setup stores only its listener
URL and needs no Patchy CLI installation or saved CLI sign-in.
