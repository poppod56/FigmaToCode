# FigmaToCode

A Figma plugin that inspects the selected layer(s) and generates CSS, Flutter
(Dart), and HTML on the spot — entirely inside the Figma sandbox, no server,
no account, no data leaving your machine.

## Demo

![FigmaToCode plugin demo](docs/figma-to-code-demo.gif)

## Features

- **CSS** — flat, copyable CSS for the selected node: fills/gradients,
  strokes, radius, shadows, blur, auto-layout (flex/grid), text styles.
- **Flutter (Dart)** — a `Widget build...()` function for the full subtree,
  including Row/Column/Stack layout, gradients, borders, box shadows, and
  exported image assets for anything CSS/Flutter can't reproduce exactly
  (rotated groups, vector icons, alpha drop shadows).
- **HTML** — the full node tree as nested `<div>`/`<p>` markup plus a matching
  `<style>` block, one rule per node.
- **Real asset files** — generated HTML/Dart stays self-contained by default,
  but when images or vectors are present the plugin can download them as named
  files and copy code rewritten to use `assets/...` paths (including the
  matching Flutter `pubspec.yaml` entries).
- **Design System** — reads Figma **variables** and **styles** (not just raw
  values) so exported tokens use the name a designer actually gave them,
  resolves **component instances** back to their component/variant/properties,
  and reports what fraction of tokens in the selection are backed by a real
  variable/style vs. inferred from a raw value. Exports as CSS custom
  properties (with per-mode overrides), a Flutter theme, Dart component
  scaffolds, or raw JSON.
- **Responsive (fluid) mode** — an opt-in second output that translates
  Figma's own per-node resize behavior (Fill/Hug sizing on auto-layout
  children, Constraints on freely-positioned ones) into fluid CSS/Dart,
  instead of the fixed pixel size captured at export time. Toggle it on
  per-tab; the fixed-pixel output is always still there.
- **Multi-selection** — select more than one layer and the Design System tab
  aggregates tokens/components across the whole selection; CSS/Flutter/HTML
  get a picker to switch between the selected layers.
- **Preview** — the real Figma-rendered PNG of the selection next to the
  generated HTML rendered live, side by side, to catch layout drift without
  leaving the plugin.
- 100% local: every tab above runs inside the Figma plugin sandbox. Nothing
  is sent to any server unless you explicitly turn on the local debug
  Connect button (see [Local debug server](#local-debug-server)).

## Usage

1. **Install** — in Figma, go to `Plugins → Development → Import plugin from
   manifest...` and point it at `manifest.json` in this repo. (Works on
   Figma Desktop and figma.com once imported for development — see
   `Plugins → Development → Manage plugins in development` to sync it to
   the web.)
2. **Select** a frame, component, or any layer(s) on the canvas.
3. **Open** the plugin — it updates automatically on every selection change.
4. Pick a tab (**CSS** / **Flutter** / **HTML** / **Design System** /
   **Preview**), optionally flip the **Responsive (fluid)** toggle, and hit
   **Copy**.
5. When an HTML or Flutter selection contains exported assets, use
   **Download images + copy code** to save real files and copy path-based code
   instead of the inline base64 version.

### Local debug server

The **Connect** button streams every selection's full payload (including the
exported preview PNG) to a small local HTTP server for offline debugging —
useful for filing a bug with the exact JSON that produced it. It stays off by
default and never sends anything anywhere on its own.

```
python3 .debug-server/debug-server.py
```

Dumps land in `.debug-server/data/latest.json` / `latest.png` (git-ignored).

## Project structure

```
manifest.json    Plugin manifest (entry points, network access)
code.js          Plugin sandbox code — all CSS/Flutter/HTML/design-system
                 extraction logic, no UI concerns
ui.html          Plugin UI (tabs, toggles, copy buttons) — postMessage'd
                 payloads from code.js, no direct Figma API access
tests/           Node-runnable regression suite (see below)
.debug-server/   Optional local debug HTTP server (see above); generated JSON,
                 PNG captures, and logs stay git-ignored
```

## Development

No build step — `code.js`/`ui.html` are loaded by Figma as-is. To iterate:
edit, then `Plugins → Development → <plugin name>` in Figma to reload.

### Running the tests

```
node --test tests/code-regression.test.js
```

The suite loads `code.js` into a sandboxed `vm` context with a minimal fake
`figma` global (including fake variables/styles/component APIs) and asserts
against the exported CSS/Dart/HTML/design-system functions directly — no
Figma installation required to run it.

## Known limitations

- Responsive mode doesn't extend to Dart-side GRID children yet — Figma GRID
  already has no native Flutter widget and is hand-rolled as a fixed `Stack`.
- The Preview tab always compares against the fixed-pixel render, even with
  Responsive mode on — a fluid layout has no single "correct" size to hold
  the Figma export up against.

## License

MIT — see [LICENSE](LICENSE).
