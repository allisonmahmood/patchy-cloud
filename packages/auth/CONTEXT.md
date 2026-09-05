# Auth

Who a caller is. Auth owns browser sessions, viewers, machine tokens, revocation and bearer parsing, the sign-in and sign-out pages, and the `auth` API routes; device login arrives next. Auth depends on [Companies](../companies/CONTEXT.md) for the users and companies behind credentials; [Patches](../patches/CONTEXT.md) receives the identity from bearer middleware without importing Auth.

## Language

**Machine token**:
The credential a machine holds to act as one user, shared by the agents on it and named for the machine. Only its hash is stored; it expires 90 days after minting or after 30 idle days, whichever comes first, and every version records the machine token that published it.
_Avoid_: API key, personal access token, agent token (an agent has no identity of its own)

**Identity**:
The user, their company and role, and the machine acting for them on a bearer-authenticated request. Every bearer is a user; a different machine token for that user reaches the same patches.
_Avoid_: account, principal (on the wire), scopes

**Revocation**:
Permanently disabling a machine token, including when its user is deactivated; a bearer can revoke itself through logout. The row and its original revocation time survive for version provenance, and visits keep topping up patch retention regardless; reactivation never restores a revoked key.
_Avoid_: ban, token deletion

**Bearer parsing**:
How the hosting server reads `Authorization`: the scheme is case-insensitive, one or more spaces or tabs separate it from the credential, trailing whitespace is tolerated, anything else on the line is invalid. Missing and invalid are told apart here only; on the wire both are one 401, `{ ok: false, error: "Missing or invalid API token." }`, so no configuration ever admits a tokenless request.
_Avoid_: header validation

**Session**:
The browser's sign-in held by Clerk, verified locally by Patchy and refreshed while a person reads a first-party page. A session can exist before a company is chosen or after deactivation; sign-out is available in both states, while deactivation refuses access on the next page load.
_Avoid_: token (a machine's credential, not a browser's), cookie (how, not what)

**Viewer**:
The signed-in user, their company and role on a first-party page, without a machine credential. A viewer exists only after create-or-join and while the user is active; their email and name follow their current sign-in.
_Avoid_: bearer, machine, principal

**Device login**:
How a machine comes to act as a user: `patchy login` prints a URL and a short code, the person opens the URL in a browser already signed in, confirms the code on screen is the one on their terminal, names the machine on a first login, and the CLI receives a machine token. The confirmation is what defeats a relayed code. The only login route for now.
_Avoid_: device flow (the protocol), OAuth, paste your token

**Your machines**:
The user's list of their machine tokens — name, last use — with revoke-one and revoke-all. The user's control over which machines may act for them.
_Avoid_: sessions (a browser's), API keys
