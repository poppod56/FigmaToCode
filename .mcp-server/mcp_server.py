#!/usr/bin/env python3
"""Local MCP server for the FigmaToCode plugin.

Bridges an MCP client (e.g. Claude Desktop) to whatever is currently
selected in Figma. The FigmaToCode plugin's Settings > MCP Connect panel
pushes the live selection to this process over a WebSocket; this script
re-exposes the last snapshot it received as MCP tools over stdio, and can
write real files (code, decoded image assets, the ground-truth preview PNG)
to disk — something the plugin's own browser-sandboxed UI can't do itself.

NOTE: this file is also embedded verbatim in ui.html's Settings > MCP
Connect panel (as the Copy/Download source for marketplace users who never
cloned this repo) — keep both copies in sync when editing.

Setup:
    pip install mcp websockets
    python3 mcp_server.py

Then, in Figma: FigmaToCode > Settings > MCP Connect > Connect.
And point your MCP client at this script over stdio, e.g. in Claude
Desktop's claude_desktop_config.json:
    "figma-to-code": {
      "command": "python3",
      "args": ["/absolute/path/to/mcp_server.py"]
    }
"""

import asyncio
import base64
import json
import os
import tempfile
import threading

import websockets

# mcp 2.x renamed FastMCP to MCPServer (different import path, same .tool()/
# .run() shape used below) — support whichever the user's `pip install mcp`
# actually resolved to instead of pinning a version.
try:
    from mcp.server.fastmcp import FastMCP as MCPServer
except ImportError:
    from mcp.server.mcpserver import MCPServer

WS_PORT = 8788

# The most recent selection and whole-page-scan payloads pushed by the
# plugin's ui.html over the WebSocket below. Only one Figma tab is ever
# expected to connect at a time, so a single shared value per kind (not a
# per-connection cache) is enough.
_latest_selection = None
_latest_page_overview = None

# Opening several editor windows on this project each spawns its own
# mcp_server.py (one per MCP client instance), and every one of them tries
# to bind WS_PORT for the Figma plugin to talk to — only the first can win
# that race. Rather than have the rest crash on "address already in use",
# whichever one is left holding the port writes every payload it receives
# here; the others poll this file instead of running their own server, so
# every window's MCP tools stay populated regardless of which process the
# plugin actually connects to. Local temp dir only, single-user trust model
# — same as the "only ever accepts connections from localhost" bridge below.
_SHARED_STATE_PATH = os.path.join(tempfile.gettempdir(), "figma-to-code-mcp-bridge-state.json")
_LEADER_RETRY_SECONDS = 5


async def _handle_plugin_connection(websocket):
    global _latest_selection, _latest_page_overview
    async for message in websocket:
        try:
            payload = json.loads(message)
        except ValueError:
            continue
        if payload.get("type") == "pageOverview":
            _latest_page_overview = payload
        else:
            _latest_selection = payload
        _write_shared_state()


def _write_shared_state():
    # Only ever called from the single process that currently holds
    # WS_PORT, so a plain write-then-replace (no locking) is enough; the
    # temp suffix plus os.replace keeps a concurrent reader from ever
    # seeing a half-written file.
    tmp_path = f"{_SHARED_STATE_PATH}.tmp-{os.getpid()}"
    with open(tmp_path, "w") as f:
        json.dump({"selection": _latest_selection, "pageOverview": _latest_page_overview}, f)
    os.replace(tmp_path, _SHARED_STATE_PATH)


def _read_shared_state():
    global _latest_selection, _latest_page_overview
    try:
        with open(_SHARED_STATE_PATH) as f:
            state = json.load(f)
    except (OSError, ValueError):
        return
    if state.get("selection") is not None:
        _latest_selection = state["selection"]
    if state.get("pageOverview") is not None:
        _latest_page_overview = state["pageOverview"]


