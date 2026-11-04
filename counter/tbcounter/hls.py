"""HLS polling through the backend media gateway (or an upstream URL in dry-run mode)."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from urllib.parse import urljoin

import requests

from . import log, video
from .clock import OverlayClock
from .segments import Segment, SegmentBuffer

LOG = log.get("hls")
MAX_SEGMENT_BYTES = 20 << 20
MAX_PLAYLIST_BYTES = 1 << 20


@dataclass(frozen=True)
class MediaSegment:
    seq: int
    duration: float
    uri: str
    discontinuity: bool


@dataclass(frozen=True)
class MediaPlaylist:
    target_duration: float
    segments: list[MediaSegment]
    ended: bool


def parse_master(text: str, base: str) -> str | None:
    """URI of the highest-bandwidth variant, or None if `text` is already a media playlist."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    best, best_bw = None, -1
    for i, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF"):
            bw = 0
            for part in line.split(":", 1)[1].split(","):
                if part.upper().startswith("BANDWIDTH="):
                    try:
                        bw = int(part.split("=", 1)[1])
                    except ValueError:
                        pass
            nxt = next((l for l in lines[i + 1:] if not l.startswith("#")), None)
            if nxt and bw > best_bw:
                best, best_bw = urljoin(base, nxt), bw
    return best


def parse_media(text: str, base: str) -> MediaPlaylist:
    if not text.startswith("#EXTM3U"):
        raise ValueError("not an HLS playlist")
    seq, target, duration, disc, ended = 0, 10.0, None, False, False
    segments: list[MediaSegment] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            seq = int(line.split(":", 1)[1])
        elif line.startswith("#EXT-X-TARGETDURATION:"):
            target = float(line.split(":", 1)[1])
        elif line.startswith("#EXTINF:"):
            duration = float(line.split(":", 1)[1].split(",", 1)[0])
        elif line.startswith("#EXT-X-DISCONTINUITY") and not line.startswith("#EXT-X-DISCONTINUITY-SEQUENCE"):
            disc = True
        elif line == "#EXT-X-ENDLIST":
            ended = True
        elif not line.startswith("#"):
            if duration is not None:
                segments.append(MediaSegment(seq, duration, urljoin(base, line), disc))
            seq, duration, disc = seq + 1, None, False
    return MediaPlaylist(target, segments, ended)


class StreamFetcher(threading.Thread):
    """Polls one camera, downloads new segments, anchors them to the camera clock and buffers them."""

    def __init__(self, stream_id: int, master_url: str, session: requests.Session, buffer: SegmentBuffer,
                 clock: OverlayClock, headers: dict[str, str] | None = None) -> None:
        super().__init__(name=f"fetch-{stream_id}", daemon=True)
        self.stream_id, self.master_url = stream_id, master_url
        self.session, self.buffer, self.clock = session, buffer, clock
        self.headers = headers or {}
        self.variant_url: str | None = None
        self.stop_event = threading.Event()
        self.last_error = ""
        self.segments_seen = 0
        self.last_segment_at = time.monotonic()
        self.frame_size: tuple[int, int] = (0, 0)

    def stop(self) -> None:
        self.stop_event.set()

    def _get(self, url: str, limit: int) -> bytes:
        # A full gateway is not an expired camera session. Briefly retry the
        # same scoped handle instead of reopening playlists and backing off 30s.
        for attempt in range(3):
            with self.session.get(url, headers=self.headers, timeout=(5, 20), stream=True) as response:
                if response.status_code == 503 and attempt < 2:
                    retry = response.headers.get("Retry-After", "2")
                    try:
                        wait = min(2.0, max(0.25, float(retry)))
                    except ValueError:
                        wait = 2.0
                    response.close()
                    if self.stop_event.wait(wait):
                        raise requests.RequestException("camera fetch stopped")
                    continue
                response.raise_for_status()
                data = bytearray()
                for chunk in response.iter_content(65536):
                    data += chunk
                    if len(data) > limit:
                        raise ValueError("response exceeds size limit")
                return bytes(data)
        raise RuntimeError("unreachable")

    def _resolve(self) -> str:
        text = self._get(self.master_url, MAX_PLAYLIST_BYTES).decode("utf-8", "replace")
        variant = parse_master(text, self.master_url)
        return variant or self.master_url

    def poll_once(self) -> float:
        if self.variant_url is None:
            self.variant_url = self._resolve()
        try:
            text = self._get(self.variant_url, MAX_PLAYLIST_BYTES).decode("utf-8", "replace")
        except requests.HTTPError:
            self.variant_url = None  # gateway handles expire; resolve the master again next time
            raise
        playlist = parse_media(text, self.variant_url)
        failed = None
        for item in playlist.segments:
            if self.buffer.has(item.seq) or self.stop_event.is_set():
                continue
            try:
                data = self._get(item.uri, MAX_SEGMENT_BYTES)
            except requests.HTTPError as exc:
                # Keep downloading newer segments even if an older one expired.
                # The missing segment stays missing; coverage gates still fail
                # that window, while subsequent windows can recover normally.
                self.variant_url = None
                failed = exc
                continue
            fetched_at = time.time()
            first_pts, width, height = video.probe(data)
            if first_pts is None:
                continue
            anchor = self.clock.anchor_segment(data, fetched_at, item.duration)
            self.frame_size = (width, height)
            self.buffer.add(Segment(seq=item.seq, duration=item.duration, data=data, fetched_at=fetched_at,
                                    discontinuity=item.discontinuity, anchor=anchor, first_pts=first_pts,
                                    width=width, height=height))
            self.segments_seen += 1
            self.last_segment_at = time.monotonic()
            LOG.debug("segment", stream=self.stream_id, seq=item.seq, duration=item.duration,
                      anchored=anchor is not None, latency=round(anchor.latency, 2) if anchor else None)
        if failed is not None:
            raise failed
        # A session may keep returning HTTP 200 with a frozen media playlist.
        # Re-resolve the public master after three missed segment intervals.
        if not self.stop_event.is_set() and time.monotonic()-self.last_segment_at >= max(30.0, playlist.target_duration*3):
            LOG.warning("playlist stopped advancing; reopening master", stream=self.stream_id)
            self.variant_url = None
            self.last_segment_at = time.monotonic()
            return 1.0
        return max(1.0, min(playlist.target_duration / 2, 4.0))

    def run(self) -> None:
        backoff = 2.0
        while not self.stop_event.is_set():
            before = self.segments_seen
            try:
                wait = self.poll_once()
                self.last_error, backoff = "", 2.0
            except Exception as exc:  # network errors must never kill the camera thread
                self.last_error = f"{type(exc).__name__}: {exc}"[:300]
                LOG.warning("fetch failed", stream=self.stream_id, error=self.last_error)
                if self.segments_seen > before:
                    wait, backoff = 2.0, 2.0
                else:
                    wait, backoff = backoff, min(backoff * 2, 30.0)
            self.stop_event.wait(wait)
