# Deployment updates local prototypes

The integrated local preview reads the real **Deploy** GitHub Action history in `allisonmahmood/patchy-cloud`. Only successful attempts with a successful **Confirm the release is live** step create entries. The destination is local dev storage; this does not deploy Patchy or change the production workflow.

## Integrated app preview

Run these commands in a dedicated worktree so the preview has its own dev data:

```sh
pnpm install
pnpm dev
pnpm prototype:updates:sync --watch
```

Open the printed dev URL and sign in as **Dev Machine**. The real app header has the bell on Patches, Company, Connections and Your machines. Open **View all updates** for the newest-first, expandable history. Opening the bell marks its displayed update read and clears the dot; the summary stays visible until the bell closes. Reopening it shows All caught up. A visible page checks for updates every five seconds. Closing a tab without opening the bell leaves the update unread. Visiting the visible history also marks its displayed snapshot read.

The shared release-notes document lives once at `.local/dev/storage/platform-updates/history.json`, read through the existing content store. It is shared across all people and companies, outside patch-owned stores and the app database. Each signed-in person's browser stores only a read-through sequence in localStorage. It survives closing tabs, synchronizes between tabs on the same origin, and does not sync across devices. If browser storage is disabled, the marker lasts for the page only.

The watcher checks GitHub every 30 seconds using your authenticated `gh` CLI. Stop it with Ctrl-C; omit `--watch` for one import. Use `--worktree /absolute/path/to/preview` to write into another running local worktree. Return to the app tab or open the bell to pick up a newer deployment. Readers see a summary of what changed and expandable details; Action references stay internal.

GitHub Action runs determine both entries and their deployed commit ranges. Main updates, pull requests, CI and Server image runs cannot create entries. The importer reads the resolved `COMMIT` and `DEPLOYMENT_REVISION` from the confirmed deploy job, including explicit rollback targets. It preserves chronological rollback events, collapses retries of the same release, and keeps read-marker sequences stable on repeated imports. Successful confirmations are cached locally before GitHub logs expire.

Notes are generated from those deployed ranges using `RELEASE_NOTES_API_KEY`, or a reviewed local response file. A generation failure leaves an honest “details are being prepared” entry and retries later; it never invents feature or maintenance claims. See [Operations](../../../../docs/OPERATIONS.md#local-history-from-the-deploy-action) for setup and recovery. Live model output still needs quality evaluation.

Sample mode remains available in a separate local instance with `pnpm prototype:updates:seed`, then `pnpm prototype:updates:seed --deploy`. The seeder refuses to append invented entries to Action-backed history. The original standalone sketch below also remains sample-only.

### Browser behavior checks

```sh
pnpm exec playwright test -c playwright.tier1.config.ts --project=chromium updates.spec.ts
```

These checks start disposable local servers and exercise the real authenticated pages, browser script and content-store reader. They cover the newest-only bell, reading history, closing/reopening tabs, cross-tab read markers, a newer deployment arriving on an older history snapshot, blocked/full storage, unavailable history and switching people. Publication is simulated by replacing the instance's shared document. Focus and visibility events are controlled for deterministic headless checks; tab closure and storage events use real browser behavior. Screenshots land in `.local/tier1-results/`. Existing dev instances and production are untouched.

Compatibility checks pass real generator drafts through the shared document reader into the bell and expanded history. Plain-language sample notes cover New, Improved and Fixed changes; drafts cover first deployment, same-version maintenance, rollback and internal-only work. The checks verify that display copy survives intact and internal provenance stays out of the notes. Samples are hand-authored: these checks do not prove the factual accuracy or readability of future AI output. Review that output locally for a clear user benefit, concrete behavior and any necessary action before using it in a simulation.

## Original standalone interaction sketch

Throwaway preview of the chosen interaction: a bell shows the newest deployment;
**View all updates** opens newest-first history, with an expandable entry per
deployment. Opening the history clears the bell through the entries shown.
When nothing is unread, the bell shows **All caught up** and **View all updates**,
with no previously read deployment card.

From the repository root, run `pnpm prototype:updates`, then open
<http://127.0.0.1:20660>. Stop with Ctrl-C. An optional
`PATCHY_PROTOTYPE_PORT` changes the port.

Open **Simulation** at the bottom right to:

- **Simulate new deployment**: prepare sample notes in the local Action simulator,
  confirm a successful deployment, and publish one history entry.
- **Retry latest deployment**: repeat that deployment without another entry.
- **Return to Patchy**: return to the portal without clearing unread updates.
- **Reset demo**: restore three sample deployments, two unread.

Close the tab and return to try persistence. The disposable file
`.local/updates-prototype/PROTOTYPE-state.json` holds history and the sample
viewer's read marker; it survives restarting the preview too. This prototype
has one shared sample viewer, not real authentication or per-account storage.

`deploy-action.mjs` is the simulated GitHub Action boundary. It prepares a notes
payload from invented release-note fixtures, then publishes only confirmed
successful deployments. The browser does not compose release notes. The actual
production workflow is not connected or modified, and this does not generate
notes from real commits or call an AI model.

The preview imports Patchy's existing HTML shell and uses sample portal content.
It listens only on loopback, has no production credentials, and does not change
the separately running dev instance. The other navigation sections are context
only. This standalone sketch does not install routes in the real app. The integrated preview above does.