def _run_websocket_bridge():
    # Own event loop in a background thread so it never blocks the MCP
    # server's stdio event loop started from __main__ below.
    async def main():
        while True:
            try:
                # websockets' 1 MiB default max_size drops any selection whose
                # payload (preview PNG + per-node CSS/HTML/Dart + image assets,
                # all base64) runs bigger than that — trivially easy with just
                # a couple of image-heavy layers selected. Unbounded is fine
                # here: this only ever accepts connections from localhost.
                async with websockets.serve(_handle_plugin_connection, "localhost", WS_PORT, max_size=None):
                    # Winning the bind makes this process the leader for as
                    # long as it stays alive.
                    await asyncio.Future()
            except OSError:
                # A sibling mcp_server.py (another open window) already owns
                # WS_PORT. Don't crash — fall back to polling its shared
                # state so this process's tools stay populated, and keep
                # retrying the bind in case that sibling exits, so leadership
                # (and direct plugin data) fails over automatically.
                _read_shared_state()
                await asyncio.sleep(_LEADER_RETRY_SECONDS)

    asyncio.run(main())


# Read by the MCP client as up-front, standing context for this whole
# server — unlike a tool docstring, which the client only sees once it has
# already decided to call that tool. Without this, a client with no other
# signal tends to fall back to asking the user for a screenshot or a written
# description instead of calling these tools, even though the *exact* code,
# layout data, and real assets are one tool call away.
INSTRUCTIONS = """\
This server gives you the live selection from a Figma plugin (FigmaToCode) — \
real generated code, design tokens, and image assets, not a picture to \
reverse-engineer. If you're about to ask the user for a screenshot, a design \
description, or "what should this look like" — stop and call \
list_selected_nodes() first. If it returns nodes, use this server instead of \
guessing.

Planning across a whole app (multiple screens), not just one selection: \
call list_page_screens() first. It's the closest thing to a screenshot of \
the whole file without pulling one — every top-level frame's name, position \
and size, grouped by Figma Section where the designer used one (a \
Section's name is usually the flow/feature it groups, e.g. "Onboarding" or \
"Checkout"). Use it to decide what exists, how screens relate spatially, \
and what order to tackle them in, before following the per-selection \
workflow below for whichever one you pick. Unlike the selection tools, this \
requires the user to have clicked Settings > MCP Connect > Scan page at \
least once — it isn't sent automatically, since it exposes the file's whole \
structure rather than just what's selected.

Standard workflow:
1. list_selected_nodes() — see what's selected, by index.
2. get_node_metadata(index) — width/height/warnings. Compare width/height \
against common device viewports (e.g. ~375-430 wide, ~700-930 tall) to tell \
a full-screen layout from an isolated component/card — a node sized like a \
phone screen should become the screen's root container, not something \
nested inside one.
3. get_design_tokens() / get_design_export(format) — pull real colors, \
type scale, and spacing before inventing any values of your own.
4. export_node(index, output_dir, output) or export_selection(output_dir, \
output) — write ready-to-use code plus a real assets/ folder (images \
already rewritten to real file paths, never left as inline base64) and a \
preview.png. Prefer this over get_node_code when you're actually building \
something, not just inspecting. get_selection_code(indices, output) is the \
lighter-weight option for inspecting several layers at once without writing \
files — it still strips inline base64 to an assets/ placeholder path, so it \
stays safe to use even with a small context window.
5. get_prototype_html() — when 2+ frames were selected together, this is \
the ground truth for navigation between screens (which reactions/links go \
where) — use it instead of guessing screen flow, and to see which layers \
Figma's own prototype keeps fixed across screens (a strong signal for a \
persistent bottom navigation bar or header).

Things Figma's fixed-pixel export does NOT encode, so infer them instead of \
copying pixels blindly:
- Scrolling: nothing marks a layer as scrollable. A tall stack of content \
inside a phone-sized frame almost always means the frame's body scrolls \
and any nav bar / tab bar pinned to the same edge across every screen in \
get_prototype_html should stay fixed (position: sticky/fixed) instead of \
scrolling with it.
- Full-bleed vs. centered: a node whose width/height matches a device \
viewport should fill the screen (100vw/100dvh or equivalent); don't leave \
it boxed in a fixed-pixel container sized to the Figma frame.
- Responsive: request output="responsive_css"/"responsive_html"/\
"responsive_dart" from get_node_code (or export_node/export_selection with \
a *_dart output for Flutter) for a fluid, Fill/Hug/Constraints-based layout \
instead of the fixed-pixel default — use this whenever the target is a real \
app/site meant to run at more than one exact size, not a pixel-perfect \
match of the Figma canvas.

The rule for everything visual — theme, color, type, spacing, reusable \
components, assets — is: it comes from Figma via these tools, always, on \
both web and mobile. Never invent a color/font-size/spacing value, and \
never hand-roll a component Figma already defines once and reuses. \
Everything else (business logic, state, data fetching, routing beyond what \
get_prototype_html encodes, backend integration) is normal engineering \
judgment — this server has no opinion on it.

Theme, once, shared by every platform you're building for:
- Call get_design_tokens() and get_design_export() for the *whole* \
selection before writing any component, not per-node — a theme built once \
and imported everywhere keeps web and mobile visually identical, instead of \
each screen/component silently drifting from the last.
- get_design_export(format="css") → CSS custom properties, for a web \
target (or feed those values into your own Tailwind config / styled-\
components theme / CSS-in-JS tokens object — same values, whichever your \
stack uses). get_design_export(format="flutter") → a ThemeData + pubspec \
font snippet, for a Flutter/mobile target. Same underlying tokens, just two \
renderings — use both if you're building both platforms from one selection.
- Afterwards, every hex color, font-size, and spacing value in the code you \
write should trace back to one of these tokens (a CSS var / Theme property \
/ Dart constant) — not a bare literal typed by hand. If a value doesn't \
appear in get_design_tokens() at all, that's a real signal it's a one-off \
override, not a token — keep it inline rather than inventing a fake token \
for it.

Reusable components:
- get_design_tokens()["componentLibrary"] lists every Figma component used \
in the selection with a usageCount. usageCount > 1 means: build it once (a \
React/Vue/web component, a Flutter widget — whatever your stack's reuse \
unit is) and reuse it everywhere it appears, instead of copy-pasting the \
markup/widget tree at each occurrence.
- get_design_export(format="components") returns ready-made Dart widget \
scaffolds for that same component library — a starting point for the \
Flutter side; port the same componentization to whatever you're building \
for web instead of re-deriving it from scratch.

Assets, on every platform: always go through export_node/export_selection \
(never ship get_node_code's raw output as-is if it contains images) so \
every image lands as a real file under assets/ with the code already \
pointing at it — never inline base64 in anything you actually ship.

Verify before calling it done, every time:
1. Compare your result against the ground-truth render: export_node/\
export_selection already writes preview.png; open it (or save_preview_image \
for a single layer) and check your generated UI actually matches it — \
layout, spacing, colors — not just "looks plausible".
2. Re-check for stray hardcoded values: grep the code you wrote for hex \
colors / raw px-or-pt sizes that aren't one of get_design_tokens()'s \
values — anything left over either belongs in the theme or is a genuine \
one-off, decide which, don't leave it unexamined.
3. Confirm no leftover inline base64 made it into shipped code — only \
export_node/export_selection's rewritten output, never get_node_code's raw \
html/dart, should end up in a component that uses images.
4. Re-read get_node_metadata(index).warnings for every node you used and \
either address what they flag (a flattened layer, a missing font, etc.) or \
consciously decide it doesn't matter here — don't silently drop them.
"""

