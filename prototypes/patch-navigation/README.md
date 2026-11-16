# Patch navigation exploration

Throwaway clickable mockups for [issue #1459](https://github.com/allisonmahmood/patchy-cloud/issues/1459). This branch and PR are for design exploration only. Do not merge them. No product behavior is implemented.

## Run

From the repository root, with Node 22.18 or newer:

```sh
node prototypes/patch-navigation/serve.ts
```

Open http://127.0.0.1:43159. Stop with Ctrl+C. Run the same command to restart. To use a different port, append its number.

The runner only serves this directory on loopback. It strips TypeScript syntax from `app.ts` in memory for the browser. There is no build, install, package manifest or dependency change.

## Explore

Use the top switcher to compare the three directions already discussed in the issue:

- **Sort headings.** Click Patch, Owner, Updated, Visits, Access or Failures. Click again to reverse. Sorting applies before pagination. Missing failure counts remain last.
- **Quick filters.** Combine any owner, Not opened and an updated-date range. Clear filters restores the list. The fictional clock is 15 November 2026.
- **Custom groups.** Start from an individual patch and choose Add to group. Pick an existing group or create a group with that patch already in it. You can also open a group to manage its patches, rename it or delete it. Patches remain in All patches and can belong to multiple groups. Personal groups are a proposal, not an approved requirement.

Open a patch title to inspect fictional content and return to the list. Home, pins, Your agents and Settings have local destinations. These destinations do not connect or configure anything. **Screen map** shows the paths between screens. Browser Back and Forward work between destinations. Search submits on Enter. On phones the sort selector exposes columns hidden from the narrow table.

The 120 synthetic records are shared across all variations. Opening a patch clears its unopened dot and increments its fictional visits. Group edits, pins, filters and opens live only in memory. Reload or Reset mock restores the starting data. URL hashes identify the variant and destination, not saved group contents.

## Scope

Only this directory belongs to the exploration. `patchy.css` is a frozen copy of the shared stylesheet served by Patchy during the earlier mock study. Local font copies preserve its appearance; the Geist license is in `assets/OFL.txt`. The prototype does not import production modules or fetch production assets. The browser policy blocks connections outside its own localhost origin.

Static PatchPage previews are visual snapshots. They do not contain the TypeScript interactions. The PR description links the previews and screenshots. No database, real authentication, integration, storage, analytics or persistence is used.

## Static previews

- [Sort headings](https://post.patchyhq.com/d/abgi63lo34yx)
- [Quick filters](https://post.patchyhq.com/d/nkh5fu8szysi)
- [Custom groups](https://post.patchyhq.com/d/ni4pc49t8o20)
- [Screen map](https://post.patchyhq.com/d/868pbzc56s5h)

These links are public and unlisted. The local prototype is the version to click through.
