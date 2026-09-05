---
name: ui-consistency
description: Review spec for the server-rendered pages Patchy serves to readers.
disable-model-invocation: true
metadata:
  internal: "true"
---

# UI consistency review

Review changed page-rendering code and directly affected call sites against the rules below. Apply them when a change creates, moves, or modifies markup or styling on a served page. Do not demand unrelated repository-wide cleanup.

First-party pages compose the server-rendered shell and inline `<style>` block in `packages/core/src/html.ts`; the served-patch wrapper stays in `packages/serving/src/render.ts`. There is no component library, utility-CSS framework, client-side framework, or second theme. Auth and Companies pages use plain forms; only the session shell loads Clerk's headless script and Patchy's external initializer, never inline script or analytics.

Two page kinds, and the distinction drives most findings:

- **First-party chrome** — the home page, 404, sign-in, create-or-join and deactivated pages — all composed through `htmlPage`.
- **Served patches** — `renderPatchWrapper`, which is user content and is deliberately _not_ `htmlPage`.

## The shell and its one exception

- First-party pages compose `htmlPage`. A new page that re-emits its own `<head>`, base styles, or design tokens instead of composing the shell is a concrete finding.
- `renderPatchWrapper` is the standing exception and stays one. It is a separate document on purpose: its own minimal `<head>`, no shell paper/grid/glyph styling, and a locked CSP (`form-action 'none'`, no script source) that nothing inside the wrapper may need to relax. Do not report it as a duplicated skeleton, and do not accept a change that folds it into `htmlPage`.
- When first-party pages repeat the same durable treatment — pills, notes, compact code panels — prefer a named shared class in the shell. Keep contextual layout, width, and color at the call site.
- Flag call-site overrides that replace a shared class's core height, radius, padding, focus ring, or base colors. Extend the shared contract instead when the pattern is genuinely shared.

## Served patches

- Served patches carry no JavaScript, anywhere in the wrapper. A control that needs script is the wrong control.
- Keep the patch iframe's `sandbox` and `title`, and its `srcdoc` escaping. Patch HTML reaches the attribute through `escapeAttribute`; a patch title reaching markup goes through `escapeHtml`. Flag any user-supplied value interpolated raw.
- Readers of a served patch are unwatched: no cookies, no session, no analytics, no third-party requests from the wrapper. Flag anything that adds one.
- The wrapper is the sandboxed frame and nothing else: no footer, no chrome, no first-party link out of the page. Flag anything that adds one.

## CSS ownership

- Ordinary one-owner presentation belongs with the page that renders it: local geometry, spacing, typography, backgrounds, borders, and page-only positioning. Shell CSS is for what is genuinely shared or behaviorally complex.
- Do not apply `filter` to `html`, `body`, or the page root: it also tints the embedded patch frame and user media.
- Before calling a selector dead, trace the emitted class string and any class-valued field through to its DOM sink. A helper that returns a class is not proof that it is rendered.
- Flag duplicate declarations only after comparing specificity, inheritance, and the final owning element. Textually identical declarations are not necessarily redundant.
- Inspect the emitted HTML and CSS after template interpolation, nested pseudo-elements, or attribute matching. Valid-looking source is insufficient. Flag malformed or empty emitted selectors and interpolations that silently drop a rule.
- Avoid continuously repainting animations. A never-ending pulse, shimmer, or spinner pegs the GPU on high-refresh displays.

## Scroll and frames

- The served-patch frame owns its scrolling: `html, body { height: 100% }`, `body { overflow: hidden }`, and the iframe fills the viewport. A change that scrolls the document instead of the frame changes reader behavior and is a finding.
- Verify actual scroll behavior when changing overflow ownership or frame sizing. Comparing classes in source is not enough.

## Change discipline and evidence

- Preserve responsive geometry, frame insets, clipping, radius, and the shell's shadow tokens.
- Preserve accessibility and interaction semantics through a migration: focus-visible rings, disabled behavior, keyboard behavior, pointer cursor, `aria-*`, and coarse-pointer hit targets.
- Preserve comments that explain a browser, sandbox, or CSP constraint. They are why the exception exists.
- Prefer the smallest durable contract over a page-specific workaround or a broad abstraction with one consumer.
- Require focused tests in `render.test.ts` when a change alters rendered structure, escaping, or defaulting logic. A visual-only class change does not need one.
- Match the verification gate to the change: typecheck or focused tests for rendering contracts, emitted-HTML inspection for template and selector transformations. Do not fail a change solely because an artifact the available tools cannot produce is missing.

## Reporting

Report only concrete violations introduced by changed lines, plus pre-existing behavior the change directly worsens. Anchor each finding to the smallest line range, name the broken behavior or ownership rule rather than the preferred syntax, and state the smallest fix. With no findings, report "No UI consistency findings" on one line.
