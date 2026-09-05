# Companies

The tenant and who is in it. A company is what everything on Patchy Cloud hangs off and the unit that pays; this context owns the company, its users and their two roles, its groups, how a person gets in (invite, verified domain, SSO) and out (deactivation, deletion), what the operator may do to a whole company, and nothing about what a user builds. Not yet in code: the package arrives with auth, and this glossary was written first so it lands where the map says. Who a caller _is_ — session, login, machine token — is [Auth](../auth/CONTEXT.md)'s; what a user owns is [Patches](../patches/CONTEXT.md)'.

## Language

**Company**:
The tenant everything on Patchy Cloud hangs off, and the unit that pays: every patch, connection, group and user lives in exactly one, usage is counted against it, and nothing inside crosses its line except a patch made public. Flat — groups are access, not structure — with a globally unique handle. Created at signup by its first admin; suspended by the operator (including running out of credits), deleted by its admin with a recovery window.
_Avoid_: organization, workspace, team, tenant (this document's word for the concept, never the product's)

**Handle**:
A company's globally unique short name, the first segment of every address in it (`acme/sales/pipeline`). Users and groups draw their own handles from one per-company namespace, so the middle segment of an address never collides. First-come, never reserved; released only after the company's recovery window.
_Avoid_: slug, subdomain, namespace (what the handle opens, not the handle)

**User**:
One individual with one account, in exactly one company. Signs in (through Clerk: Google, Microsoft or an emailed code, never a password) and holds one machine token per machine they build from. Has one of two roles, member or admin; every member builds. Deactivated (an admin's act: sign-in and tokens end, personal connection credentials are wiped, data kept, owner-only patches go dark) is distinct from deleted (a later act, where the admin is prompted to reassign the user's patches and what is not reassigned goes with the account).
_Avoid_: account (the wire's word for a principal), person (a user is the account, not the human), builder (every user is one)

**Member**:
The role every user has who is not an admin. A member builds — publishes patches with no gate — and reaches whatever is shared with them; the role exists only so admin has something to be more than.
_Avoid_: viewer (the person with a patch open, whatever their role), builder (a description, not a role), guest

**Admin**:
A user with the role that runs the company: invites users, creates groups, verifies the domain and turns on SSO, connects company integrations, sees every patch in the company (owner-only ones included), and — alone — reassigns a patch's owner. A company always has at least one, and the last admin cannot demote themself.
_Avoid_: owner (patches have owners; companies have admins), operator (Patchy, never a company role), superadmin

**Group**:
A named set of users an admin creates; a user can be in many. Purely a grant surface — access to patches and connections — never a container that owns anything. "Team" and "department" are names companies give their groups.
_Avoid_: team, department (labels, not concepts), role (what an admin has; a group is who), space

**Invite**:
An admin's act of admitting one email address to the company; the person signs in and is in. The default way in, and always available — verifying a domain never replaces it. Refused for someone already in another company: a user is in exactly one, and must leave first.
_Avoid_: add user, share the company

**Verified domain**:
A company's email domain, proven by an admin, after which anyone signing in with a work identity on it joins the company automatically. Never a consumer domain; one domain belongs to one company, first-come. Also where SSO is enforced.
_Avoid_: allowed domain, auto-join (the effect, not the thing)

**SSO**:
A company signing its users in through its own identity provider (SAML or OIDC) instead of Google, Microsoft or an emailed code. Patchy flips the flag for the company, the admin sets the connection up themself, and it is enforced on the verified domain — everyone at that domain uses it and nothing else. Paid.
_Avoid_: enterprise connection (Clerk's word), SAML (one of the two shapes)

**Deactivation**:
An admin's act on a user: sign-in and every machine token end at once, personal connection credentials are wiped, all data is kept, and the user's owner-only patches enter the same kept-but-off state as retire. Patches shared to a group or company-wide stay up. Distinct from deleting the user, which comes later and prompts the admin to reassign what the user owned.
_Avoid_: ban, suspend (the operator's act on a company), delete (the later act)

**Suspension**:
The operator's act on a whole company: nothing serves, nothing publishes, data kept. Also where a company lands when it runs out of credits and cannot top up.
_Avoid_: freeze, lock, deactivate (an admin's act on a user)

**Operator**:
Patchy, running the platform. Platform powers only — create, suspend or delete a company, quotas, moderation — never a role inside a company, and never the word for whoever drives the CLI (that is the agent, see [Publishing](../cli/CONTEXT.md)).
Its surfaces are a separate login and separate dashboards, never a company in the product and never in the `patchy` CLI.
_Avoid_: admin (a company role), superuser, staff, the CLI's user
