# Auth

Who may talk to the hosting API, and who a person is once the door lands. `packages/auth` owns tokens and the principals behind them, self-service minting with its quota and mint records, revocation, bearer parsing, the `accounts` / `api_tokens` / `token_mints` migrations (ids 1 and 2), and the `auth` group of the wire contract — `/api/tokens/self-service`, `/api/me`, `/api/tokens`, `/api/tokens/:id/revoke`. It emits `token.minted` through Analytics and spends the per-minute mint limit through Limits. Nothing here knows what a patch is: `patches` receives the principal from the bearer middleware and never imports this package.

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

**Company**:
The tenant everything on Patchy Cloud hangs off, and the unit that pays: every patch, connection, group and user lives in exactly one, usage is counted against it, and nothing inside crosses its line except a patch made public. Flat — groups are access, not structure — with a globally unique handle. Created at signup by its first admin; suspended by the operator (including running out of credits), deleted by its admin with a recovery window. (Not yet in the code: the door arrives with auth.)
_Avoid_: organization, workspace, team, tenant (this document's word for the concept, never the product's)

**User**:
One individual with one account, in exactly one company. Signs in (through Clerk: Google, Microsoft or an emailed code, never a password) and holds one machine token per machine they build from. Has one of two roles, member or admin; every member builds. Deactivated (an admin's act: sign-in and tokens end, personal connection credentials are wiped, data kept, owner-only patches go dark) is distinct from deleted (a later act, where the admin is prompted to reassign the user's patches and what is not reassigned goes with the account).
_Avoid_: account (the wire's word for a principal), person (a user is the account, not the human), builder (every user is one)

**Admin**:
A user with the role that runs the company: invites users, creates groups, verifies the domain and turns on SSO, connects company integrations, sees every patch in the company (owner-only ones included), and — alone — reassigns a patch's owner. A company always has at least one, and the last admin cannot demote themself.
_Avoid_: owner (patches have owners; companies have admins), operator (Patchy, never a company role), superadmin

**Group**:
A named set of users an admin creates; a user can be in many. Purely a grant surface — access to patches and connections — never a container that owns anything. "Team" and "department" are names companies give their groups.
_Avoid_: team, department (labels, not concepts), role (what an admin has; a group is who), space

**Integration**:
A capability Patchy ships — Salesforce, Gmail, Postgres — built and maintained by Patchy, the same for every company, declaring the connection mode or modes it supports: company, personal, or both. A company-scoped primitive (see [Patches](../patches/CONTEXT.md)). There is no bring-your-own source: companies request integrations and Patchy builds them.
_Avoid_: connector, app (Zapier's word), resource (Retool and Windmill's word), toolkit

**Connection**:
The live, credentialed instance of an integration. Company mode: connected once by an admin, granted to groups or company-wide, carrying a handle alongside its integration (`postgres/warehouse`) so a company can hold many per integration. A patch uses it through the cloud as the viewer — the credential applied server-side, the viewer's grant checked, every call logged — and patch code never sees the credential at any tier.
_Avoid_: datasource, connected account, credential (what it holds, not what it is)

**Personal connection**:
A connection in personal mode: one user's own — their Gmail — made by the user with no admin involved, at most one per integration per user, dying with the account (credential wiped, stored data kept). Holding it is sufficient: any patch the user opens that declares the integration acts on it as them, with no per-patch consent step.
_Avoid_: user resource, private connection

**Member**:
The role every user has who is not an admin. A member builds — publishes patches with no gate — and reaches whatever is shared with them; the role exists only so admin has something to be more than.
_Avoid_: viewer (the person with a patch open, whatever their role), builder (a description, not a role), guest

**Session**:
What signing in produces: one login, good across every Patchy Cloud page and patch, held by Clerk on the browser. A link opened without one shows the login door and lands back on the patch. Deactivation ends every session of the user at once, including patches they have open.
_Avoid_: token (a machine's credential, not a browser's), cookie (how, not what)

**Invite**:
An admin's act of admitting one email address to the company; the person signs in and is in. The default way in, and always available — verifying a domain never replaces it. Refused for someone already in another company: a user is in exactly one, and must leave first.
_Avoid_: add user, share the company

**Verified domain**:
A company's email domain, proven by an admin, after which anyone signing in with a work identity on it joins the company automatically. Never a consumer domain; one domain belongs to one company, first-come. Also where SSO is enforced.
_Avoid_: allowed domain, auto-join (the effect, not the thing)

**SSO**:
A company signing its users in through its own identity provider (SAML or OIDC) instead of Google, Microsoft or an emailed code. Patchy flips the flag for the company, the admin sets the connection up themself, and it is enforced on the verified domain — everyone at that domain uses it and nothing else. Paid.
_Avoid_: enterprise connection (Clerk's word), SAML (one of the two shapes)

**Device login**:
How a machine comes to act as a user: `patchy login` prints a URL and a short code, the person opens the URL in a browser already signed in, confirms the code on screen is the one on their terminal, names the machine on a first login, and the CLI receives a machine token. The confirmation is what defeats a relayed code. The only login route for now.
_Avoid_: device flow (the protocol), OAuth, paste your token

**Machine token**:
The credential a machine holds to act as one user, issued by device login and owned by that user: one per machine, shared by every agent on it, named by the person, Patchy's own (never the identity provider's, so publishing waits on no one). Expires 90 days after login or 30 days after last use, whichever first; revoked one at a time or all at once from _Your machines_, and by deactivation. Every version records the token that published it. Replaces the self-service token; today's token rows are its ancestor.
_Avoid_: API key, personal access token, agent token (an agent has no token of its own), CI token (CI holds an ordinary machine token through `PATCHY_API_TOKEN`)

**Your machines**:
The user's list of their machine tokens — name, last use — with revoke-one and revoke-all. The self-service side of revocation.
_Avoid_: sessions (a browser's), API keys

**Operator**:
Patchy, running the platform. Platform powers only — create, suspend or delete a company, quotas, moderation — never a role inside a company, and never the word for whoever drives the CLI (that is the agent, see [Publishing](../cli/CONTEXT.md)).
_Avoid_: admin (a company role), superuser, staff, the CLI's user
