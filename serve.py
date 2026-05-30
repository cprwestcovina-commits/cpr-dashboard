#!/usr/bin/env python3
"""Local dev server: serves static files + proxies /api/* to Make with CORS."""
import http.server, socketserver, urllib.request, urllib.error, os

PORT = 8788
MAKE_BASE = "https://us2.make.com/api/v2"
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Cache-Control, Pragma")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def _proxy(self, method):
        if not self.path.startswith("/api/"):
            return super().do_GET() if method == "GET" else self.send_error(405)
        url = MAKE_BASE + self.path[4:]
        body = None
        if "Content-Length" in self.headers:
            body = self.rfile.read(int(self.headers["Content-Length"]))
        req = urllib.request.Request(url, data=body, method=method)
        if "Authorization" in self.headers:
            req.add_header("Authorization", self.headers["Authorization"])
        if "Content-Type" in self.headers:
            req.add_header("Content-Type", self.headers["Content-Type"])
        req.add_header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        req.add_header("Accept", "application/json")
        try:
            with urllib.request.urlopen(req) as r:
                data = r.read(); status = r.status; ctype = r.headers.get("Content-Type","application/json")
        except urllib.error.HTTPError as e:
            data = e.read(); status = e.code; ctype = e.headers.get("Content-Type","application/json")
        except Exception as e:
            self.send_response(502); self._cors(); self.end_headers()
            self.wfile.write(str(e).encode()); return
        self.send_response(status); self._cors()
        self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/"): self._proxy("GET")
        else: super().do_GET()
    def do_POST(self): self._proxy("POST")
    def do_PUT(self): self._proxy("PUT")
    def do_PATCH(self): self._proxy("PATCH")
    def do_DELETE(self): self._proxy("DELETE")

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"http://localhost:{PORT}/dashboard.html")
    httpd.serve_forever()
