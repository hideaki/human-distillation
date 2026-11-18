#!/usr/bin/env python3
"""Local preview of the page, served the way Claude serves it.

Claude wraps the published file in a small document skeleton; this does the
same, so the local view matches the published one.

  /        the page with a stand-in for Claude (placeholder answers)
  /bare    the page with no runtime at all, as a plain copy would see it
  /built   the single-file build (run build.py first), with the stand-in

Run:  python3 live/dev.py        then open http://localhost:4174/
"""

import http.server
import os
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "4174"))

SKELETON = (
    "<!doctype html><html><head><meta charset=utf8>"
    '<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
    "<style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}"
    "body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>"
    "</head><body>"
)
STAND_IN = '<script src="/dev-runtime.js"></script>'
PAGES = {
    "/": ("page.html", True),
    "/bare": ("page.html", False),
    "/built": ("dist/human-distillation.html", True),
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?")[0].split("#")[0]
        if path not in PAGES:
            return super().do_GET()
        name, stand_in = PAGES[path]
        source = HERE / name
        if not source.exists():
            self.send_error(404, f"{name} does not exist yet")
            return
        html = SKELETON + (STAND_IN if stand_in else "") + source.read_text("utf-8") + "</body></html>"
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Preview on http://localhost:{PORT}/", flush=True)
    server.serve_forever()