mcp = MCPServer("figma-to-code", instructions=INSTRUCTIONS)


def _selection_or_raise():
    if not _latest_selection or not _latest_selection.get("nodes"):
        raise ValueError(
            "No selection available yet. In Figma, open the FigmaToCode plugin, "
            "select a layer, and toggle Settings > MCP Connect > Connect."
        )
    return _latest_selection


def _node_or_raise(index: int) -> dict:
    nodes = _selection_or_raise()["nodes"]
    if index < 0 or index >= len(nodes):
        raise ValueError(f"index {index} out of range: selection has {len(nodes)} node(s)")
    return nodes[index]


# code/output keys, by the `output` string a caller passes in.
_CODE_FIELDS = {
    "css": lambda n: "\n".join(f"{key}: {value};" for key, value in n["css"].items()),
    "html": lambda n: n["html"],
    "dart": lambda n: n["dart"],
    "inline_svg_html": lambda n: n["inlineSvgHtml"],
    "responsive_css": lambda n: "\n".join(f"{key}: {value};" for key, value in n["responsive"]["css"].items()),
    "responsive_html": lambda n: n["responsive"]["html"],
    "responsive_dart": lambda n: n["responsive"]["dart"],
}

# Per-output asset lists and the file extension code should be saved under.
_ASSET_FIELDS = {"html": "htmlAssets", "inline_svg_html": "htmlAssets", "dart": "dartAssets"}
_FILE_EXT = {
    "css": "css",
    "html": "html",
    "dart": "dart",
    "inline_svg_html": "html",
    "responsive_css": "css",
    "responsive_html": "html",
    "responsive_dart": "dart",
}


