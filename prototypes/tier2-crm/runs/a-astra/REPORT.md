# CRM delivery report

## Timing and publication

- Start: 2026-09-27 17:46:37 +02:00.
- Finish: 2026-09-27 18:41:31 +02:00, including publication and the report.
- Elapsed: 54 minutes 54 seconds. Finished inside the 90-minute time box.
- Published name: `crm-a-astra`.
- Address: http://127.0.0.1:24076/patchy-dev/crm-a-astra
- Patch id: `hdvar72hed2j`.
- Version: **1**, `ver_bf0dhp16hedofuzkn4a689in`.
- Company scope, tier 2, schema revision 1.
- Provisioned four tables: `members`, `companies`, `contacts`, `deals`; six indexes; one private file store, `attachments`.
- Unused resources: none. Publish warnings: none.

The published release contains no local contact, deal, finance or contract fixture data. I did not read or modify production business rows, contract bytes or finance records. Integration discovery read metadata only. Publication created this CRM's resources and declared its read-only dependencies.

## Implemented behavior

- Companies and contacts are visible to the team. Company, contact and deal mutations derive initial ownership from the authenticated viewer. Every edit, deletion, transfer and stage move checks ownership on the server.
- Teammates register through `team.join` when they open the app. Transfers select an authenticated, previously registered teammate, rather than accepting an arbitrary unverified user id.
- Private deal records are filtered in the board and company queries. Direct retrieval and attachment selection return `not_found` to non-owners. See the previously issued file-handle exception below.
- The pipeline has Lead, Qualified and Proposal lanes, plus a Won/Lost view. One subscribed server query returns all displayed lanes from one snapshot. Dragging and stage menus call owner-checked mutations.
- Attachments use `dealId/uploadToken/filename` keys. The store entry is the attachment record, so there is no separate metadata write after storing the bytes. The UI distinguishes staging failure, pre-write rejection, saved bytes, absent bytes and an unknown outcome. A lost reply is reconciled by reading the upload's unique key, never by automatically replaying a write.
- Raster images have thumbnails and an expanded viewer. Downloads use the shell broker. The current deal owner can remove attachments.
- Company pages subscribe to the contracts tool's shared `documents` store, using its documented `<company-slug>.pdf` and `.png` names. Missing files and access errors have visible states.
- CSV import runs in a single mutation. Parsing completes before writes. Invalid email and missing-company rows are rejected; existing and earlier valid-file duplicate emails are skipped; only valid new contacts create missing companies. New rows belong to the importer. The report includes physical source line numbers and reasons.
- The finance action reads the discovered `finance` Postgres connection. It aggregates payments per invoice before summing invoices, avoiding multiplication when an invoice has several payments. Amounts remain integer cents represented as strings across the server boundary and use bigint formatting in the UI.
- Companies, contacts, board lanes, attachments and finance reports are bounded and pageable. Company selection supports server-side prefix search. Finance is explicitly refreshed rather than presented as live Postgres data.

## Packages and handwritten code

No additional package was requested or installed. No allowlist exception was needed. I used the supplied `patchy` SDK and Preact through `patchy/preact`; Preact and signals remain the supplied dependencies. TypeScript, Vite, the single-file plugin and Node types were already installed build tooling.

The runtime allowlist did not provide a CSV parser, router, component library or CSS framework. I wrote the following without adding dependencies:

| Area                                                    | Rough delivered line count |
| ------------------------------------------------------- | -------------------------: |
| CSV parser                                              |                        131 |
| Transactional import and row results                    |                         90 |
| Ownership helpers, company/contact/deal/team handlers   |                        213 |
| Attachment handlers and browser workflow                |                        123 |
| Contracts and finance handlers/components               |                        242 |
| Remaining Preact UI, route handling and shared controls |                        460 |
| Shared record types                                     |                          7 |
| Handwritten CSS, expanded into readable declarations    |                      1,342 |
| Focused CSV tests using Node's built-in test runner     |                         36 |

The small exact-cent USD formatter is seven lines inside `src/Integrations.tsx`. Navigation uses Patchy's route broker, not a routing package. Icons are inline SVG paths. No React, external assets, client persistence, production data copies or outbound application requests were added.

Verification used the installed Chromium, Patchy's installed PGlite runtime, and `pdftoppm` for invented contract thumbnails. These were tools, not additional application dependencies. Temporary browser SDK exposure used during authorization checks was removed before final verification and publication. Generic generated sample fixtures were removed; the named contract fixtures are invented, non-binding local samples.

## Verification exercised

### Build and final restart

- `pnpm typecheck`: passed.
- `pnpm test`: all five tests passed. They cover quoted commas, escaped quotes, CRLF and embedded line breaks, physical source-line numbering, malformed trailing records, header mismatch, and contact/UTF-8 byte limits.
- Restarted `pnpm patchy dev` after final source/fixture cleanup. The final owner URL was `http://127.0.0.1:39437/dev/localdev0000`; the colleague URL was `http://127.0.0.1:41135/dev-as-colleague/localdev0000`.
- Rechecked the actual final build with both identities, without the temporary SDK probe. The board had no visible alerts. Created a zero-dollar Won deal through the form, then deleted it through the owner confirmation flow.
- `pnpm patchy publish --share company --json`: passed its release, typecheck, build and server-descriptor checks and returned the publication receipt above.

