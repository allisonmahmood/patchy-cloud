# CRM build report

## Times and outcome

- Started: 2026-09-27T17:46:32+02:00, or 15:46:32 UTC.
- Finished: 2026-09-27T16:29:31.607Z.
- Elapsed: approximately 43.0 minutes. Inside the 90-minute time box.
- Published as **crm-b-astra**, version 1, tier 2, company-only access.
- Address: http://127.0.0.1:24076/patchy-dev/crm-b-astra
- Patch id: e97c304w3wxq. Version id: ver_8sfxxn1uigbh0kqbqpw6z3l2.
- Provisioned tables: members, companies, contacts, deals. Provisioned file store: attachments. Seven declared indexes. No unused resources and no publish warnings.

All six workflows are implemented. There is a material SDK limitation around attachment handles issued before a privacy or ownership change. New record and attachment reads enforce ownership and privacy, but previously issued file handles are not revoked by those record changes. The strict interpretation of private access after such a change is therefore not fully met. See the security limitation below.

## What was built

- Companies and contacts are shared with the team. Creation assigns the authenticated viewer as owner. Server mutations enforce ownership for edits, deletion and transfers. A company with linked records cannot be deleted.
- Deals hold a company reference, integer USD cents, one of Lead / Qualified / Proposal / Won / Lost, notes, an owner and a private flag. Private deals are filtered on the server from both pipeline and company queries. Direct private-record reads return not_found to other viewers.
- The pipeline uses one live query per board, returning a consistent snapshot of the displayed stages. Owners move deals through a stage select. Open and closed stages have separate views. Server-backed pagination bounds company, contact, deal and file lists.
- Attachments use the file store as their only metadata source. There is no second attachment row that can fail after a successful put. The UI separates staging from storage, reports staged / stored / unknown outcomes, and offers a read-only exact-key reconciliation. It never automatically replays an upload or mutation. Raster images have previews; all attachments have shell-mediated downloads.
- Discovered contracts via Patchy's metadata CLI, then declared bhqb6nld1vtz/documents as contracts. Company pages subscribe to the exact company-slug PDF and PNG names. They display the thumbnail, download the PDF and show source-access errors instead of stale content.
- CSV import accepts the supplied six-column format, BOM, CRLF, quoted commas, escaped quotes and embedded newlines. Email and company validation precede duplicate handling. Normalized email and company-name indexes prevent duplicates. A transaction creates companies only for accepted, nonduplicate rows and assigns imported records to the importer. Every rejected or skipped row has its logical CSV row number and reason.
- Discovered and declared the finance Postgres connection. Separate invoice and payment aggregations avoid counting an invoice once per payment. Exact decimal-string cents and BigInt formatting avoid int4 aggregation overflow. Finance-only companies and CRM companies without invoices are included. Finance refresh is explicit because connections are action-only, not subscribable.

Development used the supplied local CSV and synthetic contract/finance fixtures. No production rows or file bytes were copied into development. Publishing created only this CRM's resources and declarations; it did not modify the contracts tool or finance database. Local CRM rows and sample attachments are not published as production data.

## Packages and handwritten replacements

No dependencies were installed or added. The existing pinned release and its admitted packages were used.

| Package or capability                                | Allowed?                                    | Decision                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| patchy                                               | Yes                                         | Used the generated client, typed handlers, tables, files, subscriptions and declared integrations.                                                                    |
| preact through patchy/preact                         | Yes                                         | Used hooks and rendering through the required compatibility entry point. No React dependency.                                                                         |
| @zag-js/preact and @zag-js/dialog                    | Yes                                         | Used for modal focus management, dismissal and dialog semantics.                                                                                                      |
| @zag-js/combobox, select and menu                    | Yes, already installed                      | Not needed. Used native selects, a server-backed company-name search, and explicit edit/transfer/delete buttons.                                                      |
| @tanstack/preact-table                               | Yes, already installed                      | Not needed for bounded server pages. Rendered native tables with server-side indexed search and pagination.                                                           |
| @preact/signals                                      | Yes, already installed                      | No direct application use; ordinary hook state was sufficient.                                                                                                        |
| CSV parser package                                   | No server package beyond Patchy is admitted | No package was requested or installed. Wrote lib/csv.ts, approximately 116 lines, and transactional import logic, approximately 167 lines.                            |
| Router, CSS framework, currency library, test runner | Not requested                               | Native state navigation, handwritten CSS, Intl and BigInt were sufficient. Verification used the actual local shell and browser rather than adding a test dependency. |

Approximate handwritten source counts at the final typecheck:

- Main UI and reusable controls: 231 TSX lines, with some compact JSX.
- Attachment UI and handlers: 325 lines.
- Import UI, parser and handlers: 437 lines.
- Contract/finance UI and handlers: 322 lines.
- Record/deal handlers and shared validation: 229 lines.
- Schema: 24 lines. CSS: about 14 KiB of compact rules.

