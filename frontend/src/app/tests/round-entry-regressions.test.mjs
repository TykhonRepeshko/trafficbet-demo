import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject, Subject, of } from 'rxjs';

const output = new URL(`.round-entry-regressions-${process.pid}.mjs`, import.meta.url);
const bundle = await build({
  stdin: { contents: `
    export { StreamDetailComponent } from './pages/stream-detail.component';
    export { ApiService } from './services/api.service';
    export { AuthService } from './services/auth.service';
  `, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }
});
await writeFile(output, bundle.outputFiles[0].text);
const { StreamDetailComponent, ApiService, AuthService } = await import(output.href);
await unlink(output);

function harness(query = {}, anchor = false) {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  const frames = new Map(), cancelledFrames = [], lookups = [], scrolled = [], focused = [];
  let nextFrame = 1, rendered = false;
  globalThis.window = { setInterval: () => 1, clearInterval: () => {} };
  globalThis.document = { hidden: false };
  if (anchor) {
    globalThis.window.requestAnimationFrame = (callback) => { const id = nextFrame++; frames.set(id, callback); return id; };
    globalThis.window.cancelAnimationFrame = (id) => { cancelledFrames.push(id); frames.delete(id); };
    globalThis.document.getElementById = (id) => {
      lookups.push(id);
      return rendered ? { scrollIntoView: (options) => scrolled.push({ id, options }), focus: (options) => focused.push({ id, options }) } : null;
    };
  }
  const now = Date.now();
  const stream = { id: 38, isActive: true, streamType: 'hls', streamUrl: '/api/media/streams/38/index.m3u8' };
  const market = {
    id: 71, streamId: 38, status: 'open', threshold: 100,
    bettingClosesAt: new Date(now + 60_000).toISOString(),
    windowStart: new Date(now + 120_000).toISOString(), windowEnd: new Date(now + 420_000).toISOString()
  };
  const route = { paramMap: new BehaviorSubject(convertToParamMap({ id: '38' })), snapshot: { queryParamMap: convertToParamMap(query) } };
  const betCalls = [], loadCalls = [], response = new Subject();
  const auth = { user: { id: 1, balanceCredits: 100 }, sessionGeneration: 1, updateUser: () => {} };
  const injector = createEnvironmentInjector([
    { provide: AuthService, useValue: auth },
    { provide: ActivatedRoute, useValue: route },
    { provide: ApiService, useValue: {
      getStream: (id) => { loadCalls.push(id); return of(id === 38 ? stream : { ...stream, id }); },
      listPublicMarkets: (id) => of(id === 38 ? [market] : [{ ...market, id: 72, streamId: id }]), listMetrics: () => of([]),
      createBet: (...args) => { betCalls.push(args); return response; }
    } }
  ]);
  const component = runInInjectionContext(injector, () => new StreamDetailComponent());
  component.ngOnInit();
  return {
    component, market, stream, route, betCalls, loadCalls, response, frames, cancelledFrames, lookups, scrolled, focused,
    render: () => { rendered = true; },
    frame: () => { const first = frames.entries().next().value; if (first) { frames.delete(first[0]); first[1](); } },
    query: (values) => { route.snapshot = { queryParamMap: convertToParamMap(values) }; },
    destroy: () => {
      response.complete(); component.ngOnDestroy(); injector.destroy();
      globalThis.window = oldWindow; globalThis.document = oldDocument;
    }
  };
}

test('opening a round without a URL choice leaves both sides unselected and spends no credits', () => {
  const h = harness();
  try {
    assert.equal(h.component.requestedRoundId, undefined);
    assert.equal(h.component.selectedMarket, undefined);
    assert.equal(h.component.selectedSide, undefined);
    assert.equal(h.component.requestedRoundUnavailable, false);
    assert.equal(h.component.stakes[h.market.id], 25);
    assert.deepEqual(h.betCalls, []);
  } finally { h.destroy(); }
});

test('a homepage round choice highlights only an available matching round and updates without reloading its camera', () => {
  const h = harness({ round: '71', side: 'over', stake: '99' });
  try {
    assert.equal(h.component.selectedMarket, h.market);
    assert.equal(h.component.isSelectedMarket(h.market), true);
    assert.equal(h.component.selectedSide, 'over');
    assert.equal(h.component.stakes[h.market.id], 25, 'URL input changed the entered stake');
    assert.equal(h.component.requestedRoundUnavailable, false);
    h.query({ round: '71', side: 'under' });
    assert.equal(h.component.selectedSide, 'under', 'Reused stream page retained a previous query choice');
    assert.deepEqual(h.loadCalls, [38], 'Changing a choice reloaded the camera player');
    assert.deepEqual(h.betCalls, [], 'A URL choice automatically placed a prediction');
  } finally { h.destroy(); }
});

