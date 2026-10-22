# Connect Patchy MCP

Requires Node 22.22+ and the exact Cloud URL supplied by its owner. This is a local,
unreleased prototype. The matching Cloud must have the Page, operation catalog
and machine handler routes; stdio also needs its matching Patchy CLI on PATH.
The add-on stays separate from Cloud's deployment.

## Install

From `addons/patchy-mcp` in this checkout:

```sh
npm ci
npm test
npm pack
```

Install the resulting archive on the agent's machine:

```sh
npm install --global ./patchy-mcp-0.4.2.tgz
patchy-mcp --version
```

npm bundles compiled code and runtime dependencies; installation needs no source
build. Development uses `npm run build`, then `node /absolute/path/to/dist/cli.js`.

## Existing HTTP connection

HTTP uses a separate dedicated person login per connection and does not require
the Patchy CLI. Start the loopback listener and keep its terminal open:

```sh
patchy-mcp serve --api-url '<exact-cloud-url>' --port 38143 \
  --state-dir "$HOME/.local/state/patchy-mcp/local-http"
```

The client and listener must share a computer. Keep the port, Cloud URL and state
directory stable across restarts. The state directory must be private (mode 700),
outside the installed package; the credential file is mode 600. One listener owns
it. `curl --fail http://127.0.0.1:38143/healthz` reports version and selected Cloud.
An unauthenticated request to `/mcp` returns 401.

Use the existing OAuth-capable client registration. For a new Codex registration:

```sh
codex mcp add patchy-local-http --url http://127.0.0.1:38143/mcp
codex mcp login patchy-local-http --scopes patchy:tools,patchy:write
```

Complete the browser sign-in as yourself. The consent page defaults to **Read
only**; choose **Read and write** to allow declared mutations. The Patchy tab opens
directly, while the original tab waits and completes OAuth automatically. Clients
must send the required OAuth resource indicator. Change permission by reconnecting
and consenting again; refresh cannot widen it. HTTP ignores saved CLI credentials
and `PATCHY_API_TOKEN`.

Completed sign-ins survive restarts and installation updates. Access expires in
at most one hour; rotating refresh credentials retain the same person until the
finite grant or original Cloud credential expires. Reused refresh credentials
revoke the connection. Cloud's **Your machines** page or the OAuth revocation
endpoint can revoke it. Disconnecting or stopping the listener alone does not.

## Existing stdio connection

Stdio reuses the person's Patchy CLI login. Sign in using the existing command:

```sh
patchy login --api-url '<exact-cloud-url>' --json
```

Give the person the verification URL/code and run its returned completion command.
Confirm identity with `patchy whoami --api-url '<exact-cloud-url>' --json`. The
connector uses the explicit credential export through a private subprocess pipe;
never run or log secret-bearing `auth token` output by hand. Re-login repairs the
same running connection. Separate people use separate OS logins or `PATCHY_STATE_DIR`.

The existing helpers remain available:

```sh
patchy-mcp doctor --api-url '<exact-cloud-url>'
patchy-mcp setup codex --api-url '<exact-cloud-url>' --name patchy
```

Alternatively configure any stdio MCP client directly with the absolute executable
path and environment containing `PATCHY_API_URL` and a PATH with the matching CLI.
Do not store tokens in client config. The Codex helper clears a parent test token
and forwards the selected private login directory. `patchy-mcp login/logout`
continue to delegate to Patchy's existing commands. An empty terminal without a
command is normal: stdio waits for its client.

## Use, disconnect and update

Ask the agent to list accessible patches, read an existing Page, or inspect a
Tool's operations before calling it. Create/update/delete require existing declared
mutations. Keep one key per intended change. An unknown write outcome requires
explicit recovery with the original request; never automatically retry or replace
the key. See [README.md](README.md) for the contract.

For stdio, `patchy-mcp remove codex --name patchy` removes the registration;
`patchy logout --api-url '<exact-cloud-url>' --json` revokes the selected machine
credential. For HTTP, use the client's logout/remove commands and revoke the
connection's dedicated machine through **Your machines** when retiring it.
Uninstalling or stopping MCP leaves separately managed logins intact.

Updates are manual: stop the MCP process, install a replacement archive, then
reconnect. Keep the same HTTP state directory. Reinstall an older archive to roll
back the connector. No custom release metadata or automatic updater is involved.
