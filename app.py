#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DuckAI Chat Studio — local server
=================================
Serves the single-page UI (index.html) and relays chat requests to Duck.ai
using DuckDuckGo's own chat protocol:

    1) GET  https://duckduckgo.com/duckchat/v1/status
       header:  x-vqd-accept: 1
       returns: x-vqd-4  (the conversation token) in the response headers

    2) POST https://duckduckgo.com/duckchat/v1/chat
       headers: x-vqd-4: <token>, Content-Type: application/json
       body:    {"model": "<model id>", "messages": [{"role": "user", "content": "..."}]}
       returns: text/event-stream, lines of `data: {"message": "..."}` and `data: [DONE]`

The browser cannot call duckduckgo.com directly (CORS + token handling), so
this small relay does it server-side and re-streams the tokens to the page.

Run:
    python3 app.py                 # http://127.0.0.1:8000
    python3 app.py --port 3000
    python3 app.py --demo          # no network: canned streaming reply, to preview the UI

No third-party packages required — Python 3.9+ standard library only.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import http.cookiejar
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(BASE_DIR, "index.html")

DDG = "https://duckduckgo.com"
STATUS_URL = DDG + "/duckchat/v1/status"
CHAT_URL = DDG + "/duckchat/v1/chat"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# model ids accepted by duck.ai -> friendly labels used in the UI
MODELS = {
    "gpt-4o-mini": "GPT-6 Luna",
    "claude-3-haiku-20240307": "Claude Haiku",
    "meta-llama/Llama-3.3-70B-Instruct-Turbo": "Llama 3.3 70B",
    "mistralai/Mistral-Small-24B-Instruct-2501": "Mistral Small",
    "o3-mini": "o3-mini",
}
DEFAULT_MODEL = "gpt-4o-mini"

_opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
)


class DuckError(Exception):
    """Raised when duck.ai refuses or breaks the handshake."""


def _headers(extra=None):
    h = {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": DDG,
        "Referer": DDG + "/",
    }
    if extra:
        h.update(extra)
    return h


def new_token(timeout=20):
    """Handshake step 1: obtain the x-vqd-4 conversation token."""
    req = urllib.request.Request(STATUS_URL, headers=_headers({"x-vqd-accept": "1"}))
    try:
        with _opener.open(req, timeout=timeout) as resp:
            token = resp.headers.get("x-vqd-4")
            if not token:
                raise DuckError(
                    "Duck.ai did not return an x-vqd-4 token "
                    "(the endpoint may require a browser challenge)."
                )
            return token
    except urllib.error.HTTPError as e:
        raise DuckError("Duck.ai handshake failed with HTTP %s." % e.code)
    except urllib.error.URLError as e:
        raise DuckError("Cannot reach duckduckgo.com: %s" % getattr(e, "reason", e))


def open_chat(model, messages, timeout=180):
    """Handshake step 2: open the streaming chat response."""
    token = new_token()
    body = json.dumps({"model": model, "messages": messages}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        CHAT_URL,
        data=body,
        method="POST",
        headers=_headers({
            "x-vqd-4": token,
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }),
    )
    try:
        return _opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read()[:300].decode("utf-8", "replace")
        except Exception:
            pass
        if e.code == 418:
            raise DuckError("Duck.ai rejected the request (HTTP 418 — anti-bot challenge).")
        if e.code == 429:
            raise DuckError("Duck.ai rate limit reached (HTTP 429). Please wait a moment.")
        raise DuckError("Duck.ai chat failed with HTTP %s. %s" % (e.code, detail))
    except urllib.error.URLError as e:
        raise DuckError("Cannot reach duckduckgo.com: %s" % getattr(e, "reason", e))