def _safe_dir(output_dir: str) -> str:
    path = os.path.abspath(os.path.expanduser(output_dir))
    os.makedirs(path, exist_ok=True)
    return path


def _get_assets(node: dict, output: str) -> list:
    key = _ASSET_FIELDS.get(output)
    return node.get(key, []) if key else []


def _write_assets(assets: list, assets_dir: str) -> list:
    if not assets:
        return []
    os.makedirs(assets_dir, exist_ok=True)
    written = []
    for asset in assets:
        # basename() strips any accidental path segments out of a filename
        # that ultimately came from a Figma layer name.
        filename = os.path.basename(asset["filename"])
        file_path = os.path.join(assets_dir, filename)
        with open(file_path, "wb") as f:
            f.write(base64.b64decode(asset["base64"]))
        written.append(file_path)
    return written


# Mirrors rewriteHtmlWithAssetPaths/rewriteDartWithAssetPaths in ui.html
# exactly, so code exported here matches what the plugin's own "Download
# images + copy code" button produces — real files, not inline base64. The
# data URI (or, for Dart, the whole Image.memory/MemoryImage call) is unique
# per asset, so a literal string replace is exact and needs no regex.
def _rewrite_html_with_asset_paths(html: str, assets: list) -> str:
    result = html
    for asset in assets:
        result = result.replace(asset["dataUri"], f"assets/{asset['filename']}")
    return result


def _rewrite_dart_with_asset_paths(dart: str, assets: list) -> str:
    result = dart
    for asset in assets:
        if asset.get("fillOnly"):
            old_provider = f"MemoryImage(base64Decode('{asset['base64']}'))"
            new_provider = f"AssetImage('assets/{asset['filename']}')"
            result = result.replace(old_provider, new_provider)
            continue
        old_call = (
            f"Image.memory(base64Decode('{asset['base64']}'), width: {asset['width']}, "
            f"height: {asset['height']}, fit: BoxFit.fill, gaplessPlayback: true)"
        )
        new_call = (
            f"Image.asset('assets/{asset['filename']}', width: {asset['width']}, "
            f"height: {asset['height']}, fit: BoxFit.fill)"
        )
        result = result.replace(old_call, new_call)
    if "base64Decode(" not in result:
        result = result.replace("import 'dart:convert';\n", "")
    return result


def _rewrite_code_with_asset_paths(code: str, output: str, assets: list) -> str:
    if output == "dart":
        return _rewrite_dart_with_asset_paths(code, assets)
    return _rewrite_html_with_asset_paths(code, assets)


@mcp.tool()
def list_page_screens() -> dict:
    """Return a lightweight map of every top-level frame on the current
    Figma page, grouped by Figma Section where the designer used one — name,
    position (x/y), size (width/height), and visibility only, no generated
    code. Use this before diving into any one screen, to see how many
    screens the whole app has, which ones are grouped together (a Section's
    name is usually the flow/feature it groups), and how they're laid out on
    the canvas. Requires the user to have clicked Settings > MCP Connect >
    Scan page at least once — it isn't pushed automatically like the
    selection is, since it exposes the file's whole structure rather than
    just what's selected."""
    if not _latest_page_overview:
        raise ValueError(
            "No page overview yet. In Figma, open the FigmaToCode plugin and "
            "click Settings > MCP Connect > Scan page."
        )
    return {
        "pageName": _latest_page_overview["pageName"],
        "sections": _latest_page_overview["sections"],
        "ungroupedScreens": _latest_page_overview["ungroupedScreens"],
    }


@mcp.tool()
def list_selected_nodes() -> list:
    """List every currently-selected layer's index, name, and type. Call this
    first to see what's selected before calling other tools by index."""
    selection = _selection_or_raise()
    return [
        {"index": i, "name": node["nodeName"], "type": node["nodeType"]}
        for i, node in enumerate(selection["nodes"])
    ]