test('round choices reject malformed, duplicate, negative and unsafe identifiers', () => {
  const h = harness();
  try {
    for (const round of ['', '0', '-71', '+71', '071', '71.0', '7.1e1', ' 71', '71 ', 'Infinity', 'NaN', '9007199254740992', ['71', '71']]) {
      h.query({ round, side: 'over' });
      assert.equal(h.component.requestedRoundId, undefined, `Accepted malformed round: ${round}`);
      assert.equal(h.component.selectedMarket, undefined);
      assert.equal(h.component.selectedSide, undefined);
      assert.equal(h.component.requestedRoundUnavailable, false);
    }
    assert.deepEqual(h.betCalls, []);
  } finally { h.destroy(); }
});

test('invalid and duplicate side values never choose an outcome or override an otherwise valid round', () => {
  const h = harness();
  try {
    for (const side of ['', 'OVER', 'Under', ' under', 'over ', 'both', '<script>', ['over', 'under']]) {
      h.query({ round: '71', side });
      assert.equal(h.component.selectedMarket, h.market);
      assert.equal(h.component.selectedSide, undefined, `Accepted invalid side: ${side}`);
    }
    h.query({ side: 'over' });
    assert.equal(h.component.selectedSide, undefined, 'A side alone selected an arbitrary round');
    assert.deepEqual(h.betCalls, []);
  } finally { h.destroy(); }
});

test('missing, closed, foreign and archived rounds cannot remain selected or silently switch to another round', () => {
  const h = harness({ round: '71', side: 'over' });
  try {
    h.query({ round: '999', side: 'over' });
    assert.equal(h.component.requestedRoundUnavailable, true);
    assert.equal(h.component.selectedMarket, undefined);
    h.query({ round: '71', side: 'over' });
    h.component.now = Date.parse(h.market.bettingClosesAt);
    assert.equal(h.component.selectedSide, undefined, 'A choice survived the prediction deadline');
    assert.equal(h.component.requestedRoundUnavailable, true);
    h.component.now -= 1;
    h.market.streamId = 39;
    assert.equal(h.component.selectedMarket, undefined, 'A round for a different camera was selected');
    h.market.streamId = 38;
    h.stream.isActive = false;
    assert.equal(h.component.selectedMarket, undefined, 'An archived camera retained an available selection');
    h.stream.isActive = true;
    for (const status of ['draft', 'settled', 'void']) {
      h.market.status = status;
      assert.equal(h.component.selectedMarket, undefined, `Selected a ${status} round`);
      assert.equal(h.component.selectedSide, undefined);
    }
    assert.deepEqual(h.betCalls, []);
  } finally { h.destroy(); }
});

test('camera cards expire at the counting deadline without waiting for operator settlement', () => {
  const h = harness();
  try {
    const now = h.component.now;
    const round = (id, start, end, status = 'open') => ({
      ...h.market, id, status,
      bettingClosesAt: new Date(now + start - 30_000).toISOString(),
      windowStart: new Date(now + start).toISOString(), windowEnd: new Date(now + end).toISOString()
    });
    const upcoming = round(1, 120_000, 150_000);
    const locked = round(2, 15_000, 45_000);
    const counting = round(3, -15_000, 15_000);
    const awaitingReview = round(4, -60_000, 0);
    h.component.markets = [upcoming, awaitingReview, round(5, -90_000, -30_000), locked,
      round(6, 120_000, 150_000, 'settled'), round(7, 120_000, 150_000, 'void'),
      round(8, 120_000, 150_000, 'draft'), counting];
    assert.deepEqual(h.component.activeMarkets.map(item => item.id), [3, 2, 1]);
    assert.equal(h.component.displayedRound, counting);
    h.component.now = now + 15_000;
    assert.deepEqual(h.component.activeMarkets.map(item => item.id), [2, 1]);
    assert.equal(h.component.displayedRound, locked);
    h.component.now = now + 45_000;
    assert.deepEqual(h.component.activeMarkets.map(item => item.id), [1]);
    h.component.now = now + 150_000;
    assert.deepEqual(h.component.activeMarkets, []);
    assert.equal(h.component.displayedRound, undefined);
    assert.equal(awaitingReview.status, 'open', 'Hiding a past round changed its unsettled state');
    assert.deepEqual(h.betCalls, []);
  } finally { h.destroy(); }
});