### Ownership and privacy

- Used the owner `usr_dev` and colleague `usr_colleague` in separate browser profiles.
- Attempted company and contact edits/deletions and public-deal edits/moves/deletions directly as the wrong viewer. All returned `owner_only`.
- Direct private deal reads, moves, deletions, attachment listing and upload-status queries by the other viewer returned `not_found`.
- A company-specific deal query returned no private deal belonging to the other viewer.
- Tested company and deal transfers through the UI, and contact transfer through the generated client. The previous owner lost write permission; the new owner could act. Supplying another owner id while creating a company or contact did not override creator ownership.
- Tested private deal handoff: old-owner queries were denied and the new owner obtained an attachment handle. Also tested the historical-handle limit described below.
- A company with a contact could not be deleted. After its contact's new owner deleted the contact, the company owner could delete the now-empty company.

### Live pipeline

- Created a public deal through the UI and observed it on the colleague's already-open board.
- Moved it from Lead to Qualified through the stage menu and observed the colleague's board change without navigation or reload.
- After consolidating subscriptions, exercised successive moves through Qualified, Proposal and Won; checked both the open and closed views.
- On the final restarted build, moved Freight renewal through the UI and observed it in the colleague's Qualified lane. The colleague page's `performance.timeOrigin` was unchanged.
- Each viewer's board showed their own private deal and omitted the other's private deal, including from the displayed totals.

### Attachments

- Uploaded an invented PDF and PNG through the file picker. The other viewer could see the public attachment list but had no upload/remove controls before becoming the deal owner.
- Downloaded the PDF through the colleague's UI. Chromium reported a completed 978-byte download. Its SHA-256 matched the source fixture exactly: `57cc7af1de08324c4561e893e5612368559943020302704672742a12aba98fa1`.
- Verified thumbnail loading and the expanded image viewer.
- Passing an owner's private-file handle to the colleague's document returned `access_denied`.
- Removed an attachment as the new deal owner. Redeeming a fresh handle to that removed file returned `not_found`.
- Submitted a staged file with an invalid filename. Found and fixed a recovery bug where the picker stayed disabled. The final UI said the file was staged but rejected before saving and allowed a corrected selection.
- Used Chromium response interception to drop the attachment action's reply after the server responded. The UI reconciled the key and reported the file saved. Exactly one matching attachment existed; the write was not replayed.
- A second use of a consumed Upload was refused by the SDK before handler execution. This confirmed that upload reuse is a platform refusal, not a handler-level retry mechanism.

### Import

- Imported `data/contacts.csv` through the UI: **140 contacts added, 10 companies created, 7 rejected rows, 5 duplicates skipped**.
- Re-imported the same file: **0 added, 0 companies created, 7 rejected, 145 skipped**.
- Imported a second synthetic file as the colleague, including a case-variant duplicate, an existing email, missing company, invalid email, quoted comma/quote and an embedded newline. It added three contacts and one company. New rows belonged to the colleague; an existing company's owner was unchanged.
- A malformed record after a valid record rejected the complete import. No company from that file appeared.
- Selecting an oversized CSV after a valid one cleared the prior selection and disabled Import, rather than accidentally importing the old file.

### Integrations and layout

- Acme Robotics displayed its invented contract thumbnail and PDF download action. Both identities could query its contract.
- The finance UI displayed Acme at **$3,750 invoiced / $1,750 paid / $2,000 outstanding**, and Blue Harbor at **$1,800 / $1,800 / $0**. CRM companies without ledger rows displayed zero totals.
- The aggregation SQL was also exercised against the local PGlite fixtures, including multiple payments on one invoice and an unpaid company.
- Inspected actual desktop and 390-pixel mobile screens. The mobile page did not overflow horizontally; the navigation strip scrolls independently. Checked native required-company validation and image expansion on that layout.

## SDK and skill gaps

1. **No authoritative teammate directory.** The documented viewer exposes only the current user, company and admin flag. `.agents/skills/patchy-server/SKILL.md:60` says: "there is no API to pick an identity." Installed client/server declarations exposed no member-directory method. The app therefore maintains authenticated visitors in `members`. It cannot validate whether a previously registered teammate is still an active company member.

2. **Issued file handles do not recheck application record ownership.** `.agents/skills/patchy-server/SKILL.md:83` says: "Filtering by viewer is your code; Patchy only checks that the viewer can reach the store at all." Line 125 says: "A handle freezes your selection until the query re-runs." I observed that a handle minted for a private deal's old owner remained redeemable after transfer, while fresh deal and attachment queries correctly returned `not_found`. The SDK has no record-authorization callback or handle-revocation method. The editor now states this limit.

