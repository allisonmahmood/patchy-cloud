# Auth

Who may talk to the hosting API. `packages/auth` owns tokens and the principals behind them, self-service minting with its quota and mint records, revocation, bearer parsing, the `accounts` / `api_tokens` / `token_mints` migrations (ids 1 and 2), and the `auth` group of the wire contract — `/api/tokens/self-service`, `/api/me`, `/api/tokens`, `/api/tokens/:id/revoke`. It emits `token.minted` through Analytics and spends the per-minute mint limit through Limits. Nothing here knows what a patch is: `patches` receives the principal from the bearer middleware and never imports this package.

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
A token the instance mints for anyone who asks, on instances that allow it; it controls exactly the patches it creates, because its principal is 1:1 with it by construction and the ordinary account-scoped ownership checks do the rest.
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
An operator's act of permanently disabling a token. Revoked is a state the row enters, never a deletion — the mint provenance survives, and patch versions still reference the token that created them. Idempotent: the first `revokedAt` stands, because it is when the token's patches stopped getting retention top-ups. There is no un-revoke; a replacement is a fresh mint.
_Avoid_: ban, token deletion

**Bearer parsing**:
How the hosting server reads `Authorization`: the scheme is case-insensitive, one or more spaces or tabs separate it from the credential, trailing whitespace is tolerated, anything else on the line is invalid. Missing and invalid are told apart here only; on the wire both are one 401, `{ ok: false, error: "Missing or invalid API token." }`, so no configuration ever admits a tokenless request.
_Avoid_: header validation
