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
