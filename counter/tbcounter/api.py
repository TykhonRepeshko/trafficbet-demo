"""Backend client for the worker-token automation API."""
from __future__ import annotations

import base64
import time
from typing import Any

import requests

from . import log

LOG = log.get("api")


class Conflict(Exception):
    """409: the round/stream state no longer accepts this action (already resolved, closed, ...)."""


class Client:
    def __init__(self, base: str, token: str, session: requests.Session | None = None) -> None:
        self.base = base.rstrip("/")
        self.session = session or requests.Session()
        self.session.headers.update({"X-Worker-Token": token, "Accept": "application/json",
                                     "User-Agent": "trafficbet-counter"})

    def _request(self, method: str, path: str, *, json: Any = None, raw: bool = False, attempts: int = 4, timeout: tuple[float, float] = (5, 30)):
        delay = 1.0
        for attempt in range(attempts):
            try:
                response = self.session.request(method, self.base + path, json=json, timeout=timeout, allow_redirects=False)
            except requests.RequestException as exc:
                if attempt == attempts - 1:
                    raise
                LOG.warning("api unreachable, retrying", path=path, error=str(exc)[:200])
            else:
                if 300 <= response.status_code < 400:
                    raise requests.HTTPError("Backend redirects are forbidden for worker-token requests.", response=response)
                if response.status_code == 409:
                    raise Conflict(response.text[:300])
                if response.status_code == 404 and raw:
                    return None
                if response.status_code < 500 and response.status_code != 429:
                    if response.status_code >= 400:
                        raise requests.HTTPError(f"{response.status_code} {response.text[:300]}", response=response)
                    return response.content if raw else (response.json() if response.content else {})
                if attempt == attempts - 1:
                    response.raise_for_status()
                LOG.warning("api error, retrying", path=path, status=response.status_code)
            time.sleep(delay)
            delay = min(delay * 2, 15)
        raise RuntimeError("unreachable")

    def streams(self) -> list[dict]:
        return self._request("GET", "/api/internal/automation/streams").get("streams", [])

    def reference(self, stream_id: int) -> bytes | None:
        return self._request("GET", f"/api/internal/automation/streams/{stream_id}/reference", raw=True)

    def calibrate(self, stream_id: int, png: bytes, definition: dict, note: str) -> dict:
        body = {"referencePng": base64.b64encode(png).decode("ascii"), "definition": definition, "note": note}
        return self._request("POST", f"/api/internal/automation/streams/{stream_id}/calibration", json=body,
                             attempts=2).get("profile", {})

    def availability(self, stream_id: int, available: bool, reason: str) -> dict:
        return self._request("POST", f"/api/internal/automation/streams/{stream_id}/availability",
                             json={"available": available, "reason": reason[:300]})

    def rounds(self) -> list[dict]:
        return self._request("GET", "/api/internal/automation/rounds").get("rounds", [])

    def result(self, round_id: int, payload: dict) -> dict:
        return self._request("POST", f"/api/internal/automation/rounds/{round_id}/result", json=payload)

    def progress(self, round_id: int, payload: dict) -> dict:
        """Live count while the round is being counted; best effort, never retried."""
        return self._request("POST", f"/api/internal/automation/rounds/{round_id}/progress", json=payload, attempts=1, timeout=(2, 3))
