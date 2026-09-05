# Auth

Who a caller is: Clerk sessions and viewers, user-owned machine tokens, device login and revocation. Auth draws the user and company behind each credential from [Companies](../companies/CONTEXT.md); [Patches](../patches/CONTEXT.md) uses the resulting identity without owning authentication.

## Language

**Machine token**:
The credential a machine holds to act as one user, shared by the agents on it and named for the machine. It expires 90 days after minting or after 30 idle days, whichever comes first; a version keeps the machine token that published it as provenance.
_Avoid_: API key, personal access token, agent token (an agent has no identity of its own)

**Identity**:
The user, their company and role, and the machine acting for them on a bearer-authenticated request. Every bearer is a user; a different machine token for that user reaches the same patches.
_Avoid_: account, principal (on the wire), permission set

**Revocation**:
Permanently ending a machine token's authority, whether by its user, replacement at login or the user's deactivation. Its provenance survives, patch retention is unchanged, and reactivation never restores it.
_Avoid_: ban, token deletion

**Bearer parsing**:
The boundary that extracts a machine credential from a request's Authorization header. Missing and invalid credentials are indistinguishable to a protected API caller.
_Avoid_: header validation

**Session**:
The browser's sign-in held by Clerk and kept fresh while a person reads a first-party page or company patch. A session can exist before a company is chosen or after deactivation, so signing out remains available even when company access is refused.
_Avoid_: token (a machine's credential, not a browser's), cookie (how, not what)

**Viewer**:
The signed-in user, their company and role on a first-party page or at a company patch's login door, without a machine credential. A viewer exists only after create-or-join and while the user is active; their email and name follow their current sign-in.
_Avoid_: bearer, machine, principal

**Device login**:
The authorization of a machine through a short-lived URL and code that the person confirms, never types, in their signed-in browser. Confirmation records their answer and machine name; only the terminal's poll mints and receives the machine token, once, so an abandoned confirmation creates no credential.
_Avoid_: device flow (the protocol), OAuth, paste your token

**Your machines**:
The user's list of live machine tokens — name, creation, last use and expiry — with revoke-one and revoke-all. The user's control over which machines may act for them; browser sign-out lives here too.
_Avoid_: sessions (a browser's), API keys
