# ADR-0013 — Each integration chooses its dev binding

`patchy dev` runs an integration through local fixtures or a fake by default, so a builder's agent never reaches company rows while building. An integration may instead read the real connection in dev when two things hold: the shapes it returns can't be known ahead of time, so fixtures would never resemble production, and it can't write, so a dev read can't change anything. Postgres keeps fixtures: PGlite stands in for it and its schema is known. PostHog reads live: HogQL can't run locally and a project's events and properties aren't known ahead. Its connect form says so before an admin connects.

A live dev read goes through a separate, narrow door on the instance, never the published runtime, which keeps refusing bearer tokens. The machine token is the only authority there: its current person, company and machine decide each call, checked again after any wait for a query slot. The repo's manifest only routes the call to a connection, which must be a connected one of the token's company. The door runs only the operations an integration's definition names as `live`, under the runtime's argument and result bounds, deadlines, per-project slots and draining, and a per-person rate limit that names no patch. Both local viewers read as the machine token's person. The credentials stay on the instance; the token reaches the dev daemon on stdin and stays out of files, logs and workerd. Each read, refusals included, is logged as a machine call with no patch or version, shown as a dev call on the connection page.

Future integrations choose for themselves by the same rule: a fixture or fake where the shapes are known, live reads where they aren't and the integration can't write.

## Considered options

- **Fixtures for every integration.** Rejected for PostHog: hand-written events would never look like the project's, so a dashboard built on them would break on publish.
- **Live reads through the published runtime.** Rejected: it would have to admit bearer tokens and invent a loaded version for a patch that isn't published.
- **Live dev reads for Postgres.** Rejected: Postgres can write and its fixtures work; a builder's agent reading production rows would gain nothing fixtures don't give.

## Consequences

A dev read is real company data under the builder's own access, the same any member already has through a published patch. An expired or revoked key, a deactivated person, a disconnected source or an unreachable instance stops these reads with a clear error while the rest of dev keeps working. Rolling back to a release that doesn't know machine calls breaks the recent calls of a connection that has them, until rolled forward or those rows are deleted.

Decided in [#643](https://github.com/allisonmahmood/patchy-cloud/issues/643), implemented by [#647](https://github.com/allisonmahmood/patchy-cloud/issues/647).
