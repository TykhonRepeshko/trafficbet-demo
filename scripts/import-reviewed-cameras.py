"""Install the six reviewed views and reversibly archive the previous catalog.

Run from this prepared checkout after scripts/start.ps1 -Local. The default is
a dry run; --apply uses audited admin APIs. Existing source settings, counting
profiles and completed history stay attached to their original camera IDs.
"""
import argparse
import datetime
import http.cookiejar
import json
from pathlib import Path
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'http://localhost:4200'
FIELDS = 'title city country locationLabel description streamType streamUrl thumbnailUrl sourceOwner sourcePageUrl termsUrl usageNotes latitude longitude isActive'.split()
SCHEDULE_FIELDS = 'enabled countingRule threshold oddsOver oddsUnder entrySeconds leadSeconds countingSeconds'.split()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    cameras = json.loads((ROOT / 'docs/reviewed-cameras-20261103.json').read_text(encoding='utf-8'))
    assert len(cameras) == 6 and len({c['streamUrl'] for c in cameras}) == 6
    assert all(c['isActive'] and c['streamUrl'].startswith('https://wzmedia.dot.ca.gov/D12/') for c in cameras)
    previous_urls = {c['streamUrl'] for c in json.loads((ROOT / 'backend/internal/app/camera_catalog.json').read_text(encoding='utf-8'))}
    new_urls = {c['streamUrl'] for c in cameras}
    settings = dict(line.split('=', 1) for line in (ROOT / '.env').read_text(encoding='utf-8-sig').splitlines() if '=' in line and not line.startswith('#'))
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(method, path, payload=None):
        assert path.startswith('/api/')
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(ORIGIN + path, data=data, method=method,
            headers={'Origin': ORIGIN, 'Content-Type': 'application/json'})
        try:
            with client.open(request, timeout=30) as response:
                raw = response.read(8 << 20)
            return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f'{method} {path}: HTTP {exc.code}: {exc.read(2048).decode()}') from None

    session = call('POST', '/api/auth/login', {'email': 'admin@example.com', 'password': settings['DEMO_ADMIN_PASSWORD']})
    settings.clear()
    assert session['user']['role'] == 'admin'
    try:
        before = call('GET', '/api/admin/streams')
        unexpected = [s['id'] for s in before if s['isActive'] and s['streamUrl'] not in previous_urls | new_urls]
        assert not unexpected, f'Unexpected active cameras require review: {unexpected}'
        old = [s for s in before if s['streamUrl'] in previous_urls - new_urls]
        old_ids = {s['id'] for s in old}
        schedules = call('GET', '/api/admin/round-schedules')['schedules']
        markets = [m for m in call('GET', '/api/admin/markets') if m['streamId'] in old_ids]
        if not args.apply:
            print(json.dumps({'dryRun': True, 'newViews': [c['title'] for c in cameras], 'archiveIds': sorted(s['id'] for s in old if s['isActive']), 'openRoundsToRefund': sum(m['status'] == 'open' for m in markets)}))
            return

        receipt_dir = ROOT / '.tools/camera-activation-20261103'
        receipt_dir.mkdir(exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        (receipt_dir / f'before-{stamp}.json').write_text(json.dumps({'streams': before, 'schedules': schedules, 'oldMarkets': markets}, ensure_ascii=False, indent=2), encoding='utf-8')
        added = []
        created_ids = set()
        for camera in cameras:
            existing = next((s for s in before if s['streamUrl'] == camera['streamUrl']), None)
            if existing:
                assert all(existing.get(k) == camera.get(k) for k in FIELDS if k != 'isActive'), f'Existing camera {existing["id"]} differs; refusing to overwrite settings'
                saved = existing if existing['isActive'] else call('PATCH', f'/api/admin/streams/{existing["id"]}/restore', {})
            else:
                saved = call('POST', '/api/admin/streams', camera)
                created_ids.add(saved['id'])
            # A new scene has no approved geometry. Viewing does not enable rounds.
            if not existing:
                call('PUT', f'/api/admin/round-schedules/{saved["id"]}', {
                    'enabled': False, 'countingRule': 'Vehicles crossing the reviewed line, both carriageways and directions',
                    'threshold': 30, 'oddsOver': 1.9, 'oddsUnder': 1.9,
                    'entrySeconds': 30, 'leadSeconds': 30, 'countingSeconds': 30})
            added.append({'id': saved['id'], 'title': saved['title'], 'url': f'{ORIGIN}/streams/{saved["id"]}'})

        archived = []
        for stream in old:
            if stream['isActive']:
                call('DELETE', f'/api/admin/streams/{stream["id"]}')
                archived.append(stream['id'])
        # Archiving first closes entry and prevents further schedule publication.
        refunded = []
        for market in call('GET', '/api/admin/markets'):
            if market['streamId'] in old_ids and market['status'] in ('open', 'draft'):
                call('PATCH', f'/api/admin/markets/{market["id"]}/void', {
                    'reason': 'Camera temporarily archived while new reviewed sources are tested; all pending stakes refunded.'})
                refunded.append(market['id'])

        after = call('GET', '/api/admin/streams')
        by_id = {s['id']: s for s in after}
        for stream in old:
            assert not by_id[stream['id']]['isActive']
            assert all(by_id[stream['id']][k] == stream[k] for k in FIELDS if k != 'isActive')
        after_schedules = {s['streamId']: s for s in call('GET', '/api/admin/round-schedules')['schedules']}
        for schedule in schedules:
            if schedule['streamId'] in old_ids:
                assert all(after_schedules[schedule['streamId']][k] == schedule[k] for k in SCHEDULE_FIELDS)
        assert all(not after_schedules[cid]['enabled'] for cid in created_ids)
        assert {s['streamUrl'] for s in after if s['isActive']} == new_urls
        public = call('GET', '/api/streams')
        assert {s['id'] for s in public} == {c['id'] for c in added}
        after_markets = {m['id']: m for m in call('GET', '/api/admin/markets')}
        assert all(after_markets[m['id']] == m for m in markets if m['status'] in ('settled', 'void'))
        result = {'activeCameras': added, 'archivedIds': archived, 'voidedRoundIds': refunded,
                  'oldSettingsPreserved': True, 'completedRoundHistoryPreserved': True, 'newRoundsEnabled': any(after_schedules[c['id']]['enabled'] for c in added)}
        (receipt_dir / f'result-{stamp}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False))
    finally:
        call('POST', '/api/auth/logout')


if __name__ == '__main__':
    main()
