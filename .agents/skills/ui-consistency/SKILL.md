---
name: ui-consistency
description: Review spec for served-page UI. Read by /code-review's Standards axis for diffs that touch rendered HTML, CSS, or page controls.
disable-model-invocation: true
metadata:
  internal: "true"
---

# UI consistency review

Review changed page-rendering code and directly affected call sites for consistency with the shared page shell, CSS ownership, and the behavioral constraints below. Apply these rules when a change creates, moves, or modifies controls or styling on a served page. Do not demand unrelated repository-wide cleanup.

The served surface today is server-rendered HTML with inline `<style>` blocks in `apps/server/src/render.ts`; the Effect v4 port (issue #54) moves it into `packages/serving`. There is no component library or utility-CSS framework. The rules name the owners that exist here; where a rule assumes one that does not (a shared primitive, a build-time CSS pipeline), apply its ownership principle to the page shell and skip its mechanics.

The goal is not to minimize CSS or class counts at any cost. The goal is to put each behavior in the smallest correct owner while preserving interaction, theming, accessibility, layout, and browser behavior.

## Shared shell and controls

- Prefer the shared page shell (`htmlPage` and the page fragments beside it) over a locally reconstructed document skeleton. A page that re-emits its own `<head>`, base styles, or footer instead of composing the shell is a concrete finding.
- Do not flag raw elements that intentionally implement a semantic row, tab, resize handle, swatch, image target, embedded frame, or another interaction whose behavior or geometry differs from the shared piece.
- When multiple pages repeat the same durable geometry or treatment, prefer a named shared class or fragment. Examples include pills, notes, and compact code panels. Keep contextual layout, width, and color at the call site.
- Flag large call-site style overrides that replace a shared piece's core height, radius, padding, focus ring, cursor, hit target, or base state colors. Prefer extending the shared contract when the same pattern is genuinely shared.
- Preserve accessibility and interaction semantics during migrations: focus-visible rings, disabled behavior, keyboard behavior, pointer cursor, `aria-*`, iframe `sandbox` and `title`, and coarse-pointer hit targets.
- Do not require tests for a tiny visual-only class migration. Require focused tests when a change alters rendered structure, escaping, state transitions, or width/defaulting logic; `render.test.ts` is where they go.

## CSS ownership

- Ordinary one-owner presentation belongs with the page that renders it: local geometry, spacing, typography, backgrounds, borders, simple vendor pseudo-elements, and page-only positioning.
- Keep shared shell CSS when it is genuinely reusable or behaviorally complex: the frame/footer layout of served drafts, masks, shared or complex pseudo-elements, animations, runtime theme variables, safe-area calculations, scrollbar-lane preservation, and browser/vendor integration. Simple owner-local pseudo-elements may still belong with the page.
- Before calling a selector dead, trace literal, dynamic, generated, imperative, and test consumers. Search both the emitted class string and any class-valued field names through their final DOM sink. A helper returning a class is not proof that it is rendered, and a missed downstream property read can make a deletion unsafe.
- Flag duplicate declarations only after comparing selector specificity, inheritance, media scope, and the final owning element. Textually identical declarations are not necessarily behaviorally redundant.
- When moving CSS between the shell and a page, preserve selector scope and cascade ownership. A rule at the owner is preferable to a fragile global override that depends on stylesheet order.
- Do not request moving complex shared behavior into a page merely to shrink the shell. Do not preserve ordinary one-owner CSS merely because it already lives in the shell.

## Themes and emitted CSS

- Keep theme-only declarations behind the media or attribute scope the shell already uses; do not fork a page onto its own theme mechanism.
- Preserve runtime token bridges. Removing a variable or selector is safe only when all runtime, generated, and theme consumers are accounted for.
- Contrast and accessibility settings that target page chrome must derive from semantic color tokens. Do not apply `filter` to `html`, `body`, or the page root: it also changes the embedded draft frame and user media.
- Preserve alpha and surface ownership when deriving contrast tokens. Soften translucent borders and inputs toward transparent rather than an opaque canvas, use a modest semantic-foreground mix for stronger borders, and adjust panel, note, and accent foregrounds against their own surfaces when the base foreground changes.
- Inspect the emitted HTML and CSS after unusual selectors, nested pseudo-elements, attribute matching, or template interpolation. Source syntax that looks valid is insufficient.
- Flag malformed or empty emitted selectors such as empty `:is()` or `:not(:is())`, selector branches that can never match their own class attribute, and interpolations that silently drop the intended rule.
- Prefer source-level logic over clever selectors when behavior depends on caller-provided class strings.
- Do not fail solely because a valid emitted selector is verbose or because a rule uses an intentional custom property.

## Scroll and embedded frames

- The served-draft frame owns its scrolling: the shell fixes the footer and lets the sandboxed iframe scroll. A page that scrolls the document instead of the frame changes reader behavior and is a finding.
- Preserve runtime top and bottom overflow state where a fade or mask exists. Do not replace a dynamic fade with an always-on static mask.
- Preserve fade geometry and keep the native scrollbar lane opaque so the track and thumb stay visible and usable. A visually similar mask that fades the scrollbar is a regression.
- Verify actual scroll behavior when changing overflow ownership, frame sizing, or scrollbar selectors. Source-level class comparison is not enough.

## Visual and layout preservation

- Preserve responsive geometry, frame and footer insets, light and dark contrast, clipping, radius, and composable shadows.
- For meaningful visual changes, prefer real-app evidence using the actual rendered page and state. A mock recreation does not validate the real page. Light and dark evidence is useful when theme-sensitive styles change, but missing or inaccessible evidence alone is not a finding; report only a concrete regression supported by the diff, code, or available artifacts.
- Do not treat a screenshot as proof of keyboard, overflow, scrollbar, responsive, or runtime-theme behavior. Pair visual evidence with source, computed-style, emitted-CSS, or interaction checks as appropriate.
- Be alert to shared color indirection. When the shell routes a color through a CSS variable, ensure migrated contextual elements retain their intended tone, including hover and disabled states.

## Change discipline

- Review the change's scope and directly affected consumers. Do not turn a focused PR into a demand for unrelated legacy cleanup.
- Prefer the smallest durable contract over a page-specific workaround or a broad abstraction with one consumer.
- Preserve intentional exceptions and comments that explain browser, sandbox, or theme constraints.
- If a proposed cleanup cannot prove ownership or semantic equivalence, ask for evidence or leave it unchanged rather than guessing.
- Select verification gates according to the changed behavior: typecheck or focused tests for typing and rendering contracts, emitted-HTML inspection for template or selector transformations, and real-app evidence for meaningful visual behavior when available. These gates are complementary when applicable, but do not require every gate for tiny visual-only migrations or fail solely because an artifact the available tools cannot produce is absent.

## Reporting

Report only concrete violations introduced by changed lines or behavior, plus pre-existing behavior that the change directly makes relevant or worsens. Touching a large file does not make unrelated retained issues reportable. Anchor each finding to the smallest relevant line range, explain the broken behavior or ownership rule rather than merely the preferred syntax, and state the smallest expected fix. Optional aesthetic preferences, harmless class ordering, and unrelated legacy code are not findings. With no findings, report "No UI consistency findings" on one line.