test('only an explicit Place action submits the entered stake and clicked side, with duplicate submission blocked', () => {
  const h = harness({ round: '71', side: 'under', stake: '90' });
  try {
    assert.deepEqual(h.betCalls, []);
    h.component.stakes[h.market.id] = 30;
    h.component.placeBet(h.market, 'over');
    assert.equal(h.betCalls.length, 1);
    assert.deepEqual(h.betCalls[0].slice(0, 3), [71, 'over', 30], 'URL values replaced the user action');
    assert.match(h.betCalls[0][3], /^[\da-f-]{36}$/i);
    h.component.placeBet(h.market, 'over');
    assert.equal(h.betCalls.length, 1, 'A second click submitted while the first action was pending');
  } finally { h.destroy(); }
});

test('the initial selected round scroll waits for its card, focuses once and never repeats on updates', () => {
  const h = harness({ round: '71', side: 'over' }, true);
  try {
    assert.equal(h.frames.size, 1);
    assert.deepEqual(h.scrolled, [], 'Scrolled before the asynchronously loaded card rendered');
    h.frame();
    assert.equal(h.frames.size, 1, 'Did not allow a bounded extra frame for rendering');
    h.render(); h.frame();
    assert.deepEqual(h.lookups, ['round-71', 'round-71']);
    assert.deepEqual(h.scrolled, [{ id: 'round-71', options: { block: 'start', behavior: 'auto' } }]);
    assert.deepEqual(h.focused, [{ id: 'round-71', options: { preventScroll: true } }]);
    assert.equal(h.frames.size, 0);
    h.component.load(true); h.component.load();
    h.query({ round: '71', side: 'under' });
    assert.equal(h.frames.size, 0, 'A normal update scheduled another scroll');
    assert.equal(h.scrolled.length, 1);
    assert.deepEqual(h.betCalls, []);
  } finally { h.destroy(); }
});

test('a missing card stops after three frames rather than polling indefinitely', () => {
  const h = harness({ round: '71', side: 'over' }, true);
  try {
    for (let n = 0; n < 5; n++) h.frame();
    assert.deepEqual(h.lookups, ['round-71', 'round-71', 'round-71']);
    assert.equal(h.frames.size, 0);
    assert.deepEqual(h.scrolled, []);
    h.component.load(true);
    assert.equal(h.frames.size, 0, 'A background refresh restarted a timed-out scroll');
  } finally { h.destroy(); }
});

test('camera navigation cancels an old anchor and stale callbacks cannot focus a different route or cancel its current anchor', () => {
  const h = harness({ round: '71', side: 'over' }, true);
  try {
    const [oldId, stale] = h.frames.entries().next().value;
    h.query({ round: '72', side: 'under' });
    h.route.paramMap.next(convertToParamMap({ id: '39' }));
    assert.equal(h.cancelledFrames.includes(oldId), true);
    assert.equal(h.frames.size, 1);
    h.render(); stale();
    assert.deepEqual(h.lookups, [], 'An old callback searched the new page');
    h.frame();
    assert.deepEqual(h.lookups, ['round-72']);
    assert.equal(h.scrolled.length, 1);
    assert.equal(h.scrolled[0].id, 'round-72');
    assert.deepEqual(h.betCalls, []);
  } finally { h.destroy(); }
});

test('destroying a camera page cancels its scheduled anchor and rejects an already queued callback', () => {
  const h = harness({ round: '71', side: 'over' }, true);
  try {
    const [id, stale] = h.frames.entries().next().value;
    h.component.ngOnDestroy();
    assert.equal(h.cancelledFrames.includes(id), true);
    assert.equal(h.frames.size, 0);
    h.render(); stale();
    assert.deepEqual(h.lookups, []);
    assert.deepEqual(h.scrolled, []);
    assert.deepEqual(h.focused, []);
  } finally { h.destroy(); }
});

test('invalid choices and query-only changes cannot turn a URL fragment into an anchor lookup', () => {
  const h = harness({ round: '../../account', side: 'over' }, true);
  try {
    assert.equal(h.frames.size, 0);
    h.query({ round: '71', side: 'over' });
    h.component.load(true); h.component.load();
    assert.equal(h.frames.size, 0, 'A later query change reran the initial anchor behavior');
    assert.deepEqual(h.lookups, []);
    assert.deepEqual(h.betCalls, []);
  } finally { h.destroy(); }
});
