# Patchy Cloud

The product, written down where agents read it. Each section is the resolution of one decision on the [foundation map](https://github.com/allisonmahmood/patchy-cloud/issues/5); the glossaries in each `CONTEXT.md` carry the words, this file carries the shape.

## Patches

A **patch** is the unit of what people build and deploy on Patchy Cloud — anything from a static page to a full CRM. A tier 0 page and a CRM are both patches for the same reason: each is one built thing in a company's cloud, stored as one, permissioned as one, provisioned as one, at one address, at one runtime tier. What differs between them is the tier they need — a CRM is a CRUD app, so it needs tier 2 — never what kind of thing they are.

### What a patch is made of

A patch is a **file tree**. The folder it is built in is the **patch repo**: the tree plus its id, its declared **tier**, and base config. Today's single HTML upload is a one-file tree with no repo; from tier 1 up, the CLI initialises the repo with the SDK and the parts the patch needs to run, and a person or their agent builds inside it. One repo is the working copy of exactly one patch: publishing from it updates that patch, cloning it elsewhere still publishes to the same patch, and the first publish from a repo with no id creates the patch and writes the id back.

A patch has exactly one tier, declared in its repo. The structure of the tree says what the code is trying to do — client code, server code, and from tier 3 work that runs with no viewer present — so the cloud checks the declared tier against the tree and refuses a publish that claims less than the tree does. A patch is never two tiers at once.

A patch may say it needs a **primitive** — its own file storage or tables, or a company connection — and the cloud provides it: the patch's own are provisioned as part of the patch, a connection must already exist in the company (see [Integrations](#integrations)).

### Who makes one, and how it gets in

A person, or an agent acting for them, through the `patchy` CLI. That is the only route today. The later routes are the same route: the SDK is what `init` puts in the repo, and the AI builder is an agent with the same skills and SDK, working on a sandboxed computer Patchy runs instead of the person's own machine. All three produce the same unit.

Ownership: a patch belongs to a **user** in a company. The user holds a machine token per device, every token acts for that user, and replacing a token never changes who owns their patches.

### Versions and publishing

**Publish** is the act; every publish is a new immutable **version**, and the patch serves the version its pointer names. Rollback moves the pointer. There is no working copy in the cloud and no unpublished patch — the working copy is the local repo, and the act that creates a patch is the act that makes it live.

### Sharing and finding

A published patch is visible to **everyone in the company** by default. Its owner can tighten that (to the owner plus named users, or to one group) or widen it to anyone with the link. No patch is public without a login unless someone chose that; who may open, and who may change, a patch is spelled out under [Identity and access](#access-to-a-patch).

Finding a patch is a portal of everything you have access to. A patch's identity is its **id**, so two sales dashboards made by two salespeople never collide; its human-readable address follows its sharing scope (see [Addresses](#addresses)).

### Updating, retiring, deleting

Updating is publishing again. A patch never expires on its own in the intended company model: expiry and the retention clock are inherited from public hosting and leave in the expiry-removal effort; pins are already gone. Two exits remain: **retire** takes a patch off its address and keeps it, restorable by its owner; **delete** removes it for good after a recovery window.

### Patches and other patches

Today patches reference each other by address, nothing more. The long-run vision is composition (a tier 1 or 2 patch calling another) and **extensions** — a patch that plugs into another patch. Both are promised, neither is designed.

### What a patch is not

Not a **connection** (a connected source belongs to the company or a user, and a patch uses it), not a **primitive** (a patch declares and uses those), not a **company**, not a **version** (part of a patch), not an **agent** or a skill (those make patches). A patch is not a source of data, not a place data lives, and not the people using it.

## Runtime tiers

A **tier** is where a patch's code runs, and nothing else. Tier 0 is **static**: no code runs anywhere. Tier 1 is **browser**: code runs in the viewer's browser, as the viewer. Tier 2 is **hosted**: the patch also has server-side code Patchy runs for it, while someone has the patch open. Beyond them, and not designed: tier 3 runs with no viewer present — automations, a thing that persists — and tier 4 gives an agent its own computer to work in (the shape Daytona fits). The numbers are the names; the glosses are for context.

### What a tier changes, and what it never changes

A tier changes where code runs. It never changes who can open a patch, what a patch may declare it needs, or how it is published, versioned, retired, shared or found — those are identical at every tier. A person opening a patch never thinks about its tier: they are inside their company's cloud, so the patch opens; if they are not logged in they log in once and land back on it. That door is the same for a tier 0 page and a tier 2 CRM, and it sits in front of the page, not inside it. (Today there is no login; the door arrives with auth.)

A patch may be set **public** — anyone with the link, no login — at any tier. That is a tier 0 story: a page the sales team hands a client. Above tier 0 it is allowed but pointless, because an anonymous viewer carries no identity and nothing acts as them, so a public tier 1 patch is client code with no company access and a public tier 2 patch serves through its own identity only. Setting a patch above tier 0 to public warns the agent and the person exactly that.

### Tier 0 — static

The uploaded document and nothing else: no script runs in the page, so the page cannot watch the reader or reach anything. What carries over from public hosting is the part of the [serving guarantees](../packages/serving/CONTEXT.md) about the page itself — a locked, script-free CSP; caching keyed to URL shape, so a version URL is immutable and the latest URL follows the patch; open to any agent that may open it, never bot-blocked. What does not carry over is "no session on the serving host": once auth lands, the host knows who opened the page in order to let them in. The promise becomes _the page cannot watch you_, not _nobody knows you were here_.

### Tier 1 — browser

Code runs in the viewer's browser and acts **as the viewer**. It never holds a credential: not the Patchy session, not an integration token, not another patch's storage. It learns who the viewer is as claims, and it reaches everything else — the patch's primitives (its tables, its files) and the company's integrations — through Patchy, which performs the call as the viewer within the viewer's own permissions. A tier 1 patch can therefore never do more than the person using it could do themselves. Nothing leaves the browser except through Patchy: there is no direct outbound to third-party APIs, credentialed or not — reaching outside systems is what integrations are for.

What tier 1 cannot do is anything the viewer's browser is not there to do: no pre-processing before the data reaches the page, no work on behalf of one viewer visible to another. Save a photo to file storage and it is saved; that is the whole story.

### Tier 2 — hosted

The patch also has server-side code, and Patchy runs it **while a viewer has the patch open**: it starts when someone asks, serves requests and live connections to every open client (two people with the same patch open can be kept in sync), and stops when nobody is looking. It costs nothing when nobody has it open. The line to tier 3 is the question a builder can answer: _does this need to happen when nobody has it open?_ If yes, it is not tier 2.

The server side is handler-shaped code Patchy runs, with a fixed layout `init` lays down — not an arbitrary app listening on a port. Bringing a whole app is a second runtime with a second set of limits, and is not promised.

Server-side code has two identities available. Company data and integrations are reached **as the viewer** by default, exactly as at tier 1. The patch's own primitives are reached as the **patch identity**: a principal of its own, accountable to the patch's owner (reassignable, so a patch outlives its owner's account), starting with nothing but the patch's own primitives and gaining a shared integration only when a company admin grants it. Neither identity ever sees a raw credential; credentials stay behind Patchy at every tier. As at tier 1, nothing leaves except through Patchy.

When a patch asks for data the viewer may not reach, the viewer is told plainly that this is their access, not the patch being broken.

### Declaring and changing a tier

The tier is an explicit field in the patch repo, written by `init`, and the cloud checks it against the tree on every publish: a tree with server code cannot claim tier 1, a tree with script cannot claim tier 0. A **version** has exactly one tier; the patch's tier is the tier of the version it serves. Changing tier is publishing a version built for the new tier — there is no move in place, because tier 2 code is not tier 1 code. Rolling back to an older version rolls the tier back with it. Primitives belong to the patch, not the tier, so they persist across the change.

## Companies

A **company** is the tenant everything on Patchy Cloud hangs off, and the unit that pays. Every patch, connection, group and user lives in exactly one company; usage is counted against the company; nothing inside crosses the company line except a patch someone chose to make public. A company is flat — no sub-tenants; groups are access, not structure — and carries a globally unique **handle** alongside its display name.

A company comes to exist at signup: the person signing up names it and becomes its first admin. Self-serve billing — put in a card, set when it tops up, invite others — is the intended path. There is no person without a company: a solo builder is a company of one.

### Users, admins, groups

A **user** is one individual with one account, in exactly one company. They sign in, and they hold expiring, rotatable tokens on the machines they build patches from — see [Identity and access](#identity-and-access).

An **admin** is a user with the role that runs the company: invites users, creates groups, sets permissions, connects company integrations, and — alone — reassigns a patch's owner. A company always has at least one admin, and the last admin cannot demote themself.

Today `/company` lists users, roles, active/deactivated state and pending invites.
Admins manage invitations, roles, deactivation and reactivation there; members
read the same page without actions. The last active admin cannot be demoted or
deactivated. Reactivation restores sign-in to the same company and data, but
machine tokens revoked by deactivation remain revoked.

A **group** is a named set of users an admin creates; a user can be in many. "Team", "department", "north-american-sales" are names companies give their groups, not concepts of their own. A group is purely a grant surface — access to patches and connections — never a container that owns anything.

### Ownership and deactivation

A patch belongs to a user, and everything ultimately belongs to the company, because the company is what pays. The two sentences meet at **deactivation**: an admin deactivating a user ends their sign-in and tokens and wipes the credentials of their personal connections, keeps all data, and takes down the patches only they could reach — a deactivated user's owner-only patches, and those patches' provisioned primitives, enter the same kept-but-off state as retire, so a thousand departed builders never leave a thousand dead patches running. Patches shared to a group or company-wide stay up; managing those is what admins are for. Deleting a user is a separate, later act: the deletion flow prompts the admin to reassign any of the user's patches, and what is not reassigned goes with the account.

### Integrations and connections

Patchy ships the **integration** — Salesforce-the-capability, the same for every company, a company-scoped primitive built by Patchy. What a company holds is a **connection**: the live, credentialed instance of an integration, connected by an admin and granted to groups or company-wide. Some integrations connect per user — sign into your own email — making a personal connection that dies with the user's account: credential wiped, stored data kept. A user needs no admin enablement to make a personal connection. A patch always uses a connection, never the integration in the abstract, and no patch at any tier ever sees a credential. The layer itself — modes, handles, declaring, what patch code is handed — is spelled out under [Integrations](#integrations).

### Addresses

A patch's sharing scope is single-select — the owner (plus named users), exactly one group, or the whole company — and its human-readable address follows that scope: `company/user/patch`, `company/group/patch`, `company/patch`. Users and groups draw their handles from one per-company namespace, so the two middle shapes never collide. Names are first-come and never reserved: widening a patch to company-wide prompts for a name free at `company/`, the old address keeps redirecting, and a new patch later taking that name simply wins the address. The patch's identity stays its id throughout — addresses are pointers, and a move never touches the patch.

### The operator

The **operator** — Patchy, running the platform — is not a company role and holds no company powers. Its powers are platform-shaped: create, suspend or delete a company, quotas, and moderation — taking a patch off its address, never acting inside the company. The operator's surfaces are not built yet; taking a patch down is a SQL statement by hand until that effort is designed. Support means being invited like anyone else; a customer-support role is not designed. **Suspension** is the operator's act on a whole company — nothing serves, nothing publishes, data kept — and is also where a company lands when it runs out of credits and cannot top up. Deleting a company is its admin's act, with a recovery window; the handle is released only after it.

Its surfaces are a separate login and separate dashboards, never a company in the product and never in the `patchy` CLI.

## Identity and access

Log in once, and every patch you have access to opens when someone sends you its link. That is the whole promise, and everything below serves it. Patchy does not run its own identity system: **Clerk** holds who a person is, their sign-in and their browser session; Patchy holds the company, what each user may reach, and which machines may act as them.

### Signing in

A person signs in with **Google**, **Microsoft**, or a **code sent to their email**. There are no passwords — every other route gives Patchy nothing to protect and no reset flow to run. Signing in produces one session that is good across all of Patchy Cloud: a patch at `acme/sales/pipeline` and the portal that lists it are the same login. A link to a patch opened without a session shows the login door, and the door lands you back on the patch (the tier decision already placed the door in front of the page at every tier).

A company that wants its own identity provider turns on **SSO**: Patchy flips the flag for the company, and the company's admin sets up SAML or OIDC against their IdP themselves — Patchy never handles the IdP credentials. SSO is enforced on the company's verified domain, so once it is on, everyone at `acme.com` signs in through Acme's IdP and nothing else. SSO is a paid feature; the price is a pricing question, not a design one.

### Getting into a company

There is no person without a company. A sign-in with no company behind it lands on **create or join**: either the person's work-email domain has been verified by an existing company and they join it, or they create a company of their own — which is the full onboarding, card included, because a company is the unit that pays.

**Invite** is the default way in: an admin invites an email address, the person signs in, they are in. An admin may also verify the company's **domain** — proven by email, never a consumer domain like `gmail.com`, and one domain belongs to one company — after which anyone signing in with an `@acme.com` work identity joins Acme automatically. Verifying a domain never stops inviting: a contractor on another domain is invited like anyone else.

Today Clerk sends the invitation email and Patchy owns the invitation, which
does not expire. The person signs in and chooses **Join** on create-or-join;
several companies may invite one address, with at most one pending invite per
company. Admins can revoke or resend; failed email delivery keeps the invitation
and tells the admin to resend.

A user is in **exactly one company**, and the rule is hard. Inviting someone who is already in another company is refused; they must leave that company first. Someone who created a company of one and is then invited (or whose domain a real company verifies) must either delete that company or add someone else and leave it — its patches do not come along. Merging a company of one into a company is not designed. Agencies and consultants who need several companies were deliberately deferred with the company decision.

### Roles

Two: **member** and **admin**. **Everyone in a company builds** — a member publishes patches with no gate and no permission to ask, because that is the point of the product. Admin adds running the company: invites, groups, domain and SSO, company connections, and reassigning a patch's owner. A company always has at least one admin and the last cannot demote themself. There is no builder role and no viewer role; if a company ever wants "can't publish", that is a setting to add, not a third role.

### Access to a patch

Who may **open** a patch is its sharing scope: the owner plus named users, one group, the whole company, or — by explicit choice — anyone with the link. Who may **change** a patch is its **owner** alone: publish a version, roll back, change the scope, retire, delete. There are no editors. When two people want to work on one patch, the repo is where they collaborate, and the owner publishes; when the owner is away, an admin reassigns ownership.

**Admins see everything.** An admin has every patch in the company in view, owner-only ones included, and can act on any of them. The company owns what is built in it; "owner-only" is a sharing default, not a secret from the company. Making that more nuanced is a later decision.

Across the company line there is nothing but **public**: a patch is inside the company or it is anyone-with-the-link. Guests — a named outsider with a login — are not a thing Patchy does yet.

What the wrong person sees: not signed in, the login door, then the patch if they may open it. Signed in, in the same company, but outside the scope: "you don't have access to this patch", who owns it, and a **request access** button that asks the owner — inside a company a patch's existence is not a secret. Signed in from a different company, or the link points at nothing: "no such patch", confirming nothing, exactly as public hosting does today.

### Machines and tokens

A person's agent works on a machine — their laptop, a server, later a sandbox Patchy runs — and that machine needs to act as them. `patchy login` does it: the CLI prints a URL and a short code (as JSON under `--json`, so the agent relays both and waits), the person opens the URL in a browser they are already signed into, **sees the same code and confirms it is the one on their terminal**, and names the machine on a first login — "allison's macbook". The CLI receives a **machine token** and saves it on the machine, outside any project tree. The confirmation step, not the code entry, is what defeats the phishing that hit device logins elsewhere: someone who never ran `patchy login` has no code to match. The device flow is the one login route for now; a browser-on-the-same-machine fast path can come later.

A machine token is **the user's**, one per machine, shared by every agent on that machine — Claude Code now and Codex an hour later use the same one, under the same name. Re-authenticating keeps the name. The token is Patchy's own, not the identity provider's: publishing never waits on a third party, and the token dies in the same act as everything else the user holds. It expires **90 days** after login and **30 days** after its last use, whichever comes first; a busy builder signs in once a quarter, a laptop left in a drawer stops being a credential on its own. Every version records the token that published it, so "which machine — which agent — did this" is always answerable without an agent ever being a principal.

**Your machines** is the page that lists a user's tokens by name and last use, revokes one, or revokes all. Deactivating a user revokes every token and ends every session at once, including tier 1 and tier 2 patches they have open. CI holds a token from the same page, set through `PATCHY_API_TOKEN`; there is no company-owned or non-human token kind, so everything published has a human owner. Company-owned tokens for CI that is nobody's come back when someone needs them.

**Self-service minting is gone.** Until device login lands, `patchy auth set` saves a machine token the user already holds, and the dev loop supplies its seeded key. The intended first run is `patchy login`: a URL and code relayed by the agent for the person to confirm.

### Who's who

- **Person** — the human. Never an authorization key: names and emails change, the account does not.
- **User** — one person's one account, in exactly one company. The subject of every permission.
- **Agent** — software acting for a user, with that user's machine token. Never a who, always a how; it is indistinguishable from its user except by the token's machine name.
- **Member**, **admin** — the two roles a user has in the company.
- **Owner** — the one user a patch belongs to; the only one who changes it.
- **Viewer** — the person who has a patch open; from tier 1 up, the identity patch code acts as. A tier 0 page has a **reader** instead, because a page that runs nothing cannot act for anyone.
- **Operator** — Patchy, running the platform. Platform powers only, never a role inside a company, and never the word for whoever drives the CLI — that is the agent, the CLI's primary **driver**.

## Integrations

An **integration** is a capability Patchy ships — Salesforce, Gmail, Postgres — built and maintained by Patchy, the same for every company. What a company holds is a **connection**: the live, credentialed instance of one. That distinction was drawn with [Companies](#integrations-and-connections); this section is the layer itself — how a connection comes to exist, how a patch declares and uses one, and what patch code is actually handed.

Integrations sit inside the **primitive** model. A primitive is what the cloud provides a patch because the patch declared the need, and primitives come in two scopes. **Patch-scoped** primitives — the patch's own tables, its file storage — are provisioned with the patch, are part of it, and go with it. **Company-scoped** primitives — connections, and the company database a patch's tables live in — exist once for the whole company; a patch uses them and never owns them. A patch's tables are patch-scoped wherever they physically live: an extra table in the company database belongs to that patch, not to every patch.

### Company and personal connections

Every integration declares the mode or modes it supports, fixed by Patchy when the integration is built — never chosen at connect time. A **company** connection is made once by an admin and granted to groups or the whole company: one shared credential, where "as the viewer" means Patchy checks the viewer holds the grant and records who acted — the source itself sees the shared identity. A **personal** connection is one user's own — sign into your own Gmail — made by the user with no admin involved, and dying with their account. An integration that honestly supports both is two declarations to a patch: "Salesforce, shared" and "Salesforce, as each rep" are different things to build against.

A company holds as many connections of one integration as it likes — two databases, a production and a sandbox CRM — so every company connection carries a **handle** alongside its integration: `postgres/warehouse`, `salesforce/sandbox`. Handles are per integration per company, first-come like every name. Personal connections need none: a user holds at most one per integration.

### Declaring, granting, opening

A patch declares the connections it needs in its repo, the way it declares its tier — the integration and, for a company connection, the handle. The CLI lists the integrations Patchy ships and the connections the company already holds, so an agent builds against what is actually there, and publish tells the owner when the declaration names a connection the company does not have.

Using a company connection takes no per-patch grant on the viewer path: if the viewer holds the connection — through a group or company-wide — every patch they open can act through it as them. The declaration is not a permission; it is what lets the cloud be honest up front. A viewer without the grant is told plainly that this is their access, not the patch being broken, exactly as the tiers decision put it.

Holding a personal connection is likewise sufficient: any patch the viewer opens that declares the integration acts on the viewer's own connection, with no per-patch consent step. That is deliberate — inside a company, the patches are your colleagues' — and per-patch consent comes back as its own decision if the threat proves real.

The connect moment sits in front of the page, exactly like the login door: a viewer opening a patch that declares a personal connection they have not made is walked through connecting it, then lands on the patch. Patch code is written against the promise that every declared connection is present — no "not connected" branch to write. An admin disconnecting or un-granting a company connection breaks that promise mid-flight; the patch's calls then fail as that same access message, and the door reappears on the next open.

### What patch code sees

A **typed client** per integration, from the SDK — `salesforce.query(…)`, never raw HTTP against the source. Building and maintaining that surface is Patchy's job: that is why Patchy builds integrations instead of letting each company wire its own, and it is what keeps the surface simple for agents. No patch at any tier ever sees a credential — credentials live in Patchy's own encrypted store, applied server-side, and every call through the layer is logged with the patch, the connection and the identity it ran as.

There is no bring-your-own source: no generic REST escape hatch and no "connect an MCP server". A company that needs an integration Patchy has not shipped requests it, and Patchy builds it; opening the catalog is its own later decision if that pressure proves real.

### Development

The builder's agent reaches connections through the same layer, as its user: the machine token stands in for the session, so the dev loop sees exactly what the user would see in the browser — their grants, their personal connections, nothing more. There are no mocks and no per-connection staging environments; the blast radius of an agent is the blast radius of its user.

### The edges

A tier 2 patch's own **patch identity** against a shared connection is sketched under [Runtime tiers](#tier-2--hosted); its mechanics are settled when tier 2 is designed. The company database as a shared data surface — company-wide tables several patches read — is undesigned, and belongs with composition.
