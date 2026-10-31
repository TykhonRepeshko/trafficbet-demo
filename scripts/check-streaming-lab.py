"""Bounded receive-only public camera experiment; never a generic URL proxy.

The provider's 600-second presence interval is honored with an explicit stdin
continuation. No browser QoE or absolute capture-to-screen delay is inferred.
"""
import argparse, asyncio, hashlib, http.client, io, ipaddress, json, pathlib, re, socket, statistics, sys, threading, time
import urllib.request, urllib.parse
from datetime import datetime, timezone
sys.path.insert(0, str(pathlib.Path('.tools/rtc-qa').resolve()))
import av
from aiortc import RTCPeerConnection, RTCConfiguration, RTCSessionDescription, RTCRtpSender

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--seconds', type=int, default=960, help='30–1800 wall seconds; use at least 960 for the long observation')
parser.add_argument('--output', type=pathlib.Path, default=pathlib.Path('.tools/streaming-lab')/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
args = parser.parse_args()
if not 30 <= args.seconds <= 1800: parser.error('seconds must be between 30 and 1800')
ROOT = args.output.resolve()
if not ROOT.is_relative_to(pathlib.Path.cwd().resolve()): parser.error('output must be inside the project')
if ROOT.exists() and any(ROOT.iterdir()): parser.error('output directory must be new or empty')
ROOT.mkdir(parents=True, exist_ok=True)
ORIGIN = 'http://localhost:4200'
KEY = '5tYtr3zD'
HOSTS = {'rtsp.me', 'fn.rtsp.me'}
started = time.monotonic(); deadline = started + args.seconds
stop = threading.Event(); lock = threading.Lock()
rtc_hashes = {}; hls_hashes = {}; lags = []
stats = {'startedUTC': datetime.now(timezone.utc).isoformat(), 'requestedSeconds': args.seconds,
         'camera': 'Cala Bona harbour', 'scope': 'protocol experiment; unsuitable traffic-counting view',
         'rtcFrames': 0, 'rtcErrors': 0, 'rtcSessions': 0, 'rtcFrameGapsOver2s': 0, 'rtcMaxFrameGapSeconds': 0,
         'hlsRequests': 0, 'hlsRequestErrors': 0, 'hlsSegments': 0, 'hlsDecodedFrames': 0,
         'hlsMissingSequences': 0, 'hlsEndlist': False, 'exactMatchedFrames': 0, 'privateICECandidatesDiscarded': 0,
         'presenceContinuationRequired': args.seconds > 595, 'intentionalPresenceBreaks': [], 'rtcDecodedMediaSeconds': 0}

def event(kind, **values):
    row = {'elapsedSeconds': round(time.monotonic()-started, 3), 'kind': kind, **values}
    with lock:
        with (ROOT/'events.jsonl').open('a', encoding='utf-8') as f: f.write(json.dumps(row)+'\n')

def allowed(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme != 'https' or p.hostname not in HOSTS or p.port not in (None, 443) or p.username or p.fragment:
        raise ValueError('Rejected upstream')
    return url

class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        allowed(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def public_ip(value):
    address = ipaddress.ip_address(value)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped: address = address.ipv4_mapped
    return address.is_global and not any((address.is_private, address.is_loopback, address.is_link_local, address.is_multicast, address.is_reserved, address.is_unspecified))

class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        if self._tunnel_host: raise ValueError('Tunnels are disabled')
        addresses = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)
        if not addresses or len(addresses)>32 or not all(public_ip(a[4][0]) for a in addresses):
            raise ValueError('Non-public DNS answer rejected')
        last_error = None
        for address in addresses:
            sock = None
            try:
                sock = socket.create_connection((address[4][0], self.port), timeout=self.timeout)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
                return
            except OSError as e:
                if sock: sock.close()
                last_error = e
        raise last_error or OSError('Connection failed')

class PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req): return self.do_open(PinnedHTTPSConnection, req, context=self._context)

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), PinnedHTTPSHandler(), SafeRedirect())
def request(url, data=None, method=None):
    req = urllib.request.Request(allowed(url), data, method=method, headers={
        'Origin': ORIGIN, 'Content-Type': 'application/sdp' if data else 'application/json'})
    with opener.open(req, timeout=8) as r:
        body = r.read(20_000_001)
        if len(body)>20_000_000: raise ValueError('Oversized response')
        return body, r.headers

def get_stream():
    token = json.loads(request('https://rtsp.me/api/embed/'+KEY+'/token/')[0])
    assert token.get('status') == 'ok' and token.get('cam', {}).get('timerSec') == 600
    stream = json.loads(request(token['url'].rstrip('/')+'/token/'+token['token'])[0])
    allowed(stream['hls']); allowed(stream['webrtc'])
    return stream

def fingerprint(frame):
    return hashlib.sha256(frame.reformat(width=320, height=180, format='gray').to_ndarray().tobytes()).hexdigest()

