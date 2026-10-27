# ADR-0013 — Each integration chooses its dev binding

`patchy dev` runs an integration through local fixtures or a fake by default, so a builder's agent never reaches company rows while building. An integration reads the real connection in dev instead when fixtures wouldn't resemble production, and writes never run live in dev. Postgres keeps fixtures: PGlite stands in for it and its schema is known. PostHog reads live: HogQL can't run locally and a project's events and properties aren't known ahead. Pidgeon reads live too: mail a builder's agent invents never resembles a company's, as #819's invoice trial showed when the agent built a parser for its own made-up invoices and found none of the real ones. Each connect form says so before an admin connects.

A live dev read goes through a separate, narrow door on the instance, never the published runtime, which keeps refusing bearer tokens. The machine token is the only authority there: its current person, company and machine decide each call, checked again after any wait for a slot. The repo's manifest only routes the call to a connection, which must be a connected one of the token's company. The door runs only the operations an integration's definition names as `live`, which are only reads, under the runtime's argument and result bounds, deadlines, per-project or per-address slots and draining, and a per-person rate limit that names no patch. Both local viewers read as the machine token's person. The credentials stay on the instance; the token reaches the dev daemon on stdin and stays out of files, logs and workerd. Each read, refusals included, is logged as a machine call with no patch or version, shown as a dev call on the connection page.

An integration that can write simulates its writes in dev. Pidgeon's sends, replies and triage never reach the instance: `patchy dev` checks each call's arguments and the connection's access as the host would, answers with a well-formed result whose new ids start `dev_` and whose `test` is true, and prints what it would have sent in dev's output. Nothing changes, so a simulated reply doesn't appear in the next live read. Dev doesn't check Pidgeon's send policy, since the snapshot can't tell who the address has written with. Pidgeon's test-mode keys can't stand in for this: #823 found a test key's replies and triage land in the real conversations the team reads.

Future integrations choose for themselves by the same rule: a fixture or fake where the shapes are known, live reads where fixtures wouldn't resemble production, and simulated writes wherever the integration writes.

## Considered options

- **Fixtures for every integration.** Rejected for PostHog: hand-written events would never look like the project's, so a dashboard built on them would break on publish. Rejected for Pidgeon by #819's invoice trial.
- **Live reads through the published runtime.** Rejected: it would have to admit bearer tokens and invent a loaded version for a patch that isn't published.
- **Live dev reads for Postgres.** Rejected: Postgres can write and its fixtures work; a builder's agent reading production rows would gain nothing fixtures don't give.
- **Live writes in dev, or through a Pidgeon test key.** Rejected: a builder pressing Send while building would mail a customer or change the conversations the team works from.

## Consequences

A dev read is real company data under the builder's own access, the same any member already has through a published patch. An expired or revoked key, a deactivated person, a disconnected source or an unreachable instance stops these reads with a clear error while the rest of dev, simulated writes included, keeps working. A simulated write's ids name nothing in the integration, so reading one back answers `not_found`. A release reads only the credential kinds it knows, so rolling back to one from before machine calls hides dev calls rather than breaking a connection's recent calls.

Decided in [#643](https://github.com/allisonmahmood/patchy-cloud/issues/643), implemented by [#647](https://github.com/allisonmahmood/patchy-cloud/issues/647). Amended for writes and Pidgeon in [#822](https://github.com/allisonmahmood/patchy-cloud/issues/822), implemented by [#826](https://github.com/allisonmahmood/patchy-cloud/issues/826).
