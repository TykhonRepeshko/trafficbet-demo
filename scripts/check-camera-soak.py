"""Observe live camera HLS through the application gateway, without a browser.

Run from the project root with the bundled Python and PyAV in .tools/video-qa.
Evidence contains only public camera data and local gateway resource handles.
"""

import argparse
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.abspath('.tools/video-qa'))
import av


def utc():
    return datetime.now(timezone.utc).isoformat()


def resource_lines(body):
    return [line.strip() for line in body.decode('utf-8').splitlines()
            if line.strip() and not line.startswith('#')]


def save_frame(frame, path):
    with av.open(str(path), 'w', format='image2') as output:
        stream = output.add_stream('png', rate=1)
        stream.width, stream.height = frame.width, frame.height
        stream.pix_fmt = 'rgb24'
        for packet in stream.encode(frame.reformat(format='rgb24')):
            output.mux(packet)
        for packet in stream.encode(None):
            output.mux(packet)


def framing_array(frame):
    """Small grayscale background view with timestamp/edge borders excluded."""
    import numpy as np
    gray = frame.reformat(width=256, height=144, format='gray').to_ndarray().astype(np.float32)
    return gray[12:126, 13:243]


def framing_metrics(reference, current):
    """QA measurements, not a calibrated camera-motion or counting detector."""
    import numpy as np

    def correlation(a, b):
        a, b = a - a.mean(), b - b.mean()
        scale = float(np.linalg.norm(a) * np.linalg.norm(b))
        return float(np.sum(a * b) / scale) if scale > 1e-9 else 0.0

    reference_gradient = np.hypot(*np.gradient(reference))
    current_gradient = np.hypot(*np.gradient(current))
    window = np.outer(np.hanning(reference.shape[0]), np.hanning(reference.shape[1]))
    a = np.fft.rfft2((reference - reference.mean()) * window)
    b = np.fft.rfft2((current - current.mean()) * window)
    cross = a * np.conj(b)
    cross /= np.maximum(np.abs(cross), 1e-9)
    phase = np.fft.irfft2(cross, s=reference.shape)
    y, x = np.unravel_index(np.argmax(phase), phase.shape)
    if x > reference.shape[1] // 2:
        x -= reference.shape[1]
    if y > reference.shape[0] // 2:
        y -= reference.shape[0]
    return {'grayCorrelation': round(correlation(reference, current), 6),
            'gradientCorrelation': round(correlation(reference_gradient, current_gradient), 6),
            'alignmentShiftX': int(x), 'alignmentShiftY': int(y),
            'phasePeak': round(float(phase.max()), 6)}


def analyze_evidence(folder):
    """Derive observable transport and coverage facts; this is not browser QoE."""
    summary_path = folder / 'summary.json'
    summary = json.loads(summary_path.read_text(encoding='utf-8'))
    events = [json.loads(line) for line in (folder / 'events.jsonl').read_text(encoding='utf-8').splitlines() if line]
    decoded = [row for row in events if row['kind'] == 'decoded_segment']
    requests = [row for row in events if row['kind'] in ('request_success', 'request_error')]
    missing_sequences = []
    pts_gaps = []
    for previous, current in zip(decoded, decoded[1:]):
        if current['sequence'] > previous['sequence'] + 1:
            missing_sequences.extend(range(previous['sequence'] + 1, current['sequence']))
        if current['firstPTS'] is not None and previous['lastPTS'] is not None:
            gap = current['firstPTS'] - previous['lastPTS']
            if gap > 0.5:
                pts_gaps.append({'afterSequence': previous['sequence'], 'beforeSequence': current['sequence'],
                                 'seconds': round(gap, 3)})
    errors_by_resource = {}
    for row in requests:
        if row['kind'] == 'request_error':
            kind = row['resourceKind']
            errors_by_resource[kind] = errors_by_resource.get(kind, 0) + 1
    summary['successfulHTTPRequests'] = sum(row['kind'] == 'request_success' for row in requests)
    summary['errorsByResource'] = errors_by_resource
    summary['missingDecodedSequenceCount'] = len(set(missing_sequences))
    summary['missingDecodedSequences'] = sorted(set(missing_sequences))
    summary['observedPTSGapsOverHalfSecond'] = pts_gaps
    summary['maximumObservedPTSGapSeconds'] = max([row['seconds'] for row in pts_gaps], default=0)
    summary['completeFrameCoverageProven'] = False
    summary['browserRenderingTested'] = False
    framing = [row for row in events if row['kind'] == 'framing_sample']
    if framing:
        summary['framingSamples'] = len(framing)
        summary['framingCandidates'] = sum(row['candidate'] for row in framing)
        summary['minimumReferenceGradientCorrelation'] = min(row['reference']['gradientCorrelation'] for row in framing)
        summary['minimumPreviousGradientCorrelation'] = min(row['previous']['gradientCorrelation'] for row in framing)
        summary['maximumReferenceAlignmentShiftPixels'] = max(max(abs(row['reference']['alignmentShiftX']), abs(row['reference']['alignmentShiftY'])) for row in framing)
    summary_path.write_text(json.dumps(summary, indent=2), encoding='utf-8')
    return summary


