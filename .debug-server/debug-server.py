import http.server
import json
import base64
import os
import datetime

PORT = 8787
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(OUT_DIR, exist_ok=True)


class Handler(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
        except Exception as e:
            self.send_response(400)
            self._cors()
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode())
            return

        with open(os.path.join(OUT_DIR, "latest.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        # A selection carries one payload per layer; the first one lands on
        # latest.png so existing tooling keeps working, the rest are numbered.
        nodes = data.get("nodes") or [data]
        for index, node in enumerate(nodes):
            preview = node.get("previewImage")
            if not preview or "," not in preview:
                continue
            name = "latest.png" if index == 0 else f"latest-{index + 1}.png"
            with open(os.path.join(OUT_DIR, name), "wb") as f:
                f.write(base64.b64decode(preview.split(",", 1)[1]))

        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        summary = ", ".join(
            f"{node.get('nodeName')!r} ({node.get('width')}x{node.get('height')})" for node in nodes
        )
        skipped = data.get("skippedCount") or 0
        print(
            f"[{ts}] received {len(nodes)} layer(s): {summary}"
            + (f" (+{skipped} in design system only)" if skipped else ""),
            flush=True,
        )

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode())

    def log_message(self, format, *args):
        pass  # keep stdout clean, we print our own line above


if __name__ == "__main__":
    print(f"Debug server listening on http://localhost:{PORT} — writing to {OUT_DIR}", flush=True)
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
