"""Orchestrator: one fetcher per camera, a processing pool for rounds and calibration."""

from __future__ import annotations

import os
import signal
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field

import cv2
import numpy as np
import requests

from . import api as api_mod
from . import config as config_mod
from . import detector as detector_mod
from . import framing, log, pipeline
from .clock import OverlayClock
from .hls import StreamFetcher
from .rules import Definition, valid_definition
from .segments import SegmentBuffer
from .quality import counting_problem

LOG = log.get("counter")
COVERAGE_DEADLINE = 120.0  # seconds after window end to wait for footage
LAST_START = (
    540.0  # don't start a round the backend will expire (10 min) before we finish
)
BASELINE_MAX_AGE = 900.0
MOVED_STREAK_RECALIBRATE = 3
NO_CLOCK_REASON = (
    "No readable capture clock in the video; rounds cannot be verified automatically."
)
NO_LINE_REASON = "Waiting for automatic calibration: no counting line has been placed for this camera yet."
RESUME_REASON = "Capture clock and counting line verified; automatic counting resumed."
CALIBRATION_MAX_BACKOFF = 1800.0
COVERAGE_RECHECK = (
    1800.0  # light and traffic change through the day: re-decide every 30 min
)
COVERAGE_PROBE_SECONDS = 45.0


def encode_reference(bgr: np.ndarray, limit: int = 900_000) -> bytes:
    """PNG ≤ limit bytes (backend re-encodes and caps at 1 MiB); downscale preserving aspect if needed."""
    for scale in (1.0, 0.8, 0.66, 0.5, 0.4):
        img = (
            bgr
            if scale == 1.0
            else cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        )
        if img.shape[1] > 1920 or img.shape[0] > 1080:
            continue
        ok, png = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, 6])
        if ok and len(png) <= limit:
            return png.tobytes()
    raise ValueError("reference frame cannot be encoded under the size limit")


@dataclass
class Camera:
    id: int
    title: str
    buffer: SegmentBuffer
    clock: OverlayClock
    fetcher: StreamFetcher
    info: dict = field(default_factory=dict)
    profile: dict | None = None
    reference_sig: framing.Signature | None = None
    baseline: tuple[int, framing.Signature, float] | None = (
        None  # (profile id, last verified frame, time)
    )
    moved_streak: int = 0
    calibration: Future | None = None
    calibration_attempts: int = 0
    next_calibration_at: float = 0.0
    recalibrate: bool = False
    availability: bool | None = None
    coverage: str = (
        "line"  # detection mode for new rounds, chosen by the coverage probe
    )
    coverage_probe: Future | None = None
    coverage_checked_at: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def clock_state(self) -> str:
        if self.clock.successes >= 2:
            return "ok"
        if self.clock.successes == 0 and self.clock.failures >= 3:
            return "missing"
        return "probing"


@dataclass
class LiveJob:
    """A round counted live: segments are fed to its session as soon as they arrive."""

    cam: Camera
    rnd: dict
    session: pipeline.RoundSession


