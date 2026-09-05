# Auth

Who a caller is. Auth owns browser sessions, viewers, machine tokens, device login, revocation and bearer parsing, the sign-in and sign-out pages, Your machines, and the `auth` API routes. Auth depends on [Companies](../companies/CONTEXT.md) for the users and companies behind credentials; [Patches](../patches/CONTEXT.md) receives the identity from bearer middleware without importing Auth.

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
How the hosting server reads `Authorization`: the scheme is case-insensitive, one or more spaces or tabs separate it from the credential, trailing whitespace is tolerated, anything else on the line is invalid. Missing and invalid are told apart here only; protected routes answer both with one 401, `{ ok: false, error: "Missing or invalid API token." }`. Only starting and polling a device login need no bearer.
_Avoid_: header validation

**Session**:
The browser's sign-in held by Clerk, verified locally by Patchy and refreshed while a person reads a first-party page or company patch. A session can exist before a company is chosen or after deactivation; sign-out is available in both states, while deactivation refuses access on the next page load.
_Avoid_: token (a machine's credential, not a browser's), cookie (how, not what)

**Viewer**:
The signed-in user, their company and role on a first-party page or at a company patch's login door, without a machine credential. A viewer exists only after create-or-join and while the user is active; their email and name follow their current sign-in.
_Avoid_: bearer, machine, principal

**Device login**:
How a machine comes to act as a user: the terminal prints a URL carrying a short code, the person opens it in their signed-in browser, confirms the displayed code matches their terminal, and names the machine. The code is confirmed, never typed. Confirmation authorizes the login; the terminal's poll mints and receives the machine token exactly once. An abandoned confirmation creates no credential. The only machine login route for now.
_Avoid_: device flow (the protocol), OAuth, paste your token

**Your machines**:
The user's list of live machine tokens — name, creation, last use and expiry — with revoke-one and revoke-all. The user's control over which machines may act for them; browser sign-out lives here too.
_Avoid_: sessions (a browser's), API keys
