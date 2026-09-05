# Companies

The tenant and who is in it. `packages/companies` owns companies, users, roles and invites, including deactivation and reactivation; groups, verified domains, SSO and operator surfaces remain future work. Who a caller _is_ — session, login, machine token — is [Auth](../auth/CONTEXT.md)'s; what a user owns is [Patches](../patches/CONTEXT.md)'.

## Language

**Company**:
The tenant everything on Patchy Cloud hangs off, and the unit that pays: every patch, connection, group and user lives in exactly one, usage is counted against it, and nothing inside crosses its line except a patch made public. Flat — groups are access, not structure — with a globally unique handle. Created at signup by its first admin; suspended by the operator (including running out of credits), deleted by its admin with a recovery window.
_Avoid_: organization, workspace, team, tenant (this document's word for the concept, never the product's)

**Handle**:
A company's globally unique short name, fixed once created: 3–32 lowercase letters, digits or hyphens, with no leading or trailing hyphen and a reserved set of platform names. Users and groups will draw their own handles from one per-company namespace; company handles are released only after the company's recovery window.
_Avoid_: slug, subdomain, namespace (what the handle opens, not the handle)

**User**:
One individual with one account, in exactly one company. Signs in (through Clerk: Google, Microsoft or an emailed code, never a password) and holds one machine token per machine they build from. Has one of two roles, member or admin; every member builds. Deactivated (an admin's act: sign-in and tokens end, personal connection credentials are wiped, data kept, owner-only patches go dark) is distinct from deleted (a later act, where the admin is prompted to reassign the user's patches and what is not reassigned goes with the account).
_Avoid_: account, person (a user is the account, not the human), builder (every user is one)

**Member**:
The role every user has who is not an admin. A member builds — publishes patches with no gate — and reaches whatever is shared with them; the role exists only so admin has something to be more than.
_Avoid_: viewer (the person with a patch open, whatever their role), builder (a description, not a role), guest

**Admin**:
A user with the role that runs the company: invites users and manages roles and deactivation; groups, SSO, integrations and reassignment are future powers. A company always has at least one active admin, and the last one can neither be demoted nor deactivated.
_Avoid_: owner (patches have owners; companies have admins), operator (Patchy, never a company role), superadmin

**Group**:
A named set of users an admin creates; a user can be in many. Purely a grant surface — access to patches and connections — never a container that owns anything. "Team" and "department" are names companies give their groups.
_Avoid_: team, department (labels, not concepts), role (what an admin has; a group is who), space

**Invite**:
An invitation for one email address to join a company with a role, live until revoked or consumed and matched case-insensitively at sign-in. Several companies may invite the same address, but each has at most one live invitation for it; joining creates one user in exactly one company, and an existing user cannot join another.
_Avoid_: add user, share the company

**Verified domain**:
A company's email domain, proven by an admin, after which anyone signing in with a work identity on it joins the company automatically. Never a consumer domain; one domain belongs to one company, first-come. Also where SSO is enforced.
_Avoid_: allowed domain, auto-join (the effect, not the thing)

**SSO**:
A company signing its users in through its own identity provider (SAML or OIDC) instead of Google, Microsoft or an emailed code. Patchy flips the flag for the company, the admin sets the connection up themself, and it is enforced on the verified domain — everyone at that domain uses it and nothing else. Paid.
_Avoid_: enterprise connection (Clerk's word), SAML (one of the two shapes)

**Deactivation**:
An admin ending a user's access while keeping their data: sign-in and every machine token stop, and the last active admin cannot be deactivated. Reactivation reverses the user's state, not the revocation of old keys; personal connections and patch retirement follow in their own efforts.
_Avoid_: ban, suspend (the operator's act on a company), delete (the later act)

**Reactivation**:
An admin restoring a deactivated user's access to the same company and data. The user needs fresh machine tokens; keys revoked by deactivation stay revoked.
_Avoid_: un-revoke, restore token

**Suspension**:
The operator's act on a whole company: nothing serves, nothing publishes, data kept. Also where a company lands when it runs out of credits and cannot top up.
_Avoid_: freeze, lock, deactivate (an admin's act on a user)

**Operator**:
Patchy, running the platform. Platform powers only — create, suspend or delete a company, quotas, moderation — never a role inside a company, and never the word for whoever drives the CLI (that is the agent, see [Publishing](../cli/CONTEXT.md)).
Its surfaces are a separate login and separate dashboards, never a company in the product and never in the `patchy` CLI.
_Avoid_: admin (a company role), superuser, staff, the CLI's user
