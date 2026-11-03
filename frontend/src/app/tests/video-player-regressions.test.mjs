import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';

// Test the real component and its HLS integration contract without a browser,
// a DOM renderer or external camera/network requests.
const output = new URL(`.video-player-regressions-${process.pid}.mjs`, import.meta.url);
const bundle = await build({
  stdin: { contents: `export { VideoPlayerComponent } from './components/video-player.component'; export { CountingOverlayComponent } from './components/counting-overlay.component';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }
});
await writeFile(output, bundle.outputFiles[0].text);
const { VideoPlayerComponent, CountingOverlayComponent } = await import(output.href);
await unlink(output);

const stream = { id: 37, streamType: 'hls', streamUrl: '/api/media/streams/37/index.m3u8', thumbnailUrl: '' };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function harness({ supported = true, nativeSupport = 'maybe' } = {}) {
  const oldWindow = globalThis.window, oldDocument = globalThis.document, oldDateNow = Date.now;
  let timerId = 0, now = 1_000_000;
  const timers = new Map(), instances = [];
  const document = { hidden: false };
  globalThis.document = document; Date.now = () => now;
  globalThis.window = {
    location: { origin: 'http://localhost:4200' },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay, at: now + (delay ?? 0) }); return timerId; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => ++timerId, clearInterval: () => {}
  };
  class FakeHls {
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifestParsed', LEVEL_UPDATED: 'levelUpdated', MEDIA_ATTACHED: 'mediaAttached', MEDIA_DETACHING: 'mediaDetaching' };
    static isSupported = () => supported;
    events = new Map(); starts = 0; stops = 0; recoveries = 0; sourceLoads = 0; destroyed = false; liveSyncPosition = null;
    constructor(config) { this.config = config; instances.push(this); }
    on(event, callback) { this.events.set(event, callback); }
    emit(event, data) { this.events.get(event)?.(event, data); }
    loadSource(url) { this.source = url; this.sourceLoads++; }
    attachMedia(video) { this.media = video; }
    startLoad() { this.starts++; }
    stopLoad() { this.stops++; }
    recoverMediaError() { this.recoveries++; }
    destroy() { this.destroyed = true; }
  }
  const video = {
    src: '', muted: false, loads: 0, plays: 0, pauses: 0, currentTime: 0, paused: true, seeking: false, frames: 0,
    seekable: { length: 1, start: () => 10, end: () => 40 },
    canPlayType: () => nativeSupport,
    getVideoPlaybackQuality() { return { totalVideoFrames: this.frames, droppedVideoFrames: 0 }; },
    load() { this.loads++; }, play() { this.plays++; this.paused = false; return Promise.resolve(); }, pause() { this.pauses++; this.paused = true; }
  };
  const injector = createEnvironmentInjector([{ provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (value) => value } }]);
  const component = runInInjectionContext(injector, () => new VideoPlayerComponent());
  component.loadHls = async () => FakeHls;
  component.stream = stream; component.ngOnChanges();
  return {
    component, video, timers, instances, FakeHls, document,
    mount: () => { component.video = { nativeElement: video }; },
    fireTimer: (delay) => { const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry, `Expected ${delay}ms timer`); timers.delete(entry[0]); now = Math.max(now, entry[1].at); entry[1].callback(); },
    advance: (ms, { playback = false, frames = playback } = {}) => {
      now += ms;
      if (playback) video.currentTime += ms / 1000;
      if (frames) video.frames += Math.ceil(ms / 40);
      component.updateLiveHealth();
    },
    destroy: () => { component.ngOnDestroy(); injector.destroy(); globalThis.window = oldWindow; globalThis.document = oldDocument; Date.now = oldDateNow; }
  };
}

function updateSource(player, endSN, targetduration = 10) { player.emit('levelUpdated', { details: { live: true, endSN, targetduration } }); }

test('reported source resolution follows decoded video metadata and in-stream resolution changes', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush();
    h.video.videoWidth = 1280; h.video.videoHeight = 720;
    h.component.updateResolution();
    assert.equal(h.component.sourceResolution, '1280 × 720');
    h.video.videoWidth = 1920; h.video.videoHeight = 1080;
    h.component.updateResolution();
    assert.equal(h.component.sourceResolution, '1920 × 1080');
  } finally { h.destroy(); }
});

test('source resolution never invents dimensions from unavailable video and resets when a camera changes', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush();
    h.component.updateResolution();
    assert.equal(h.component.sourceResolution, '');
    h.video.videoWidth = 0; h.video.videoHeight = 720;
    h.component.updateResolution();
    assert.equal(h.component.sourceResolution, '');
    h.video.videoWidth = 800; h.video.videoHeight = 450;
    h.component.loaded();
    assert.equal(h.component.sourceResolution, '800 × 450');
    h.component.stream = { ...stream, id: 38, streamUrl: '/api/media/streams/38/index.m3u8' };
    h.component.ngOnChanges();
    assert.equal(h.component.sourceResolution, '');
    h.component.updateResolution();
    assert.equal(h.component.sourceResolution, '', 'A late old-video event restored stale dimensions');
  } finally { h.destroy(); }
});
function healthyPlayback(h, player, sequence = 100) {
  player.emit('manifestParsed'); player.emit('mediaAttached'); h.component.loaded();
  updateSource(player, sequence); h.advance(1000, { playback: true }); updateSource(player, sequence + 1);
  for (let i = 0; i < 12; i++) h.advance(1000, { playback: true });
}

function exhaustNetworkRetries(h, player, used = 0) {
  const failure = { fatal: true, type: 'networkError', details: 'fragLoadError', response: { code: 502 } };
  for (const delay of [1000, 2000, 4000, 8000, 15_000].slice(used)) { player.emit('error', failure); h.fireTimer(delay); }
  player.emit('error', failure);
  assert.equal(h.component.coolingDown, true);
}

test('Chrome native HLS "maybe" uses hls.js / MediaSource instead of the native source', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush();
    assert.equal(h.instances.length, 1, 'Native canPlayType(maybe) bypassed hls.js');
    assert.equal(h.instances[0].media, h.video);
    assert.equal(h.instances[0].source, 'http://localhost:4200/api/media/streams/37/index.m3u8');
    assert.equal(h.instances[0].config.liveDurationInfinity, true, 'Live HLS should use the live duration API rather than appear as a finite clip');
    assert.equal(h.video.src, '', 'The playlist was assigned directly to the native player');
    h.instances[0].emit('manifestParsed');
    assert.equal(h.video.plays, 1);
  } finally { h.destroy(); }
});

test('playback initialises when the conditional video view appears, once per attempt', async () => {
  const h = harness();
  try {
    h.component.start(); await flush(); assert.equal(h.instances.length, 0);
    h.mount(); h.mount(); await flush();
    assert.equal(h.instances.length, 1, 'View readiness either skipped playback or created duplicate players');
    h.component.start(); await flush();
    assert.equal(h.instances.length, 2); assert.equal(h.instances[0].destroyed, true);
  } finally { h.destroy(); }
});

test('native HLS remains available when MediaSource is unsupported', async () => {
  const h = harness({ supported: false, nativeSupport: 'probably' });
  try {
    h.component.start(); h.mount(); await flush();
    assert.equal(h.instances.length, 0);
    assert.equal(h.video.src, 'http://localhost:4200/api/media/streams/37/index.m3u8');
    assert.equal(h.video.loads, 1); assert.equal(h.video.plays, 1);
    assert.equal(h.component.error, '');
  } finally { h.destroy(); }
});

test('unsupported HLS produces a browser-specific error immediately', async () => {
  const h = harness({ supported: false, nativeSupport: '' });
  try {
    h.component.start(); h.mount(); await flush();
    assert.match(h.component.error, /browser does not support HLS/);
    assert.equal(h.component.loading, false); assert.equal(h.timers.size, 0);
  } finally { h.destroy(); }
});

test('consecutive fatal network failures use bounded backoff then a safe cooldown status', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush();
    const player = h.instances[0];
    const failure = { fatal: true, type: 'networkError', response: { code: 502, url: 'https://private.example/secret-token' } };
    for (const delay of [1000, 2000, 4000, 8000, 15_000]) {
      player.emit('error', failure); player.emit('error', failure);
      assert.equal(h.component.error, '');
      assert.equal([...h.timers.values()].filter((timer) => timer.delay === delay).length, 1, 'Duplicate errors scheduled duplicate retries');
      h.fireTimer(delay);
    }
    assert.equal(player.starts, 1); assert.equal(player.sourceLoads, 5, 'Later retries must discard obsolete fragment handles');
    player.emit('error', failure);
    assert.match(h.component.error, /HTTP 502/); assert.doesNotMatch(h.component.error, /private|secret-token/);
    assert.equal(player.destroyed, false); assert.equal(player.stops, 1); assert.equal(h.component.coolingDown, true);
    assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 60_000);
  } finally { h.destroy(); }
});

test('fatal HLS decode recovery is bounded and reports a distinct decode failure', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush();
    const player = h.instances[0], failure = { fatal: true, type: 'mediaError' };
    player.emit('error', failure); h.fireTimer(1000); assert.equal(player.recoveries, 1); assert.equal(h.component.error, '');
    player.emit('error', failure); h.fireTimer(2000); assert.equal(player.recoveries, 2);
    player.emit('error', failure);
    assert.equal(player.recoveries, 2); assert.match(h.component.error, /could not be decoded/);
    assert.equal(player.destroyed, true);
  } finally { h.destroy(); }
});

test('separated network and decode outages regain recovery budgets only after healthy playback', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0];
    healthyPlayback(h, player);
    const network = { fatal: true, type: 'networkError', details: 'fragLoadError', response: { code: 502 } };
    player.emit('error', network); h.fireTimer(1000); assert.equal(player.starts, 1);
    healthyPlayback(h, player, 110); assert.equal(h.component.recovering, false);
    player.emit('error', network); h.fireTimer(1000); assert.equal(player.starts, 2, 'A separate outage inherited the old retry budget');
    const decode = { fatal: true, type: 'mediaError', details: 'bufferAppendError' };
    healthyPlayback(h, player, 120); player.emit('error', decode); h.fireTimer(1000); assert.equal(player.recoveries, 1);
    healthyPlayback(h, player, 130); player.emit('error', decode); h.fireTimer(1000); assert.equal(player.recoveries, 2);
    assert.equal(h.component.error, '');
  } finally { h.destroy(); }
});

test('upgrading a queued network retry cannot exceed the decode recovery cap', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0], decode = { fatal: true, type: 'mediaError' };
    player.emit('error', decode); h.fireTimer(1000); player.emit('error', decode); h.fireTimer(2000);
    player.emit('error', { fatal: true, type: 'networkError' });
    const callback = [...h.timers.values()].find((timer) => timer.delay === 4000).callback;
    player.emit('error', decode); callback();
    assert.match(h.component.error, /could not be decoded/); assert.equal(player.recoveries, 2);
    assert.equal(h.timers.size, 0); assert.equal(player.destroyed, true);
  } finally { h.destroy(); }
});

test('loadeddata and advancing manifests cannot reset an outage while playback is frozen', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; healthyPlayback(h, player);
    const failure = { fatal: true, type: 'networkError', response: { code: 502 } };
    player.emit('error', failure); h.fireTimer(1000); h.component.loaded();
    for (let i = 0; i < 12; i++) { h.advance(1000); updateSource(player, 110 + i); }
    assert.equal(h.component.recovering, true);
    player.emit('error', failure); h.fireTimer(2000);
    assert.equal(player.sourceLoads, 2, 'Frozen playback incorrectly regained its initial network retry');
  } finally { h.destroy(); }
});

test('an advancing media clock without presented frames is not healthy video playback', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; healthyPlayback(h, player);
    player.emit('error', { fatal: true, type: 'networkError' }); h.fireTimer(1000);
    for (let i = 0; i < 12; i++) { h.advance(1000, { playback: true, frames: false }); updateSource(player, 110 + i); }
    assert.equal(h.component.recovering, true, 'A stalled decoder incorrectly reset its retry budget');
  } finally { h.destroy(); }
});

test('a frozen video automatically reloads the safe master even while playlists keep advancing', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; healthyPlayback(h, player);
    for (let i = 0; i < 21; i++) { h.advance(1000); updateSource(player, 110 + i); }
    assert.equal(h.component.recovering, true); assert.equal(h.component.error, '');
    h.fireTimer(1000); assert.equal(player.sourceLoads, 2); assert.equal(player.starts, 0);
    assert.equal(player.source, 'http://localhost:4200/api/media/streams/37/index.m3u8');
  } finally { h.destroy(); }
});

test('a source that stops publishing new segments is automatically reconnected', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; healthyPlayback(h, player);
    for (let i = 0; i < 21; i++) h.advance(1000, { playback: true });
    assert.equal(h.component.liveSourceState, 'stalled'); assert.equal(h.component.recovering, true);
    h.fireTimer(1000); assert.equal(player.sourceLoads, 2);
  } finally { h.destroy(); }
});

test('a permanent silent stall enters a cooldown and leaves a visible reconnect action', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; healthyPlayback(h, player);
    h.advance(20_001);
    for (const delay of [1000, 2000, 4000, 8000, 15_000]) { h.fireTimer(delay); h.advance(20_001); }
    assert.match(h.component.error, /stopped (playing|updating)/); assert.equal(h.component.loading, false);
    assert.equal(player.destroyed, false); assert.equal(h.component.coolingDown, true); assert.equal(player.stops, 1);
    assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 60_000);
  } finally { h.destroy(); }
});

test('a live source returning after an exhausted retry cycle reconnects without user action', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; healthyPlayback(h, player);
    exhaustNetworkRetries(h, player);
    assert.match(h.component.error, /retry automatically after 60 seconds/);
    assert.equal(h.component.liveSourceLabel, 'Camera unavailable · waiting to reconnect');
    h.fireTimer(60_000); assert.equal(h.component.error, ''); assert.equal(h.component.coolingDown, false);
    h.fireTimer(1000); assert.equal(player.sourceLoads, 6, 'A new cycle did not reload the safe live master');
    healthyPlayback(h, player, 200);
    assert.equal(h.component.error, ''); assert.equal(h.component.recovering, false); assert.equal(h.component.liveSourceState, 'live');
    player.emit('error', { fatal: true, type: 'networkError' }); h.fireTimer(1000);
    assert.equal(player.starts, 2, 'Healthy resumed playback did not restore normal recovery');
  } finally { h.destroy(); }
});

test('a cooldown does not restart manually paused playback and resumes after explicit play', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; healthyPlayback(h, player); exhaustNetworkRetries(h, player);
    h.video.pause(); h.component.playbackPaused(); const loads = player.sourceLoads, plays = h.video.plays, position = h.video.currentTime;
    h.fireTimer(60_000); h.advance(120_000);
    assert.equal(h.component.coolingDown, true); assert.equal(h.timers.size, 0);
    assert.equal(player.sourceLoads, loads); assert.equal(h.video.plays, plays); assert.equal(h.video.currentTime, position);
    h.video.play(); h.component.playbackResumed(); h.fireTimer(1000);
    assert.equal(h.component.coolingDown, false); assert.equal(player.sourceLoads, loads + 1);
  } finally { h.destroy(); }
});

test('a cooldown waits while hidden and reconnects once the tab is visible', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; healthyPlayback(h, player); exhaustNetworkRetries(h, player);
    h.document.hidden = true; const loads = player.sourceLoads;
    h.fireTimer(60_000); h.advance(60_000);
    assert.equal(h.component.coolingDown, true); assert.equal(h.timers.size, 0); assert.equal(player.sourceLoads, loads);
    h.document.hidden = false; h.advance(1000); h.fireTimer(1000);
    assert.equal(h.component.coolingDown, false); assert.equal(player.sourceLoads, loads + 1);
  } finally { h.destroy(); }
});

test('source changes and destruction cancel a cooldown and its retained callback', async () => {
  for (const action of ['change', 'destroy']) {
    const h = harness();
    try {
      h.component.start(); h.mount(); await flush(); const player = h.instances[0]; exhaustNetworkRetries(h, player);
      const callback = [...h.timers.values()].find((timer) => timer.delay === 60_000).callback;
      const loads = player.sourceLoads;
      if (action === 'change') { h.component.stream = { ...stream, id: 36, streamUrl: '/api/media/streams/36/index.m3u8' }; h.component.ngOnChanges(); }
      else h.component.ngOnDestroy();
      callback();
      assert.equal(h.component.coolingDown, false); assert.equal(h.timers.size, 0); assert.equal(player.destroyed, true); assert.equal(player.sourceLoads, loads);
    } finally { h.destroy(); }
  }
});

test('manual Reconnect remains usable during a cooldown and cancels its old timer', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; exhaustNetworkRetries(h, player);
    h.component.retry(); h.fireTimer(undefined); await flush();
    assert.equal(h.component.coolingDown, false); assert.equal(h.component.error, ''); assert.equal(player.destroyed, true);
    assert.equal(h.instances.length, 2); assert.equal([...h.timers.values()].some((timer) => timer.delay === 60_000), false);
  } finally { h.destroy(); }
});

test('network cooldown cycles cannot replenish unsuccessful decoder repairs', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0], decode = { fatal: true, type: 'mediaError' };
    player.emit('error', decode); h.fireTimer(1000); player.emit('error', decode); h.fireTimer(2000);
    exhaustNetworkRetries(h, player, 2); h.fireTimer(60_000); h.fireTimer(1000);
    player.emit('error', decode);
    assert.match(h.component.error, /could not be decoded/); assert.equal(h.component.coolingDown, false);
    assert.equal(player.recoveries, 2); assert.equal(player.destroyed, true); assert.equal(h.timers.size, 0);
  } finally { h.destroy(); }
});

test('manual pause cancels a queued recovery and never seeks or resumes the video', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; healthyPlayback(h, player);
    player.emit('error', { fatal: true, type: 'networkError' });
    h.video.pause(); h.component.playbackPaused();
    const position = h.video.currentTime, plays = h.video.plays;
    h.advance(120_000); updateSource(player, 200);
    assert.equal(h.timers.size, 0); assert.equal(player.sourceLoads, 1); assert.equal(player.starts, 0);
    assert.equal(h.video.currentTime, position); assert.equal(h.video.plays, plays);
    h.video.play(); h.component.playbackResumed(); h.fireTimer(1000);
    assert.equal(player.sourceLoads, 2, 'An explicit user resume did not restart the interrupted feed');
  } finally { h.destroy(); }
});

test('hidden tabs suspend watchdog recovery and get a fresh observation period when shown', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; healthyPlayback(h, player);
    h.document.hidden = true; h.advance(120_000);
    assert.equal(h.component.recovering, false); assert.equal(player.sourceLoads, 1); assert.equal(h.timers.size, 0);
    h.document.hidden = false; updateSource(player, 200); h.advance(1000, { playback: true });
    assert.equal(h.component.recovering, false, 'Background throttling caused an immediate false stall');
  } finally { h.destroy(); }
});

test('destroying a player cancels timers and a retained callback cannot recover the old source', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0];
    player.emit('error', { fatal: true, type: 'networkError' });
    const callback = [...h.timers.values()].find((timer) => timer.delay === 1000).callback;
    assert.equal([...h.timers.values()].some((timer) => timer.delay === 25_000), false, 'The startup timer can cut off recovery');
    h.component.ngOnDestroy(); callback();
    assert.equal(player.starts, 0); assert.equal(player.sourceLoads, 1); assert.equal(h.timers.size, 0);
  } finally { h.destroy(); }
});

test('access, incompatible media and other permanent player errors are terminal', async () => {
  for (const failure of [
    { fatal: true, type: 'networkError', response: { code: 403 } },
    { fatal: true, type: 'mediaError', details: 'manifestIncompatibleCodecsError' },
    { fatal: true, type: 'keySystemError', details: 'keySystemNoAccess' }
  ]) {
    const h = harness();
    try {
      h.component.start(); h.mount(); await flush(); const player = h.instances[0]; player.emit('error', failure);
      assert.notEqual(h.component.error, ''); assert.equal(h.component.loading, false); assert.equal(h.timers.size, 0);
      assert.equal(player.destroyed, true); assert.equal(player.starts, 0); assert.equal(player.recoveries, 0);
    } finally { h.destroy(); }
  }
});

test('a failed master manifest is fetched again instead of resuming nonexistent levels', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush();
    const player = h.instances[0];
    player.emit('error', { fatal: true, type: 'networkError', details: 'manifestLoadError' });
    h.fireTimer(1000);
    assert.equal(player.sourceLoads, 2); assert.equal(player.starts, 0);
  } finally { h.destroy(); }
});

test('a failed initial master can recover without a new media attachment and still respect pause', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0];
    player.emit('error', { fatal: true, type: 'networkError', details: 'manifestLoadError' }); h.fireTimer(1000);
    player.emit('manifestParsed'); h.component.loaded();
    h.video.pause(); h.component.playbackPaused(); h.advance(120_000);
    assert.equal(h.component.playbackWanted, false); assert.equal(h.timers.size, 0);
    assert.equal(player.sourceLoads, 2, 'The watchdog ignored a manual pause after a master-only recovery');
  } finally { h.destroy(); }
});

test('only an actual media detachment suppresses the internal pause during source recreation', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; healthyPlayback(h, player);
    player.emit('mediaDetaching'); h.video.pause(); h.component.playbackPaused();
    assert.equal(h.component.playbackWanted, true, 'Internal MediaSource pause was mistaken for user intent');
    const plays = h.video.plays; player.emit('mediaAttached'); assert.equal(h.video.plays, plays + 1);
    h.video.pause(); h.component.playbackPaused();
    player.emit('manifestParsed');
    assert.equal(h.video.paused, true, 'A later manifest overrode a user pause');
  } finally { h.destroy(); }
});

test('an HLS startup timeout enters automatic recovery before a late fatal network event', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0]; h.fireTimer(25_000);
    assert.equal(h.component.error, ''); assert.equal(h.component.recovering, true); assert.equal(player.destroyed, false);
    player.emit('error', { fatal: true, type: 'networkError', details: 'manifestLoadTimeOut' });
    assert.equal(h.timers.size, 1); h.fireTimer(1000); assert.equal(player.sourceLoads, 2);
    healthyPlayback(h, player, 200);
    assert.equal(h.component.error, ''); assert.equal(h.component.recovering, false); assert.equal(h.component.liveSourceState, 'live');
  } finally { h.destroy(); }
});

test('a retained startup deadline cannot replace or duplicate an already pending recovery', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0];
    const deadline = [...h.timers.values()].find((timer) => timer.delay === 25_000).callback;
    player.emit('error', { fatal: true, type: 'networkError', details: 'fragLoadError' }); deadline();
    assert.equal(h.timers.size, 1); h.fireTimer(1000);
    assert.equal(player.starts, 1); assert.equal(player.sourceLoads, 1, 'A stale startup deadline overrode fragment recovery with a master reload');
  } finally { h.destroy(); }
});

test('pausing before the first frame defers startup recovery until explicit play', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush(); const player = h.instances[0];
    player.emit('manifestParsed'); h.video.pause(); h.component.playbackPaused();
    const position = h.video.currentTime, plays = h.video.plays;
    h.fireTimer(25_000); h.advance(60_000);
    assert.equal(h.component.error, ''); assert.equal(h.component.recovering, true); assert.equal(h.timers.size, 0);
    assert.equal(player.sourceLoads, 1); assert.equal(h.video.currentTime, position); assert.equal(h.video.plays, plays);
    h.video.play(); h.component.playbackResumed(); h.fireTimer(1000);
    assert.equal(player.sourceLoads, 2);
    healthyPlayback(h, player, 200);
    assert.equal(h.component.error, ''); assert.equal(h.component.recovering, false); assert.equal(h.component.liveSourceState, 'live');
  } finally { h.destroy(); }
});

test('a hanging player import still reaches a finite startup error', async () => {
  const h = harness();
  try {
    h.component.loadHls = () => new Promise(() => {});
    h.component.start(); h.mount(); h.fireTimer(25_000);
    assert.match(h.component.error, /did not provide playable video in time/);
    assert.equal(h.component.loading, false); assert.equal(h.component.coolingDown, false); assert.equal(h.timers.size, 0);
  } finally { h.destroy(); }
});

test('expired media handles recover through the safe master URL', async () => {
  for (const code of [404, 410]) {
    const h = harness();
    try {
      h.component.start(); h.mount(); await flush();
      const player = h.instances[0], failure = { fatal: true, type: 'networkError', details: 'levelLoadError', response: { code } };
      player.emit('error', failure); h.fireTimer(1000);
      assert.equal(player.sourceLoads, 2); assert.equal(player.starts, 0);
      assert.equal(player.source, 'http://localhost:4200/api/media/streams/37/index.m3u8');
      player.emit('error', failure); h.fireTimer(2000);
      assert.equal(player.sourceLoads, 3); assert.equal(h.component.error, '');
    } finally { h.destroy(); }
  }
});

test('changing cameras cancels a pending player import and scheduled recovery', async () => {
  const h = harness();
  try {
    let resolve;
    h.component.loadHls = () => new Promise((callback) => resolve = callback);
    h.component.start(); h.mount();
    h.component.stream = { ...stream, id: 36, streamUrl: '/api/media/streams/36/index.m3u8' };
    h.component.ngOnChanges(); resolve(h.FakeHls); await flush();
    assert.equal(h.instances.length, 0, 'A stale import attached the previous camera');
    h.component.loadHls = async () => h.FakeHls;
    h.component.start(); await flush();
    const player = h.instances[0]; player.emit('error', { fatal: true, type: 'networkError' });
    assert.equal([...h.timers.values()].some((timer) => timer.delay === 1000), true);
    h.component.stream = { ...stream };
    h.component.ngOnChanges();
    assert.equal(h.timers.size, 0); assert.equal(player.starts, 0);
  } finally { h.destroy(); }
});

test('updating counting geometry and round selection preserves playback and pending recovery', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush();
    const player = h.instances[0];
    player.emit('error', { fatal: true, type: 'networkError' });
    const timers = h.timers.size;
    h.component.countingSnapshot = { mode: 'legacy_manual' };
    h.component.ngOnChanges({ countingSnapshot: {} });
    h.component.stream = { ...stream, countingGuide: { version: 2 } };
    h.component.ngOnChanges({ stream: {} });
    assert.equal(h.component.playing, true);
    assert.equal(player.destroyed, false);
    assert.equal(h.timers.size, timers);
    assert.equal(h.instances.length, 1);
  } finally { h.destroy(); }
});

test('HLS resource requests remain restricted to the current camera gateway', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush();
    const xhr = {}, setup = h.instances[0].config.xhrSetup;
    setup(xhr, 'http://localhost:4200/api/media/streams/37/resource/abc');
    assert.equal(xhr.withCredentials, false);
    for (const url of [
      'https://external.example/segment.ts', '/api/media/streams/36/resource/abc',
      '/api/media/streams/37/resource/abc?upstream=secret', '/api/media/streams/37/resource/abc#fragment'
    ]) assert.throws(() => setup(xhr, url), /Invalid media resource/);
  } finally { h.destroy(); }
});

test('a live label requires the live playlist to advance beyond its initial media sequence', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush();
    const player = h.instances[0], update = (endSN) => player.emit('levelUpdated', { details: { live: true, endSN, targetduration: 29 } });
    assert.equal(h.component.liveSourceState, 'checking');
    update(100); assert.equal(h.component.liveSourceState, 'checking', 'A live manifest alone is not continuity evidence');
    update(100); assert.equal(h.component.liveSourceState, 'checking', 'An unchanged playlist is not continuity evidence');
    update(101); assert.equal(h.component.liveSourceState, 'live');
    h.component.updateLiveHealth(h.component.lastSourceChange + 87_001);
    assert.equal(h.component.liveSourceState, 'stalled', 'The live label stayed green after the source stopped advancing');
    update(102); assert.equal(h.component.liveSourceState, 'live');
    update(10); assert.equal(h.component.liveSourceState, 'checking', 'A sequence reset needs fresh continuity evidence');
  } finally { h.destroy(); }
});

test('an ended playlist is explicitly labelled a recording and cannot be sent to live', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush();
    const player = h.instances[0];
    player.emit('levelUpdated', { details: { live: false, endSN: 100, targetduration: 10 } });
    assert.equal(h.component.liveSourceState, 'recording'); assert.match(h.component.error, /marked as a recording/);
    assert.equal(player.destroyed, true); assert.equal(h.timers.size, 0);
    h.component.goLive(); assert.equal(h.video.plays, 0); assert.equal(h.video.currentTime, 0);
  } finally { h.destroy(); }
});

test('returning to live clamps the playback position to the current seekable window', async () => {
  const h = harness();
  try {
    h.component.start(); h.mount(); await flush();
    const player = h.instances[0], update = (endSN) => player.emit('levelUpdated', { details: { live: true, endSN, targetduration: 10 } });
    update(100); update(101);
    player.liveSyncPosition = 25; h.component.goLive(); assert.equal(h.video.currentTime, 25);
    for (const position of [-10, 50, Number.NaN, Infinity, null]) {
      player.liveSyncPosition = position; h.component.goLive();
      assert.equal(h.video.currentTime, 37, 'An invalid sync position escaped the seekable window');
    }
    h.video.seekable.length = 0;
    const plays = h.video.plays; h.component.goLive(); assert.equal(h.video.plays, plays);
  } finally { h.destroy(); }
});

test('native HLS does not claim continuity that the component cannot observe', async () => {
  const h = harness({ supported: false, nativeSupport: 'probably' });
  try {
    h.component.start(); h.mount(); await flush();
    assert.equal(h.component.liveSourceState, 'native');
    assert.equal(h.component.liveSourceLabel, 'Streaming · live status unavailable');
  } finally { h.destroy(); }
});


test('public line distinguishes drafts, frozen round rules and mismatched camera geometry', () => {
  const component = new CountingOverlayComponent();
  const definition = { label: 'Road line', lineStart: { x: .1, y: .6 }, lineEnd: { x: .9, y: .6 } };
  component.guide = { profileId: 1, version: 1, approved: false, sourceFingerprint: 'a', width: 1280, height: 720, definition };
  assert.equal(component.definition, definition);
  assert.match(component.label, /Draft/);
  component.snapshot = { mode: 'legacy_manual' };
  assert.match(component.label, /round uses manual rules/);
  const frozen = { ...definition, lineStart: { x: .2, y: .5 } };
  component.snapshot = { mode: 'versioned', sourceFingerprint: 'a', version: 2, definition: frozen };
  assert.equal(component.definition, frozen, 'Current draft cannot replace a frozen round line');
  component.snapshot.sourceFingerprint = 'other';
  assert.equal(component.definition, undefined, 'A different source must never inherit this camera line');
  component.snapshot.sourceFingerprint = 'a'; component.mediaWidth = 640; component.mediaHeight = 480;
  assert.equal(component.definition, undefined, 'A changed aspect ratio needs recalibration');
  component.mediaWidth = 1920; component.mediaHeight = 1080;
  assert.equal(component.definition, frozen, 'A resolution change retaining the aspect ratio preserves normalized geometry');
  component.snapshot.definition = { ...definition, lineEnd: { x: Infinity, y: .6 } };
  assert.equal(component.definition, undefined);
});

test('fullscreen uses the common video and overlay container and handles unavailable browser support', async () => {
  const h = harness();
  try {
    let requests = 0, exits = 0;
    const shell = { requestFullscreen: async () => { requests++; } };
    h.document.exitFullscreen = async () => { exits++; };
    await h.component.toggleFullscreen(shell); assert.equal(requests, 1);
    h.document.fullscreenElement = shell;
    await h.component.toggleFullscreen(shell); assert.equal(exits, 1);
    h.document.fullscreenElement = undefined;
    await h.component.toggleFullscreen({ requestFullscreen: async () => { throw new Error('Disabled'); } });
  } finally { h.destroy(); }
});


test('AI playback rewinds to the counting window and waits for analysed frames without overriding user pause', async () => {
  const h=harness();
  try {
    h.component.start();h.mount();await flush();h.video.readyState=4;h.video.paused=false;h.video.currentTime=15;
    h.component.bufferedFragments=[{sn:1,start:10,duration:10},{sn:2,start:20,duration:10}];
    const round={marketId:9,streamId:37,status:'open',windowStart:new Date(1000_000).toISOString(),windowEnd:new Date(1030_000).toISOString(),live:{processedUntil:1000.1,segments:[{seq:1,startUtc:1000,duration:10},{seq:2,startUtc:1010,duration:10}]}};
    h.component.syncToAnalysis(round);
    assert.equal(h.video.currentTime,10);assert.equal(h.video.paused,true);
    h.component.playbackPaused(); // internally paused: keep the user's play intent
    round.live.processedUntil=1003;h.component.syncToAnalysis(round);
    assert.equal(h.video.paused,false);
    h.video.pause();h.component.playbackPaused();const plays=h.video.plays;
    round.live.processedUntil=1008;h.component.syncToAnalysis(round);
    assert.equal(h.video.plays,plays);assert.equal(h.video.paused,true);
  } finally {h.destroy();}
});

test('AI sync ignores other cameras and never highlights or maps a frame during a seek', async () => {
  const h=harness();
  try {
    h.component.start();h.mount();await flush();h.video.readyState=4;h.video.currentTime=15;h.video.seeking=true;
    h.component.bufferedFragments=[{sn:1,start:10,duration:10}];
    assert.equal(h.component.displayedCaptureTime([{seq:1,startUtc:1000}]),null);
    h.component.syncToAnalysis({marketId:9,streamId:999,status:'open',windowStart:new Date(1000_000).toISOString(),windowEnd:new Date(1030_000).toISOString(),live:{processedUntil:1001,segments:[{seq:1,startUtc:1000}]}});
    assert.equal(h.video.currentTime,15);
  } finally {h.destroy();}
});


test('releasing a public counter resumes only an analysis pause and keeps a manual pause', async () => {
  const h=harness();try{
    h.component.start();h.mount();await flush();h.component.analysisPaused=true;h.component.playbackWanted=true;h.video.pause();
    h.component.releaseAnalysisSync();assert.equal(h.video.paused,false);assert.equal(h.component.analysisStarted,false);
    h.video.pause();h.component.playbackPaused();const plays=h.video.plays;h.component.releaseAnalysisSync();assert.equal(h.video.plays,plays);assert.equal(h.video.paused,true);
  }finally{h.destroy();}
});
