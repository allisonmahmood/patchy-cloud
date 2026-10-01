# Scenarios

What `pnpm dev up <scenario>` builds an environment from. See `docs/DEVELOPMENT.md`, **Environments**.

Each folder holds a `scenario.json`:

- `company`: name and handle.
- `people`: `key`, `name`, `email` and `admin` or `member` role. Use `.example` addresses; no mail is ever sent.
- `publisher`: the admin the environment's CLI publishes as.
- `patches`: repo patches (`repo`, `tier`, `description`, optional `sampleData`) and file patches (`file`, `name`, `description`), published in order.

A repo patch's source is `patches/<repo>/`, holding only builder-owned files: `src/`, `server/`, `helpers/`, `fixtures/`, `index.html`, `patchy.config.ts` and `AGENTS.md`. `up` runs `patchy init` at the scenario's tier, copies these over the starter, refreshes and publishes. Managed files (pins, lockfile, `patchy/_generated/`, project skills) always come from the instance's current release.

`sampleData: true` means the patch's empty state has a **Load sample data** button. `up` presses it once, as the publisher, after publishing. Sample data comes from the patch's own code, so it uses the scenario's people and goes through the patch's own rules.

File patches are static pages in `files/`, published with their `name` and `description`.

| Scenario     | What it is                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `team`       | The default. Acme Co: Ada (admin), Ben and Cleo. No patches.                                                                                                                                |
| `brightline` | A brand and digital agency: New Business (tier 2 CRM board), Spend Requests (tier 2 approvals with receipts), Kudos (tier 1) and a tier 0 kickoff brief. Five people, Allison is the admin. |
