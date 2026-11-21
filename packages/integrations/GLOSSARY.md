# Integrations

The company capability for connecting outside systems without handing credentials to patches. Postgres, PostHog, Pidgeon, Attio, Email (IMAP) and GitHub connections and their discovered metadata are managed here, and, behind the **Models switch**, model providers and the model roles mapped to them; the `connections` API group exposes their safe metadata to active members. [Companies](../companies/GLOSSARY.md) owns membership and teams, and [Runtime](../runtime/GLOSSARY.md) uses the initiating viewer as the effective principal for connection calls, which also check that the patch's owner may build with the connection.

## Language

**Integration**:
A capability Patchy ships for reaching an outside system, the same capability for every company. Postgres, PostHog, Pidgeon, Attio, Email (IMAP) and GitHub are built; OAuth integrations such as Salesforce and Gmail remain future work.
_Avoid_: connector, app (Zapier's word), resource (Retool and Windmill's word), toolkit

**Connection**:
A credentialed instance of an integration, used by a patch rather than owned by it. Today's company connection carries a handle and an admin description and is shared company-wide; pausing preserves its identity and metadata while denying new use.
_Avoid_: data source, datasource, connected account, credential (what it holds, not what it is)

**Connection discovery**:
The member-readable list of the company's connections and their state, with declaration hints for connected ones and setup guidance for disconnected ones. Offered integrations are optional; drilling into one connection reveals its current immutable snapshot and taken-at time, or reports the snapshot unavailable.
_Avoid_: connection administration

**Catalogue**:
The integrations Patchy offers a company, each with its mark, a line on what it gives patches and how many connections the company already has, then a row to ask for another. Admins reach it from the Integrations page, which lists the company's connections, through Connect an integration; it is not that list. With nothing connected it is the Integrations page, the same rows at the same width.
_Avoid_: marketplace, app directory

**Connect frame**:
The one page every integration connects through, drawn from what the integration says, its connect spec: what to make in the other system first, the credential's fields, any sections a sign-in unlocks (GitHub's repositories), its example name, and what it reads, never does and one caveat. The frame owns the order, the Name section, the access list's platform facts, the actions and where refusals read, so a new integration adds data, never a layout.
_Avoid_: walkthrough, wizard, connector setup

**Pause / Resume**:
An admin's reversible stop of a connection, stored as disconnected: patches that declare it are refused until Resume, which tests the stored credentials first, reconnects it and keeps its identity, metadata and every declaration. The pages show it as Paused, a badge; the API and CLI keep `status: disconnected` and `reason: not_connected`.
_Avoid_: disconnect (what ending a connection is called), suspend, disable

**Disconnect**:
Ending a connection: Patchy forgets its credentials and frees its handle, keeping the snapshots patches were published against; stored as a delete. Refused while any stored version declares it, naming the live patches to remove it from and every other patch whose stored versions declare it. A Pidgeon one forgets its key, which stays valid in Pidgeon: Patchy can't revoke it, so the admin does, in Pidgeon.
_Avoid_: delete, revoke, remove

**Replace key**:
Giving a connection new credentials for the same target, keeping its identity and what patches can read: Replace credentials for Postgres, Replace password for IMAP, Replace key for the rest. Stored as a rotate.
_Avoid_: rotate, reconnect

**Needs attention**:
A connection Patchy stopped, or whose state waits on an admin, for its integration's own reason, shown with its fix: an Attio key a check found writable (paused by Patchy, fixed by Resume or Replace key), an IMAP **login pause** (fixed by Replace password or Test), a Pidgeon test key (fixed by Replace key with a live one), and a GitHub App uninstalled (paused by Patchy, fixed by Reconnect), its permissions changed (paused by Patchy, fixed by Resume) or a repository **left** its installation (fixed by Refresh, Resume or Change repositories). A GitHub connection **suspended on GitHub** shows that in place of Connected instead. Distinct from Paused, which an admin chose; Postgres and PostHog have no reason of their own.
_Avoid_: broken, error, unhealthy

