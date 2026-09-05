# Companies

The tenant and who is in it: companies, users, roles, invitations, deactivation and reactivation. The future language of groups, verified domains, SSO and the operator is defined here; its product decisions live in [the product](../../docs/product.md#companies), while caller identity belongs to [Auth](../auth/CONTEXT.md) and patch ownership to [Patches](../patches/CONTEXT.md).

## Language

**Company**:
The tenant every user and patch belongs to: exactly one company each, with nothing crossing that line except a patch made public. A company has a display name, a globally unique handle and at least one active admin.
_Avoid_: organization, workspace, team, tenant (this document's word for the concept, never the product's)

**Handle**:
A company's globally unique short name, fixed once created. It uses 3–32 lowercase letters, digits or hyphens, with no leading or trailing hyphen and a reserved set of platform names.
_Avoid_: slug, subdomain, namespace (what the handle opens, not the handle)

**User**:
One individual's Patchy account in exactly one company, carrying the member or admin role. Every active user can build; their machines act for them through [machine tokens](../auth/CONTEXT.md).
_Avoid_: account, person (a user is the account, not the human), builder (every user is one)

**Member**:
The role every user has who is not an admin. A member builds — publishes patches with no gate — and reads the company's users, roles, states and pending invites without management actions.
_Avoid_: viewer (the [Auth](../auth/CONTEXT.md) identity, whatever the user's role), builder (a description, not a role), guest

**Admin**:
A user with the role that manages the company's invitations, roles, deactivation and reactivation. A company always has at least one active admin, and the last one can neither be demoted nor deactivated.
_Avoid_: owner (patches have owners; companies have admins), operator (Patchy, never a company role), superadmin

**Group**:
A named set of users used to grant access, never a container that owns patches or connections. Its future access model is recorded in [the product](../../docs/product.md#users-admins-groups).
_Avoid_: team, department (labels, not concepts), role (what an admin has; a group is who), space

**Invite**:
An invitation for one email address to join a company with a role, live until revoked or consumed rather than expiring. Several companies may invite the same address, each at most once while live; an email already belonging to a user cannot be invited.
_Avoid_: add user, share the company

**Create-or-join**:
The choice a signed-in person without a company makes: accept a live invitation for their email or, without an invitation, name a company and choose its handle as its first admin. The person becomes a user in the chosen company at that moment.
_Avoid_: onboarding wizard, organization picker

**Verified domain**:
A company's proven work-email domain, reserved for domain-based joining and SSO. The future verification and access rules live in [the product](../../docs/product.md#getting-into-a-company).
_Avoid_: allowed domain, auto-join (the effect, not the thing)

**SSO**:
Company sign-in through its own identity provider instead of the ordinary sign-in choices. Its future domain enforcement and setup are recorded in [the product](../../docs/product.md#signing-in).
_Avoid_: enterprise connection (Clerk's word), SAML (one of the two shapes)

**Deactivation**:
An admin ending a user's company access and revoking every machine token while keeping their data. It is reversible through reactivation, but the last active admin cannot be deactivated.
_Avoid_: ban, suspend (the operator's act on a company), delete (the later act)

**Reactivation**:
An admin restoring a deactivated user's access to the same company and data. The user needs fresh machine tokens because keys revoked by deactivation stay revoked.
_Avoid_: un-revoke, restore token

**Suspension**:
The operator's future act of stopping a whole company's serving and publishing while keeping its data. The product's company-level lifecycle is recorded in [the product](../../docs/product.md#the-operator).
_Avoid_: freeze, lock, deactivate (an admin's act on a user)

**Operator**:
Patchy, running the platform, rather than a role inside a company or the driver of the CLI. Its future surfaces are its own login and dashboards, outside the company product and the `patchy` CLI.
_Avoid_: admin (a company role), superuser, staff, the CLI's user
