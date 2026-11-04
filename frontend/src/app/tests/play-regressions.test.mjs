import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const output = new URL(`.play-regressions-${process.pid}.mjs`, import.meta.url);
const bundle = await build({
  stdin: { contents: `export * from './services/play-logic'; export * from './services/camera-sources';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false
});
await writeFile(output, bundle.outputFiles[0].text);
const logic = await import(output.href);
await unlink(output);

const iso = (ms) => new Date(ms).toISOString();
const now = Date.parse('2026-11-01T16:00:00Z');
const round = (extra = {}) => ({ marketId: 7, streamId: 1, status: 'open', threshold: 8, windowStart: iso(now + 30_000), windowEnd: iso(now + 60_000), live: null, ...extra });
const at = (offset) => (now + offset) / 1000;

test('ready-made and exact choices read naturally', () => {
  assert.equal(logic.rangeLabel({ rangeMin: 0, rangeMax: 2 }), '0–2');
  assert.equal(logic.rangeLabel({ rangeMin: 9, rangeMax: 9 }), '9');
  assert.equal(logic.rangeLabel({ rangeMin: 13, rangeMax: logic.OPEN_ENDED_MAX }), '13+');
  assert.equal(logic.payoutFor(25, 3.79), 95);
  assert.equal(logic.payoutFor(25, 1.55), 39);
  assert.equal(logic.mmss(65.2), '1:06');
  assert.equal(logic.mmss(-3), '0:00');
});

test('only AI-countable cameras and rounds with enough entry time are offered', () => {
  const streams = [
    { id: 1, isActive: true, streamType: 'hls' },
    { id: 2, isActive: true, streamType: 'hls', automationPause: 'Waiting for automatic calibration.' },
    { id: 3, isActive: false, streamType: 'hls' },
    { id: 4, isActive: true, streamType: 'youtube' }
  ];
  assert.deepEqual(logic.playableStreams(streams).map((s) => s.id), [1]);
  const market = (id, closesIn, mode = 'versioned', status = 'open') => ({ id, status, bettingClosesAt: iso(now + closesIn), countingRules: { mode } });
  assert.equal(logic.pickMarket([market(1, 5_000), market(2, 70_000), market(3, 40_000)], now).id, 3, 'nearest round with at least 12 s left');
  assert.equal(logic.pickMarket([market(4, 40_000, 'legacy_manual')], now), undefined, 'rounds without a frozen AI line are skipped');
  assert.equal(logic.pickMarket([market(5, 40_000, 'versioned', 'void')], now), undefined);
  assert.equal(logic.randomItem([1, 2, 3], () => 0.99), 3);
  assert.equal(logic.randomItem([], () => 0.5), undefined);
});

test('the live count follows the frame on screen, not the analysis', () => {
  const live = { vehicleCount: 3, crossings: [{ at: at(32_000) }, { at: at(40_000) }, { at: at(55_000) }], segments: [{ seq: 10, startUtc: at(28_000), duration: 12 }], processedUntil: at(60_000), updatedAt: iso(now) };
  const r = round({ live });
  assert.equal(logic.livePhase(r, at(29_000), now + 50_000), 'syncing', 'a delayed frame must not extend the scheduled countdown');
  assert.equal(logic.liveCount(r, at(29_000)), 0);
  assert.equal(logic.livePhase(r, at(41_000), now + 70_000), 'counting');
  assert.equal(logic.liveCount(r, at(41_000)), 2, 'only crossings already shown are counted');
  assert.equal(logic.livePhase(r, at(61_000), now + 90_000), 'checking');
  assert.equal(logic.liveCount(r, null), 3, 'without a video clock the latest analysed count is shown');
  assert.equal(logic.livePhase(r, null, now + 40_000), 'counting', 'wall-clock fallback');
});

test('the 30-second safety interval ends on schedule despite a delayed live feed', () => {
  const r = round();
  // Fast-forward the complete interval without sleeping or modifying a live schedule.
  for (const elapsed of [0, 10_000, 29_999]) {
    assert.equal(logic.livePhase(r, at(elapsed - 45_000), now + elapsed), 'waiting');
  }
  assert.equal(logic.livePhase(r, at(-15_000), now + 30_000), 'syncing');
  assert.equal(logic.livePhase(r, at(30_000), now + 75_000), 'counting');
  assert.equal(logic.livePhase(r, at(35_000), now + 20_000), 'waiting', 'a clock-ahead frame cannot start the round early');
});

test('a settled result is revealed when the video has shown the whole window', () => {
  const settled = round({ status: 'settled', actualCount: 9 });
  assert.equal(logic.livePhase(settled, at(50_000), now + 80_000), 'counting', 'no spoiler before the window ends on screen');
  assert.equal(logic.livePhase(settled, at(60_500), now + 80_000), 'result');
  assert.equal(logic.livePhase(settled, at(40_000), now + 151_000), 'result', 'revealed at the latest 90 s after the window');
  assert.equal(logic.livePhase(settled, null, now + 61_000), 'result');
  assert.equal(logic.liveCount(settled, null), 9);
  assert.equal(logic.livePhase(round({ status: 'void' }), at(10_000), now), 'result', 'refunds are shown at once');
});

test('the HUD says the AI is catching up instead of showing a confident count', () => {
  const live = { vehicleCount: 1, crossings: [{ at: at(32_000) }], segments: [{ seq: 10, startUtc: at(28_000), duration: 12 }], processedUntil: at(40_000), updatedAt: iso(now) };
  assert.equal(logic.aiBehind(round({ live }), at(38_000), now, 'counting'), false, 'analysis is ahead of the video');
  assert.equal(logic.aiBehind(round({ live }), at(45_000), now, 'counting'), true, 'video shows a moment not analysed yet');
  assert.equal(logic.aiBehind(round(), at(35_000), now, 'counting'), true, 'no live data at all yet');
  assert.equal(logic.aiBehind(round({ live }), at(45_000), now, 'waiting'), false);
  assert.equal(logic.aiBehind(round({ live, status: 'settled', actualCount: 3 }), at(45_000), now, 'checking'), false);
  assert.equal(logic.aiBehind(round({ live: { ...live, processedUntil: at(60_000) } }), at(70_000), now, 'checking'), false, 'whole window analysed');
});


test('counted vehicle pulses last half a second after the crossing in capture time', () => {
  const box={trackId:7,x:.1,y:.2,width:.1,height:.2};
  const crossings=[{trackId:7,at:10,direction:'A_to_B',class:'car'}];
  const frames=[{at:9.9,boxes:[box]},{at:10,boxes:[box]},{at:10.2,boxes:[{...box,x:.3}]},{at:10.4,boxes:[box]},{at:10.8,boxes:[box]}];
  const get=(at)=>logic.countedVehicleBoxes(frames,at,crossings);
  assert.equal(get(null).length,0);
  assert.equal(get(9.99).length,0);
  assert.equal(get(10).length,1);
  assert.ok(Math.abs(get(10.1)[0].x-.2)<1e-6);
  assert.equal(get(10.4999).length,1);
  assert.equal(get(10.5).length,0);
  assert.equal(get(10.8).length,0,'later observations must not restart the pulse');
  assert.equal(get(20).length,0);
  assert.equal(logic.countedVehicleBoxes(frames,10,[]).length,0);
  assert.equal(logic.countedVehicleBoxes([{at:10,boxes:[{...box,width:2}]}],10,crossings).length,0);
});

test('highlight expiry is per vehicle and cannot interpolate across missing observations', () => {
  const a={trackId:1,x:.1,y:.2,width:.1,height:.2},b={...a,trackId:2};
  const crossings=[{trackId:1,at:10},{trackId:2,at:10.4}];
  const frames=[{at:10.4,boxes:[a,b]},{at:10.6,boxes:[a,b]}];
  assert.deepEqual(logic.countedVehicleBoxes(frames,10.6,crossings).map(b=>b.trackId),[2]);
  assert.equal(logic.countedVehicleBoxes(frames,10.9,crossings).length,0);
  assert.equal(logic.countedVehicleBoxes([{at:10,boxes:[a]},{at:10.5,boxes:[a]}],10.3,crossings).length,0);
});


test('duplicate camera sources do not create repeated cards or random-selection weight', () => {
  const streams=[
    {id:45,countingGuide:{sourceFingerprint:'same'},streamUrl:'/api/media/streams/45/index.m3u8'},
    {id:99,countingGuide:{sourceFingerprint:'same'},streamUrl:'/api/media/streams/99/index.m3u8'},
    {id:50,sourcePageUrl:'https://provider.example/camera/50'},
    {id:98,sourcePageUrl:'https://provider.example/camera/50'},
    {id:51,sourcePageUrl:'https://provider.example/camera/51'},
    {id:52},{id:53}
  ];
  assert.deepEqual(logic.uniqueCameraSources(streams).map(s=>s.id),[45,50,51,52,53]);
  assert.equal(streams.length,7,'deduplication must not mutate admin history');
});