**Unused**:
A connection no stored version of any company patch declares, which is exactly when it can be disconnected. A connection only older versions or retired, deleted or disabled patches declare is used by no live patch, but is not unused; its row reads "None live" with how many.
_Avoid_: idle (a statement about calls), orphaned

**Model role**:
A connection of the `models` integration, what a patch's action will ask a model through: a fixed handle and a fixed kind, **decision** (fixed questions in, probabilities out) or **text**, a description, an audience and a block-guests setting, as any connection has. An admin maps it to one **model provider** of the same company and a model id there, which may hold a slash, and remaps it at any time; patches follow from their next call, since its snapshot holds only its kind. It is unavailable while it or its provider is paused, or while its provider is of an integration the running release doesn't know, and reads as paused wherever a connection's state is read. Deleting one is refused while a stored version declares it, so pausing is how to stop one.
_Avoid_: model (what a provider serves), prompt, agent

**Model provider**:
The company's key for one model provider, such as OpenAI: a connection of that provider's own integration (`openai`), its key sealed as every connection's credentials are. The store keeps it but never as a connection a builder sees: no listing, detail, offer, page, form, attention view, generation or declaration names one. Shown by its type; the first of a type is `main`, and a second takes a name. Pausing it stops every role on it at once and resuming starts them again; Replace key keeps a paused one paused; deleting one is refused while a role points at it.
_Avoid_: model connection, API key (what it holds), vendor

**Models switch**:
The host setting `PATCHY_MODELS`, off unless set and off in production, on in the dev runner and in tests. Off, the server keeps and reads no model provider or role, as a release before Models would: discovery neither lists, offers nor answers a role, and neither is made.
_Avoid_: feature flag, Models toggle

**Personal connection**:
A future connection belonging to one user rather than their company, such as that user's Gmail. Its credentials and lifetime follow the user; the access rules live in [the product](../../docs/product.md#company-and-personal-connections).
_Avoid_: user resource, private connection

**Connection handle**:
The immutable name a company connection carries beside its integration — `warehouse` in `postgres/warehouse` — distinguishing one integration's connections in one company. Two integrations may each have a `warehouse`, so the integration and handle together name a connection. A declared connection binds to its stable identity, not a later reuse of that handle.
_Avoid_: alias, connection id (the identity, which never changes)

**Declaration**:
A tier 2 patch's statement of a connection, shared table, shared file store or company member directory its handlers use but it does not own. It binds the required resource's identity and metadata where applicable, never grants access; below tier 2 a patch declares nothing.
_Avoid_: dependency, requirement, scope request

**Description**:
An admin's hint about a connection's purpose, helping a builder choose it. It neither grants nor restricts access.
_Avoid_: permission, policy, grant

**Block guests**:
An admin's setting on one connection that keeps a patch's [guests](../companies/GLOSSARY.md) out of every patch whose current version declares it, while it's on. Their grants stay, so they're back once it's off or the patch stops declaring it; members are unaffected. Off for every connection until an admin turns it on, and it applies to the next call. The owner and admins see why on the patch's card and in Needs attention, and publish warns.
_Avoid_: guest access, allow list, sensitive flag

**Metadata**:
The source's shape as discovered for one connection, never its business rows. Postgres metadata is a schema snapshot; PostHog metadata is an events snapshot; Pidgeon metadata is an address snapshot of its inbox; Attio metadata is a workspace snapshot; IMAP metadata is a mailbox snapshot; GitHub metadata is a repository snapshot. A stored snapshot names its own integration, so it reads correctly after its connection is deleted.
_Avoid_: instance, fixture