@mcp.tool()
def get_node_metadata(index: int = 0) -> dict:
    """Return a selected layer's size and any generation warnings, without the
    full generated code — use this to reason about layout before pulling code."""
    node = _node_or_raise(index)
    return {
        "nodeId": node["nodeId"],
        "nodeName": node["nodeName"],
        "nodeType": node["nodeType"],
        "width": node["width"],
        "height": node["height"],
        "warnings": node["warnings"],
    }


@mcp.tool()
def get_node_code(index: int = 0, output: str = "css") -> str:
    """Return generated code for one selected layer. `output` is one of: css,
    html, dart, inline_svg_html, responsive_css, responsive_html,
    responsive_dart. `index` picks which selected layer (see
    list_selected_nodes). The non-responsive variants match the fixed-pixel
    size captured from Figma; the responsive_* variants are the fluid,
    Fill/Hug/Constraints-based layout instead."""
    node = _node_or_raise(index)
    getter = _CODE_FIELDS.get(output)
    if getter is None:
        raise ValueError(f"output must be one of: {', '.join(_CODE_FIELDS)}")
    return getter(node)


@mcp.tool()
def get_selection_code(indices: list = None, output: str = "html") -> list:
    """Return generated code for several (or, by default, all) selected
    layers in one call, with any image assets replaced by an
    `assets/<filename>` placeholder path instead of inline base64 — safe to
    use with a low-context client, unlike raw get_node_code on an
    image-heavy selection. Each result also lists the assets that code
    references (filename + mimeType, no bytes); fetch the real files
    afterward with export_node_assets or export_node if you need them.
    `output` accepts the same values as get_node_code. `indices` (default:
    every selected node) picks which layers to include — see
    list_selected_nodes."""
    nodes = _selection_or_raise()["nodes"]
    if indices is None:
        indices = list(range(len(nodes)))
    if output not in _CODE_FIELDS:
        raise ValueError(f"output must be one of: {', '.join(_CODE_FIELDS)}")
    getter = _CODE_FIELDS[output]
    # Responsive variants reuse the same top-level asset lists as their
    # fixed-pixel counterpart — ui.html's own copy/download buttons do the
    # same lookup (see rewriteHtmlWithAssetPaths call sites).
    asset_key = _ASSET_FIELDS.get(output.replace("responsive_", "", 1))
    results = []
    for i in indices:
        node = _node_or_raise(i)
        code = getter(node)
        assets = node.get(asset_key, []) if asset_key else []
        if assets:
            code = _rewrite_code_with_asset_paths(code, "dart" if "dart" in output else "html", assets)
        results.append({
            "index": i,
            "name": node["nodeName"],
            "code": code,
            "assets": [{"filename": a["filename"], "mimeType": a["mimeType"]} for a in assets],
        })
    return results


@mcp.tool()
def list_node_assets(index: int = 0, output: str = "html") -> list:
    """List the image assets a selected layer's generated code references
    (filename + MIME type, no image bytes) — use export_node_assets to
    actually save them as files."""
    node = _node_or_raise(index)
    key = _ASSET_FIELDS.get(output)
    if key is None:
        raise ValueError(f"output must be one of: {', '.join(sorted(set(_ASSET_FIELDS)))}")
    return [{"filename": a["filename"], "mimeType": a["mimeType"]} for a in node.get(key, [])]


@mcp.tool()
def export_node_assets(index: int, output_dir: str, output: str = "html") -> list:
    """Decode a selected layer's image assets and write them as real files
    under output_dir (created if missing). Returns the absolute paths written."""
    node = _node_or_raise(index)
    return _write_assets(_get_assets(node, output), _safe_dir(output_dir))


@mcp.tool()
def export_node(index: int, output_dir: str, output: str = "html") -> dict:
    """Export one selected layer as a ready-to-use folder under output_dir:
    a code file (html or dart) with every image it uses already rewritten to
    point at real files in an assets/ subfolder — not left as inline base64 —
    plus preview.png, the ground-truth Figma render. Use this for "pull this
    one component, images and all" requests; use export_selection instead for
    the whole current selection at once."""
    node = _node_or_raise(index)
    if output not in ("html", "dart"):
        raise ValueError("output must be 'html' or 'dart'")
    node_dir = _safe_dir(output_dir)
    assets = _get_assets(node, output)
    code = _rewrite_code_with_asset_paths(node[output], output, assets)
    code_path = os.path.join(node_dir, f"code.{_FILE_EXT[output]}")
    with open(code_path, "w") as f:
        f.write(code)
    written_assets = _write_assets(assets, os.path.join(node_dir, "assets"))
    preview_path = None
    if node.get("previewImage"):
        _, _, b64 = node["previewImage"].partition(",")
        preview_path = os.path.join(node_dir, "preview.png")
        with open(preview_path, "wb") as f:
            f.write(base64.b64decode(b64))
    return {"code": code_path, "assets": written_assets, "preview": preview_path}


