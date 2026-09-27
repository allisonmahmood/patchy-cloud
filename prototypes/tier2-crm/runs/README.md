<!-- PROTOTYPE for #315 -->

# The four fresh-agent CRMs

Each directory is one fresh agent's CRM, built from the project skills alone on this branch's stack, from the same `TASK.md`, in a 90-minute box. Variant A is `patchy` + `preact` + `@preact/signals`; variant B adds `@zag-js/preact` (combobox, dialog, select, menu) and `@tanstack/preact-table`.

| Run       | Builder                           | Wall time | Verifier score |
| --------- | --------------------------------- | --------- | -------------- |
| `a-opus`  | Opus 5.5 (`claude -p`)            | 9 m 43 s  | 92             |
| `a-astra` | astra (`omp -p --thinking xhigh`) | 56 m 08 s | 95             |
| `b-opus`  | Opus 5.5                          | 10 m 44 s | 92             |
| `b-astra` | astra                             | 43 m 52 s | 94             |

`REPORT.md` in each is the agent's own account; `SCORES.md` is the independent verifier's. `node_modules`, `.patchy`, the lockfile, generated files and the served skills are left out; `pnpm prototype:crm init <dir> --variant a|b` recreates a tree to drop a run's sources into.

The repo's commit hook ran Prettier over these files, so their layout here is not what the agents wrote; the verifier's line-length and CSS measures come from the original trees.
