# Deployment updates local prototypes

## Integrated app preview

Run these commands in a dedicated worktree so the preview has its own dev data:

```sh
pnpm install
pnpm dev
pnpm prototype:updates:seed
```

Open the printed dev URL and sign in as **Dev Machine**. The real app header has the bell on Patches, Company, Connections and Your machines. Open **View all updates** for the newest-first, expandable history. Merely opening the bell does not mark anything read; visiting the visible history marks the snapshot shown there.

The sample release-notes document lives once at `.local/dev/storage/platform-updates/history.json`, read through the existing content store. It is shared across all people and companies, outside patch-owned stores and the app database. Each signed-in person's browser stores only a read-through sequence in localStorage. It survives closing tabs, synchronizes between tabs on the same origin, and does not sync across devices. If browser storage is disabled, the marker lasts for the page only.

To simulate the next successful deployment:

```sh
pnpm prototype:updates:seed --deploy
```

Return to the app tab or open the bell to pick it up. Rerunning the seed without `--deploy` preserves the history. Restarting the local server preserves both the document and browser marker. The seeder refuses non-loopback instances and Clerk mode. It publishes sample content directly to local disk; it never runs a GitHub Action or contacts production. The app provides read-only session routes, not a publication endpoint.

The production workflow writer, useful notes from the deployed commit range, retry/rollback semantics and publication recovery are deferred. Sequence numbers identify ordered publication events and must never be reused for a different event; they are not commit hashes or GitHub run ids.

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
