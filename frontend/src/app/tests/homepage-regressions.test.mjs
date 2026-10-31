import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DefaultIterableDiffer, createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';

const output = new URL(`.homepage-regressions-${process.pid}.mjs`, import.meta.url);
const bundle = await build({
  stdin: { contents: `export { StreamListComponent } from './pages/stream-list.component'; export { ApiService } from './services/api.service';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }
});
await writeFile(output, bundle.outputFiles[0].text);
const { StreamListComponent, ApiService } = await import(output.href);
await unlink(output);

const now = Date.now();
const camera = (id = 38, extra = {}) => ({ id, title: `Camera ${id}`, city: 'Oslo', country: 'Norway', locationLabel: 'Road', isActive: true, streamType: 'hls', ...extra });
const market = (id = 71, streamId = 38, close = now + 60_000, extra = {}) => ({ id, streamId, status: 'open', threshold: 120, oddsOver: 1.8, oddsUnder: 1.9, bettingClosesAt: new Date(close).toISOString(), windowStart: new Date(close + 60_000).toISOString(), windowEnd: new Date(close + 360_000).toISOString(), ...extra });

function harness(api = {}) {
  const betCalls = [];
  const service = { listStreams: () => of([camera()]), listPublicMarkets: () => of([]), createBet: (...args) => { betCalls.push(args); return of({}); }, ...api };
  const injector = createEnvironmentInjector([{ provide: ApiService, useValue: service }]);
  const component = runInInjectionContext(injector, () => new StreamListComponent());
  component.now = now;
  return { component, service, betCalls, destroy: () => { component.ngOnDestroy(); injector.destroy(); } };
}

test('the lobby shows only accepting rounds on their own active continuous source, ordered by deadline', () => {
  const h = harness();
  try {
    h.component.streams = [camera(), camera(39), camera(40, { isActive: false }), camera(41, { streamType: 'mp4' })];
    h.component.markets = {
      38: [market(72), market(99, 39), market(73, 38, now), market(74, 38, now + 60_000, { status: 'draft' })],
      39: [market(71, 39, now + 30_000)], 40: [market(75, 40)], 41: [market(76, 41)]
    };
    assert.deepEqual(h.component.availableRounds.map((entry) => entry.market.id), [71, 72]);
    h.component.now = now + 30_000;
    assert.deepEqual(h.component.availableRounds.map((entry) => entry.market.id), [72]);
    h.component.now = now + 60_000;
    assert.deepEqual(h.component.availableRounds, []);
    assert.equal(h.component.closesIn(market()), 'Closed');
  } finally { h.destroy(); }
});

test('countdowns round partial seconds upward and never show negative or invalid times', () => {
  const h = harness();
  try {
    assert.equal(h.component.closesIn(market(1, 38, now + 999)), '00:01');
    assert.equal(h.component.closesIn(market(1, 38, now + 3_661_000)), '01:01:01');
    assert.equal(h.component.closesIn({ bettingClosesAt: 'invalid' }), 'Closed');
    assert.equal(h.component.closesIn(market(1, 38, now - 1)), 'Closed');
  } finally { h.destroy(); }
});

test('countdown updates retain Angular round-card identities and do not recreate focused cards', () => {
  const h = harness();
  try {
    h.component.streams = [camera()]; h.component.markets = { 38: [market(71), market(72)] };
    const differ = new DefaultIterableDiffer(h.component.trackRound);
    differ.diff(h.component.availableRounds);
    h.component.now = now + 1000;
    const changes = differ.diff(h.component.availableRounds), added = [], removed = [];
    changes?.forEachAddedItem((row) => added.push(row.item.market.id));
    changes?.forEachRemovedItem((row) => removed.push(row.item.market.id));
    assert.deepEqual(added, []); assert.deepEqual(removed, []);
  } finally { h.destroy(); }
});

test('failed round requests remain unknown instead of pretending there are zero open rounds', () => {
  const h = harness({ listStreams: () => of([camera(), camera(39)]), listPublicMarkets: (id) => id === 38 ? of([market()]) : throwError(() => new Error('Unavailable')) });
  try {
    h.component.load();
    assert.equal(h.component.hasRoundErrors, true);
    assert.equal(h.component.roundCountLabel, '—');
    assert.deepEqual(h.component.availableRounds.map((entry) => entry.market.id), [71]);
    assert.equal(h.component.marketsLoading, false);
    assert.equal(h.component.roundsRefreshing, false);
  } finally { h.destroy(); }
});

test('reloading cancels an old camera-round request and destruction cancels the current request', () => {
  const old = new Subject(), current = new Subject();
  let requests = 0;
  const h = harness({ listPublicMarkets: () => ++requests === 1 ? old : current });
  try {
    h.component.load();
    assert.equal(old.observers.length, 1);
    h.component.load();
    assert.equal(old.observers.length, 0);
    old.next([market(99)]); old.complete();
    current.next([market(71)]); current.complete();
    assert.deepEqual(h.component.availableRounds.map((entry) => entry.market.id), [71]);
    const pending = new Subject(); h.service.listPublicMarkets = () => pending;
    h.component.refreshRounds();
    assert.equal(pending.observers.length, 1);
    h.component.ngOnDestroy();
    assert.equal(pending.observers.length, 0);
  } finally { h.destroy(); }
});

test('background refresh does not overlap requests and removes unavailable stale betting choices', () => {
  const next = new Subject();
  let calls = 0;
  const h = harness({ listPublicMarkets: () => ++calls === 1 ? of([market()]) : next });
  try {
    h.component.load();
    assert.equal(h.component.availableRounds.length, 1);
    h.component.refreshRounds(); h.component.refreshRounds();
    assert.equal(calls, 2);
    next.error(new Error('Unavailable'));
    assert.equal(h.component.hasRoundErrors, true);
    assert.deepEqual(h.component.availableRounds, []);
    assert.equal(h.component.roundCountLabel, '—');
  } finally { h.destroy(); }
});

test('practice outcomes explain equality without sending a credit or prediction request', () => {
  const h = harness();
  try {
    h.component.chooseExample('under');
    assert.match(h.component.exampleExplanation, /12 or fewer/);
    h.component.chooseExample('over');
    assert.match(h.component.exampleExplanation, /13 or more/);
    h.component.chooseExample('invalid');
    assert.equal(h.component.exampleSide, 'over');
    assert.deepEqual(h.betCalls, []);
  } finally { h.destroy(); }
});


test('camera cards show the active counting or locked round between short entry periods', () => {
  const h = harness();
  try {
    h.component.streams = [camera()]; h.component.now = now;
    const locked = market(71, 38, now - 1000, { windowStart: new Date(now + 30_000).toISOString(), windowEnd: new Date(now + 60_000).toISOString() });
    h.component.markets = { 38: [locked] };
    assert.equal(h.component.nextRound(38), undefined);
    assert.equal(h.component.currentRound(38), locked);
    assert.match(h.component.waitingLabel(38), /Counting starts in 00:30/);
    h.component.now = now + 30_000;
    assert.match(h.component.waitingLabel(38), /Counting ends in 00:30/);
    h.component.now = now + 60_000;
    assert.equal(h.component.currentRound(38), undefined);
  } finally { h.destroy(); }
});