@mcp.tool()
def save_preview_image(index: int, output_dir: str, filename: str = "preview.png") -> str:
    """Save the ground-truth Figma render (the same PNG the plugin's Preview
    tab compares generated code against) for a selected layer to output_dir.
    Returns the absolute path written."""
    node = _node_or_raise(index)
    uri = node.get("previewImage")
    if not uri:
        raise ValueError("This node has no preview image (export may have failed).")
    _, _, b64 = uri.partition(",")
    path = os.path.join(_safe_dir(output_dir), os.path.basename(filename))
    with open(path, "wb") as f:
        f.write(base64.b64decode(b64))
    return path


@mcp.tool()
def get_design_tokens() -> dict:
    """Return the raw design system collected from the current selection:
    Figma variables, styles, colors, gradients, typography, radii, shadows,
    spacing, fonts, and the component library — everything needed to build a
    consistent theme, not just one layer's code."""
    selection = _selection_or_raise()
    ds = selection["designSystem"]
    return {k: v for k, v in ds.items() if k != "exports"}


@mcp.tool()
def get_design_export(format: str = "css") -> str:
    """Return a ready-to-use export built from the current selection's design
    system. `format` is one of: css (CSS custom properties + token rules),
    flutter (ThemeData + pubspec font snippet), components (Dart component
    scaffolds), json (design tokens as JSON)."""
    selection = _selection_or_raise()
    exports = selection["designSystem"]["exports"]
    if format not in exports:
        raise ValueError(f"format must be one of: {', '.join(exports)}")
    return exports[format]


@mcp.tool()
def get_prototype_html() -> str:
    """Return the bundled, clickable multi-frame HTML prototype (Navigate/
    Overlay reactions become real click/hover behavior, Smart Animate
    transitions tween matching layers) — only available when 2+ top-level
    frames were selected together in Figma."""
    selection = _selection_or_raise()
    prototype = selection.get("prototype")
    if not prototype or not prototype.get("html"):
        raise ValueError(
            "No prototype available — select 2 or more top-level frames together in Figma "
            "(with MCP Connect on) and try again."
        )
    return prototype["html"]


@mcp.tool()
def export_selection(output_dir: str, output: str = "html") -> dict:
    """One-shot export of the entire current selection to real files under
    output_dir: one subfolder per selected layer (code + assets/ + preview.png
    — see export_node), plus the design tokens export and prototype.html if
    the selection qualifies for one. `output` is 'html' or 'dart'. This is the
    fastest way to pull a whole selection down to build from — call
    list_selected_nodes first if you only want one specific layer, via
    export_node instead."""
    selection = _selection_or_raise()
    root = _safe_dir(output_dir)
    written = {"root": root, "nodes": [], "designTokens": None, "prototype": None}

    for i, node in enumerate(selection["nodes"]):
        node_dir = os.path.join(root, f"{i:02d}_{node['nodeName'] or 'node'}")
        node_export = export_node(i, node_dir, output)
        written["nodes"].append({"name": node["nodeName"], **node_export})

    tokens_format = "flutter" if output == "dart" else "css"
    tokens_ext = "dart" if tokens_format == "flutter" else "css"
    tokens_path = os.path.join(root, f"design-tokens.{tokens_ext}")
    with open(tokens_path, "w") as f:
        f.write(selection["designSystem"]["exports"][tokens_format])
    written["designTokens"] = tokens_path

    prototype = selection.get("prototype")
    if prototype and prototype.get("html"):
        prototype_path = os.path.join(root, "prototype.html")
        with open(prototype_path, "w") as f:
            f.write(prototype["html"])
        written["prototype"] = prototype_path

    return written


if __name__ == "__main__":
    threading.Thread(target=_run_websocket_bridge, daemon=True).start()
    mcp.run(transport="stdio")
