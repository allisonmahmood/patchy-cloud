# What changed

<!-- One or two sentences. What does this do, and why now? -->

Closes #

## How it was verified

<!-- Tests added or run, manual checks, anything a reviewer should reproduce. -->

- [ ] `pnpm test` passes locally
- [ ] Added or updated tests covering this change

## Release impact

<!--
Area and size labels are applied automatically. This section is the part no
automation can decide: whether the change breaks anyone already running Patchy
Cloud, which is what an upgrade note has to cover, and whether production can
go back past it.
-->

Tick exactly one.

- [ ] **Breaking** — requires action from anyone already running this
- [ ] **Not breaking** — no action required

<!--
"Breaking" means a change to the CLI's public behaviour, the API contract, the
database schema, or the configuration format that existing users must react to.

If breaking, describe the break and the upgrade path below. If not breaking,
say briefly why -- "lockfile only", "dev dependency", "internal refactor".
Leaving both boxes unticked is not an answer; it reads as "not filled in".
-->

- **What does a revert leave behind?**
- **Does the release before it still work with that?**

<!--
Answer both from judgment, for someone deciding whether to merge. A revert can
leave behind schema, rows in a new shape, mail sent, deleted data, changed
infrastructure, or a contract that clients now rely on. An additive column
usually leaves the release before it working. A dropped column it reads, or
rows it can't parse, don't. If the second answer is no, add the `one-way`
label: rolling production back past this PR would break that release.
-->
