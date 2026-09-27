# crm-b-opus: build report

## Time

- Start: 17:46 CEST (`date` at first command), 2026-09-27.
- Finish: 17:57 CEST by the same clock, report written after publish.
- Inside the 90-minute time box: yes. (The machine clock only advanced ~11 minutes over the whole session, which seems low for the amount of work. I'm reporting what `date` printed.)

## What was built

Published as `crm-b-opus` (patch `11bxuwkuetbr`, version 1, tier 2, company scope):
http://127.0.0.1:24076/patchy-dev/crm-b-opus

- **Records and ownership.** Tables `companies`, `contacts` and `deals` carry `ownerId`/`ownerName`. The creator is the owner. Every edit, handoff and delete handler runs `assertOwner` (`shared/access.ts`) and refuses anyone else with `not_owner`. A `members` roster, which each viewer joins on page load, supplies the handoff picker.
- **Deals and pipeline.** Deals have a stage enum, `valueCents` and `private`. `deals.pipeline` reads shared deals through the `byPrivate` index and the viewer's own private deals through `byOwnerPrivate`, so other people's private rows never leave the server. Company pages, `deals.get` and `attachments.list` filter or refuse the same way (`not_found`, so nobody can tell a private deal exists). The board subscribes with `useQuery`. Deals move by drag and drop or by a stage select, and the change reaches other open boards live.
- **Attachments.** `dealFiles` store keyed `<dealId>/<name>` plus an `attachments` record table. Attaching is stage → `put` → record, and the page reports each failure point separately:
  - sending failed, nothing saved;
  - refused by the server, nothing saved;
  - stored but not recorded: listed as "not recorded" with _Finish attaching_ / _Remove_;
  - `unknown_outcome`: the page says it may or may not be saved and asks you to check first.

  Removing a file reports file-deleted-but-record-kept the same way.

- **Contracts.** Found `contracts` (patch `bhqb6nld1vtz`) through `patchy list` and declared its shared `documents` store as `contracts`. `contracts.forCompany` stats `<slug>.pdf` / `<slug>.png`. It is a subscribed query, so it re-runs when the contracts tool writes or reshares its store. The page shows the thumbnail when one exists and a download button for the PDF.
- **Import.** `contacts.importCsv` parses the CSV on the server with a hand-written RFC 4180 parser. The checks run in this order: invalid email → rejected, blank company → rejected, email already saved or seen earlier in the file (trimmed, case-insensitive) → skipped. It creates missing companies owned by the importer and inserts everything in one transaction. On `data/contacts.csv` the result was 140 added, 7 rejected, 5 skipped, 10 companies created, with each problem row listed by line number and reason. Re-importing adds 0.
- **Finance.** Declared the `finance` Postgres connection. The `finance.report` action returns invoiced, paid and outstanding per company, summing payments per invoice first. The page has a Refresh button because Postgres cannot drive a subscription.

## Verification

- `pnpm typecheck` passes.
- `e2e/scenario.mjs` (Playwright against `patchy dev`, owner URL plus colleague URL) passes every check:
  - import;
  - the colleague cannot see the private deal on the board or company page, and `deals.get` / `attachments.list` refuse it;
  - the colleague's direct handler calls to move, rename and delete the owner's records are refused with `not_owner`;
  - drag and select moves show up live on the colleague's board;
  - attach, a bad-type refusal message, and the colleague seeing and downloading the attachment;
  - handoff, after which the new owner can move the deal and the old owner cannot;
  - contract states: thumbnail plus PDF, PDF only, and none;
  - finance totals.
- `e2e/forms.mjs` drives the dialogs: create company, create a private deal, a duplicate-email refusal, create a contact, and contacts paging.
- The server-side checks need handlers callable from the test. `src/main.tsx` exposes the client on `window` only when `VITE_E2E=1` is set in `.env.local` (gitignored). I deleted that file before publishing and checked that a build without it contains no hook.

## Packages

| Wanted                                    | Allowed?                                                      | What I did instead                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A CSV parser (papaparse)                  | No; not on the allowlist and `server/` only resolves `patchy` | Wrote `parseCsv` in `shared/rules.ts` (~35 lines)                                                                                                     |
| An email validator                        | No                                                            | One regex (1 line)                                                                                                                                    |
| `@zag-js/dialog`                          | Yes                                                           | Used native `<dialog>` + `showModal()` instead (~20 lines). The browser already gives focus trap, Escape and backdrop, so the machine was unnecessary |
| `@zag-js/combobox` for the company picker | Yes                                                           | Plain `<select>`; ten-odd companies didn't need it                                                                                                    |
| `@tanstack/preact-table`                  | Yes                                                           | Plain tables; contacts page on the server (50 per page)                                                                                               |
| A router                                  | Not provided                                                  | A `View` union in state (~10 lines)                                                                                                                   |
| Playwright for testing                    | CLI on PATH, not a repo dependency                            | Imported it from the mise install path in `e2e/*.mjs`; not added to `package.json`                                                                    |

## What the SDK or skills lacked

- **No team directory.** Handoff needs "a teammate", but neither `ctx.viewer`, `patchy.me()` nor any skill offers a list of company members. I built a `members` table that each viewer joins on page load. The catch: you can only hand a record to someone who has opened the CRM at least once.
- **The scaffold's DEV comment is wrong for `patchy dev`.** `src/main.tsx` says: "Debug helpers only in the local dev shell, never shipped: the build drops this branch." But `patchy dev` runs `vite.build` with a watcher (`dist/dev.js`), so `import.meta.env.DEV` is false there too and `preact/debug` never loads in the dev shell. I lost ~5 minutes to this when my `DEV`-gated test hook didn't appear. Reading `dev.js` explained it.
- **Unclear where server helpers live.** patchy-server says "put helpers in a non-exported function or a file outside `server/` that you import". The scaffold's `tsconfig.json` only includes `src`, `server`, `patchy`, so a helper directory isn't typechecked until you add it. I added `shared/`.
- **No named context type per handler kind.** Typing a helper that takes an action's `ctx` needed `Pick<Context<typeof config, "action">, ...>` imported from `patchy/server`. The skill says to import builders from the generated module, not `patchy/server`, but the generated module re-exports `Context` without the `Uses` parameter bound. `QueryTables<typeof config>` worked for table-only helpers.
- **Ref index names aren't documented.** The tables skill says "Refs are indexed automatically" but never says what the index is called. The types (`TableIndexes`) show it is the column name (`index: "companyId"`).
- **Summing money in Postgres.** `sum(int4)` returns int8, and the postgres skill says int8 arrives as a string. I cast to `float8` so I could use a `t.number()` shape. A note on the usual cast for aggregates would help.
- **Tables skill vs server skill on transactions.** The tables skill says "there is no cross-table transaction or automatic mutation retry". patchy-server says a mutation is one transaction and is retried up to three times. On tier 2 the server skill appears to be correct, so the tables line reads as tier 1 only.
- **Nowhere to test partial failures.** I found no way to make `put` succeed and the record write fail in `patchy dev`, so the "stored but not recorded" UI path is implemented but was never triggered.

## Where I got stuck

- The `import.meta.env.DEV` hook (~5 min, see above). Fixed by gating on `VITE_E2E` in `.env.local` instead.
- Finding the patch iframe in Playwright: it is the frame whose URL contains `/~content/`. Took a couple of minutes, found by printing `page.frames()`.

## Known bugs and unfinished parts

- The "stored but not recorded" and "file deleted, record kept" attachment paths were never exercised; see above.
- I didn't test the contracts list staying live when the contracts tool itself changes. Locally the shared store is only loaded from fixtures at dev start, and I did not publish changes to the real contracts tool. It relies on the documented subscription behaviour of `ctx.shared` in a query.
- Deleting a company is refused while it still has contacts or deals, including other people's private deals. The refusal therefore reveals that _something_ is attached, but not what.
- `companies.list`, the pipeline and the importer's duplicate scan read at most 1,000 rows per call. The importer pages through everything. The companies list and the board would silently truncate past 1,000 companies or 1,000 open deals.
- `ownerName` is copied onto records when they are created or handed off, so it doesn't follow later name changes.
- The published patch was not opened, to avoid writing roster rows into the live instance. Only the dev loop was exercised.
