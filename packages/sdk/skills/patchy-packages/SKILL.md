---
name: patchy-packages
description: The UI packages this repo's release admits beyond Preact, with one line each on when to use them. Read before building menus, dialogs, selects, comboboxes or data tables.
---

<!-- PROTOTYPE for #315: served only to repos initialised with the wide allowlist. -->

# Admitted packages

This repo pins these packages exactly in `package.json` (`pnpm patchy refresh` keeps the pins); the build admits them in `src/`, never in `server/`. They run on Preact with compat semantics; import hooks from `patchy/preact` as usual.

- `@zag-js/preact` with `@zag-js/dialog`: an accessible modal (focus trap, Escape, restore focus) for forms such as "New deal" or a confirmation.
- `@zag-js/preact` with `@zag-js/combobox`: a searchable picker over many options, such as choosing a company for a contact.
- `@zag-js/preact` with `@zag-js/select`: a short, fixed list of options such as a deal stage.
- `@zag-js/preact` with `@zag-js/menu`: a row's actions menu (edit, reassign, delete).
- `@tanstack/preact-table`: sorting, filtering and column logic for a large table of contacts; you render the markup.

A Zag component is a machine plus `normalizeProps` from `@zag-js/preact`:

```tsx
import * as dialog from "@zag-js/dialog";
import { useMachine, normalizeProps } from "@zag-js/preact";
import { useId } from "patchy/preact";

function NewDeal() {
  const service = useMachine(dialog.machine, { id: useId() });
  const api = dialog.connect(service, normalizeProps);
  return (
    <>
      <button {...api.getTriggerProps()}>New deal</button>
      {api.open && (
        <div {...api.getPositionerProps()}>
          <div {...api.getContentProps()}>
            <h2 {...api.getTitleProps()}>New deal</h2>
            <button {...api.getCloseTriggerProps()}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}
```

Anything not listed here is refused by the build; copy small helpers into `src/` instead.