3. **No transaction covering file bytes and table changes.** `.agents/skills/patchy-server/SKILL.md:126` says: "put then a mutation is not atomic." Using the file store entry itself as the attachment record avoids that particular second-write failure. Staging and lost replies still require explicit outcome reporting. There is no documented staged-upload cancellation helper.

4. **Conflicting store discovery text.** `.agents/skills/patchy-loop/SKILL.md:55` says "stores are not shareable", but `.agents/skills/patchy-files/SKILL.md:18-20` describes a shared, declarable store and `patchy add shared-store`. Discovery returned `shared: true` and `declarable: true`; declaring it worked. The loop sentence should be updated.

5. **Transaction wording needs a tier qualifier.** `.agents/skills/patchy-tables/SKILL.md:72` says "there is no cross-table transaction or automatic mutation retry." The server skill's line 51 explicitly documents one transaction per mutation and up to three executions on serialization conflict. The importer uses the tier 2 mutation contract, not the standalone table-call contract.

6. **Execution capacity is sharper than the client limits suggest.** The loop skill lists "at most 32 outstanding requests" at line 112. A few multi-viewer subscription reruns plus direct checks produced company-level `busy` refusals below that client limit. I replaced one subscription per lane with one board subscription. Repeated stage moves and final two-viewer checks then passed. No automatic write retries were added.

7. **Postgres is not subscribable.** `.agents/skills/patchy-server/SKILL.md:65` says: "A query cannot subscribe to it: call the action when the page needs fresh figures." The report has a Refresh action. A single transaction also cannot span owned CRM tables and the external finance connection, so a concurrent company rename can require a refresh.

8. **Local shared-store change simulation is not documented.** The shared-store skill documents fixtures loaded at dev start and says existing names are not overwritten. I verified file selection, image redemption and downloads, but did not mutate the live contracts tool to test a source-write notification. `CompanyContracts` uses the documented live query path. Source writes, unsharing and restoration remain unexercised integration cases.

## Blockers and recovery

Durations below are approximate active debugging time, not additional elapsed time.

| Blocker                                                                                                                                                                | Time                          | Resolution                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branded row ids and a conditional indexed-list type failed the initial typecheck                                                                                       | About 3 minutes               | Carried named `Row` id types through helpers/components and kept indexed/unindexed list options as distinct branches. No `any` escapes.                                                                                  |
| First Chromium launch timed out; reusing one custom profile reused its tab; frame evaluation used an isolated realm; some scaled pointer actions hit the wrong control | About 6 minutes total         | Used explicit headless/no-sandbox launch flags, separate owner/colleague profiles, main-realm SDK checks, and DOM-targeted UI actions when pointer helpers mis-targeted. Inspected real screenshots and download events. |
| Invalid attachment filename left the picker in an unknown state                                                                                                        | About 2 minutes               | Distinguished pre-write `HandlerError` rejection from a potentially lost action reply; verified recovery through the picker.                                                                                             |
| Intermittent `busy` during multi-viewer invalidations                                                                                                                  | About 4 minutes               | Consolidated board reads into one subscribed snapshot rather than fanning out per lane.                                                                                                                                  |
| Historical file-handle access after ownership transfer                                                                                                                 | About 3 minutes investigation | Confirmed the SDK boundary. Added an explicit editor warning and retained it as a known limitation rather than claiming revocation.                                                                                      |
| First CSS formatting pass expanded shorthands differently                                                                                                              | Under 1 minute                | Refused the changed serialization and preserved parsed declaration text. Re-parsing the formatted CSS produced identical rule serialization.                                                                             |

## Known limitations and unfinished verification

- **Strict immediate revocation of previously issued file handles is not implemented.** Fresh private-record queries and handle selection are owner-only. Previously issued handles, and bytes already downloaded, are a separate capability boundary. Remove sensitive attachments before changing visibility or ownership if old handles must stop working. This is the main exception to an absolute interpretation of "private everywhere".
- **Deleting a deal does not automatically purge its stored attachment bytes.** The confirmation warns the owner to remove attachments first. Deal deletion removes the record and prevents new attachment-list queries, but it does not call file deletion for the old names. Existing handles therefore have the same retention caveat. Automatic file/table deletion with resumable partial outcomes is not included.
- Teammates must open the CRM once before they can receive a transfer. The registry is not an authoritative active-member directory.
- Import accepts the sample's six headers in order, with a 500-contact / 512 KiB limit. Larger files must be split. Email checking is syntactic; it does not verify mailbox deliverability.
- The board and lists are bounded windows, not whole-database totals. Finance pages contain up to 25 CRM companies and match ledger rows by trimmed, case-insensitive company name, because the source supplies no stable CRM company id. Renaming a company can change its finance and contract association.
- Live changes and source-access loss in the real contracts tool were not induced. I did not use production modifications as a substitute for missing local simulation tooling.
- No permanent browser test framework or third-party packages were added. The permanent tests cover CSV boundary behavior; the authorization, multi-viewer and file scenarios above were exercised directly in the local runtime.
