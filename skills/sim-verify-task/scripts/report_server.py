#!/usr/bin/env python3
"""Serve report.html and PNG screenshots on loopback; enqueue authenticated actions.

python3 report_server.py .devloop --port 8765 [--wait 900]
The printed token URL establishes a session cookie for images. No arbitrary files
or directory listings are served. --wait exits 0 on a pending task, 3 on timeout.
"""
import argparse
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import threading
import time
import sqlite3
import sys
from urllib.parse import parse_qs, unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'start-task' / 'scripts'))
from runtime import Conflict, ID as TASK_ID, Store
sys.path.insert(0, str(Path(__file__).resolve().parent))
from artifact_bridge import Bridge

MAX_BODY = 32768
ACTIONS = {"execute", "retest", "pr"}


def matches(value, token):
    return secrets.compare_digest(value.encode("utf-8"), token.encode("utf-8"))


def inside(root, path):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def make_server(root, port=8765):
    store = Store(root)
    store.import_queue()
    root = store.root
    token = secrets.token_urlsafe(24)
    bridge = Bridge(root)
    done = threading.Event()

    def pending():
        return [r for r in store.snapshot() if r['status'] != 'done']

    def runnable():
        # A request waiting for the person's answer (blocked) is not work yet: --wait keeps the page alive for it.
        return [r for r in store.snapshot() if r['status'] in ('queued', 'ready')]

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def reply(self, code, body, content_type="application/json", cookie=False, head=False):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
            if cookie:
                self.send_header("Set-Cookie", f"{self.server.cookie_name}={token}; HttpOnly; SameSite=Strict; Path=/")
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def local(self):
            host = self.headers.get("Host", "")
            origin = self.headers.get("Origin")
            return host in self.server.allowed_hosts and (origin is None or origin == f"http://{host}")

        def authenticated(self):
            value = self.headers.get("X-Devloop-Token", "")
            if matches(value, token):
                return True
            try:
                cookies = SimpleCookie(self.headers.get("Cookie", ""))
                name = self.server.cookie_name
                return name in cookies and matches(cookies[name].value, token)
            except (ValueError, TypeError, CookieError):
                return False

        def do_HEAD(self):
            self.do_GET(head=True)

        def do_GET(self, head=False):
            if not self.local():
                return self.reply(403, {"error": "forbidden"}, head=head)
            url = urlsplit(self.path)
            page = re.fullmatch(r'/tasks/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})/report\.html', unquote(url.path))
            if url.path in ("/", "/index.html") or page:
                supplied = parse_qs(url.query).get("t", [""])[0]
                if not matches(supplied, token) and not self.authenticated():
                    return self.reply(403, {"error": "open the printed token URL"}, head=head)
                path = root / 'tasks' / page.group(1) / 'report.html' if page else root / 'report.html'
                if not inside(root, path) or not path.is_file():
                    return self.reply(404, {"error": "report not found"}, head=head)
                html = path.read_text(encoding="utf-8").replace("/*__TOKEN__*/''", json.dumps(token))
                return self.reply(200, html.encode(), "text/html; charset=utf-8", cookie=True, head=head)
            if not self.authenticated():
                return self.reply(403, {"error": "forbidden"}, head=head)
            if url.path == "/queue":
                return self.reply(200, sorted({r["task_id"] for r in pending()}), head=head)
            if url.path == '/artifact':
                try:
                    return self.reply(200, bridge.status(parse_qs(url.query).get('task_id', [''])[0]), head=head)
                except (ValueError, OSError):
                    return self.reply(404, {'error': 'task page not found'}, head=head)
            relative = Path(unquote(url.path).lstrip("/"))
            # Only canonical screenshot paths; task pages are handled above. JSON/logs stay private.
            if (len(relative.parts) < 6 or relative.parts[0] != "tasks"
                    or not TASK_ID.fullmatch(relative.parts[1])
                    or relative.parts[2] != "runs" or not relative.parts[3].isdigit()
                    or relative.parts[4] not in {"before", "after", "diff"}
                    or ".." in relative.parts or relative.suffix.lower() != ".png"):
                return self.reply(404, {"error": "not found"}, head=head)
            path = root / relative
            if not inside(root, path) or not path.is_file():
                return self.reply(404, {"error": "not found"}, head=head)
            return self.reply(200, path.read_bytes(), "image/png", head=head)

        def do_POST(self):
            endpoint = urlsplit(self.path).path
            if endpoint not in ('/send', '/artifact'):
                return self.reply(404, {"error": "not found"})
            if not self.local() or not matches(self.headers.get("X-Devloop-Token", ""), token):
                return self.reply(403, {"error": "forbidden"})
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/json":
                return self.reply(415, {"error": "json only"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return self.reply(400, {"error": "invalid content length"})
            if self.headers.get("Transfer-Encoding") or not 0 < length <= MAX_BODY:
                return self.reply(413, {"error": "body must be 1..32768 bytes"})
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, OSError):
                return self.reply(400, {"error": "invalid JSON"})
            if not isinstance(body, dict):
                return self.reply(400, {"error": "expected object"})
            tid, action, comment = body.get("task_id"), body.get("action", "execute"), body.get("comment", "")
            if not isinstance(tid, str) or not TASK_ID.fullmatch(tid):
                return self.reply(400, {"error": "invalid task_id"})
            if endpoint == '/artifact':
                try:
                    return self.reply(202, bridge.request(tid))
                except Conflict as exc:
                    return self.reply(409, {'error': str(exc)})
                except (ValueError, OSError):
                    return self.reply(400, {'error': 'rebuild the task page before publishing'})
                except sqlite3.Error:
                    return self.reply(503, {'error': 'artifact queue unavailable'})
            if not isinstance(action, str) or action not in ACTIONS:
                return self.reply(400, {"error": "invalid action"})
            if not isinstance(comment, str) or len(comment) > 4000:
                return self.reply(400, {"error": "comment must be text, at most 4000 characters"})
            task_file = root / "tasks" / tid / "task.json"
            if not inside(root, task_file) or not task_file.is_file():
                return self.reply(404, {"error": "unknown task"})
            try:
                task = json.loads(task_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return self.reply(409, {"error": "invalid task.json"})
            if not isinstance(task, dict):
                return self.reply(409, {"error": "invalid task.json"})
            try:
                # Dev Loop: a blocked request takes the comment as its answer and continues; otherwise a new request.
                record = store.request(tid, action, comment)
            except Conflict as exc:
                return self.reply(409, {"error": str(exc)})
            except (ValueError, OSError, sqlite3.Error):
                return self.reply(503, {"error": "queue unavailable; inspect runtime status before retry"})
            request_id = record['request_id']
            self.reply(200, {"ok": True, "queued": tid, "request_id": request_id, "stage": record['stage']})
            print(f"[queue] {tid} ← {action}", flush=True)
            done.set()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    actual_port = server.server_address[1]
    server.allowed_hosts = {f"localhost:{actual_port}", f"127.0.0.1:{actual_port}"}
    server.token, server.done, server.store = token, done, store
    server.cookie_name = f"devloop_{actual_port}"
    if runnable():
        done.set()
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--wait", type=int)
    args = parser.parse_args()
    if args.wait is not None and args.wait <= 0:
        parser.error("--wait must be positive")
    with make_server(args.root, args.port) as server:
        print(f"report: http://localhost:{server.server_address[1]}/?t={server.token}", flush=True)
        if args.wait is None:
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            return 0
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        deadline = time.monotonic() + args.wait
        while not server.done.wait(min(.25, max(0, deadline-time.monotonic()))):
            if any(r['status'] in ('queued', 'ready') for r in server.store.snapshot()):
                server.done.set()
            if time.monotonic() >= deadline:
                break
        fired = server.done.is_set()
        server.shutdown()
        thread.join()
        print("queue: task received" if fired else "queue: timeout, nothing received", flush=True)
        return 0 if fired else 3


if __name__ == "__main__":
    raise SystemExit(main())