DEMO_TEXT = (
    "این یک پاسخ **نمایشی** است، چون سرور با پرچم `--demo` اجرا شده و به Duck.ai وصل نیست.\n\n"
    "برای گفتگوی واقعی، سرور را بدون این پرچم اجرا کنید:\n\n"
    "```bash\npython3 app.py --port 8000\n```\n\n"
    "سپس نشانی `http://127.0.0.1:8000` را باز کنید. در آن حالت، هر پیام از طریق پروتکل "
    "`duckchat/v1` به Duck.ai فرستاده می‌شود و پاسخ به‌صورت جریانی (streaming) نمایش داده می‌شود.\n\n"
    "نکته‌ها:\n"
    "- توکن گفتگو (`x-vqd-4`) برای هر درخواست از نو گرفته می‌شود.\n"
    "- تاریخچهٔ همان گفتگو به‌عنوان `messages` ارسال می‌شود تا مدل زمینه را داشته باشد.\n"
    "- با دکمهٔ توقف می‌توانید جریان را قطع کنید."
)


class Handler(BaseHTTPRequestHandler):
    server_version = "DuckAIChatStudio/1.0"
    protocol_version = "HTTP/1.1"

    # ---------- helpers ----------
    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _sse_start(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def _sse(self, payload):
        data = ("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode("utf-8")
        self.wfile.write(data)
        self.wfile.flush()

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---------- routes ----------
    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            try:
                with open(INDEX, "rb") as f:
                    body = f.read()
            except OSError:
                self._send(500, b"index.html not found next to app.py")
                return
            self._send(200, body, "text/html; charset=utf-8")
            return
        if path == "/api/health":
            if DEMO:
                self._json(200, {"ok": True, "demo": True, "models": list(MODELS)})
                return
            try:
                new_token(timeout=10)
                self._json(200, {"ok": True, "models": list(MODELS)})
            except DuckError as e:
                self._json(200, {"ok": False, "error": "blocked", "detail": str(e)})
            return
        if path == "/api/models":
            self._json(200, {"models": [{"id": k, "label": v} for k, v in MODELS.items()]})
            return
        if path == "/favicon.ico":
            self._send(204)
            return
        self._send(404, b"Not found")

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path != "/api/chat":
            self._send(404, b"Not found")
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            self._json(400, {"error": "Invalid JSON body."})
            return

        model = payload.get("model") or DEFAULT_MODEL
        if model not in MODELS:
            model = DEFAULT_MODEL
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            self._json(400, {"error": "messages must be a non-empty list."})
            return
        clean = []
        for m in messages[-40:]:
            if not isinstance(m, dict):
                continue
            role = m.get("role")
            content = m.get("content")
            if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                clean.append({"role": role, "content": content})
        if not clean:
            self._json(400, {"error": "No usable messages."})
            return

        if DEMO:
            self._demo_stream()
            return

        try:
            resp = open_chat(model, clean)
        except DuckError as e:
            self._sse_start()
            self._sse({"error": str(e)})
            self._sse_done()
            return

        self._sse_start()
        try:
            for raw_line in resp:
                line = raw_line.decode("utf-8", "replace").strip()
                if not line:
                    continue
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data:
                    continue
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if "message" in obj:
                    self._sse({"message": obj["message"]})
                elif "action" in obj and obj["action"] == "error":
                    self._sse({"error": "Duck.ai stream error."})
                    break
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:  # noqa: BLE001 - relay must never crash the server
            try:
                self._sse({"error": "Stream interrupted: %s" % e})
            except Exception:
                pass
        finally:
            try:
                resp.close()
            except Exception:
                pass
        self._sse_done()

    # ---------- demo ----------
    def _demo_stream(self):
        self._sse_start()
        try:
            for chunk in DEMO_TEXT.split(" "):
                self._sse({"message": chunk + " "})
                time.sleep(0.03)
            self._sse_done()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _sse_done(self):
        try:
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except Exception:
            pass


DEMO = False


def main():
    global DEMO
    ap = argparse.ArgumentParser(description="DuckAI Chat Studio local server")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=8000, help="port (default 8000)")
    ap.add_argument("--demo", action="store_true", help="offline demo mode (no Duck.ai calls)")
    args = ap.parse_args()
    DEMO = args.demo

    if not os.path.exists(INDEX):
        sys.exit("index.html must sit next to app.py")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    url = "http://%s:%d" % ("127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host, args.port)
    print("DuckAI Chat Studio  →  %s" % url)
    print("mode: %s" % ("DEMO (offline)" if DEMO else "live relay to Duck.ai"))
    print("press Ctrl+C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
        httpd.server_close()


if __name__ == "__main__":
    main()
