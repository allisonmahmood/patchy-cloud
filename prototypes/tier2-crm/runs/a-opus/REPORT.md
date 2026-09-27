# crm-a-opus report

## Time

- Start: 17:46:16 CEST, 2026-09-27 (first `date` in the session).
- Finish: 17:55:03 CEST (after publish), plus the time to write this report.
- Finished inside the 90-minute time box: yes.

These are the machine's `date` readings. The elapsed time looks short for the amount of work, so read it as the clock's value, not a claim about effort.

## What was built

Published as `crm-a-opus`: patch `lb4wmb1md1dd`, version 1, company scope, tier 2, at `http://127.0.0.1:24076/patchy-dev/crm-a-opus`. Publish provisioned 5 tables (`members`, `companies`, `contacts`, `deals`, `dealFiles`) and 1 store (`attachments`). Nothing was reported unused and there were no warnings.

- **Ownership.** Every company, contact and deal has an `ownerId`, set from `ctx.viewer.user.id` on insert. Each `update`, `remove`, `move` and `transfer` mutation calls `requireOwner` on the server (`lib/rules.ts`). The page hides controls, but it isn't the gate.
- **Private deals.** `canSee()` runs in every deal-reading handler: `pipeline`, `list`, `get`, `companies.get`, `files.forDeal`, and all deal mutations and actions. For anyone but the owner, a private deal looks exactly like a missing one (`not_found` / null).
- **Pipeline.** `useQuery(deals.pipeline)` shows three open columns plus Won/Lost drop zones. Owners can drag cards or use a stage menu on each card.
- **Attachments.** The page calls `files.stage`, then the `files.attach` action. The action checks the owner, the size (10 MB max) and the name, `put`s the file, and then records it with `ctx.run.files.record`. The listing is the store contents under `<dealId>/` joined with the records, so a file that was stored but never recorded shows as "not recorded" with Retry and Remove buttons. The page reports each outcome separately:
  - the upload failed and nothing was saved;
  - the handler refused and nothing was stored;
  - the file was stored but not recorded;
  - there was no reply (`unknown_outcome`), so the user should check the live list before retrying;
  - storing failed.

  Detach and deal deletion return how far they got in the same way.

- **Contracts.** I declared `bhqb6nld1vtz/documents` from the "contracts" tool as the shared store `contracts`. `contracts.forCompany` stats `<slug>.pdf` and `<slug>.png`, using the slug rule from the store description. The company page subscribes to it and shows a thumbnail through `useFileUrl` and a "Download PDF" button.
- **Import.** The `importer.contacts` mutation runs in one transaction, all or nothing. It uses a hand-written CSV parser. Invalid emails and blank companies (including whitespace-only) are rejected. Duplicates are matched on trimmed, lower-cased email, both within the file and against saved contacts, and skipped. Missing companies are created, matching names case-insensitively, and owned by the importer. With `data/contacts.csv`: 140 added, 10 companies created, 7 rejected, 5 skipped, which accounts for all 152 data rows. Every problem row is listed with its line, outcome and reason.
- **Finance.** I declared the `finance` Postgres connection. The `finance.report` action runs one grouped SQL query to get invoiced, paid and outstanding per company, and links each row to the CRM company when the names match. There is a Refresh button because Postgres can't drive a subscription.

## Exercised in the dev loop

