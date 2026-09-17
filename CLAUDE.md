# CLAUDE.md

Guidance for working in this repo. See [README.md](README.md) for user-facing
docs (features, usage, project structure).

## What this is

A Figma plugin (no build step, no bundler). `code.js` runs in the Figma
plugin sandbox and has access to the `figma` global; `ui.html` is the plugin
panel (iframe) and only ever talks to `code.js` via `postMessage`. There is
no server component except the optional local debug HTTP server in
`.debug-server/` (git-ignored, not part of the shipped plugin).

## Core invariant: don't break the fixed-pixel converter

The CSS/HTML/Dart extraction (`extractCss`, `generateHtmlTree`,
`generateDartForNode`, and everything they call) reproduces the Figma
selection at its exact captured pixel size, verified against a real Figma
render in the Preview tab. This is the thing users trust most about the
plugin — new features must be **additive**, never a rewrite of this path:

- New output modes (e.g. Responsive/fluid) are opt-in via an extra parameter
  that defaults to today's exact behavior, so every existing call site
  (including tests) stays byte-identical unless it explicitly opts in.
- Prefer post-processing a copy of the CSS object these functions already
  return over threading new logic into them directly.

## Tests

```
node --test tests/code-regression.test.js
```

Loads `code.js` into a `vm` sandbox with a minimal fake `figma` global
(including fake variables/styles/component-instance APIs) and asserts
directly against the exported functions — no Figma installation needed. CI
runs this on every push/PR (`.github/workflows/test.yml`).

When adding a feature, extend this file's fixtures rather than creating a
new test file, and keep the existing assertions passing unmodified — that's
the proof the default path didn't regress.

## Conventions

- Plain functions, no classes. Small, single-purpose helpers (see the
  `PRIMARY_AXIS_ALIGN_CSS`-style constant tables and `getBorderRadiusCss`-style
  helpers near the top of `code.js`) composed by the top-level
  `extractCss`/`generateDartForNode`/`generateHtmlTree`.
- Comments explain *why*, not what — a hidden Figma API quirk, a
  browser/Flutter constraint workaround, a non-obvious invariant. Don't
  narrate what the code already says.
- No new npm dependencies — this ships as two plain files Figma loads
  directly, and `tests/` runs on bare Node with no `node_modules`.

## Known gaps (see README's "Known limitations" for the user-facing version)

- Assets (rasterized icons, rotated groups) are inlined as base64 today, not
  exported as separate files.
- Dart-side GRID children don't participate in Responsive mode yet.
- The Prototype tab's Smart Animate diffing (`diffFramesForSmartAnimate`)
  matches layers between two frames by name + sibling occurrence order, same
  as Figma's own heuristic — duplicate/renamed layers can match the wrong
  node or fall back to a cross-dissolve cut instead of a tween.
- The opt-in "Inline SVG icons" HTML mode (`inlineSvgHtml`) only applies to
  vector-only-subtree assets (real SVG bytes) — image-fill/rotated-container
  assets are still raster PNGs and always stay a background-image, and the
  variant is only computed for the fixed-pixel geometry, not combined with
  Responsive.
