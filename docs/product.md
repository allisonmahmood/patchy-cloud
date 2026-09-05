# Patchy Cloud

The product, written down where agents read it. Each section is the resolution of one decision on the [foundation map](https://github.com/allisonmahmood/patchy-cloud/issues/5); the glossaries in each `CONTEXT.md` carry the words, this file carries the shape.

**Built today:** tier 0 HTML patches; user ownership and company/public sharing; Clerk sign-in; create-or-join and company administration; machine login, logout and revocation. Higher runtimes, patch repos, the portal, narrower sharing, addresses, integrations, billing and company lifecycle remain the intended product shape below, not available features.

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

**Publish** is the act; every publish is a new immutable **version**, and the patch serves the version its pointer names. There is no working copy in the cloud and no unpublished patch — the working copy is local, and the act that creates a patch is the act that makes it live. Today another upload advances the pointer; moving it back through rollback is future work.

### Sharing and finding

A published patch is shared with **everyone in the company** by default, or made **public** on purpose: anyone with the link, without a login. Today its owner chooses either scope with `patchy upload <file> --share company|public` or changes an existing patch with `patchy share <file> company|public` (or `patchy share --patch <id> company|public`); an upload without `--share` preserves an existing patch's scope. Only the owner changes sharing. Narrower scopes — the owner plus named users, or one group — remain future work; who may open, and who may change, a patch is spelled out under [Identity and access](#access-to-a-patch).

The future way to find a patch is a portal of everything you have access to; today a person shares its link. A patch's identity is its **id**, so two sales dashboards made by two salespeople never collide; the planned human-readable address follows its sharing scope (see [Addresses](#addresses)).

### Updating, retiring, deleting

Updating is publishing again. Today each upload gives the patch 90 days of retention; a visit in its final 30 days moves expiry to 30 days out, never shorter and never reviving an expired patch. Revoking or replacing a machine token does not stop those top-ups. Expiry stops serving and updates, then the sweep removes the patch and its content. Today's owner **delete** stops serving immediately, with no restore action; its stored content remains until expiry and the sweep.

The intended company model removes automatic expiry in [the expiry-removal effort](https://github.com/allisonmahmood/patchy-cloud/issues/93). Its two exits will be **retire**, which takes a patch off its address and keeps it restorable by its owner, and **delete**, which removes it for good after a recovery window. Retirement and the recovery window are not built yet.

### Patches and other patches

Today patches reference each other by address, nothing more. The long-run vision is composition (a tier 1 or 2 patch calling another) and **extensions** — a patch that plugs into another patch. Both are promised, neither is designed.

### What a patch is not

Not a **connection** (a connected source belongs to the company or a user, and a patch uses it), not a **primitive** (a patch declares and uses those), not a **company**, not a **version** (part of a patch), not an **agent** or a skill (those make patches). A patch is not a source of data, not a place data lives, and not the people using it.

## Runtime tiers

A **tier** is where a patch's code runs, and nothing else. Tier 0 is **static**: no patch code runs anywhere. Tier 1 is **browser**: code runs in the viewer's browser, as the viewer. Tier 2 is **hosted**: the patch also has server-side code Patchy runs for it, while someone has the patch open. Beyond them, and not designed: tier 3 runs with no viewer present — automations, a thing that persists — and tier 4 gives an agent its own computer to work in (the shape Daytona fits). The numbers are the names; the glosses are for context.

### What a tier changes, and what it never changes

A tier changes where code runs. It never changes who can open a patch, what a patch may declare it needs, or how it is published, versioned, retired, shared or found — those are identical at every tier. A person opening a patch never thinks about its tier: they are inside their company's cloud, so the patch opens; if they are not logged in they log in once and land back on it. That door is the same for a tier 0 page and a tier 2 CRM, and it sits in front of the page, not inside it. Today the door protects tier 0; the higher runtimes are still to come.

A patch may be set **public** — anyone with the link, no login — at any tier. That is a tier 0 story: a page the sales team hands a client. Above tier 0 it is allowed but pointless, because an anonymous viewer carries no identity and nothing acts as them, so a public tier 1 patch is client code with no company access and a public tier 2 patch serves through its own identity only. Setting a patch above tier 0 to public warns the agent and the person exactly that.

### Tier 0 — static

The uploaded document runs no script, so the patch cannot watch the reader or reach anything. The [serving guarantees](../packages/serving/CONTEXT.md) distinguish it from the shell: the patch remains in its script-free sandbox; a public shell runs no script, while a company shell runs only Patchy's own session script — Clerk's headless client and Patchy's external initializer — never analytics. Caching is keyed to sharing: a minute at most for a public page, never for a doored one, at both latest and version URLs. Pages stay open to any agent that may open them, never bot-blocked; an agent reads a company patch through its user's signed-in browser, not a machine token. The host knows who opened a company page in order to let them in. The promise is _the patch cannot watch you_, not _nobody knows you were here_.

### Tier 1 — browser

Code runs in the viewer's browser and acts **as the viewer**. It never holds a credential: not the Clerk session, not an integration token, not another patch's storage. It learns who the viewer is as claims, and it reaches everything else — the patch's primitives (its tables, its files) and the company's integrations — through Patchy, which performs the call as the viewer within the viewer's own permissions. A tier 1 patch can therefore never do more than the person using it could do themselves. Nothing leaves the browser except through Patchy: there is no direct outbound to third-party APIs, credentialed or not — reaching outside systems is what integrations are for.

What tier 1 cannot do is anything the viewer's browser is not there to do: no pre-processing before the data reaches the page, no work on behalf of one viewer visible to another. Save a photo to file storage and it is saved; that is the whole story.

### Tier 2 — hosted

The patch also has server-side code, and Patchy runs it **while a viewer has the patch open**: it starts when someone asks, serves requests and live connections to every open client (two people with the same patch open can be kept in sync), and stops when nobody is looking. It costs nothing when nobody has it open. The line to tier 3 is the question a builder can answer: _does this need to happen when nobody has it open?_ If yes, it is not tier 2.

The server side is handler-shaped code Patchy runs, with a fixed layout `init` lays down — not an arbitrary app listening on a port. Bringing a whole app is a second runtime with a second set of limits, and is not promised.

Server-side code has two identities available. Company data and integrations are reached **as the viewer** by default, exactly as at tier 1. The patch's own primitives are reached as the **patch identity**: a principal of its own, accountable to the patch's owner (reassignable, so a patch outlives its owner's account), starting with nothing but the patch's own primitives and gaining a shared integration only when a company admin grants it. Neither identity ever sees a raw credential; credentials stay behind Patchy at every tier. As at tier 1, nothing leaves except through Patchy.

When a patch asks for data the viewer may not reach, the viewer is told plainly that this is their access, not the patch being broken.

### Declaring and changing a tier

The tier is an explicit field in the patch repo, written by `init`, and the cloud checks it against the tree on every publish: a tree with server code cannot claim tier 1, a tree with script cannot claim tier 0. A **version** has exactly one tier; the patch's tier is the tier of the version it serves. Changing tier is publishing a version built for the new tier — there is no move in place, because tier 2 code is not tier 1 code. Rolling back to an older version rolls the tier back with it. Primitives belong to the patch, not the tier, so they persist across the change.

## Companies

A **company** is the tenant everything on Patchy Cloud hangs off. Every patch and user lives in exactly one company, and nothing inside crosses the company line except a patch someone chose to make public. A company is flat — no sub-tenants — and carries a globally unique **handle** alongside its display name. In the intended product it is also the unit that pays, owns connections and groups, and has usage counted against it; billing, connections and groups are not built yet.

A company comes to exist on **create-or-join**, after sign-in: a person without an invitation names a company, chooses its handle and becomes its first admin. The company and user are created together; a solo builder is a company of one. The handle is fixed once created, 3–32 lowercase letters, digits or hyphens, with no leading or trailing hyphen and reserved platform names refused. Self-serve billing — put in a card, set when it tops up — is the intended later path, not a step in today's signup.

### Users, admins, groups

A **user** is one individual with one account, in exactly one company. They sign in, and they hold expiring, rotatable tokens on the machines they build patches from — see [Identity and access](#identity-and-access).

An **admin** is a user with the role that runs the company. Today that means invitations, roles, deactivation and reactivation; creating groups, setting their permissions, connecting company integrations and reassigning a patch's owner are future powers.

Today `/company` lists users, roles, active/deactivated state and pending invites.
Admins manage invitations, roles, deactivation and reactivation there; members
read the same page without actions. The last active admin cannot be demoted or
deactivated. Reactivation restores sign-in to the same company and data, but
machine tokens revoked by deactivation remain revoked.

A **group** will be a named set of users an admin creates; a user can be in many. "Team", "department", "north-american-sales" are names companies give their groups, not concepts of their own. A group is purely a grant surface — access to patches and connections — never a container that owns anything.

### Ownership and deactivation

A patch belongs to a user. Today **deactivation** ends that user's company access on the next request and revokes every machine token while keeping all data; a browser with a Clerk session sees the deactivated page and can still sign out. Reactivation restores access to the same company, but fresh machine tokens are required. Deactivation does not currently change a patch's sharing or serving state.

In the intended company lifecycle, deactivation will also wipe personal-connection credentials and take down patches only that user could reach: owner-only patches and their provisioned primitives enter the same kept-but-off state as retire. Patches shared to a group or company-wide stay up; managing those is what admins are for. That patch-lifecycle work belongs with [expiry removal](https://github.com/allisonmahmood/patchy-cloud/issues/93), narrower sharing and the primitives themselves. Deleting a user is a separate, later act: its flow will prompt the admin to reassign the user's patches, and what is not reassigned will go with the user.

### Integrations and connections

Patchy ships the **integration** — Salesforce-the-capability, the same for every company, a company-scoped primitive built by Patchy. What a company holds is a **connection**: the live, credentialed instance of an integration, connected by an admin and granted to groups or company-wide. Some integrations connect per user — sign into your own email — making a personal connection that dies with the user's account: credential wiped, stored data kept. A user needs no admin enablement to make a personal connection. A patch always uses a connection, never the integration in the abstract, and no patch at any tier ever sees a credential. The layer itself — modes, handles, declaring, what patch code is handed — is spelled out under [Integrations](#integrations).

### Addresses

Human-readable addresses are future work; today the link is `/d/<id>`, or `/d/<id>/v/<n>` for a version, for either sharing scope.

The intended internal sharing choice is single-select — the owner (plus named users), exactly one group, or the whole company — and its human-readable address will follow that choice: `company/user/patch`, `company/group/patch`, `company/patch`. Users and groups will draw their handles from one per-company namespace, so the two middle shapes never collide. Patch names are first-come and never reserved: widening a patch to company-wide will prompt for a name free at `company/`, the old address will keep redirecting, and a new patch later taking that name will simply win the address. The patch's identity stays its id throughout — addresses are pointers, and a move never touches the patch.

### The operator

The **operator** — Patchy, running the platform — is not a company role and holds no company powers. Its future powers are platform-shaped: company lifecycle, quotas, and moderation — taking a patch off its address, never acting inside the company. None of those surfaces is built; taking a patch down is a SQL statement by hand until that effort is designed. Support means being invited like anyone else; a customer-support role is not designed. **Suspension** will stop a whole company's serving and publishing while keeping its data, including when it runs out of credits and cannot top up. Company deletion by its admin, its recovery window and the eventual release of the handle are future work too.

The operator will use its own login and dashboards, never a company in the product and never the `patchy` CLI.

## Identity and access

Log in once, and every patch you have access to opens when someone sends you its link. That is the whole promise, and everything below serves it. Patchy does not run its own identity system: **Clerk** holds who a person is, their sign-in and their browser session; Patchy holds the company, what each user may reach, and which machines may act as them.

### Signing in

A person signs in with **Google**, **Microsoft**, or a **code sent to their email**, through Clerk's Account Portal. There are no passwords — every other route gives Patchy nothing to protect and no reset flow to run. One Clerk session opens the company's patches and first-party pages: a company link opened without a session shows the login door, whose Sign in link returns the person to that patch. A public patch needs no sign-in. The future portal and higher-runtime patches use the same door.

Company **SSO** is future work: Patchy will enable it for a company, and its admin will set up SAML or OIDC against their IdP themselves — Patchy never handles the IdP credentials. SSO will be enforced on the company's verified domain, so everyone at `acme.com` signs in through Acme's IdP and nothing else. SSO is intended as a paid feature; the price is a pricing question, not a design one.

### Getting into a company

There is no Patchy user without a company, but a Clerk session may exist before that membership does. A sign-in with no company behind it lands on **create-or-join**, which names the email it checked: choose **Join** on one of the live invitations for that email, or, without any invitations, create a company with a name and handle. A person on the wrong account can use **Not you? Sign out** rather than accidentally create a company for it.

**Invite** is the default way in: an admin invites an email address with a role, the person signs in, checks the company and chooses **Join**. Joining consumes that invitation and creates the user together, so a user always belongs to exactly one company.

Today Clerk sends the invitation email and Patchy owns the invitation, which
does not expire. The person signs in and chooses **Join** on create-or-join;
several companies may invite one address, with at most one pending invite per
company. Admins can revoke or resend; failed email delivery keeps the invitation
and tells the admin to resend.

A user is in **exactly one company**, and the rule is hard. An invitation to an email already belonging to any user is refused, and a person who joins one company cannot then consume another company's invitation. Leaving or deleting a company is not offered today.

Later, an admin may verify the company's **domain** — proven by email, never a consumer domain like `gmail.com`, and one domain belonging to one company — after which a work identity on that domain will join it automatically. Invitations will still admit contractors from other domains. Someone with a company of one will need to delete it or add someone else and leave before joining another; its patches will not move with them. Those exits, domain verification and full billing onboarding remain future work. Company merging and multiple memberships for agencies or consultants are not designed.

### Roles

Two: **member** and **admin**. **Everyone in a company builds** — a member publishes patches with no gate and no permission to ask, because that is the point of the product. Today admin adds invitations, role changes, deactivation and reactivation; groups, domain and SSO, company connections and patch reassignment will come with those features. A company always has at least one active admin, who can neither be demoted nor deactivated. There is no builder role and no viewer role; if a company ever wants "can't publish", that is a setting to add, not a third role.

### Access to a patch

Who may **open** a patch is its sharing scope: today the whole company or, by explicit choice, anyone with the link. Who may **change** it is its **owner** alone: publish a version, change sharing or delete. There are no editors, and admin status grants no extra patch-write permission. Owner-plus-named-users and group sharing, rollback, retirement and admin reassignment remain future work; when two people work on one patch, the owner publishes their shared local work.

**Admins will see everything.** The intended admin view includes every patch in the company, owner-only ones included, with the ability to manage it or reassign its owner. That view and reassignment are not offered today. The company owns what is built in it; future owner-only sharing is not a secret from the company. Making that more nuanced is a later decision.

Across the company line there is nothing but **public**: a patch is inside the company or it is anyone-with-the-link. Guests — a named outsider with a login — are not a thing Patchy does yet.

Today a published patch is either company-scoped or explicitly public. A public patch opens without a session, but a company patch has three outcomes: an active colleague gets the page; a signed-out reader gets a 401 login door with one **Sign in** link rather than a redirect; a signed-in reader from another company gets the same 404 as a missing link, confirming nothing. A signed-in person without a company goes through create-or-join with the patch as the return destination; a deactivated user sees a 403 deactivated page instead of a sign-in loop. The door admits browser sessions, never machine tokens. When owner-only sharing is built, a colleague outside that narrower scope will see "you don't have access to this patch", who owns it, and **request access**; that state is not offered today.

### Machines and tokens

A person's agent works on a machine — their laptop, a server, later a sandbox Patchy runs — and that machine needs to act as them. `patchy login` prints a URL and a short code for the agent to relay; it does not open a browser. The person opens the URL in their own signed-in browser, **checks that the displayed code is the one on their terminal**, and chooses a machine name — "allison's macbook" — before confirming, or denies a login they did not start. The code lasts ten minutes and is confirmed, never typed into a page. Confirmation authorizes the login; the terminal's poll mints the **machine token** once and saves it in the CLI's state dir, outside the project tree by default. An abandoned confirmation mints nothing. Device login is the only machine-login route today; a same-machine browser shortcut may come later.

A machine token is **the user's**, shared by every agent using that machine's saved login — Claude Code now and Codex an hour later use the same credential and name. Re-authenticating offers the old name and replaces the previous key only when the completing poll mints for the same user; until then the old key keeps working. The token is Patchy's own, so publishing does not call Clerk. It expires **90 days** after minting or after **30 idle days**, whichever comes first. Every version records its creating machine token, so the responsible machine remains traceable after revocation; agents sharing that token are not separate identities.

**Your machines** is the page that lists a user's live tokens by name, creation, last use and expiry, revokes one or all, and signs the browser out. Deactivating a user revokes every token and ends their access on the next request; ending access in open tier 1 and tier 2 patches comes with those runtimes. CI will hold a user-owned token set through `PATCHY_API_TOKEN` when that flow is built; Your machines offers no create or rename action today. There is no company-owned or non-human token kind, so everything published has a human owner. Company-owned tokens for CI that is nobody's come back when someone needs them.

**First publish is login, then upload.** `patchy login --json` returns the URL, code and next command for the agent to relay; the agent waits for the person's answer, then runs that next command with `--json` added when it needs structured output. Completion reports either a saved login or a still-pending login; it does not start another code. A person at a real terminal runs the same login command without `--json` and waits. `patchy logout` forgets the stored key and pending login before courtesy revocation, while browser sign-out is separate and remains reachable on create-or-join, the company page, Your machines and the deactivated page. For publishing and `whoami`, `PATCHY_API_TOKEN` overrides a saved credential, which overrides the worktree's seeded key. Logout removes only the saved credential, says when the environment or seed still applies, and warns if remote revocation could not complete.

### Who's who

- **Person** — the human. Never an authorization key: names and emails change, the account does not.
- **User** — one person's one account, in exactly one company. The subject of every permission.
- **Agent** — software acting for a user, with that user's machine token. Never a who, always a how; it is indistinguishable from its user except by the token's machine name.
- **Member**, **admin** — the two roles a user has in the company.
- **Owner** — the one user a patch belongs to; the only one who changes it.
- **Viewer** — the active signed-in user, company and role that Auth establishes for a first-party page or a company patch's door, without a machine credential. From tier 1 up, patch code will act within that viewer's permissions; an anonymous public reader has no such identity.
- **Operator** — Patchy, running the platform. Platform powers only, never a role inside a company, and never the word for whoever drives the CLI — that is the agent, the CLI's primary **driver**.

## Integrations

This layer is not built yet. The rest of this section records its intended shape.

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
