# Local updates prototype

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
only. No production routes, APIs, schemas, migrations, or package exports change.
