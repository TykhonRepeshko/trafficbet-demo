"""Development mock of the backend automation API + media gateway (contract test for the worker).

python dev/mock_backend.py --streams 1=https://kamera.vegvesen.no/public/0329007_1/manifest.m3u8,6=https://...
"""
from __future__ import annotations

import argparse
import base64
import json
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urljoin

import requests

TOKEN = "x" * 40
STATE = {"streams": {}, "profiles": {}, "references": {}, "rounds": {}, "results": {}, "availability": {}}
LOCK = threading.Lock()
SESSION = requests.Session()


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")


def rewrite(stream_id: int, text: str, base: str) -> str:
    out = []
    for line in text.splitlines():
        if line and not line.startswith("#"):
            token = base64.urlsafe_b64encode(urljoin(base, line).encode()).decode().rstrip("=")
            line = f"/api/media/streams/{stream_id}/resource/{token}"
        out.append(line)
    return "\n".join(out) + "\n"


def publish_rounds() -> None:
    """Like the backend scheduler: a 30 s count every 60 s per calibrated camera, frozen profile snapshot."""
    while True:
        now = time.time()
        with LOCK:
            for sid, stream in STATE["streams"].items():
                prof = STATE["profiles"].get(sid)
                if not prof or not stream["roundsEnabled"]:
                    continue
                last = max((r["_start"] for r in STATE["rounds"].values() if r["streamId"] == sid), default=now + 60)
                while last < now + 150:
                    last += 60
                    rid = len(STATE["rounds"]) + 1
                    STATE["rounds"][rid] = {"id": rid, "streamId": sid, "_start": last, "windowStart": iso(last),
                                            "windowEnd": iso(last + 30), "threshold": 3,
                                            "countingRules": {"mode": "versioned", "profileId": prof["id"], "version": prof["version"],
                                                              "referenceId": prof["referenceId"], "definition": prof["definition"]}}
        time.sleep(5)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, code: int, body) -> None:
        data = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def _auth(self) -> bool:
        if self.headers.get("X-Worker-Token") != TOKEN:
            self._json(401, {"error": "worker_token_required"}); return False
        return True

    def do_GET(self):
        p = self.path
        if p.startswith("/api/media/streams/"):
            parts = p.split("/")
            sid = int(parts[4])
            upstream = STATE["streams"][sid]["_upstream"] if parts[5] == "index.m3u8" else \
                base64.urlsafe_b64decode(parts[6] + "=" * (-len(parts[6]) % 4)).decode()
            r = SESSION.get(upstream, timeout=20)
            body = r.content
            if body.startswith(b"#EXTM3U"):
                body = rewrite(sid, body.decode(), upstream).encode()
            self.send_response(r.status_code); self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body); return
        if not self._auth():
            return
        with LOCK:
            if p == "/api/internal/automation/streams":
                out = []
                for sid, s in STATE["streams"].items():
                    out.append({k: v for k, v in s.items() if not k.startswith("_")} | {"profile": STATE["profiles"].get(sid)})
                self._json(200, {"streams": out}); return
            if p.endswith("/reference"):
                sid = int(p.split("/")[5]); png = STATE["references"].get(sid)
                if png is None:
                    self._json(404, {}); return
                self.send_response(200); self.send_header("Content-Type", "image/png"); self.end_headers(); self.wfile.write(png); return
            if p.startswith("/api/internal/automation/rounds"):
                now = time.time()
                rounds = [{k: v for k, v in r.items() if not k.startswith("_")} for r in STATE["rounds"].values()
                          if r["_start"] + 30 <= now and now - (r["_start"] + 30) < 900 and r["id"] not in STATE["results"]]
                self._json(200, {"rounds": rounds}); return
        self._json(404, {})

    def do_POST(self):
        if not self._auth():
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        parts = self.path.split("/")
        with LOCK:
            if self.path.endswith("/calibration"):
                sid = int(parts[5]); old = STATE["profiles"].get(sid)
                prof = {"id": 100 + sid * 10 + (old["version"] if old else 0), "version": (old["version"] + 1) if old else 1,
                        "referenceId": sid, "width": 0, "height": 0, "automatic": True, "definition": body["definition"]}
                STATE["profiles"][sid] = prof; STATE["references"][sid] = base64.b64decode(body["referencePng"])
                print(json.dumps({"event": "CALIBRATION", "stream": sid, "note": body["note"], "line": [body["definition"]["lineStart"], body["definition"]["lineEnd"]]}), flush=True)
                self._json(201, {"profile": prof}); return
            if self.path.endswith("/availability"):
                sid = int(parts[5]); s = STATE["streams"][sid]
                s["roundsEnabled"] = bool(body["available"]); s["automationNote"] = "" if body["available"] else body["reason"]
                print(json.dumps({"event": "AVAILABILITY", "stream": sid, **body}), flush=True)
                self._json(200, {"roundsEnabled": s["roundsEnabled"]}); return
            if self.path.endswith("/result"):
                rid = int(parts[5])
                if rid in STATE["results"]:
                    self._json(409, {"error": "already_resolved"}); return
                STATE["results"][rid] = body
                ev = body.get("evidence", {})
                print(json.dumps({"event": "RESULT", "round": rid, "stream": STATE["rounds"][rid]["streamId"], "outcome": body["outcome"],
                                  "vehicleCount": body.get("vehicleCount"), "reason": body["reason"],
                                  "frames": ev.get("framesProcessed"), "clock": ev.get("clock"), "framing": ev.get("framing", {}).get("stable"),
                                  "timings": ev.get("timings"), "evidenceBytes": len(json.dumps(ev))}), flush=True)
                self._json(200, {"ok": True}); return
        self._json(404, {})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--streams", required=True)
    ap.add_argument("--port", type=int, default=8080)
    a = ap.parse_args()
    for item in a.streams.split(","):
        sid, url = item.split("=", 1)
        STATE["streams"][int(sid)] = {"id": int(sid), "title": f"Camera {sid}", "streamType": "hls",
                                      "mediaPath": f"/api/media/streams/{sid}/index.m3u8", "sourceFingerprint": "0" * 64,
                                      "roundsEnabled": True, "automationNote": "", "_upstream": url}
    threading.Thread(target=publish_rounds, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
