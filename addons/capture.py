"""mitmproxy-Addon: schreibt alle relevanten Requests der Oneisall-App nach captures/.

- captures/<session>/flows.jsonl   – ein JSON-Objekt pro Request/Response (oder WebSocket-Nachricht)
- captures/<session>/hosts.txt     – alle kontaktierten Hosts (hilft beim Finden der API-Domain)
- captures/<session>/tls_errors.txt – Hosts, bei denen der TLS-Handshake vom Client abgebrochen wurde
                                     (typisches Zeichen für Certificate Pinning)

Apple-/iCloud-/Telemetrie-Rauschen wird ausgefiltert.
"""

import json
import re
import time
from datetime import datetime
from pathlib import Path

from mitmproxy import ctx, http, tls

IGNORE_HOSTS = re.compile(
    r"(apple\.com|icloud\.com|mzstatic\.com|apple-cloudkit\.com|cdn-apple\.com|"
    r"itunes\.com|push\.apple|aaplimg\.com|googleapis\.com|gstatic\.com|"
    r"crashlytics|firebaselogging|app-measurement\.com|doubleclick|facebook)",
    re.IGNORECASE,
)

SESSION = datetime.now().strftime("%Y%m%d-%H%M%S")
OUT = Path(__file__).resolve().parent.parent / "captures" / SESSION
OUT.mkdir(parents=True, exist_ok=True)


def _body(content: bytes | None, content_type: str) -> object:
    if not content:
        return None
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return {"_binary_hex": content[:4096].hex(), "_length": len(content)}
    if "json" in content_type or text[:1] in "{[":
        try:
            return json.loads(text)
        except ValueError:
            pass
    return text


def _write(name: str, line: str) -> None:
    with open(OUT / name, "a", encoding="utf-8") as f:
        f.write(line + "\n")


class OneisallCapture:
    def __init__(self) -> None:
        self.hosts: set[str] = set()

    def running(self) -> None:
        ctx.log.info(f"[oneisall] Mitschnitt läuft → {OUT}")

    def _note_host(self, host: str) -> None:
        if host not in self.hosts:
            self.hosts.add(host)
            _write("hosts.txt", host)
            ctx.log.info(f"[oneisall] neuer Host: {host}")

    def response(self, flow: http.HTTPFlow) -> None:
        host = flow.request.pretty_host
        if IGNORE_HOSTS.search(host):
            return
        self._note_host(host)
        req, res = flow.request, flow.response
        entry = {
            "ts": datetime.fromtimestamp(req.timestamp_start).isoformat(timespec="seconds"),
            "method": req.method,
            "url": req.pretty_url,
            "request_headers": dict(req.headers),
            "request_body": _body(req.raw_content, req.headers.get("content-type", "")),
            "status": res.status_code if res else None,
            "response_headers": dict(res.headers) if res else None,
            "response_body": _body(res.raw_content, res.headers.get("content-type", "")) if res else None,
        }
        _write("flows.jsonl", json.dumps(entry, ensure_ascii=False))
        ctx.log.info(f"[oneisall] {req.method} {req.pretty_url} → {entry['status']}")

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        host = flow.request.pretty_host
        if IGNORE_HOSTS.search(host) or not flow.websocket:
            return
        self._note_host(host)
        msg = flow.websocket.messages[-1]
        entry = {
            "ts": datetime.fromtimestamp(msg.timestamp or time.time()).isoformat(timespec="seconds"),
            "websocket": flow.request.pretty_url,
            "direction": "app→server" if msg.from_client else "server→app",
            "body": _body(msg.content, "json"),
        }
        _write("flows.jsonl", json.dumps(entry, ensure_ascii=False))
        ctx.log.info(f"[oneisall] WS {entry['direction']} {flow.request.pretty_url}")

    def tls_failed_client(self, data: tls.TlsData) -> None:
        sni = data.context.client.sni or "?"
        if IGNORE_HOSTS.search(sni):
            return
        _write("tls_errors.txt", f"{datetime.now().isoformat(timespec='seconds')} {sni}")
        ctx.log.warn(f"[oneisall] TLS vom Client abgelehnt: {sni} (Certificate Pinning?)")


addons = [OneisallCapture()]