The only packages wanted for the implementation were the existing Patchy/Preact runtime and Zag dialog pair. No rejected package installation was attempted.

## Verification performed

### Build and publication

- Final pnpm typecheck passed.
- pnpm patchy dev --json started a healthy local runtime.
- pnpm patchy publish --share company --json succeeded. The publish also performed its own typecheck, client build, server build and descriptor validation.
- Temporary browser smoke access was removed before publication. The final browser check observed that globalThis.crmSmoke was undefined.

### Both identities

Used the actual development shells as usr_dev / dev@patchy.local and usr_colleague / colleague@patchy.local:

- Owner: http://127.0.0.1:40921/dev/localdev0000
- Colleague: http://127.0.0.1:40935/dev-as-colleague/localdev0000

Observed company/contact creation through the real forms, including Enter-to-save, listing and deletion. Also exercised server calls through the authenticated page broker to bypass hidden UI controls deliberately.

The colleague's attempts to edit, delete or transfer the owner's companies and contacts returned not_owner. Attempts to update, move, delete or transfer the owner's public deal returned not_owner. Reading a private deal, moving it or listing its attachments returned not_found. The colleague could see shared companies, contacts, company contracts and finance totals.

Transferred a company, contact and deal to the colleague. The old owner lost write/delete access; the new owner successfully edited them and deleted the temporary records. Transferred a private deal through the UI in both directions. The old owner's board lost it, the new owner's board gained it, and the old owner's direct detail read returned not_found. The new owner could list the private deal's attachment.

### Live pipeline

With both boards open, moved the public Acme annual platform deal from Lead to Qualified and then Proposal. The colleague saw each change without reloading. After consolidating the board query, checked that the colleague's iframe id was unchanged across the move.

Final local board state:

- Owner Proposal column: public $24,000 deal plus private $90,000 deal, total $114,000.
- Colleague Proposal column: public $24,000 deal only.

### Import

The supplied data/contacts.csv produced:

- First import: 140 added, 7 rejected, 5 skipped, 10 companies created, 152 rows processed.
- Repeat import: 0 added, 7 rejected, 145 skipped, 0 companies created.
- The UI displayed all rejected/skipped row reasons.

An additional quoted/BOM/CRLF specimen produced 2 added, 2 rejected, 1 skipped and 1 company. An escaped surname quote and a multiline job title survived parsing and storage. Case-insensitive duplicate detection worked. Companies mentioned only in invalid or duplicate rows were not created. An unclosed quote was rejected by the parser. Temporary specimen rows were removed afterward.

### Files and contracts

- Staged and stored a PNG through the actual attachment UI. The colleague saw its live appearance, rendered its preview and downloaded it.
- Colleague upload and removal calls returned not_owner.
- Owner removal disappeared from the colleague's open attachment list without a reload.
- Injected a staging refusal before sending an attach action. The UI reported that nothing had been attached.
- Injected a lost reply after a real successful file-store write. The UI reported an unknown storage outcome, then an explicit exact-key check reported Stored. No upload was automatically replayed.
- Passing the owner's private-file handle to the colleague returned access_denied.
- Company contract thumbnail decoded at its expected 612-pixel width, and PDF download succeeded.
- SHA-256 hashes of downloaded PNG and PDF bytes matched the local synthetic fixture files exactly.

The contracts query uses the SDK's shared-store subscription dependency, but no source-tool write was simulated. The consumer's local fixture interface is read-only and loads existing file names without overwriting them. I did not mutate the live contracts tool to manufacture a test.

### Finance and layout

Both viewers received the expected synthetic totals:

| Company           |   Invoiced |      Paid | Outstanding |
| ----------------- | ---------: | --------: | ----------: |
| Acme Robotics     | $15,000.00 | $7,500.00 |   $7,500.00 |
| Blue Harbor Foods | $10,000.00 | $8,800.00 |   $1,200.00 |

The Acme fixture includes two payments against one invoice and a separate unpaid invoice. Companies without invoices appeared with zero totals. Inspected the actual desktop pipeline, company/contract page, import page, dialogs and the narrow-screen finance page. Fixed narrow-screen navigation overflow and contained the finance table's horizontal scrolling.

## SDK and skill gaps

1. **Record authorization does not revoke issued file handles.** patchy-server/SKILL.md:83 says, "Filtering by viewer is your code; Patchy only checks that the viewer can reach the store at all." Line 125 says, "A handle freezes your selection until the query re-runs." The installed SDK binds the handle to viewer, patch, version and stored object, but redemption does not call this CRM's current deal policy. Measured result after making a public deal private: a new attachment query returned not_found, while the same colleague's previously issued handle still redeemed. The SDK needs a revocation/policy hook tied to record access, or an atomic operation for changing access and invalidating the selected objects. UI warnings explain the remove-before-restricting-access workaround. This is not presented as solved.