I drove both dev URLs (owner "Patchy Dev" and "Colleague (dev fixture)") with Playwright and headless `/usr/bin/chromium` (`scripts/e2e.mjs`; it imports Playwright from this machine's absolute mise path). Everything below was observed:

- The CSV import results above.
- The owner created a public deal and a private deal. The colleague's board showed the public deal and not the private one (count 0). The private deal also didn't appear on the colleague's Cobalt Freight company page ("No deals.").
- The owner moved "Acme expansion" to Proposal, and it appeared in the colleague's Proposal column without a reload.
- The owner attached a PDF and a PNG. The colleague saw both, including the PNG thumbnail, and downloaded the PDF (Playwright captured the download `proposal.pdf`). The colleague had no Edit button and no file input.
- **Server enforcement.** The owner opened the deal's edit form in one tab and handed the deal to the colleague from a second tab. Saving the stale form was refused by the server: "Only the owner can change this." The colleague then had the stage menu.
- **Partial attach.** I temporarily added a throw to `files.record` (since removed) and attached a file. The page said: "The file is stored but was not recorded on the deal; it is listed below as 'not recorded'…". After I removed the throw, Retry recorded the file and Remove deleted it.
- Acme Robotics showed its contract thumbnail and a Download PDF button. Driftwood Studio, which has no PNG in the fixtures, showed "No thumbnail." and still offered the PDF.
- The finance table showed per-company totals from the fixture ledger, including one company that isn't in the CRM.
- `pnpm typecheck` passes.

## Packages

| Wanted                                 | Allowed?                                                       | What I did instead                                                          |
| -------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A CSV parser (papaparse or csv-parse)  | No: the server import rule allows only `patchy` and `patchy/*` | `lib/csv.ts`, ~29 lines (quotes, doubled quotes, CRLF)                      |
| A router (wouter or TanStack Router)   | No: "No router, CSS framework, state library or test runner"   | Tab and selection state in `App.tsx`, ~20 lines                             |
| A CSS framework (Tailwind)             | No                                                             | `src/styles.css`, 72 lines                                                  |
| An email validator                     | No                                                             | A single regex in `lib/rules.ts`                                            |
| Playwright as a project dev dependency | Not installed (the brief says to use the CLI on PATH)          | Imported from the global mise install by absolute path in `scripts/e2e.mjs` |

I didn't install anything.

## What the SDK or skills lacked

- **No team directory.** Handing a record "to a teammate" needs the list of teammates, but `ctx.viewer` and `patchy.me()` only return the current user, and nothing lists company members. As a workaround, each viewer registers into a `members` table on page load (`members.hello`). The limitation is that you can only hand a record to someone who has opened the CRM at least once.
- **Row-level privacy is all hand-written.** The loop skill says: "Every readable row is available to whoever can open the patch … UI filters and `me()` are not row-level authorization". On tier 2, handlers are the boundary, so every deal-reading path has to remember to call `canSee`. Nothing in the SDK prevents a future handler from leaking private deals, for example by returning `t.row("deals")` from an unfiltered list.
- **Contradictory table skill text.** `patchy-tables` says "Writes are last-write-wins; there is no cross-table transaction or automatic mutation retry", while `patchy-server` says a mutation is "one transaction per invocation … may execute up to three times". For tier 2 I followed the server skill.
- **Ref index names.** The tables skill says "Refs are indexed automatically", but never gives the index name you pass to `list({ index })`. I found it is the column name (`index: "company"`) by reading `TableIndexes` in `node_modules/patchy/dist/_types/*.d.ts`.
- **`ctx.run` is untyped.** It is `{ [module]: { [handler]: (args?) => Promise<unknown> } }`, so it needs `ctx.run.files!.record!(...)` with non-null assertions, and a renamed handler isn't caught at typecheck. The server skill doesn't mention this.
- **Wrong thumbnail format in the fixture stub.** `patchy add shared-store` laid down `sample.pdf` and `sample.svg`, but the source store's description says thumbnails are `<slug>.png`. I replaced the samples with invented `acme-robotics.pdf/.png` and so on, generated with a short Python snippet.
- **No sibling-file guidance for server code.** The server skill says to put helpers "in a file outside `server/` that you import", but the scaffold's `tsconfig.json` doesn't include such a directory. I added `lib` to `include`. It also doesn't warn that a helper which imports `HandlerError` from `_generated/server.js` will pull server code into the page bundle if `src/` imports it. I split `lib/stages.ts` out for that reason.
- **Stale generated file.** `patchy/_generated/context/table-notes.md` was left behind after I removed the `notes` table and refreshed. I didn't touch it because it's generated.
- **Contract liveness can't be exercised locally.** `patchy dev` loads the shared-store fixtures once at start, and there is no local way to write to the source store. The claim that "the list stays live if the contracts tool changes" rests on the `subscribe` semantics the shared-stores skill documents. I didn't observe it.
- **Unclear shape of `t.upload()` in Playwright runs.** `files.stage` worked in the dev shell. The skill doesn't say whether a staged-but-never-adopted upload expires, so abandoned stages are unaccounted for.

## Where I got stuck

- **Playwright wouldn't import** because it isn't a project dependency. Resolving the global mise install's `index.mjs` by absolute path fixed it (about 2 minutes).
- **Name collision:** I first named both a table and the store `attachments`, which the tables skill forbids. I renamed the table to `dealFiles` before the first refresh (under a minute).

Nothing else blocked; typecheck and the first e2e run passed without source fixes.

## Known bugs and unfinished parts

- **Handoff needs a prior visit:** a teammate who has never opened the CRM can't receive records.
- **Lists are capped at 1,000 rows with no paging UI:** this applies to `contacts.list`, `companies.list`, `deals.list` and per-stage pipeline lists. Filtering on the Contacts and Companies pages happens in the browser over that window.
- **Duplicate-check gap:** the in-file duplicate check can't tell rows apart when two different people share an email. That is by design of the rule, but worth knowing.
- **Import scale:** the import is one mutation. A 1,000-row CSV (the cap) does up to about 2,000 indexed lookups in one transaction, which I haven't tested near the 10-second deadline.
- **Stale edit form:** after a deal is handed away while its edit form is open, the form stays open (Save is refused with a clear error) instead of closing itself.
- **Company names and slugs:** a company renamed in the CRM stops matching its contract file unless the contracts tool uses the new slug. Finance also matches on the exact name, case-insensitive.
- **Drag-and-drop not automated:** I only exercised stage moves through the stage menu in the e2e run.
- **Published version not opened:** I didn't open the published URL in a browser. Publish succeeded and reported healthy provisioning, but I only verified behaviour in `patchy dev`.
