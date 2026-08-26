# Patchy Cloud

## Dependencies

- `esbuild` is exact because its output is the shipped CLI bundle.
- `npm` is exact because the packed-CLI test invokes its `install` command directly.
- `typescript` stays on the v6 range so every workspace package uses one compiler baseline.
- `parse5` comes from the workspace catalog because the CLI externalizes the parser used by core.

## Agent skills

Review notes belong in PR comments, not in the working tree.

### Issue tracker

Issues live in the `allisonmahmood/patchy-cloud` GitHub repo, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context — a root `CONTEXT-MAP.md` pointing at one `CONTEXT.md` per context (hosting server, CLI publisher). See `docs/agents/domain.md`.