def sample_frame(frame, protocol, arrival):
    digest = fingerprint(frame)
    hashes = rtc_hashes if protocol == 'rtc' else hls_hashes
    if digest not in hashes: hashes[digest] = [arrival-started, 1]
    else: hashes[digest][1] += 1

def hls(stream):
    base = stream['hls']; seen = set(); last_seq = None; first = True; first_pts = None; last_pts = None
    while not stop.is_set() and time.monotonic()<deadline:
        try:
            raw, _ = request(base); stats['hlsRequests'] += 1
            text = raw.decode(); assert text.startswith('#EXTM3U')
            if '#EXT-X-STREAM-INF' in text:
                base = urllib.parse.urljoin(base, next(l for l in text.splitlines() if l and not l.startswith('#')))
                allowed(base); continue
            stats['hlsTargetDuration'] = float(re.search(r'#EXT-X-TARGETDURATION:([\d.]+)', text)[1])
            stats['llHlsParts'] = '#EXT-X-PART:' in text
            stats['programDateTime'] = '#EXT-X-PROGRAM-DATE-TIME:' in text
            if '#EXT-X-ENDLIST' in text: stats['hlsEndlist'] = True
            seq = int(re.search(r'#EXT-X-MEDIA-SEQUENCE:(\d+)', text)[1])
            lines = [l.strip() for l in text.splitlines() if l.strip() and not l.startswith('#')]
            for index, line in enumerate(lines):
                n = seq + index
                if n in seen: continue
                payload, _ = request(urllib.parse.urljoin(base, line)); stats['hlsRequests'] += 1
                arrival = time.monotonic()
                if last_seq is not None and n > last_seq + 1: stats['hlsMissingSequences'] += n-last_seq-1
                with av.open(io.BytesIO(payload), format='mpegts') as media:
                    for frame in media.decode(video=0):
                        stats['hlsDecodedFrames'] += 1
                        sample_frame(frame, 'hls', arrival)
                        last_pts = float(frame.pts*frame.time_base)
                        if first:
                            stats['hlsFirstFrameSeconds'] = round(time.monotonic()-started, 3)
                            stats['hlsDimensions'] = [frame.width, frame.height]
                            frame.to_image().save(ROOT/'hls-first.jpg'); first = False; first_pts = last_pts
                seen.add(n); last_seq = n; stats['hlsSegments'] += 1
                event('hls_segment', sequence=n, frames=stats['hlsDecodedFrames'])
            stop.wait(1)
        except Exception as e:
            stats['hlsRequestErrors'] += 1; event('hls_error', error=type(e).__name__); stop.wait(2)
    stats['hlsMediaSpanSeconds'] = None if first_pts is None else round(last_pts-first_pts, 3)

async def rtc_session(stream, max_seconds):
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[])); resource = None; consumer = None
    stats['rtcSessions'] += 1; session_started = time.monotonic(); last_frame = None; snapshot_at = 0; first_pts = None; last_pts = None
    t = pc.addTransceiver('video', direction='recvonly')
    t.setCodecPreferences([c for c in RTCRtpSender.getCapabilities('video').codecs if c.mimeType.lower() == 'video/h264'])
    async def consume(track):
        nonlocal last_frame, snapshot_at, first_pts, last_pts
        while True:
            frame = await asyncio.wait_for(track.recv(), 12)
            now = time.monotonic()
            if last_frame:
                gap = now-last_frame; stats['rtcMaxFrameGapSeconds'] = max(stats['rtcMaxFrameGapSeconds'], gap)
                if gap>2: stats['rtcFrameGapsOver2s'] += 1; event('rtc_frame_gap', seconds=round(gap,3))
            last_frame = now; stats['rtcFrames'] += 1; sample_frame(frame, 'rtc', now)
            last_pts = float(frame.pts*frame.time_base)
            if first_pts is None: first_pts = last_pts
            if 'rtcFirstFrameSeconds' not in stats:
                stats['rtcFirstFrameSeconds'] = round(now-started, 3); stats['rtcDimensions'] = [frame.width, frame.height]
                frame.to_image().save(ROOT/'rtc-first.jpg'); event('rtc_first_frame')
            if now-snapshot_at>60:
                frame.to_image().save(ROOT/('rtc-'+str(int(now-started)).zfill(4)+'.jpg')); snapshot_at = now
    @pc.on('track')
    def on_track(track):
        nonlocal consumer
        if track.kind == 'video': consumer = asyncio.create_task(consume(track))
    @pc.on('connectionstatechange')
    async def state(): event('rtc_state', state=pc.connectionState)
    try:
        await pc.setLocalDescription(await pc.createOffer())
        raw, headers = await asyncio.to_thread(request, stream['webrtc'], pc.localDescription.sdp.encode())
        if headers.get('Location'): resource = allowed(urllib.parse.urljoin(stream['webrtc'], headers['Location']))
        answer = raw.decode(); safe = []; count = 0
        for line in answer.splitlines():
            if line.startswith('a=candidate:'):
                parts = line.split()
                try: ok = public_ip(parts[4])
                except ValueError: ok = False
                if not ok: stats['privateICECandidatesDiscarded'] += 1; continue
                count += 1
                if 'raddr' in parts: parts = parts[:parts.index('raddr')]
                line = ' '.join(parts)
            if line.startswith('c=IN IP'): line = 'c=IN IP4 0.0.0.0'
            if line.startswith('a=rtcp:'): line = 'a=rtcp:9 IN IP4 0.0.0.0'
            if line.startswith('a=remote-candidates:'): continue
            safe.append(line)
        assert count>0
        await pc.setRemoteDescription(RTCSessionDescription(sdp='\r\n'.join(safe)+'\r\n', type='answer'))
        while time.monotonic()-session_started<max_seconds and time.monotonic()<deadline:
            await asyncio.sleep(1)
            if consumer and consumer.done(): await consumer
            if pc.connectionState in ['failed', 'closed']: raise RuntimeError('Peer disconnected')
    finally:
        if first_pts is not None: stats['rtcDecodedMediaSeconds'] += last_pts-first_pts
        try:
            reports = await pc.getStats()
            event('rtc_receive_statistics', reports=[{k:v for k,v in vars(r).items() if k in ['packetsReceived','packetsLost','jitter','kind']} for r in reports.values() if r.type=='inbound-rtp'])
        except Exception: pass
        if consumer:
            consumer.cancel()
            await asyncio.gather(consumer, return_exceptions=True)
        await pc.close()
        if resource:
            try: await asyncio.to_thread(request, resource, None, 'DELETE')
            except Exception as e:
                code = getattr(e, 'code', None)
                # Closing the peer can remove the remote resource before DELETE.
                event('rtc_remote_session_absent' if code in (404, 410) else 'rtc_cleanup_failed', error=type(e).__name__, status=code)

