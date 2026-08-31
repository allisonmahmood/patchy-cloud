# Patchy Cloud

The product, written down where agents read it. Each section is the resolution of one decision on the [foundation map](https://github.com/allisonmahmood/patchy-cloud/issues/5); the glossaries in each `CONTEXT.md` carry the words, this file carries the shape.

## Patches

A **patch** is the unit of what people build and deploy on Patchy Cloud — anything from a static page to a full CRM. A tier 0 page and a CRM are both patches for the same reason: each is one built thing in a company's cloud, stored as one, permissioned as one, provisioned as one, at one address, at one runtime tier. What differs between them is the tier they need — a CRM is a CRUD app, so it needs tier 2 — never what kind of thing they are.

### What a patch is made of

A patch is a **file tree**. The folder it is built in is the **patch repo**: the tree plus its id, its declared **tier**, and base config. Today's single HTML upload is a one-file tree with no repo; from tier 1 up, the CLI initialises the repo with the SDK and the parts the patch needs to run, and a person or their agent builds inside it. One repo is the working copy of exactly one patch: publishing from it updates that patch, cloning it elsewhere still publishes to the same patch, and the first publish from a repo with no id creates the patch and writes the id back.

A patch has exactly one tier, declared in its repo. The structure of the tree says what the code is trying to do — client code, server code, and from tier 3 work that runs with no viewer present — so the cloud checks the declared tier against the tree and refuses a publish that claims less than the tree does. A patch is never two tiers at once.

A patch may say it needs a **primitive** — file storage, tables, a company integration — and the cloud provisions it as part of the patch.

### Who makes one, and how it gets in

A person, or an agent acting for them, through the `patchy` CLI. That is the only route today. The later routes are the same route: the SDK is what `init` puts in the repo, and the AI builder is an agent with the same skills and SDK, working on a sandboxed computer Patchy runs instead of the person's own machine. All three produce the same unit.

Ownership: today a patch belongs to the token that created it. Once auth lands, a patch belongs to a **person** in a company; the person holds a token per device, every token acts for the person, and the company sets what the person may do.

### Versions and publishing

**Publish** is the act; every publish is a new immutable **version**, and the patch serves the version its pointer names. Rollback moves the pointer. There is no working copy in the cloud and no unpublished patch — the working copy is the local repo, and the act that creates a patch is the act that makes it live.

### Sharing and finding

A published patch is visible to **everyone in the company** by default. Its owner can tighten that (for now, to the builder alone) or widen it to anyone with the link. No patch is public without a login unless someone chose that.

Finding a patch is a portal of everything you have access to. A patch's identity is its **id**, so two sales dashboards made by two salespeople never collide; human-readable addresses — a company patch under `company/patch`, a personal one under `company/mark/patch` — are wanted and not yet designed.

### Updating, retiring, deleting

Updating is publishing again. A patch never expires on its own: expiry, the retention clock and pins are inherited from public hosting and go when ownership lands. Two exits remain: **retire** takes a patch off its address and keeps it, restorable by its owner; **delete** removes it for good after a recovery window.

### Patches and other patches

Today patches reference each other by address, nothing more. The long-run vision is composition (a tier 1 or 2 patch calling another) and **extensions** — a patch that plugs into another patch. Both are promised, neither is designed.

### What a patch is not

Not an **integration** (a connected source belongs to the company, and a patch uses it), not a **primitive** (a patch is provisioned with those), not a **company**, not a **version** (part of a patch), not an **agent** or a skill (those make patches). A patch is not a source of data, not a place data lives, and not the people using it.

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
