import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import { of } from 'rxjs';

const output = new URL(`.play-start-${process.pid}.mjs`, import.meta.url);
const bundle = await build({
  stdin: { contents: `export { PlayComponent } from './pages/play.component'; export { ApiService } from './services/api.service'; export { AuthService } from './services/auth.service';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }
});
await writeFile(output, bundle.outputFiles[0].text);
const { PlayComponent, ApiService, AuthService } = await import(output.href);
await unlink(output);

function harness(automaticSettlement, mode) {
  const savedWindow = globalThis.window;
  globalThis.window = { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 2, clearTimeout: () => {} };
  const stream = { id: 38, isActive: true, streamType: 'hls' };
  const market = { id: 99, streamId: 38, status: 'open', threshold: 10, bettingClosesAt: new Date(Date.now() + 60_000).toISOString(), windowStart: new Date(Date.now() + 90_000).toISOString(), windowEnd: new Date(Date.now() + 120_000).toISOString(), countingRules: { mode } };
  const quote = { marketId: market.id, rangeMin: 3, rangeMax: 8, odds: 2, pricingModel: 'demo_geometric_v1' };
  const api = { health: () => of({ ok: true, automaticSettlement }), listStreams: () => of([stream]), listPublicMarkets: () => of([market]), rangeOptions: () => of({ options: [quote, quote] }), quoteRange: () => of(quote) };
  const injector = createEnvironmentInjector([
    { provide: ApiService, useValue: api }, { provide: AuthService, useValue: { user: { id: 1, balanceCredits: 1000 }, sessionGeneration: 1 } },
    { provide: Router, useValue: { navigate: () => Promise.resolve(true) } }
  ]);
  const component = runInInjectionContext(injector, () => new PlayComponent());
  return { component, cleanup: () => { component.ngOnDestroy(); injector.destroy(); globalThis.window = savedWindow; } };
}

test('Make a prediction opens a real AI round and loads credit options', () => {
  const h = harness(true, 'versioned');
  try {
    h.component.start();
    assert.equal(h.component.stage, 'betting');
    assert.equal(h.component.market.id, 99);
    assert.equal(h.component.options.length, 2);
    assert.equal(h.component.automaticSettlement, true);
    assert.equal(h.component.canPlace, true);
  } finally { h.cleanup(); }
});

test('AI mode never offers a legacy round without a frozen counting line', () => {
  const h = harness(true, 'legacy_manual');
  try { h.component.start(); assert.equal(h.component.stage, 'empty'); assert.equal(h.component.market, undefined); }
  finally { h.cleanup(); }
});

test('manual mode can open existing rounds without advertising an AI count', () => {
  const h = harness(false, 'legacy_manual');
  try { h.component.start(); assert.equal(h.component.stage, 'betting'); assert.equal(h.component.automaticSettlement, false); assert.match(h.component.phaseHint, /Manual verification/); }
  finally { h.cleanup(); }
});

test('the displayed safety countdown is 30 seconds and playback delay is labelled separately', () => {
  const h = harness(true, 'versioned');
  const originalNow = Date.now;
  const closedAt = Date.parse('2026-11-02T21:00:00Z');
  let current = closedAt;
  let shown = closedAt / 1000 - 45;
  try {
    h.component.start();
    Date.now = () => current;
    h.component.market = { ...h.component.market, bettingClosesAt: new Date(closedAt).toISOString(), windowStart: new Date(closedAt + 30_000).toISOString(), windowEnd: new Date(closedAt + 60_000).toISOString() };
    h.component.live = { marketId: 99, status: 'open', windowStart: h.component.market.windowStart, windowEnd: h.component.market.windowEnd, live: { segments: [{ seq: 1 }], crossings: [{ at: closedAt / 1000 + 32 }], vehicleCount: 1, processedUntil: closedAt / 1000 + 40 } };
    h.component.player = { displayedCaptureTime: () => shown };
    h.component.stage = 'placed';
    h.component.tick();
    assert.equal(h.component.phaseTitle, 'Counting starts in 0:30');
    assert.match(h.component.phaseHint, /30-second safety interval/);
    assert.equal(h.component.count, 0, 'future crossings are hidden while the video is delayed');
    current += 30_000;
    h.component.tick();
    assert.equal(h.component.phase, 'syncing');
    assert.equal(h.component.phaseTitle, 'Counting window started');
    assert.equal(h.component.hudStatus, 'Waiting for video…');
    shown = closedAt / 1000 + 32;
    current += 15_000;
    h.component.tick();
    assert.equal(h.component.phase, 'counting');
    assert.equal(h.component.count, 1, 'counting remains aligned with the displayed crossing');
  } finally { Date.now = originalNow; h.cleanup(); }
});
