# Prototypes

Throwaway artifacts that answered a design question. Nothing here is wired, tested or meant to merge; each lives on its own `prototype/<name>` branch behind a never-merged PR so the team can look back at it.

- `portal-list-mocks.html`: three static mocks of the signed-in `/` for the Portal map (#239). Composes the `htmlPage` shell CSS from `packages/core/src/html.ts` verbatim, with page-only styling underneath. Open the file in a browser.
- `patch-page-mocks.html`: three static mocks of the patch card's Manage side at `/patches/<name>` for the Portal map (#240), plus the retired, deleted and deactivated-owner cards, an admin's card with Reassign, and the deactivation and reactivation pages. Same shell CSS as above. Open the file in a browser.
