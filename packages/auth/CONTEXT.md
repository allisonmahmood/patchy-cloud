# Auth

Who a caller is. `packages/auth` owns the credentials a request carries and the principal behind each: today the token, self-service minting with its quota and mint records, revocation, bearer parsing, the `accounts` / `api_tokens` / `token_mints` migrations (ids 1 and 2), and the `auth` group of the wire contract — `/api/tokens/self-service`, `/api/me`, `/api/tokens`, `/api/tokens/:id/revoke`; once login lands, the browser session, device login and the machine token that replaces self-service minting. It emits `token.minted` through Analytics and spends the per-minute mint limit through Limits. Nothing here knows what a patch is (`patches` receives the principal from the bearer middleware and never imports this package), and nothing here knows what a company is: the tenant, its users, roles and groups are [Companies](../companies/CONTEXT.md)'.

## Language

**Token**:
The bearer credential every API request but the mint carries. Only its hash is stored, so the plaintext appears exactly once — in the response that issued it — and no later response, and no operator, can produce it again. A token holds scopes; `admin` satisfies every scope.
_Avoid_: API key, session

**Principal**:
The internal ownership row behind a token, one per self-service mint. Plumbing, never surfaced to users: the wire calls it `accountId`, and the moderation surface `principalId`.
_Avoid_: account (in product language), user

**Bootstrap principal**:
The operator's own principal and admin token, seeded from `PATCHY_BOOTSTRAP_API_TOKEN` when the tokens layer builds. The only principal with a fixed id; every other one is a mint found by lookup. Re-seeding is idempotent and restores a rotated or revoked bootstrap token.
_Avoid_: root account, superuser

**Self-service token**:
A token the instance mints for anyone who asks, on instances that allow it; it controls exactly the patches it creates, because its principal is 1:1 with it by construction and the ordinary account-scoped ownership checks do the rest. Public hosting's door; retires with login ([Identity and access](https://github.com/allisonmahmood/patchy-cloud/issues/19)), when the machine token replaces it.
_Avoid_: anonymous token, first-run token

**Self-service minting**:
The zero-input, unauthenticated operation that creates a self-service token and returns its plaintext exactly once. Three guardrails stand in for authentication, in this order: the instance's enabled flag, the per-address per-minute mint limit, then the mint quota — so a caller parked at the quota is throttled rather than left to re-count the database.
_Avoid_: signup, registration, anonymous uploads (there is no upload without a token)

**Mint record**:
The row a self-service mint leaves behind: which principal and token were created, from what source address, and when. It is what the mint quota counts, and it outlives revocation — a token can be turned off, but where it came from stays reviewable. A mint the server could not attribute to an address lands in the null bucket rather than escaping the count.
_Avoid_: audit log, signup record

**Mint quota**:
The ceiling on self-service mints one source address may be handed, counted from the mint records inside a rolling day ending now — not a calendar day, which would reset at an instant every client can predict and needs a timezone. A database count, so it survives a restart; the per-minute mint limit is the in-memory half. Counted inside the mint's own transaction.
_Avoid_: mint limit (that is the per-minute one), signup limit

**Revocation**:
An operator's — or, once login lands, the token's own user's — act of permanently disabling a token. Revoked is a state the row enters, never a deletion — the mint provenance survives, and patch versions still reference the token that created them. Idempotent: the first `revokedAt` stands, because it is when the token's patches stopped getting retention top-ups. There is no un-revoke; a replacement is a fresh mint.
_Avoid_: ban, token deletion

**Bearer parsing**:
How the hosting server reads `Authorization`: the scheme is case-insensitive, one or more spaces or tabs separate it from the credential, trailing whitespace is tolerated, anything else on the line is invalid. Missing and invalid are told apart here only; on the wire both are one 401, `{ ok: false, error: "Missing or invalid API token." }`, so no configuration ever admits a tokenless request.
_Avoid_: header validation

**Session**:
What signing in produces: one login, good across every Patchy Cloud page and patch, held by Clerk on the browser. A link opened without one shows the login door and lands back on the patch. Deactivation ends every session of the user at once, including patches they have open.
_Avoid_: token (a machine's credential, not a browser's), cookie (how, not what)

**Device login**:
How a machine comes to act as a user: `patchy login` prints a URL and a short code, the person opens the URL in a browser already signed in, confirms the code on screen is the one on their terminal, names the machine on a first login, and the CLI receives a machine token. The confirmation is what defeats a relayed code. The only login route for now.
_Avoid_: device flow (the protocol), OAuth, paste your token

**Machine token**:
The credential a machine holds to act as one user, issued by device login and owned by that user: one per machine, shared by every agent on it, named by the person, Patchy's own (never the identity provider's, so publishing waits on no one). Expires 90 days after login or 30 days after last use, whichever first; revoked one at a time or all at once from _Your machines_, and by deactivation. Every version records the token that published it. Replaces the self-service token; today's token rows are its ancestor.
_Avoid_: API key, personal access token, agent token (an agent has no token of its own), CI token (CI holds an ordinary machine token through `PATCHY_API_TOKEN`)

**Your machines**:
The user's list of their machine tokens — name, last use — with revoke-one and revoke-all. The self-service side of revocation.
_Avoid_: sessions (a browser's), API keys