2. **No atomic table/file operation or conditional file create.** patchy-server/SKILL.md:126 explicitly says, "put then a mutation is not atomic." Avoided that two-write attachment design entirely. The SDK still cannot atomically couple an ownership check with a file write. UUID keys plus stat reject sequential reuse, but there is no put-if-absent primitive.

3. **No company teammate directory in the documented/generated client.** The available identity is the current viewer. The CRM therefore registers authenticated visitors in members and offers those people as handoff targets. A teammate must open the CRM once before appearing in the picker.

4. **No staged-upload discard operation.** A file may be staged and then abandoned. The page never adopts those bytes into attachments, but cleanup of temporary uploads belongs to Patchy.

5. **Transaction wording conflicts.** patchy-tables/SKILL.md:72 says, "there is no cross-table transaction or automatic mutation retry." patchy-server/SKILL.md:51 specifies one transaction per mutation invocation and serialization retries. The importer follows the tier-2 server contract, not the older direct-table wording.

6. **Store-sharing wording conflicts.** patchy-loop/SKILL.md:55 says, "stores are not shareable." patchy-files/SKILL.md:18-21 and patchy-shared-stores/SKILL.md correctly document declarable shared stores for tier 2. Discovery returned documents as shared and declarable, and shared-store add succeeded.

7. **The company invocation limit was not stated with the client limits.** The local engine returned "busy: 4 invocations already running for the company." patchy-loop/SKILL.md:112 documents 32 outstanding requests per frame, which is a different limit. A three-query board amplified invalidations across two viewers. Consolidated it into one query per board and avoided redundant member updates. Refusals remain visible; mutations are not replayed automatically.

8. **The finance example narrows aggregates to int4.** patchy-server/SKILL.md:137 uses sum(amount_cents)::int. This can overflow a valid multi-invoice total. The implementation uses bigint inputs, decimal text results and BigInt display formatting.

9. **No local shared-source mutation control was documented.** patchy-shared-stores/SKILL.md:16 says an existing fixture name "is never overwritten." This makes initial contract display straightforward but does not provide a way for a consumer repo to exercise a live source replacement. Live source-change behavior was not claimed as tested.

10. **Publish help mixes file and repo options.** publish --help lists --name without marking it file-only. A repo publish with --name was rejected locally. Retried without the flag; the name in patchy.config.ts was used.

## Blocks and how they were handled

Durations are approximate:

- About 2 minutes fixing the first typecheck. Branded row IDs had been widened to strings in UI props and two handlers. Carried Id types through selection and props, used t.ref arguments, and narrowed handler error details correctly.
- About 2 minutes on browser automation. The sandbox is an iframe, and the browser helper evaluates in an isolated realm by default. Used scoped frame selectors for UI and the main realm for the temporary authenticated smoke client. Incorrect automation selectors were corrected after inspecting the actual DOM.
- About 3 minutes on invocation-capacity refusals during rapid two-viewer mutations. Reconciled the refused operation before continuing, combined all pipeline stages into one snapshot query and removed unnecessary member updates.
- About 5 minutes inspecting and measuring retained file-handle behavior. Confirmed the limitation with the actual SDK and browser. Added UI warnings and documented the unresolved security boundary rather than claiming revocation.
- About 1 minute fixing mobile navigation overflow.
- Less than 1 minute on the file-only --name publish flag. The corrected repo publish succeeded.

## Known bugs, limits and unfinished parts

- **Material privacy limitation:** already-issued attachment handles remain usable by that same viewer after a deal becomes private or changes owner. Fresh record/file selection is protected; historical capability revocation is not. Removing the old files invalidates their handles, so the UI advises removal before restricting access and reattachment afterward. Downloaded copies cannot be recalled under any implementation.
- **[INFERENCE] Concurrent file-operation race:** action-level table checks and file writes are not atomic. A transfer/delete concurrent with an already-admitted upload can leave a file associated with a changed or deleted record. Deliberate simultaneous reuse of one upload id may race the stat check. These races were not stress-tested.
- **[INFERENCE] Orphan bytes after a direct deal deletion:** the UI requires an empty attachment list before offering deletion. The owner-authorized delete mutation itself does not transact with file storage. Bypassing that UI can leave inaccessible files; every subsequent attachment query still requires an existing visible deal.
- The teammate picker contains CRM visitors, not every company account. It is bounded to 1,000 visitors, sufficient for the stated small-team purpose.
- CSV imports are bounded to 250 data rows and 256 KiB per file. Larger files receive an explicit split-file message.
- Finance is a point-in-time report with manual refresh, as required by the action-only connection API. It matches companies by normalized name, as the source schema specifies. Renaming a CRM company can change its finance/contract match.
- PDF attachments are downloaded through the shell; raster images are previewed inline. There is no embedded PDF renderer.
- Live pipeline updates were tested. Live changes made by the separate contracts tool were not simulated locally.
- No persistent automated test suite was added. The report records actual runtime/browser scenarios, not claims based only on typechecking.

No temporary handler, test-only browser export or extracted SDK source was included in the published bundle.