async def main():
    global deadline
    stream = await asyncio.to_thread(get_stream)
    # The same published camera and media server are used in both receivers.
    thread = threading.Thread(target=hls, args=(stream,), daemon=True); thread.start()
    async def progress():
        while time.monotonic()<deadline:
            await asyncio.sleep(30)
            print(json.dumps({'elapsedSeconds':round(time.monotonic()-started,1),**stats}),flush=True)
    progress_task = asyncio.create_task(progress())
    try:
        while time.monotonic()<deadline:
            try: await rtc_session(stream, min(595,deadline-time.monotonic()))
            except Exception as e: stats['rtcErrors'] += 1;event('rtc_error',error=type(e).__name__)
            if time.monotonic()<deadline:
                before = time.monotonic(); print('PRESENCE CHECK: type continue to observe the remaining interval.',flush=True)
                reply = await asyncio.to_thread(input)
                stats['intentionalPresenceBreaks'].append({'startSeconds':round(before-started,3),'endSeconds':round(time.monotonic()-started,3)})
                if reply.strip() != 'continue': raise RuntimeError('Presence continuation declined')
                if time.monotonic()<deadline: stream = await asyncio.to_thread(get_stream)
    finally:
        stop.set(); await asyncio.to_thread(thread.join,10);progress_task.cancel()
        await asyncio.gather(progress_task,return_exceptions=True)
        stats['elapsedSeconds'] = round(time.monotonic()-started,3)
        stats['finishedUTC'] = datetime.now(timezone.utc).isoformat()
        stats['rtcMaxFrameGapSeconds'] = round(stats['rtcMaxFrameGapSeconds'],3)
        stats['rtcDecodedMediaSeconds'] = round(stats['rtcDecodedMediaSeconds'],3)
        shared = rtc_hashes.keys() & hls_hashes.keys()
        for digest in shared:
            if rtc_hashes[digest][1] == hls_hashes[digest][1] == 1:
                delta = hls_hashes[digest][0]-rtc_hashes[digest][0]
                if abs(delta)<120: lags.append(delta)
        stats['exactMatchedFrames'] = len(lags)
        stats['ambiguousFingerprintsExcluded'] = sum(1 for digest in shared if rtc_hashes[digest][1]>1 or hls_hashes[digest][1]>1)
        (ROOT/'frame-hashes.json').write_text(json.dumps({'rtc':rtc_hashes,'hls':hls_hashes}),encoding='utf-8')
        if lags:
            ordered = sorted(lags)
            stats['hlsMinusRtcArrivalSeconds'] = {'samples':len(lags),'min':round(min(lags),3),'median':round(statistics.median(lags),3),'p95':round(ordered[int((len(ordered)-1)*.95)],3),'max':round(max(lags),3)}
        stats['measurementLimit'] = 'Receiver startup and exact-frame arrival difference; excludes browser rendering and player buffer, and is not absolute capture-to-screen latency.'
        (ROOT/'summary.json').write_text(json.dumps(stats,indent=2),encoding='utf-8')
        print(json.dumps(stats),flush=True)

asyncio.run(main())