**Schema snapshot**:
An immutable description of a connection's relations, columns, keys, enum labels and named exclusions. A failed discovery leaves the previous snapshot current.
_Avoid_: inventory (the cumulative authority for patch-owned resources), schema revision (Primitives' term)

**Events snapshot**:
An immutable list of a PostHog project's event definitions and event and person property definitions, with their types and descriptions, never events. Its types are hints for writing HogQL; a query may name anything the project has.
_Avoid_: event catalogue, schema (PostHog has none to snapshot)

**Address snapshot**:
An immutable description of one Pidgeon inbox: its address and display name, what patches may do with it, whether the stored key is a test key, and its labels, never mail. Refresh labels takes a new one with the stored key.
_Avoid_: mailbox, inbox snapshot

**Workspace snapshot**:
An immutable description of one Attio workspace's shape: its objects and lists by API slug and id, a list's parent objects, each attribute's slug, title, type and cardinality, a record reference's targets, and the active options of each select and status, never a record. What discovery left out is named in it, and selects and statuses whose options it ran out of budget for are marked as skipped.
_Avoid_: CRM schema, data model (Attio's word for the objects alone)

**Key check**:
Attio's `/v2/self`, asked at connect, Test, Refresh, Resume and Replace key, failing closed: the key must be an active workspace token holding the read scopes Patchy needs and no write scope. A check that finds the stored key can write pauses the connection, which then needs attention, naming the scopes and the admin whose check it was, unless a newer key replaced it meanwhile.
_Avoid_: key test, token validation

**Workspace gate**:
The calls and discoveries one server process lets run at once against one Attio workspace, shared by every connection to it and by `patchy dev` and published patches, inside one gate for all of Attio. One that can't get a slot before its deadline is refused busy, having sent nothing.
_Avoid_: pool, rate limit (Attio's own)

**Mailbox snapshot**:
An immutable description of one IMAP mailbox login: its host, port, security mode and username, the capabilities its server advertised once logged in, and its folders by path with their delimiter, the special-use flags the server sent and whether each is selectable, at most 5,000 and marked truncated past that. Never mail. The folders are hints for generation and context, not limits on calls. Refresh folders takes a new one.
_Avoid_: inbox snapshot, mail index

**Mailbox login**:
What one IMAP connection is: a host, port, security mode, username and password an admin typed, fixed for the connection's life except the password. The password is sealed together with where it may go, and goes only there: to an address the host resolved to and Patchy checked public, over TLS 1.2 or later verified against the typed host, never to a fallback or a referral.
_Avoid_: email account, inbox

**Fresh session**:
An IMAP session opened for one Test, connect, Replace password, Refresh folders or Resume alone, and logged out after it: it resolves and checks the host again, and is never taken from or returned to a pool. Test runs TLS, `CAPABILITY`, the login, `LIST` and `EXAMINE INBOX` on one, naming the requirement a mailbox missed.
_Avoid_: probe, connection test

**Login pause**:
An IMAP connection whose mail server refused its login, recorded on the connection's row with when, the server's code and whose login it was, so no host process logs in with it again: calls fail `auth_failed` without contacting the server, until an admin's Test, Replace password or Resume logs in. Only a `NO` to `LOGIN` or `AUTHENTICATE` coded `AUTHENTICATIONFAILED`, `AUTHORIZATIONFAILED`, `EXPIRED` or uncoded pauses; a `BAD`, a throttle, another code and a network failure don't, nor does a refusal that lands after a login with the same password has worked and been saved since the attempt began. The pages show it as Needs attention, never Paused, which is an admin's; `patchy list connections` marks it `paused: true`, with the way out.
_Avoid_: lockout, disabled (the mail host's words for what the pause prevents), disconnect, Paused (an admin's stop)

**Mail network**:
Where IMAP sessions resolve hosts, which addresses they may dial, where a checked address is dialled and which certificate authorities are trusted. The launcher provides it: production's admits public addresses and the system's authorities only; the loopback one, which only the dev runner and tests provide, adds named mail servers on this machine with their own CA. No setting turns loopback on.
_Avoid_: proxy, egress

**Inbox**:
Pidgeon's word for an address that keeps mail; one Pidgeon connection is one inbox, by its id. An `events` inbox keeps no mail and can't be connected. Patchy's own word stays **address**.
_Avoid_: mailbox (IMAP's)

**Pidgeon key**:
The key an admin made in Pidgeon's dashboard and pasted to connect or Replace key, Read or Send, and the one Pidgeon secret Patchy keeps, encrypted with the inbox's id. It reaches the whole Pidgeon account, since Pidgeon makes none for one inbox; the **inbox boundary** keeps every call to the connection's inbox. Patchy can't revoke it: Replace key and Delete tell the admin to.
_Avoid_: address key, scoped key (Patchy no longer mints one)

**Inbox boundary**:
What keeps a Pidgeon connection's calls to its one inbox, since its key reaches every inbox of the account: nothing is returned or changed unless Patchy has shown it's the inbox's, and anything it can't show answers `not_found`, as an unknown id does. Lists and search name the inbox and refuse an answer carrying another's row; a thread or message by id must say it's the inbox's; a held message by id can't, so it isn't there; triage reads the thread first and checks a label against the inbox's own.
_Avoid_: scope, sandbox

**Test-mode connection**:
A Pidgeon connection whose key is a test key, `pgn_test_…`: the mail it sends stays in Pidgeon and reaches only the account's own inboxes. It shows "Test key, mail stays in Pidgeon" wherever it's listed, and needs attention while live patches use it: real mail needs a live key. Distinct from Test connection, the action that checks a connection's credentials still work.
_Avoid_: sandbox, demo connection

**Revision**:
The connection's server-assigned metadata revision identifying one schema snapshot. A published declaration keeps the revision it was generated against; refreshing discovery never rewrites it.
_Avoid_: snapshot revision, release, wire version, credential revision, schema revision (Primitives' term)

**Relation**:
A source table or view described in a Postgres schema snapshot. Its source name is preserved; the typed client exposes a projection of its supported columns, not a copy of every source feature.
_Avoid_: primitive table, collection

**Retarget**:
Replacing a connection's source endpoint while keeping the connection's identity and discovering its new shape. Existing declarations keep their identity and recorded snapshot. The connection page calls it Point elsewhere for Postgres and Change project for PostHog, beside Replace credentials or Replace key, which give it new ones for the same endpoint. A Pidgeon connection has none: another address is another connection. Nor has an Attio one: another workspace is another connection. Nor an IMAP one: another mailbox is another connection. Nor a GitHub one: another account is another connection, and Reconnect, which moves one to its account's new installation of the App, keeps its account.
_Avoid_: rename, new connection

**Credential revision**:
The changing generation of a connection's credentials and connected state. It invalidates old source sessions independently of the metadata revision.
_Avoid_: snapshot revision, key id

**Escape hatch**:
An explicit raw SQL query with a declared result shape instead of the relation-specific typed client. It remains a constrained read through the supplied role, not harmless execution of arbitrary SQL.
_Avoid_: unrestricted SQL, direct database access

**HogQL query**:
PostHog's one operation: a named, read-only query in PostHog's ClickHouse-flavoured SQL, with constant values for its placeholders and a declared result shape. Patchy builds the request, so patch code can only read. Its **name** labels the call in recent calls and in PostHog's own query log.
_Avoid_: event export, insight (PostHog's saved chart)

**Pidgeon operation**:
One of the calls Patchy writes for a Pidgeon inbox: reads (`threads.list`, `threads.get`, `messages.get`, `messages.search`, `labels.list`) travel as `pidgeon.read`; replies, sends and triage as `pidgeon.write`, which only a connection that may send makes. Patchy fills in the inbox and keeps the **inbox boundary**, so patch code never names a path, an inbox id or a key.
_Avoid_: email API, inbox call

**Attio operation**:
One of the reads Patchy writes for an Attio workspace, each its own runtime operation: `attio.listRecords`, `attio.getRecord`, `attio.getManyRecords`, `attio.listEntries`, `attio.getEntry` and `attio.listMembers`. Patchy builds every request from typed arguments and the snapshot the caller's client was generated from, and none writes.
_Avoid_: CRM API, Attio query (Attio's own word for one request)

**IMAP operation**:
One of the operations Patchy writes for an IMAP mailbox, each its own runtime operation: the reads `imap.listFolders`, `imap.folderStatus`, `imap.scanMessages`, `imap.listMessages`, `imap.searchMessages` and `imap.getMessages`, and `imap.stageAttachment`, which downloads one part of a message and stages it through [host staging](../primitives/GLOSSARY.md) for the action to adopt into its own file store. Patchy builds every command from typed arguments, opens folders with `EXAMINE` and fetches with `BODY.PEEK`, so none changes the mailbox or marks mail as read.
_Avoid_: IMAP command (the protocol's own word for what Patchy sends)

**GitHub operation**:
One of the twelve reads Patchy writes for a GitHub connection, each its own runtime operation: `github.listRepos`, `github.getRepo`, `github.listWorkflows`, `github.listRuns`, `github.getRun`, `github.listJobs`, `github.getJobLog`, `github.listChecks`, `github.listPulls`, `github.getPull`, `github.listPullFiles` and `github.listPullReviews`. Each names a repository of the connection's current set by its name, and Patchy builds every request, by the repository's numeric id; none writes. Every list answers whether it is complete.
_Avoid_: GitHub API call, endpoint (GitHub's own words for what Patchy sends)

**Job log**:
The end of one CI job's log, as `github.getJobLog` answers it: at most `github.log.bytes`, saying when its start was cut off. Patchy follows GitHub's redirect to its log store itself, only to the store's own hosts, and reads the end by its length and a closed range, never a whole body; the signed URL never leaves the host. Its text is untrusted, inert data, never logged.
_Avoid_: run log (a whole run's archive, which isn't read), logs

**Message ref**:
How a patch names one IMAP message: `{ connection, folder, uidValidity, uid }`, its UID within the folder under one UIDVALIDITY, on the connection that answered it. One from an earlier UIDVALIDITY fails `mailbox_reset`; a gone UID is `not_found`. Message-ID is threading metadata, never identity.
_Avoid_: message id

**Scan checkpoint**:
The durable mark an IMAP scan answers on every page: every message of the folder up to it is covered, under the folder's UIDVALIDITY. A patch stores it after the rows it covers and passes it as `after` to the next scan, which fixes a fresh bound. Its encoding stays readable across releases, since patches keep it.
_Avoid_: cursor (which continues one call only), sync token

**Mailbox gate**:
The IMAP reads one server process lets run at once against one mailbox, its normalized host and login, shared by `patchy dev`, published patches and every connection to that mailbox, inside one per mail server and one per process. A call that can't pass them before its deadline is refused busy, having sent nothing.
_Avoid_: rate limit (the mail server's own)

**Session pool**:
The logged-in IMAP sessions a server process keeps between reads, by company, connection and credential revision, closed after 30 seconds idle. A read owns the session it borrows until it settles, and one that ended on a deadline, an interruption, a bound or a broken connection is destroyed rather than returned. Test and the other admin steps never use it: they open a fresh session.
_Avoid_: connection pool (a connection is the admin's credentialed instance)

**Schema check**:
The read each Attio call makes of its object's or list's current attributes beside its query. It fails `shape_mismatch` naming any snapshot attribute that's gone, archived, renamed, retyped or changed between one value and many, and nothing is decoded until it passes. A name another attribute took since reads under it if its type and cardinality match.
_Avoid_: validation, schema refresh (an admin's Refresh takes a new snapshot)

**Draft key**:
The `idempotencyKey` a patch makes for one email when the person starts it and keeps until a send answers. Patchy sends each draft key's email at most once, by the **send ledger**; the draft key itself never leaves Patchy.
_Avoid_: request id, nonce

**Send ledger**:
Patchy's record of each email a Pidgeon connection writes, one row per hash of the connection, the patch and the **draft key**: the Pidgeon draft that is the email, how far it got (`writing`, `drafted`, `sending`, `sent`, `held` or `refused`), and the claim of the worker sending it. A draft's one send is issued only after `sending` is recorded, and a draft found `sending` or `held` is looked at, never sent; when Pidgeon hasn't said whether it left, the answer is `unconfirmed`. Pidgeon doesn't dedupe, so this is what makes a draft key one email.
_Avoid_: outbox, queue

**Held send**:
A send Pidgeon answers `held`: the account is flagged, and the email waits for a member of the account to approve it in Pidgeon; no key can. Asking again with the same draft key looks again. Distinct from **held mail**, a message that arrived and that Pidgeon Firewall holds for a person, unreadable by id and unanswerable until someone releases it.
_Avoid_: queued send, scheduled send

**Send budget**:
The emails one Pidgeon connection writes per UTC day, each counted durably once, when the **send ledger** records its draft key, before Pidgeon sees it. Past it, a new email is refused `source_rate_limited` with `limit: "budget"` and nothing is sent; replays and asking again count nothing.
_Avoid_: quota, sending allowance (Pidgeon's own)

**Project slots**:
The queries one server process lets run at once against one PostHog region and project, shared by every connection to it. A call that can't get one before its deadline is refused busy, having sent nothing.
_Avoid_: pool (a Postgres word for reusable sessions), rate limit (PostHog's own)

**Address slots**:
The calls one server process lets run at once against one Pidgeon inbox, shared by `patchy dev` and published patches. A call that can't get one before its deadline is refused busy, having sent nothing; one that waited checks its caller and connection again and loads the key as it stands.
_Avoid_: pool, rate limit (Pidgeon's own)

**Typed client**:
The integration-specific surface patch code is handed for a declared connection, rather than raw HTTP or a credential. The Postgres client exposes relation reads and the escape hatch; the PostHog client exposes one HogQL query; the Pidgeon client exposes its address's operations, without the writes when its key only reads; the Attio client exposes each object's and list's reads, typed from the snapshot, and the members.
_Avoid_: proxy (how it is carried out, not what the code sees), driver, raw API

**Call log**:
See **Runtime log** in [Runtime](../runtime/GLOSSARY.md); connection calls and admin discovery belong to that record, not a separate log.
_Avoid_: audit trail, analytics event (a business moment, not a call)

**Dev binding**:
How `patchy dev` runs an integration's operations, chosen per integration ([ADR-0013](../../docs/adr/ADR-0013-dev-bindings-per-integration.md)). By default it is local, over fixtures or a fake, with no production credentials or business rows. An integration whose fixtures wouldn't resemble production reads the real connection instead, through a dev read, and simulates its writes; PostHog, Pidgeon and Attio do, Postgres keeps fixtures. Writes never run live in dev.
_Avoid_: Mock integration, production proxy

**Dev read**:
One live dev binding call: the instance runs a read the integration opts into on a connected connection of the machine token's company, as that token's person, and logs it as a machine call with no patch. Both local viewers read as the token's person. An Attio dev read carries the revision the repo was generated from, and the instance decodes by that snapshot of that connection. An IMAP dev read borrows from the same session pool and mailbox gate as published patches. A GitHub dev read reaches the connection's current set, with no revision, through the installation's slots and token cache that published patches use.
_Avoid_: Dev proxy, impersonated read

**Simulated write**:
A Pidgeon send, reply or triage in `patchy dev`, which never reaches the instance or Pidgeon. Dev checks its arguments and the connection's access as the host would, answers it with new ids starting `dev_`, and prints it in dev's output; nothing changes, so the next dev read doesn't show it. It keeps no **send ledger**.
_Avoid_: dry run, fake send, test send (a test-mode key's send, which does land in Pidgeon)

**Fixture**:
Builder-authored synthetic data for a declaration's local shape, with invented rows for connections and shared tables, or files for shared stores. Fixtures establish local behavior, not production data, authority or volume guarantees; view fixtures contain explicit rows rather than recomputed source data.
_Avoid_: Sample of production, mock response

**Connection audience**:
Who may build patches with a connection: everyone in the company, or the people on any of its selected teams by their recorded memberships, whether or not they are active. Only an admin sets it; every existing connection is the company's. A patch's current owner must be in it at publish and on every call through the patch; anyone who can open the patch uses the connection through its handlers. Discovery, connection pages and SDK generation list only the connections a person can build with. Blocking guests is separate.
_Avoid_: connection permission, connection access list

**Repository snapshot**:
An immutable description of a GitHub connection's account and repositories by id: each one's name, default branch, and whether it's private, archived, disabled or left. Never code, a run or a pull request. Refresh, Add, Remove and a repository found left each take a new one.
_Avoid_: repository list, inventory

**GitHub App**:
The one public GitHub App each environment reaches GitHub through, "Patchy Cloud" in production: read on repositories only, webhooks off, its credentials five host settings. Its private key needs no stored ciphertext to be useful, which makes it the one GitHub secret that matters ([ADR-0015](../../docs/adr/ADR-0015-github-app-key-and-repository-rule.md)).
_Avoid_: OAuth app, integration (the capability, not the App), bot

**Installation**:
The GitHub App on one GitHub account, a person's or an organization's, with the repositories its owner chose; reinstalling makes a new one. Its platform row keeps the cooldown and when a mint last found it suspended, and outlives every claim on it.
_Avoid_: account (what it's on), app

**Repository set**:
What one GitHub connection reads: repositories by numeric id on one installation, each added because GitHub showed the person adding it as its admin at that moment. A call names a repository by its name in the current set, never a snapshot's, and is refused before GitHub is asked when it isn't there.
_Avoid_: selected repositories (the installation's own choice), scope

**Left**:
A repository Patchy found missing from its installation when a mint answered 422: kept in the repository set but refused until a Refresh finds it back. Leaving isn't final; removing it from the connection is.
_Avoid_: removed (what an admin does), deleted

**Claim**:
Which Patchy company holds an organization's installation: the first to connect a repository from it, until its last connection on it is Disconnected; Pause keeps it. Another company is refused, and told that uninstalling and reinstalling the App on GitHub starts fresh. A personal account's installation, connected by its own user, matched by GitHub's numeric id on Connect, Add and Reconnect, is exempt.
_Avoid_: ownership, lock

**GitHub sign-in**:
A Patchy admin's authorization of the App on GitHub while choosing repositories: a flow record holding a hashed one-use nonce, a PKCE verifier and, once GitHub answers, who they are there and their token, sealed. It lasts ten minutes and goes when the connection saves, and the token it holds then is revoked at GitHub. Only the return of its newest request seals a token on it; a token no record takes is revoked at once. Identity comes only from a sign-in Patchy started; installing the App and its setup URL prove nothing.
_Avoid_: OAuth flow, login (Patchy's own)

**Suspended on GitHub**:
An installation whose account suspended the App, as the last mint found it: calls are refused saying so, the connection is never paused, and it works again by itself once unsuspended there. Shown in place of Connected, with when Patchy last checked.
_Avoid_: paused (an admin's), disabled

**Cooldown**:
An installation refused GitHub calls on every host until a time a limit answer set: GitHub's own, or a minute. Written in its own statement, only ever later; a limit on a person's own token while they connect refuses them and cools nothing.
_Avoid_: rate limit (GitHub's), backoff
