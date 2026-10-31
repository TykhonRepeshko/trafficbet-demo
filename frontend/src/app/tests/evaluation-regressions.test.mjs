import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Subject } from 'rxjs';

const output = new URL(`.evaluation-${process.pid}.mjs`, import.meta.url);
// Controlled class/lifecycle fixtures: no browser navigation, DOM rendering or
// video decoding. The Angular production build separately checks this template.
const bundle = await build({ stdin: { contents: "export { EvaluationComponent } from './components/evaluation.component';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } } });
await writeFile(output, bundle.outputFiles[0].text);
const { EvaluationComponent } = await import(output.href);
await unlink(output);

function evidence(id = 1, status = 'ready') {
 return { id, streamId: 38, streamTitle: 'Real retained camera', profileId: 5, status, createdAt: '2026-10-20T12:00:00Z', requestedSeconds: 60, durationMs: 60000, clipSha256: 'a'.repeat(64), countingRules: { mode: 'versioned', profileId: 5, version: 2, referenceId: 10, sourceFingerprint: 'b'.repeat(64), intervalConvention: '[start,end)', publishedTitle: 'First allowed crossing', definition: { label: 'Saved source-specific rule', lineStart: { x: .1, y: .6 }, lineEnd: { x: .9, y: .6 }, directions: ['A_to_B'], classes: ['car', 'truck'], anchor: 'bottom_center', timeBasis: 'capture_utc', notes: 'Track each vehicle across the saved counting line only once.' } }, quality: { framesDecoded: true, relativeCoverageComplete: true, captureTimeTrusted: false, captureStart: null, timingBasis: 'media_relative', issues: ['capture_time_unverified'], segmentCount: 6, decodedFrames: 1500, firstPTS: 0, lastPTS: 59.96, missingSequences: [], ptsGaps: [], framingStatus: 'stable_sampled' } };
}
function harness() {
 const calls = [], timers = new Map(); let serial = 0;
 const oldWindow = globalThis.window, oldDocument = globalThis.document;
 globalThis.window = { setInterval: (fn) => { timers.set(++serial, fn); return serial; }, clearInterval: (id) => timers.delete(id) }; globalThis.document = { hidden: false };
 const request = (method, ...args) => { const response = new Subject(); calls.push({ method, args, response }); return response; };
 const injector = createEnvironmentInjector([{ provide: HttpClient, useValue: { get: (...args) => request('GET', ...args), post: (...args) => request('POST', ...args) } }]);
 const component = runInInjectionContext(injector, () => new EvaluationComponent());
 let paused = 0, loaded = 0, removed = 0, played = 0;
 const video = { currentTime: 0, duration: 60, playbackRate: 1, paused: true, pause: () => { paused++; video.paused = true; }, play: () => { played++; video.paused = false; return Promise.resolve(); }, load: () => loaded++, removeAttribute: (name) => { assert.equal(name, 'src'); removed++; } };
 component.video = { nativeElement: video };
 return { component, calls, timers, video, stats: () => ({ paused, loaded, removed, played }), by: (suffix) => calls.findLast((call) => call.args[0].endsWith(suffix)), destroy: () => { component.ngOnDestroy(); injector.destroy(); globalThis.window = oldWindow; globalThis.document = oldDocument; } };
}
function notes(component) { component.draft.timingEvidence = 'Only clip-relative media timing is known; camera UTC remains unverified.'; component.draft.note = 'Manually inspected the retained footage and recorded first allowed vehicle crossings.'; }

test('loads private evidence independently from history; polling stops on exit', () => {
 const h = harness(); try {
  h.component.ngOnInit(); assert.equal(h.calls.length, 3); assert.equal(h.timers.size, 1);
  for (const call of h.calls) assert.equal(call.args[1].withCredentials, true);
  h.by('/admin/source-health').response.next({ cameras: [{ streamId: 38, isActive: true }, { streamId: 39, isActive: false }] }); assert.deepEqual(h.component.captureCameras.map((item) => item.streamId), [38]);
  h.by('/admin/video-evidence').response.next({ items: [evidence()], hasMore: false });
  assert.ok(h.by('/admin/video-evidence/1')); h.by('/admin/video-evidence/1').response.next(evidence());
  assert.equal(h.component.selected.id, 1); assert.equal(h.component.metadataReady, false); assert.equal(h.component.selected.quality.captureStart, null); assert.equal(h.component.selected.quality.captureTimeTrusted, false);
  assert.equal(h.component.clipURL(), '/api/admin/video-evidence/1/clip.mp4'); assert.equal('captureStart' in h.component.draft, false);
  const oldCalls = h.calls.length; [...h.timers.values()][0](); assert.equal(h.calls.length, oldCalls, 'ready evidence does not poll continuously');
  h.component.evidenceItems.push(evidence(2, 'capturing')); [...h.timers.values()][0](); assert.equal(h.calls.length, oldCalls + 1);
 } finally { h.destroy(); }
 assert.equal(h.timers.size, 0); assert.ok(h.calls.every((call) => !call.response.observed)); assert.ok(h.stats().removed > 0);
});

test('late detail responses cannot cross camera selection; unsaved drafts stay isolated in memory', () => {
 const h = harness(); try {
  h.component.openEvidence(1); const old = h.calls.at(-1); h.component.openEvidence(2); assert.equal(old.response.observed, false); old.response.next(evidence(1)); assert.equal(h.component.selected, undefined);
  h.calls.at(-1).response.next(evidence(2)); h.component.draft.note = 'Private draft for the second clip.'; h.component.changed();
  h.component.openEvidence(3); h.calls.at(-1).response.next(evidence(3)); assert.equal(h.component.draft.note, '');
  h.component.openEvidence(2); h.calls.at(-1).response.next(evidence(2)); assert.equal(h.component.draft.note, 'Private draft for the second clip.'); assert.equal(h.component.dirty, true);
  h.component.resetDraft(); assert.equal(h.component.draft.note, ''); assert.equal(h.component.dirty, false);
 } finally { h.destroy(); }
});

test('matching draft rules permit calibration, while old sources and stale profile reads are excluded', () => {
 const h = harness(); try {
  h.component.selectCaptureCamera(38); const old = h.calls.at(-1); h.component.selectCaptureCamera(39); assert.equal(old.response.observed, false);
  old.response.next({ profiles: [{ id: 1, sourceMatches: true }] }); assert.deepEqual(h.component.captureProfiles, []);
  h.calls.at(-1).response.next({ profiles: [{ id: 5, sourceMatches: true, approved: false }, { id: 6, sourceMatches: false, approved: true }] }); assert.deepEqual(h.component.captureProfiles.map((item) => item.id), [5]); assert.equal(h.component.captureProfileId, 5);
  h.component.captureSeconds = 30.5; h.component.capture(); assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0);
  h.component.captureSeconds = 30; h.component.capture(); h.component.capture(); const post = h.calls.at(-1); assert.equal(post.method, 'POST'); assert.deepEqual(post.args, ['/api/admin/video-evidence', { streamId: 39, profileId: 5, durationSeconds: 30 }, { withCredentials: true }]);
  post.response.next({ id: 77 }); assert.equal(h.component.busy, false); assert.ok(h.by('/admin/video-evidence/77'));
 } finally { h.destroy(); }
});

test('crossings use the paused retained clip position, unique tracks and an excluded end', () => {
 const h = harness(); try {
  h.component.selected = evidence(); h.component.metadataLoaded(); h.video.currentTime = 12.345; h.component.nextTrack = '  vehicle-A  '; h.component.addCrossing();
  assert.deepEqual(h.component.draft.crossings, [{ track: 'vehicle-A', offsetMs: 12345, direction: 'A_to_B', class: 'car', uncertain: false }]); assert.equal(h.video.paused, true); assert.equal(h.component.dirty, true);
  h.component.nextTrack = 'vehicle-A'; h.component.addCrossing(); assert.equal(h.component.draft.crossings.length, 1); assert.match(h.component.error, /unique track label/);
  h.component.nextTrack = 'vehicle-B'; h.video.currentTime = 60; h.component.addCrossing(); assert.equal(h.component.draft.crossings.length, 1); assert.match(h.component.error, /excluded end/);
  h.video.currentTime = 0; h.component.nextUncertain = true; h.component.nextClass = 'unknown'; h.component.addCrossing(); assert.equal(h.component.draft.crossings[1].offsetMs, 0); assert.equal(h.component.uncertainCount, 1);
  assert.equal(h.calls.length, 0, 'marking a crossing never submits or settles anything');
 } finally { h.destroy(); }
});

test('seek controls stay within the clip, pause playback and do not hijack form keyboard input', async () => {
 const h = harness(); try {
  h.component.selected = evidence(); h.component.metadataLoaded(); h.component.seekTo(90000); assert.equal(h.video.currentTime, 59.999); h.component.seek(-100); assert.equal(h.video.currentTime, 0);
  let prevented = 0; const key = (value, extras = {}) => ({ key: value, target: { tagName: 'DIV' }, preventDefault: () => prevented++, ...extras });
  h.component.playerKey(key('ArrowRight', { target: { tagName: 'INPUT' } })); assert.equal(h.video.currentTime, 0); assert.equal(prevented, 0);
  h.component.playerKey(key('ArrowRight')); assert.equal(h.video.currentTime, .1); h.component.playerKey(key('ArrowRight', { shiftKey: true })); assert.equal(h.video.currentTime, 1.1);
  h.component.playerKey(key(' ', { ctrlKey: true })); assert.equal(h.stats().played, 0); h.component.playerKey(key(' ')); assert.equal(h.stats().played, 1); h.component.playerKey(key(' ')); assert.equal(h.video.paused, true);
  h.component.setPlaybackRate(.25); assert.equal(h.video.playbackRate, .25); h.component.setPlaybackRate(9); assert.equal(h.video.playbackRate, .25);
  await Promise.resolve();
 } finally { h.destroy(); }
});

test('a rejected old play request cannot disable a newer clip or a retried player', async () => {
 const h = harness(); try {
  const space = { key: ' ', target: { tagName: 'DIV' }, preventDefault: () => {} };
  let rejectOld;
  h.video.play = () => new Promise((_resolve, reject) => rejectOld = reject);
  h.component.selected = evidence(1); h.component.metadataLoaded(); h.component.playerKey(space);
  h.component.openEvidence(2); h.calls.at(-1).response.next(evidence(2));
  const newVideo = { ...h.video, paused: true }; h.component.video = { nativeElement: newVideo }; h.component.metadataLoaded();
  rejectOld(new Error('old element was removed')); await Promise.resolve(); assert.equal(h.component.videoError, ''); assert.equal(h.component.metadataReady, true);
  let rejectBeforeRetry;
  newVideo.play = () => new Promise((_resolve, reject) => rejectBeforeRetry = reject); h.component.playerKey(space); h.component.retryPlayer(); h.component.metadataLoaded();
  rejectBeforeRetry(new Error('old load was cancelled')); await Promise.resolve(); assert.equal(h.component.videoError, ''); assert.equal(h.component.metadataReady, true);
  newVideo.play = () => Promise.reject(new Error('current playback failed')); h.component.playerKey(space); await Promise.resolve(); assert.match(h.component.videoError, /Playback could not start/);
 } finally { h.destroy(); }
});

test('saving binds only editable annotation fields; source identity, hash and capture UTC stay server-owned', () => {
 const h = harness(); try {
  h.component.selected = evidence(52); notes(h.component); h.component.draft.crossings = [{ track: ' vehicle-1 ', offsetMs: 1, direction: 'A_to_B', class: 'car', uncertain: false }];
  h.component.save(); h.component.save(); assert.equal(h.calls.length, 1);
  const post = h.calls[0]; assert.equal(post.args[0], '/api/admin/video-evidence/52/annotation'); assert.deepEqual(Object.keys(post.args[1]).sort(), ['condition', 'crossings', 'note', 'split', 'timingEvidence']); assert.equal(post.args[1].crossings[0].track, 'vehicle-1'); assert.equal(post.args[2].withCredentials, true);
  h.component.draft.crossings[0].offsetMs = 999; assert.equal(post.args[1].crossings[0].offsetMs, 1, 'in-flight body is detached from editable draft');
  post.response.next({ id: 9 }); assert.equal(h.component.busy, false); assert.equal(h.component.dirty, false); assert.match(h.component.message, /Independent review/); assert.ok(h.by('/admin/evaluation'));
 } finally { h.destroy(); }
});

test('draft validation rejects duplicate tracks, out-of-window offsets and certain events outside rules', () => {
 const h = harness(); try {
  h.component.selected = evidence(); notes(h.component);
  const base = { track: 'same', offsetMs: 1, direction: 'A_to_B', class: 'car', uncertain: false };
  h.component.draft.crossings = [base, { ...base }]; h.component.save(); assert.equal(h.calls.length, 0);
  h.component.draft.crossings = [{ ...base, offsetMs: 60000 }]; h.component.save(); assert.equal(h.calls.length, 0);
  h.component.draft.crossings = [{ ...base, class: 'unknown' }]; h.component.save(); assert.equal(h.calls.length, 0);
  h.component.draft.crossings[0].uncertain = true; h.component.save(); assert.equal(h.calls.length, 1, 'an explicit uncertain draft is allowed for later human review');
 } finally { h.destroy(); }
});

test('zero-vehicle manual notes can be saved without manufacturing time evidence or automatic counts', () => {
 const h = harness(); try {
  h.component.selected = evidence(); notes(h.component); h.component.save(); assert.equal(h.calls[0].args[1].crossings.length, 0); assert.equal('captureStart' in h.calls[0].args[1], false);
 } finally { h.destroy(); }
});

test('interrupted writes require a refresh before retry; player failure cannot make coverage true', () => {
 const h = harness(); try {
  h.component.selected = evidence(); h.component.selected.quality.relativeCoverageComplete = false; notes(h.component); h.component.save(); h.calls[0].response.error(new HttpErrorResponse({ status: 503 })); assert.equal(h.component.busy, false); assert.match(h.component.error, /Refresh before retrying/);
  h.component.playerFailed(); assert.equal(h.component.metadataReady, false); assert.equal(h.component.selected.quality.relativeCoverageComplete, false); assert.equal(h.component.selected.quality.captureTimeTrusted, false);
  const oldLoaded = h.stats().loaded; h.component.retryPlayer(); assert.equal(h.stats().loaded, oldLoaded + 1); assert.equal(h.component.videoError, ''); assert.equal(h.component.metadataReady, false, 'retry does not claim decoding succeeded'); assert.equal(h.component.selected.quality.relativeCoverageComplete, false);
 } finally { h.destroy(); }
});

test('an older selected capture keeps polling after the latest page no longer contains it', () => {
 const h = harness(); try {
  h.component.ngOnInit(); h.component.selected = evidence(1, 'processing'); h.component.evidenceItems = [evidence(50)]; const oldCalls = h.calls.length;
  globalThis.document.hidden = true; [...h.timers.values()][0](); assert.equal(h.calls.length, oldCalls);
  globalThis.document.hidden = false; [...h.timers.values()][0](); assert.equal(h.calls.length, oldCalls + 2); assert.ok(h.by('/admin/video-evidence/1'));
  h.by('/admin/video-evidence/1').response.next(evidence(1)); assert.equal(h.component.selected.status, 'ready');
 } finally { h.destroy(); }
});

test('cursor pages deduplicate records and independent reviews are separate authenticated mutations', () => {
 const h = harness(); try {
  h.component.items = [{ id: 10 }]; h.component.load(true); assert.equal(h.calls[0].args[1].params.get('before'), '10'); h.calls[0].response.next({ items: [{ id: 10 }, { id: 9 }], hasMore: true }); assert.deepEqual(h.component.items.map((item) => item.id), [10, 9]);
  h.component.reviewNotes[9] = 'Reviewed independently against retained evidence and rule.'; h.component.review(9, 'accepted'); const post = h.calls.at(-1); assert.equal(post.args[0], '/api/admin/evaluation/9'); assert.deepEqual(post.args[1], { outcome: 'accepted', note: h.component.reviewNotes[9] }); assert.equal(post.args[2].withCredentials, true);
  h.component.review(9, 'settled'); assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1);
 } finally { h.destroy(); }
});

test('subinterval markers use interval-relative offsets and retain the parent evidence binding', () => {
 const h = harness(); try {
  h.component.selected = evidence(61); h.component.metadataLoaded(); h.component.setIntervalBoundary('start', 30); h.component.setIntervalBoundary('end', 60); notes(h.component);
  assert.equal(h.component.intervalDurationMs, 30000); assert.equal(h.component.validInterval, true);
  h.video.currentTime = 35.125; h.component.addCrossing(); assert.equal(h.component.draft.crossings[0].offsetMs, 5125); assert.equal(h.component.certainCount, 1);
  h.component.seekTo(h.component.intervalStartMs + h.component.draft.crossings[0].offsetMs); assert.equal(h.video.currentTime, 35.125);
  h.component.save(); const post = h.calls.at(-1); assert.equal(post.args[0], '/api/admin/video-evidence/61/annotation'); assert.equal(post.args[1].startOffsetMs, 30000); assert.equal(post.args[1].endOffsetMs, 60000); assert.equal(post.args[1].crossings[0].offsetMs, 5125); assert.equal('durationMs' in post.args[1], false); assert.equal('clipSha256' in post.args[1], false);
 } finally { h.destroy(); }
});

test('subinterval boundaries exclude their end and reject gaps outside the parent or sub-millisecond input', () => {
 const h = harness(); try {
  h.component.selected = evidence(); h.component.metadataLoaded(); notes(h.component); h.component.setIntervalBoundary('start', 10); h.component.setIntervalBoundary('end', 40);
  h.video.currentTime = 9.999; h.component.addCrossing(); assert.equal(h.component.draft.crossings.length, 0);
  h.video.currentTime = 40; h.component.addCrossing(); assert.equal(h.component.draft.crossings.length, 0);
  h.video.currentTime = 10; h.component.addCrossing(); assert.equal(h.component.draft.crossings[0].offsetMs, 0);
  for (const [boundary, seconds] of [['end', 60.001], ['end', 10.999], ['start', 10.0001]]) {
   h.component.setIntervalBoundary(boundary, seconds); assert.equal(h.component.validInterval, false); h.component.save(); assert.equal(h.calls.length, 0);
  }
  h.component.setIntervalBoundary('start', 10.001); h.component.setIntervalBoundary('end', 40.001); assert.equal(h.component.intervalStartMs, 10001); assert.equal(h.component.intervalEndMs, 40001); assert.equal(h.component.validInterval, true);
 } finally { h.destroy(); }
});

test('changing interval start preserves parent crossing position instead of silently moving a label', () => {
 const h = harness(); try {
  h.component.selected = evidence(); h.component.metadataLoaded(); h.video.currentTime = 20; h.component.addCrossing(); assert.equal(h.component.draft.crossings[0].offsetMs, 20000);
  h.component.setIntervalBoundary('start', 10); assert.equal(h.component.draft.crossings[0].offsetMs, 10000); assert.equal(h.component.intervalStartMs + h.component.draft.crossings[0].offsetMs, 20000);
  h.component.setIntervalBoundary('start', null); assert.equal(h.component.intervalStartMs, 10000); h.component.setIntervalBoundary('start', 21); assert.equal(h.component.draft.crossings[0].offsetMs, -1000); notes(h.component); h.component.save(); assert.equal(h.calls.length, 0, 'out-of-window existing label requires explicit correction');
  h.component.resetDraft(); assert.equal(h.component.intervalStartMs, 0); assert.equal(h.component.intervalEndMs, 60000);
 } finally { h.destroy(); }
});

test('boundary buttons use current parent time and drafts retain separate windows per evidence', () => {
 const h = harness(); try {
  h.component.selected = evidence(1); h.component.metadataLoaded(); h.video.currentTime = 15.001; h.component.boundaryFromPlayer('start'); h.video.currentTime = 45.001; h.component.boundaryFromPlayer('end'); assert.equal(h.component.intervalStartMs, 15001); assert.equal(h.component.intervalEndMs, 45001);
  h.component.openEvidence(2); h.calls.at(-1).response.next(evidence(2)); assert.equal(h.component.intervalStartMs, 0); assert.equal(h.component.intervalEndMs, 60000);
  h.component.openEvidence(1); h.calls.at(-1).response.next(evidence(1)); assert.equal(h.component.intervalStartMs, 15001); assert.equal(h.component.intervalEndMs, 45001); assert.equal(h.component.dirty, true);
 } finally { h.destroy(); }
});