class Counter:
    def __init__(self, cfg: config_mod.Config) -> None:
        self.cfg = cfg
        self.api = api_mod.Client(cfg.api_base, cfg.worker_token)
        self.media = requests.Session()
        self.cameras: dict[int, Camera] = {}
        self.pool = ThreadPoolExecutor(
            max_workers=cfg.processors, thread_name_prefix="proc"
        )
        # Calibration takes minutes; it must never delay rounds that are waiting to be settled.
        self.calibration_pool = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="calib"
        )
        self.local = threading.local()
        self.gpu_detector = None
        self.detector_lock = threading.Lock()
        self.inflight: dict[int, Future] = {}
        self.jobs: dict[int, LiveJob] = {}
        self.done: dict[int, float] = {}
        self.pending_results: dict[int, dict] = {}
        self.stop_event = threading.Event()
        self.last_streams = 0.0

    # ---------- detectors (one per pool thread) ----------
    def detector(self, threads: int | None = None):
        if self.cfg.device == "cuda":
            # Share one bounded CUDA session across processing threads. Five
            # per-thread models would compete for the laptop's 8 GiB VRAM.
            with self.detector_lock:
                if self.gpu_detector is None:
                    self.gpu_detector = detector_mod.build(
                        self.cfg.model,
                        self.cfg.models_dir,
                        self.cfg.detector_threads,
                        "cuda",
                    )
                return self.gpu_detector
        det = getattr(self.local, "detector", None)
        if det is None:
            det = detector_mod.build(
                self.cfg.model,
                self.cfg.models_dir,
                threads or self.cfg.detector_threads,
            )
            self.local.detector = det
        return det

    # ---------- cameras ----------
    def refresh_streams(self) -> None:
        streams = self.api.streams()
        seen = set()
        for info in streams:
            if info.get("streamType") != "hls" or not info.get("mediaPath"):
                continue
            sid = int(info["id"])
            seen.add(sid)
            cam = self.cameras.get(sid)
            if cam is None:
                buffer, clock = SegmentBuffer(self.cfg.buffer_seconds), OverlayClock()
                fetcher = StreamFetcher(
                    sid,
                    self.cfg.api_base + info["mediaPath"],
                    self.media,
                    buffer,
                    clock,
                )
                cam = Camera(sid, info.get("title", str(sid)), buffer, clock, fetcher)
                self.cameras[sid] = cam
                fetcher.start()
                LOG.info("camera added", stream=sid, title=cam.title)
            cam.info = info
            profile = info.get("profile")
            if (profile or {}).get("id") != (cam.profile or {}).get("id"):
                cam.profile = profile
                cam.reference_sig = None
                cam.coverage, cam.coverage_checked_at = (
                    "line",
                    0.0,
                )  # a new line needs a new decision
                if profile:
                    png = self.api.reference(sid)
                    if png:
                        img = cv2.imdecode(
                            np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR
                        )
                        cam.reference_sig = (
                            framing.signature(img) if img is not None else None
                        )
                    LOG.info(
                        "profile active",
                        stream=sid,
                        profile=profile.get("id"),
                        version=profile.get("version"),
                    )
        for sid in [s for s in self.cameras if s not in seen]:
            self.cameras.pop(sid).fetcher.stop()
            LOG.info("camera removed", stream=sid)

    @staticmethod
    def wanted_availability(cam: Camera) -> tuple[bool | None, str]:
        """Rounds are offered only when they can be settled: readable clock and a calibrated line."""
        state = cam.clock_state
        if state == "missing":
            return False, NO_CLOCK_REASON
        if state != "ok":
            return None, ""
        if cam.profile is None:
            return False, NO_LINE_REASON
        return True, RESUME_REASON

    def manage_camera(self, cam: Camera) -> None:
        state = cam.clock_state
        rounds_enabled = bool(cam.info.get("roundsEnabled"))
        note = cam.info.get("automationNote") or ""
        wanted, reason = self.wanted_availability(cam)
        if (
            wanted is False
            and cam.availability is not False
            and (rounds_enabled or not note)
        ):
            self.api.availability(cam.id, False, reason)
            cam.availability = False
            LOG.warning("camera unavailable", stream=cam.id, reason=reason)
        elif (
            wanted is True
            and not rounds_enabled
            and note
            and cam.availability is not True
        ):
            self.api.availability(cam.id, True, reason)
            cam.availability = True
            cam.info = cam.info | {"roundsEnabled": True, "automationNote": ""}
            LOG.info("camera available again", stream=cam.id)
        if state != "ok":
            return
        self.maybe_probe_coverage(cam)
        needs = cam.profile is None or cam.recalibrate
        if (
            self.cfg.auto_calibration_enabled
            and needs
            and cam.calibration is None
            and time.time() >= cam.next_calibration_at
        ):
            span = self.cfg.calibration_seconds * min(1 + cam.calibration_attempts, 3)
            segments = [s for s in cam.buffer.snapshot() if s.anchor is not None]
            if (
                segments
                and segments[-1].end - segments[0].start >= self.cfg.calibration_seconds
            ):
                recent = [s for s in segments if s.start >= segments[-1].end - span]
                cam.calibration = self.calibration_pool.submit(
                    self.run_calibration, cam, recent
                )

    def maybe_probe_coverage(self, cam: Camera) -> None:
        if self.cfg.hybrid_motion:
            # Pixelated continuation needs approach observations even when a
            # quiet calibration sample happens to contain no crossings.
            cam.coverage = "wide"
            return
        if (
            not self.cfg.wide_coverage
            or cam.profile is None
            or cam.calibration is not None
            or cam.coverage_probe is not None
            or time.time() - cam.coverage_checked_at < COVERAGE_RECHECK
        ):
            return
        try:
            rule = Definition.from_json(cam.profile.get("definition") or {})
        except (KeyError, TypeError, ValueError):
            return
        newest = cam.buffer.newest_end()
        if newest is None:
            return
        end = newest - 1.0
        start = end - COVERAGE_PROBE_SECONDS
        footage = cam.buffer.coverage(start - pipeline.PRE_ROLL, end)
        if footage.covered and valid_definition(rule):
            cam.coverage_probe = self.calibration_pool.submit(
                self.run_coverage_probe, cam, footage.segments, rule, start, end
            )

    def run_coverage_probe(
        self, cam: Camera, segments, rule: Definition, start: float, end: float
    ) -> None:
        """Count the same recent footage with line-only and wide detection; keep wide only where it pays off."""
        try:
            det = self.calibration_detector()
            line = pipeline.count_round(
                det,
                segments,
                rule,
                start,
                end,
                self.cfg.sample_fps,
                self.cfg.conf_threshold,
            )
            wide = pipeline.count_round(
                det,
                segments,
                rule,
                start,
                end,
                self.cfg.sample_fps,
                self.cfg.conf_threshold,
                coverage="wide",
            )
            cam.coverage = pipeline.choose_coverage(line.count, wide.count)
            LOG.info(
                "coverage chosen",
                stream=cam.id,
                coverage=cam.coverage,
                line=line.count,
                wide=wide.count,
                seconds=round(line.seconds + wide.seconds, 1),
            )
        except Exception:
            LOG.exception("coverage probe failed", stream=cam.id)
        finally:
            cam.coverage_checked_at, cam.coverage_probe = time.time(), None

    def calibration_detector(self):
        """Calibration yields the CPU to round counting: lower priority (inherited by the ONNX Runtime threads
        created afterwards in this thread) and half the detector threads."""
        if not getattr(self.local, "niced", False):
            try:
                os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)
            except (AttributeError, OSError):
                pass
            self.local.niced = True
        return self.detector(max(1, self.cfg.detector_threads // 2))

    def run_calibration(self, cam: Camera, segments) -> None:
        try:
            run = pipeline.calibrate(
                self.calibration_detector(),
                segments,
                self.cfg.sample_fps,
                self.cfg.conf_threshold,
                self.cfg.min_calibration_tracks,
                cam.title,
            )
            if run.result is None:
                cam.calibration_attempts += 1
                # Quiet roads and darkness rarely change within minutes: back off instead of burning CPU.
                cam.next_calibration_at = time.time() + min(
                    CALIBRATION_MAX_BACKOFF,
                    self.cfg.calibration_seconds * 2 ** (cam.calibration_attempts - 1),
                )
                LOG.info(
                    "calibration needs more traffic",
                    stream=cam.id,
                    frames=run.frames,
                    seconds=round(run.seconds, 1),
                    reason=run.error,
                )
                return
            res = run.result
            note = (
                f"Automatic calibration by {self.cfg.worker_name}: {res.tracks_used} vehicle trajectories, "
                f"line crossed by {res.coverage}; flow axis {res.flow_axis[0]:.2f},{res.flow_axis[1]:.2f}."
            )
            profile = self.api.calibrate(
                cam.id,
                encode_reference(run.reference_bgr),
                res.definition.to_json(),
                note,
            )
            cam.profile, cam.recalibrate, cam.calibration_attempts = profile, False, 0
            cam.reference_sig, cam.baseline, cam.moved_streak = (
                framing.signature(run.reference_bgr),
                None,
                0,
            )
            LOG.info(
                "calibrated",
                stream=cam.id,
                profile=profile.get("id"),
                version=profile.get("version"),
                tracks=res.tracks_used,
                line=res.definition.to_json()["lineStart"]
                | {"x2": res.definition.line_end.x, "y2": res.definition.line_end.y},
                seconds=round(run.seconds, 1),
                frames=run.frames,
            )
        except Exception:
            cam.next_calibration_at = time.time() + 60
            LOG.exception("calibration failed", stream=cam.id)
        finally:
            cam.calibration = None

    # ---------- rounds ----------
    def schedule_rounds(self) -> None:
        now = time.time()
        for rid, payload in list(self.pending_results.items()):
            self.post_result(rid, payload)
        rounds = self.api.rounds()
        listed = {int(r["id"]) for r in rounds}
        for rid in [r for r in self.jobs if r not in listed and r not in self.inflight]:
            self.jobs.pop(rid, None)  # resolved elsewhere (watchdog, operator)
        for rnd in sorted(rounds, key=lambda r: r["windowEnd"]):
            rid = int(rnd["id"])
            if rid in self.done or rid in self.inflight or rid in self.pending_results:
                continue
            start, end = _ts(rnd["windowStart"]), _ts(rnd["windowEnd"])
            cam = self.cameras.get(int(rnd["streamId"]))
            if cam is None:
                continue
            rules = rnd.get("countingRules") or {}
            evidence = {
                "profileId": rules.get("profileId"),
                "worker": self.cfg.worker_name,
            }
            try:
                rule = Definition.from_json(rules.get("definition") or {})
            except (KeyError, TypeError, ValueError):
                rule = None
            if rule is None or not valid_definition(rule):
                self.finish(
                    rid,
                    "invalid",
                    "invalid_rule: the round has no valid frozen counting line.",
                    evidence,
                )
                continue
            if cam.clock_state == "missing":
                self.finish(
                    rid, "invalid", f"no_capture_clock: {NO_CLOCK_REASON}", evidence
                )
                continue
            job = self.jobs.get(rid)
            if job is None and now > end + LAST_START:
                continue  # too late to finish before the backend expires and refunds it
            coverage = cam.buffer.coverage(
                start - pipeline.pre_roll_for(self.cfg.hybrid_motion), end
            )
            growing = coverage.covered or coverage.reason == "footage_not_yet_available"
            if growing and coverage.segments:
                if job is None:
                    # Wide detection only while the pool keeps up; otherwise fall back to the cheap mode.
                    mode = (
                        "wide"
                        if self.cfg.hybrid_motion
                        else (
                            cam.coverage
                            if len(self.inflight) < self.cfg.processors
                            else "line"
                        )
                    )
                    job = self.jobs[rid] = LiveJob(
                        cam,
                        rnd,
                        pipeline.RoundSession(
                            None,
                            rule,
                            start,
                            end,
                            self.cfg.sample_fps,
                            self.cfg.conf_threshold,
                            mode,
                            self.cfg.hybrid_motion,
                        ),
                    )
                fed = [seg.seq for seg in job.session.segments]
                if [seg.seq for seg in coverage.segments[: len(fed)]] != fed:
                    LOG.warning(
                        "footage changed under a live round; recounting",
                        round=rid,
                        stream=cam.id,
                    )
                    job.session = pipeline.RoundSession(
                        None,
                        rule,
                        start,
                        end,
                        self.cfg.sample_fps,
                        self.cfg.conf_threshold,
                        job.session.coverage,
                        self.cfg.hybrid_motion,
                    )
                    fed = []
                fresh = coverage.segments[len(fed) :]
                if fresh or (coverage.covered and job.session.complete):
                    self.inflight[rid] = self.pool.submit(
                        self.advance_round,
                        job,
                        fresh,
                        coverage if coverage.covered else None,
                    )
            elif now > end + COVERAGE_DEADLINE or (not growing and now > end + 30):
                self.jobs.pop(rid, None)
                evidence["coverage"] = coverage.evidence() | {"reason": coverage.reason}
                self.finish(
                    rid,
                    "invalid",
                    f"incomplete_coverage: {coverage.reason.replace('_', ' ')}; "
                    "the full counting window could not be verified.",
                    evidence,
                )

    def advance_round(self, job: LiveJob, fresh, coverage) -> None:
        """Feed newly arrived segments, publish the live count and settle once the window is fully covered."""
        rid = int(job.rnd["id"])
        try:
            # Each advance may run on another pool thread: always use this thread's own detector session.
            job.session.detector = self.detector()
            if job.session.tiled is not None:
                job.session.tiled.base = job.session.detector

            def publish(progress: dict) -> None:
                try:
                    self.api.progress(rid, progress)
                except (
                    Exception
                ) as exc:  # display only; the final result is what settles
                    LOG.debug(
                        "live progress not delivered", round=rid, error=str(exc)[:200]
                    )

            for seg in fresh:
                job.session.feed(seg, on_progress=publish)
            if fresh:
                publish(job.session.progress())
            if coverage is not None and job.session.complete:
                self.jobs.pop(rid, None)
                self.finalize_round(job.cam, job.rnd, job.session.analysis(), coverage)
        except Exception as exc:
            self.jobs.pop(rid, None)
            LOG.exception("round processing failed", round=rid, stream=job.cam.id)
            profile_id = (job.rnd.get("countingRules") or {}).get("profileId")
            self.finish(
                rid,
                "invalid",
                f"processing_error: {type(exc).__name__}",
                {"profileId": profile_id, "worker": self.cfg.worker_name},
            )
        finally:
            self.inflight.pop(rid, None)

    def finalize_round(
        self, cam: Camera, rnd: dict, analysis: pipeline.RoundAnalysis, coverage
    ) -> None:
        rid = int(rnd["id"])
        rules = rnd.get("countingRules") or {}
        profile_id = rules.get("profileId")
        try:
            anchors = [s.anchor for s in coverage.segments if s.anchor]
            evidence = {
                "profileId": profile_id,
                "worker": self.cfg.worker_name,
                "model": self.cfg.model,
                "device": getattr(self.cfg, "device", "cpu"),
                "packages": _packages(),
                "sampleFps": self.cfg.sample_fps,
                "confThreshold": self.cfg.conf_threshold,
                "framesProcessed": analysis.frames,
                "expectedFrames": analysis.expected_frames,
                "detections": analysis.detections,
                "tracks": analysis.tracks,
                "rejectedWeakCrossings": analysis.rejected,
                "stitchedTracks": analysis.stitches,
                "mergedDuplicates": analysis.duplicates,
                "detectionCoverage": analysis.coverage,
                "frameSize": [analysis.width, analysis.height],
                "clock": {
                    "kind": "overlay_ocr",
                    "utcOffsetMinutes": (
                        anchors[0].utc_offset_minutes if anchors else None
                    ),
                    "anchorPrecisionMs": (
                        round(max(a.precision for a in anchors) * 1000, 1)
                        if anchors
                        else None
                    ),
                    "latencySeconds": (
                        round(sum(a.latency for a in anchors) / len(anchors), 2)
                        if anchors
                        else None
                    ),
                    "displayed": [a.displayed for a in anchors if a.source == "ocr"][
                        :8
                    ],
                },
                "coverage": coverage.evidence(),
                "crossings": [
                    c | {"at": round(c["at"], 3)} for c in analysis.crossings[:200]
                ],
                "timings": analysis.timings,
                "motion": analysis.motion,
                "qualityIssues": analysis.quality_issues,
            }
            outcome, reason = (
                "counted",
                f"Counted {analysis.count} vehicles crossing the published line automatically.",
            )
            problem = counting_problem(analysis)
            if problem:
                outcome, reason = "invalid", problem
            if analysis.frames < 0.9 * analysis.expected_frames:
                outcome, reason = "invalid", (
                    f"insufficient_frames: decoded {analysis.frames} of "
                    f"{analysis.expected_frames} expected sample frames."
                )
            within = (
                framing.compare(analysis.first_sig, analysis.last_sig)
                if analysis.first_sig and analysis.last_sig
                else None
            )
            framing_ev: dict = {"withinWindow": within.to_json() if within else None}
            if within is not None and not framing.stable(within):
                outcome, reason = (
                    "invalid",
                    "camera_moved: the view changed during the counting window.",
                )
            moved_vs_baseline = False
            with cam.lock:
                baseline = (
                    cam.baseline
                    if cam.baseline
                    and cam.baseline[0] == profile_id
                    and time.time() - cam.baseline[2] < BASELINE_MAX_AGE
                    else None
                )
                ref = (
                    baseline[1]
                    if baseline
                    else (
                        cam.reference_sig
                        if (cam.profile or {}).get("id") == profile_id
                        else None
                    )
                )
            if ref is not None and analysis.first_sig is not None:
                cmp = framing.compare(ref, analysis.first_sig)
                framing_ev["baseline"] = "previous_round" if baseline else "reference"
                framing_ev["vsBaseline"] = cmp.to_json()
                if framing.moved(cmp):
                    moved_vs_baseline = True
                    if outcome == "counted":
                        outcome, reason = "invalid", (
                            "camera_moved: the view differs from the frozen line's "
                            "reference; the line may no longer match the road."
                        )
            else:
                framing_ev["baseline"] = "none"
            framing_ev["stable"] = outcome == "counted"
            evidence["framing"] = framing_ev
            with cam.lock:
                if outcome == "counted" and analysis.last_sig is not None:
                    cam.baseline, cam.moved_streak = (
                        profile_id,
                        analysis.last_sig,
                        time.time(),
                    ), 0
                elif moved_vs_baseline:
                    cam.moved_streak += 1
                    if (
                        cam.moved_streak >= MOVED_STREAK_RECALIBRATE
                        and not cam.recalibrate
                    ):
                        cam.recalibrate = True
                        LOG.warning(
                            "camera moved repeatedly; recalibrating", stream=cam.id
                        )
            LOG.info(
                "round analysed",
                round=rid,
                stream=cam.id,
                outcome=outcome,
                count=analysis.count,
                frames=analysis.frames,
                ms_per_frame=analysis.timings["msPerFrame"],
                seconds=analysis.timings["totalSeconds"],
            )
            payload = {
                "outcome": outcome,
                "reason": reason,
                "worker": self.cfg.worker_name,
                "evidence": evidence,
            }
            if outcome == "counted":
                payload["vehicleCount"] = analysis.count
            self.post_result(rid, payload)
        except Exception as exc:
            LOG.exception("round processing failed", round=rid, stream=cam.id)
            self.finish(
                rid,
                "invalid",
                f"processing_error: {type(exc).__name__}",
                {"profileId": profile_id, "worker": self.cfg.worker_name},
            )

    def finish(self, rid: int, outcome: str, reason: str, evidence: dict) -> None:
        LOG.info(
            "round resolved without count" if outcome != "counted" else "round counted",
            round=rid,
            reason=reason,
        )
        self.post_result(
            rid,
            {
                "outcome": outcome,
                "reason": reason[:500],
                "worker": self.cfg.worker_name,
                "evidence": evidence,
            },
        )

    def post_result(self, rid: int, payload: dict) -> None:
        try:
            self.api.result(rid, payload)
            self.done[rid] = time.time()
            self.pending_results.pop(rid, None)
        except api_mod.Conflict:
            self.done[rid] = time.time()
            self.pending_results.pop(rid, None)
        except Exception as exc:
            self.pending_results[rid] = (
                payload  # retry on the next tick; never recount a resolved round
            )
            LOG.warning("result not delivered yet", round=rid, error=str(exc)[:200])

    # ---------- main loop ----------
    def run(self) -> None:
        LOG.info(
            "starting",
            worker=self.cfg.worker_name,
            fps=self.cfg.sample_fps,
            processors=self.cfg.processors,
        )
        self.detector()  # fail fast if the model is missing
        while not self.stop_event.is_set():
            try:
                if time.time() - self.last_streams > 60:
                    self.refresh_streams()
                    self.last_streams = time.time()
                for cam in list(self.cameras.values()):
                    self.manage_camera(cam)
                self.schedule_rounds()
                cutoff = time.time() - 3600
                self.done = {k: v for k, v in self.done.items() if v > cutoff}
            except Exception:
                LOG.exception("tick failed")
            self.stop_event.wait(self.cfg.poll_seconds)
        for cam in self.cameras.values():
            cam.fetcher.stop()
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.calibration_pool.shutdown(wait=False, cancel_futures=True)


_PKG_CACHE: dict | None = None


def _packages() -> dict:
    global _PKG_CACHE
    if _PKG_CACHE is None:
        from importlib import metadata

        _PKG_CACHE = {}
        for name in (
            "onnxruntime",
            "onnxruntime-gpu",
            "trackers",
            "supervision",
            "rfdetr",
            "av",
            "pytesseract",
        ):
            try:
                _PKG_CACHE[name] = metadata.version(name)
            except metadata.PackageNotFoundError:
                pass
    return _PKG_CACHE


def _ts(value: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def main() -> None:
    cfg = config_mod.load()
    cv2.setNumThreads(1)
    log.setup(cfg.log_level)
    counter = Counter(cfg)
    signal.signal(signal.SIGTERM, lambda *_: counter.stop_event.set())
    signal.signal(signal.SIGINT, lambda *_: counter.stop_event.set())
    counter.run()