def observe(camera, args):
    folder = Path(args.output) / str(camera)
    folder.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    summary = {
        'camera': camera, 'startedUTC': utc(), 'requestedSeconds': args.seconds,
        'playlistSuccesses': 0, 'segmentSuccesses': 0, 'decodedSegments': 0,
        'decodedFrames': 0, 'requestErrors': 0, 'retryRecoveries': 0,
        'terminalRequestFailures': 0, 'masterRefreshes': 0, 'endlistSeen': False,
        'sequenceAdvances': 0, 'sequenceRegressions': 0, 'ptsRegressions': 0,
        'longestNewSegmentGapSeconds': 0.0, 'maximumRequestSeconds': 0.0,
        'errorsByKind': {}, 'snapshots': [],
    }
    if args.check_framing:
        summary.update({'framingSamples': 0, 'framingCandidates': 0, 'framingFlaggedSnapshots': [],
                        'framingSampleIntervalPTSSeconds': 2, 'framingMeasurementResolution': '256x144, crop x13:243/y12:126'})
    seen = set()
    last_sequence = None
    last_pts = None
    last_new_segment = None
    last_frame = None
    last_snapshot = -999.0
    fixed_child = None
    next_poll = started
    next_status = started
    reference_frame = None
    previous_frame = None
    last_framing_pts = None
    last_flagged_snapshot = -999.0

    with (folder / 'events.jsonl').open('a', encoding='utf-8', buffering=1) as events:
        def event(kind, **fields):
            row = {'utc': utc(), 'elapsedSeconds': round(time.monotonic() - started, 3),
                   'camera': camera, 'kind': kind, **fields}
            events.write(json.dumps(row) + '\n')

        def persist():
            summary['elapsedSeconds'] = round(time.monotonic() - started, 3)
            (folder / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')

        def get(path, kind):
            url = urllib.parse.urljoin(args.root, path)
            if urllib.parse.urlparse(url).netloc != urllib.parse.urlparse(args.root).netloc:
                raise ValueError('Gateway returned a resource outside the application origin')
            for attempt, delay in enumerate((0, 1, 3, 5)):
                if delay:
                    time.sleep(delay)
                request_started = time.monotonic()
                try:
                    with urllib.request.urlopen(url, timeout=12) as response:
                        body = response.read(24 * 1024 * 1024)
                        status = response.status
                    request_seconds = time.monotonic() - request_started
                    summary['maximumRequestSeconds'] = max(summary['maximumRequestSeconds'], round(request_seconds, 3))
                    event('request_success', resourceKind=kind, attempt=attempt + 1,
                          status=status, bytes=len(body), requestSeconds=round(request_seconds, 3))
                    if attempt:
                        summary['retryRecoveries'] += 1
                    return body
                except Exception as error:
                    status = error.code if isinstance(error, urllib.error.HTTPError) else None
                    error_kind = 'HTTP ' + str(status) if status else type(error).__name__
                    gateway_code = None
                    if isinstance(error, urllib.error.HTTPError):
                        try:
                            candidate = json.loads(error.read(4096)).get('error', {}).get('code')
                            if isinstance(candidate, str) and re.fullmatch(r'[a-z_]{1,64}', candidate):
                                gateway_code = candidate
                        except (ValueError, AttributeError, OSError):
                            pass
                    summary['requestErrors'] += 1
                    summary['errorsByKind'][error_kind] = summary['errorsByKind'].get(error_kind, 0) + 1
                    event('request_error', resourceKind=kind, attempt=attempt + 1,
                          status=status, errorKind=error_kind, gatewayCode=gateway_code,
                          requestSeconds=round(time.monotonic() - request_started, 3))
                    if attempt == 3:
                        summary['terminalRequestFailures'] += 1
                        raise

        def load_child():
            body = get(f'/api/media/streams/{camera}/index.m3u8', 'master')
            resources = resource_lines(body)
            if not resources:
                raise ValueError('Master playlist has no resources')
            if '#EXT-X-STREAM-INF:' not in body.decode('utf-8'):
                return f'/api/media/streams/{camera}/index.m3u8'
            return resources[0]

        event('started', requestedSeconds=args.seconds)
        while time.monotonic() - started < args.seconds:
            wait = next_poll - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            next_poll = max(next_poll + args.interval, time.monotonic())
            try:
                if fixed_child is None:
                    fixed_child = load_child()
                    summary.setdefault('firstChildHandleSHA256', hashlib.sha256(fixed_child.encode()).hexdigest())
                    summary['currentChildHandleSHA256'] = hashlib.sha256(fixed_child.encode()).hexdigest()
                    event('child_selected', handleSHA256=summary['currentChildHandleSHA256'])
                body = get(fixed_child, 'playlist')
                playlist = body.decode('utf-8')
                summary['playlistSuccesses'] += 1
                (folder / 'latest.m3u8').write_text(playlist, encoding='utf-8')
                sequence_match = re.search(r'#EXT-X-MEDIA-SEQUENCE:(\d+)', playlist)
                if sequence_match is None:
                    raise ValueError('Live playlist has no media sequence')
                sequence = int(sequence_match.group(1))
                summary.setdefault('firstSequence', sequence)
                summary['lastSequence'] = sequence
                if last_sequence is not None:
                    if sequence > last_sequence:
                        summary['sequenceAdvances'] += 1
                    elif sequence < last_sequence:
                        summary['sequenceRegressions'] += 1
                last_sequence = sequence
                ended = '#EXT-X-ENDLIST' in playlist or '#EXT-X-PLAYLIST-TYPE:VOD' in playlist
                summary['endlistSeen'] = summary['endlistSeen'] or ended
                resources = resource_lines(body)
                event('playlist', sequence=sequence, segments=len(resources), endlist=ended,
                      targetDuration=re.search(r'#EXT-X-TARGETDURATION:(\d+)', playlist).group(1))
                for index, segment_path in enumerate(resources):
                    segment_id = hashlib.sha256(segment_path.encode()).hexdigest()
                    if segment_id in seen:
                        continue
                    segment = get(segment_path, 'segment')
                    summary['segmentSuccesses'] += 1
                    frame_count = 0
                    first_pts = None
                    final_pts = None
                    with av.open(io.BytesIO(segment)) as container:
                        for frame in container.decode(video=0):
                            point = float(frame.pts * frame.time_base) if frame.pts is not None else None
                            if first_pts is None:
                                first_pts = point
                            final_pts = point
                            last_frame = frame
                            frame_count += 1
                            if args.check_framing and (last_framing_pts is None or point is None or point < last_framing_pts or point - last_framing_pts >= 2):
                                small = framing_array(frame)
                                if reference_frame is None:
                                    reference_frame = small
                                    previous_frame = small
                                ref_metrics = framing_metrics(reference_frame, small)
                                prev_metrics = framing_metrics(previous_frame, small)
                                candidate = ((ref_metrics['gradientCorrelation'] < 0.45 and prev_metrics['gradientCorrelation'] < 0.60)
                                             or (max(abs(ref_metrics['alignmentShiftX']), abs(ref_metrics['alignmentShiftY'])) > 4 and ref_metrics['phasePeak'] > 0.08))
                                summary['framingSamples'] += 1
                                summary['framingCandidates'] += int(candidate)
                                event('framing_sample', pts=point, reference=ref_metrics, previous=prev_metrics,
                                      candidate=bool(candidate), segmentSequence=sequence + index)
                                elapsed = time.monotonic() - started
                                if candidate and elapsed - last_flagged_snapshot >= 30 and len(summary['framingFlaggedSnapshots']) < 12:
                                    name = f'framing-candidate-{int(elapsed):04d}.png'
                                    save_frame(frame, folder / name)
                                    summary['framingFlaggedSnapshots'].append(name)
                                    last_flagged_snapshot = elapsed
                                previous_frame = small
                                last_framing_pts = point
                    if frame_count == 0:
                        raise ValueError('Downloaded segment decoded no video frames')
                    now = time.monotonic()
                    if last_new_segment is not None:
                        summary['longestNewSegmentGapSeconds'] = max(
                            summary['longestNewSegmentGapSeconds'], round(now - last_new_segment, 3))
                    last_new_segment = now
                    if last_pts is not None and final_pts is not None and final_pts < last_pts:
                        summary['ptsRegressions'] += 1
                    last_pts = final_pts
                    summary.setdefault('firstPTS', first_pts)
                    summary['lastPTS'] = final_pts
                    summary['decodedSegments'] += 1
                    summary['decodedFrames'] += frame_count
                    summary['lastDecodedUTC'] = utc()
                    seen.add(segment_id)
                    event('decoded_segment', sequence=sequence + index, bytes=len(segment),
                          sha256=hashlib.sha256(segment).hexdigest(),
                          frames=frame_count, firstPTS=first_pts, lastPTS=final_pts)
                    elapsed = now - started
                    if elapsed - last_snapshot >= args.snapshot_interval:
                        name = f'frame-{int(elapsed):04d}.png'
                        save_frame(last_frame, folder / name)
                        summary['snapshots'].append(name)
                        last_snapshot = elapsed
            except Exception as error:
                status = error.code if isinstance(error, urllib.error.HTTPError) else None
                event('poll_failed', errorKind=('HTTP ' + str(status) if status else type(error).__name__))
                if status in (404, 410):
                    fixed_child = None
                    summary['masterRefreshes'] += 1
            persist()
            if time.monotonic() >= next_status:
                print(json.dumps({'kind': 'progress', **summary}), flush=True)
                next_status = time.monotonic() + 30
        if last_frame is not None:
            save_frame(last_frame, folder / 'frame-final.png')
            summary['snapshots'].append('frame-final.png')
        summary['finishedUTC'] = utc()
        summary['sameChildHandleThroughout'] = summary.get('firstChildHandleSHA256') == summary.get('currentChildHandleSHA256') and summary['masterRefreshes'] == 0
        summary['elapsedSeconds'] = round(time.monotonic() - started, 3)
        if last_new_segment is not None:
            summary['tailWithoutNewSegmentSeconds'] = round(time.monotonic() - last_new_segment, 3)
        persist()
        event('finished', **summary)
        print(json.dumps({'kind': 'finished', **summary}), flush=True)
        return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='http://localhost:4200')
    parser.add_argument('--seconds', type=float, default=900)
    parser.add_argument('--interval', type=float, default=5)
    parser.add_argument('--snapshot-interval', type=float, default=300)
    parser.add_argument('--check-framing', action='store_true', help='Log experimental background/framing QA measurements with NumPy')
    parser.add_argument('--cameras', type=int, nargs='+', default=[35, 36, 37])
    parser.add_argument('--output', default='.tools/camera-soak-' + datetime.now(timezone.utc).strftime('%Y-%m-%dT%H%M%SZ'))
    parser.add_argument('--analyze-only', action='store_true', help='Summarize an existing run without making requests')
    args = parser.parse_args()
    if args.seconds <= 0 or args.interval <= 0 or args.snapshot_interval <= 0:
        parser.error('seconds, interval and snapshot-interval must be positive')
    if len(set(args.cameras)) != len(args.cameras) or any(camera <= 0 for camera in args.cameras):
        parser.error('camera IDs must be positive and unique')
    if not args.analyze_only and Path(args.output).exists() and any(Path(args.output).iterdir()):
        parser.error('output directory must be empty for a new observation; existing evidence is preserved')
    Path(args.output).mkdir(parents=True, exist_ok=True)
    if not args.analyze_only:
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(args.cameras)) as executor:
            list(executor.map(lambda camera: observe(camera, args), args.cameras))
    results = [analyze_evidence(Path(args.output, str(camera))) for camera in args.cameras]
    Path(args.output, 'summary.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps({'kind': 'analysis', 'cameras': results}), flush=True)


if __name__ == '__main__':
    main()
