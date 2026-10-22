# Auth

Who a caller is: Clerk sessions and viewers, user-owned machine tokens and agent connections, device login, client documents, consent and revocation. Auth draws the user and company behind each credential from [Companies](../companies/GLOSSARY.md); [Patches](../patches/GLOSSARY.md) uses the resulting identity without owning authentication.

## Language

**Purpose**:
What a person's credential is for. `build` is a machine token's and opens the CLI's API; `work` is an agent connection's and opens only Patchy MCP. A credential used at the wrong door is refused as unknown.
_Avoid_: scope (OAuth's word), token type

**Machine token**:
The `build` credential a machine holds to act as one user, shared by the agents on it and named for the machine. It expires 90 days after minting or after 30 idle days, whichever comes first; a version keeps the machine token that published it as provenance.
_Avoid_: API key, personal access token, agent token (an agent has no identity of its own)

**Agent connection**:
One person's consent for one install of an MCP client, such as Claude or Codex, to use their company's patches as them through Patchy MCP: the `work` credential. Each consent makes a new one and replaces none. It lasts until its person disconnects it, 30 days pass without a call, a refresh token is reused, or the person is deactivated, and it works only while agent access is on.
_Avoid_: connection on its own (Integrations' company source), integration, app (the client, not the connection), grant

**Consent**:
The person's answer, in their signed-in browser, to a client asking to connect as them. It is asked every time and counts only for the account the page showed, for ten minutes after the page was shown. A yes records nothing but a code for that account, good for a minute and bound to the client, its redirect and its PKCE challenge; a no records nothing. Only the client's code exchange creates the agent connection, once: a replayed code ends the connection it made. Disconnect everything, deactivation and agent access off cancel a code not yet exchanged.
_Avoid_: authorization (the protocol), approval

**Client document**:
The JSON an MCP client publishes on its own site to name itself; its https URL is the client's id. Patchy fetches it when the client asks to connect, accepts it only when its `client_id` is that URL and it offers the `none` auth method, and sends an answer only to a redirect it lists. Patchy keeps no registrations and trusts no list of clients; a consent page shows the document's name and site.
_Avoid_: registration, client metadata on its own (any client's fields), trusted client

**Identity**:
The user, their company and role, and the machine or agent connection acting for them on a bearer-authenticated request. Every bearer is a user; a different machine token for that user reaches the same patches.
_Avoid_: account, principal (on the wire), permission set

**Revocation**:
Permanently ending a machine token's or agent connection's authority, whether by its user, replacement at login, a reused refresh token or the user's deactivation. Its provenance survives, its patches keep their lifecycle state, and reactivation never restores the token. Disconnect everything and deactivation also record when the person's credentials ended, and nothing made or approved at or before then works again, whichever release ended it.
_Avoid_: ban, token deletion

**Bearer parsing**:
The boundary that extracts a machine token or an agent connection's access token from a request's Authorization header. Missing and invalid credentials are indistinguishable to a protected API caller.
_Avoid_: header validation

**Session**:
The browser's sign-in held by Clerk and kept fresh while a person reads a first-party page or company patch. A session can exist before a company is chosen or after deactivation, so signing out remains available even when company access is refused. Tier 2 viewer callbacks trust the admission JWT until its expiry, then share one backend session check for the rest of the invocation. Database membership, role and deactivation are still checked on every callback.
_Avoid_: token (a machine's credential, not a browser's), cookie (how, not what)

**Viewer**:
The signed-in user, their company and role on a first-party page or at a company patch's login door, without a machine credential. A viewer exists only after create-or-join and while the user is active; their email and name follow their current sign-in.
_Avoid_: bearer, machine, principal

**Device login**:
The authorization of a machine through a short-lived URL and code that the person confirms, never types, in their signed-in browser. Confirmation records their answer and machine name; only the terminal's poll mints and receives the machine token, once, so an abandoned confirmation creates no credential. Disconnect everything and deactivation cancel a confirmation whose terminal hasn't collected its token.
_Avoid_: device flow (the protocol), OAuth (how agent connections are made), paste your token

**Your machines**:
The user's list of their live agent connections and machine tokens, with disconnect one agent, revoke one machine, and disconnect everything, which also cancels approvals not yet collected. The user's control over which agents and machines may act for them; browser sign-out lives here too.
_Avoid_: sessions (a browser's), API keys
