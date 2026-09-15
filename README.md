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

### Local MCP server

Settings → **MCP Connect** runs a local [MCP](https://modelcontextprotocol.io)
server so an AI client (e.g. Claude Desktop) can pull whatever it needs from
the current Figma selection — generated CSS/HTML/Dart, design tokens, the
clickable prototype bundle, and real image/preview files written straight to
disk (not left as inline base64). It stays off by default and everything
stays on your own machine.

1. **Get the script** — either use `.mcp-server/mcp_server.py` from this repo,
   or, if you only installed the plugin from Community (no repo checkout),
   copy/download it straight from the plugin's Settings → MCP Connect panel.
2. **Create a virtual environment next to the script and install into it**
   (plain `pip install` fails on modern macOS/Homebrew Python with an
   "externally-managed-environment" error — a venv sidesteps that, and keeps
   these two packages out of your system Python entirely):

   ```
   cd .mcp-server
   python3 -m venv venv
   source venv/bin/activate   # Windows: venv\Scripts\activate
   python3 -m ensurepip --upgrade   # skip if `pip --version` already works
   pip install mcp websockets
   ```

   That `ensurepip` line is only needed if `pip install` above errors with
   `command not found: pip` — some Python builds don't bootstrap pip into a
   new venv automatically. If `ensurepip` itself then fails too (some
   Homebrew Python builds strip pip's bundled installer wheel to shrink the
   bottle), fall back to fetching the real installer instead:

   ```
   curl -sS https://bootstrap.pypa.io/get-pip.py -o get-pip.py
   python3 get-pip.py
   pip install mcp websockets
   ```

   Then, each time you want the server running:

   ```
   source venv/bin/activate
   python3 mcp_server.py
   ```

   Leave that process running — it holds the live bridge to the plugin and
   answers the MCP client's tool calls.
3. **In Figma**, open the plugin, select something, and toggle
   Settings → MCP Connect → **Connect**. Every new selection streams to the
   server automatically from then on.
4. **Point your MCP client at the script over stdio.** MCP clients spawn the
   process themselves — they don't inherit an activated venv from your shell
   — so `command` must point at the venv's own Python executable, not the
   system `python3`. For Claude Desktop, add this to
   `claude_desktop_config.json` (using the absolute paths to wherever you
   saved the script):

   ```json
   {
     "mcpServers": {
       "figma-to-code": {
         "command": "/absolute/path/to/.mcp-server/venv/bin/python3",
         "args": ["/absolute/path/to/.mcp-server/mcp_server.py"]
       }
     }
   }
   ```

   Restart Claude Desktop, and it can then call `list_selected_nodes`,
   `get_node_code`, `export_node` (code + real asset files + preview PNG for
   one layer), `export_selection` (the whole selection at once),
   `get_design_tokens`/`get_design_export`, and `get_prototype_html`.

Like the debug server, this needs Python 3 on your machine and is meant for
developers/power users wiring the plugin into an AI workflow — most
plugin users will never need it.

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
.mcp-server/     Optional local MCP server (see above) bridging the plugin's
                 live selection to an MCP client like Claude Desktop
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
