import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
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
    id: 71, streamId: 38, status: 'open', threshold: 100, oddsOver: 1.9, oddsUnder: 1.8,
    bettingClosesAt: new Date(now + 60_000).toISOString(),
    windowStart: new Date(now + 120_000).toISOString(), windowEnd: new Date(now + 420_000).toISOString()
  };
  const route = { paramMap: new BehaviorSubject(convertToParamMap({ id: '38' })), queryParamMap: new BehaviorSubject(convertToParamMap(query)), snapshot: { queryParamMap: convertToParamMap(query) } };
  const betCalls = [], rangeBetCalls = [], rangeResponses = [], quoteRequests = [], loadCalls = [], response = new Subject();
  const auth = { user: { id: 1, balanceCredits: 100 }, sessionGeneration: 1, updateUser: (user) => { auth.user=user; } };
  const injector = createEnvironmentInjector([
    { provide: AuthService, useValue: auth },
    { provide: ActivatedRoute, useValue: route },
    { provide: ApiService, useValue: {
      getStream: (id) => { loadCalls.push(id); return of(id === 38 ? stream : { ...stream, id }); },
      listPublicMarkets: (id) => of(id === 38 ? [market] : [{ ...market, id: 72, streamId: id }]), listMetrics: () => of([]),
      createBet: (...args) => { betCalls.push(args); return response; },
      quoteRange: (...args) => { const result=new Subject(); quoteRequests.push({ args,result }); return result; },
      createRangeBet: (...args) => { rangeBetCalls.push(args); const result=rangeResponses.length ? new Subject() : response; rangeResponses.push(result); return result; }
    } }
  ]);
  const component = runInInjectionContext(injector, () => new StreamDetailComponent());
  component.ngOnInit();
  return {
    component, market, stream, route, auth, betCalls, rangeBetCalls, rangeResponses, quoteRequests, loadCalls, response, frames, cancelledFrames, lookups, scrolled, focused,
    render: () => { rendered = true; },
    frame: () => { const first = frames.entries().next().value; if (first) { frames.delete(first[0]); first[1](); } },
    query: (values) => { route.snapshot = { queryParamMap: convertToParamMap(values) }; route.queryParamMap.next(convertToParamMap(values)); },
    destroy: () => {
      response.complete(); rangeResponses.forEach(result=>result.complete()); component.ngOnDestroy(); injector.destroy();
      globalThis.window = oldWindow; globalThis.document = oldDocument;
    }
  };
}

test('opening a camera prepares the nearest accepting round without spending credits', () => {
  const h = harness();
  try {
    assert.equal(h.component.requestedRoundId, undefined);
    assert.equal(h.component.selectedMarket, h.market);
    assert.equal(h.component.selectedSide, 'range');
    assert.equal(h.component.requestedRoundUnavailable, false);
    assert.equal(h.component.stakes[h.market.id], 25);
    assert.deepEqual(h.rangeBetCalls, []);
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
    assert.equal(h.component.selectedSide, 'range', 'A side-only URL overrode the automatically prepared default');
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

function answerQuote(h, index = h.quoteRequests.length-1, extra = {}) {
  const {args,result}=h.quoteRequests[index];
  result.next({marketId:args[0],rangeMin:args[1],rangeMax:args[2],odds:3.25,pricingModel:'demo_normal_v2',...extra});
  result.complete();
}

test('custom bounds request server odds and only an explicit confirmation spends the selected stake', () => {
  const h=harness();
  try {
    h.component.chooseRound(h.market);
    assert.equal(h.component.selectedSide,'range');
    assert.equal(h.component.canConfirm(h.market),false);
    h.component.rangeMinimums[71]=12; h.component.rangeMaximums[71]=25;
    h.component.requestRangeQuote(h.market); answerQuote(h);
    assert.equal(h.component.rangeLabel(h.market,'range'),'12–25');
    h.component.setStake(h.market,100);
    assert.equal(h.component.potentialReturn(h.market),325);
    assert.equal(h.component.canConfirm(h.market),true);
    assert.deepEqual(h.rangeBetCalls,[]); assert.deepEqual(h.betCalls,[]);
    h.component.confirmPrediction(h.market); h.component.confirmPrediction(h.market);
    assert.equal(h.rangeBetCalls.length,1);
    const [quote,stake,key]=h.rangeBetCalls[0];
    assert.equal(quote.rangeMin,12); assert.equal(quote.rangeMax,25); assert.equal(stake,100); assert.match(key,/^[\da-f-]{36}$/i);
    h.response.next({user:{...h.auth.user,balanceCredits:0}});
    assert.match(h.component.message,/100 cr staked on 12–25/);
    assert.equal(h.component.selectedSide,undefined,'Accepted prediction can immediately submit a second identical stake');
    h.component.confirmPrediction(h.market); assert.equal(h.rangeBetCalls.length,1);
  } finally {h.destroy();}
});

test('editing bounds immediately invalidates an earlier quote, and stale or mismatched responses cannot enable a stake', () => {
  const h=harness();
  try {
    h.component.chooseRound(h.market); answerQuote(h);
    assert.equal(h.component.canConfirm(h.market),true);
    h.component.rangeMinimums[71]=12; h.component.rangeMaximums[71]=25;
    assert.equal(h.component.canConfirm(h.market),false,'Previous quote survived changed bounds');
    h.component.requestRangeQuote(h.market);
    const old=h.quoteRequests.at(-1).result;
    h.component.rangeMaximums[71]=26; h.component.requestRangeQuote(h.market);
    assert.equal(old.observed,false);
    old.next({marketId:71,rangeMin:12,rangeMax:25,odds:99,pricingModel:'demo_normal_v2'});
    answerQuote(h,h.quoteRequests.length-1,{rangeMax:25});
    assert.equal(h.component.canConfirm(h.market),false); assert.ok(h.component.quoteError);
    h.component.requestRangeQuote(h.market); answerQuote(h);
    assert.equal(h.component.canConfirm(h.market),true);
    h.auth.sessionGeneration++;
    assert.equal(h.component.canConfirm(h.market),false,'Old session odds enabled a new session stake');
    h.component.confirmPrediction(h.market); assert.deepEqual(h.rangeBetCalls,[]);
  } finally {h.destroy();}
});

test('reversed, missing, fractional and unbounded ranges never request odds or submit; equal bounds are valid', () => {
  const h=harness();
  try {
    h.component.chooseRound(h.market);
    for (const [from,to] of [[25,12],[-1,25],[1.5,25],[0,100000001],[null,25],[undefined,25]]) {
      h.component.rangeMinimums[71]=from; h.component.rangeMaximums[71]=to;
      const calls=h.quoteRequests.length;
      h.component.requestRangeQuote(h.market); h.component.confirmPrediction(h.market);
      assert.ok(h.component.rangeError(h.market)); assert.equal(h.quoteRequests.length,calls); assert.equal(h.rangeBetCalls.length,0);
    }
    h.component.rangeMinimums[71]=0; h.component.rangeMaximums[71]=0;
    h.component.requestRangeQuote(h.market); answerQuote(h);
    assert.equal(h.component.canConfirm(h.market),true);
    h.component.now=Date.parse(h.market.bettingClosesAt);
    assert.equal(h.component.requestedRoundUnavailable,true,'An expired local draft disappeared without a closed-round notice');
    h.component.confirmPrediction(h.market); assert.equal(h.rangeBetCalls.length,0,'Deadline did not disable confirmation');
  } finally {h.destroy();}
});

test('quick stakes respect the available balance and use Go-compatible whole-credit payout rounding', () => {
  const h=harness({round:'71',side:'under'});
  try {
    h.component.setStake(h.market,50); assert.equal(h.component.stakes[71],50);
    h.component.setStake(h.market,250); assert.equal(h.component.stakes[71],50);
    h.component.stakes[71]=1; h.market.oddsUnder=1.5;
    assert.equal(h.component.potentialReturn(h.market),2);
    for (const stake of [0,-1,2.5,null,101,100001]) {
      h.component.stakes[71]=stake; assert.equal(h.component.canConfirm(h.market),false); assert.ok(h.component.stakeError(h.market));
    }
    assert.deepEqual(h.betCalls,[]);
  } finally {h.destroy();}
});

test('switching prediction type or camera cancels pending quotes without placing or reusing stale terms', () => {
  const h=harness();
  try {
    h.component.chooseRound(h.market);
    const old=h.quoteRequests.at(-1).result;
    h.component.chooseSide(h.market,'over'); assert.equal(old.observed,false);
    assert.equal(h.component.selectedSide,'over'); assert.equal(h.component.potentialReturn(h.market),48);
    h.component.chooseSide(h.market,'range'); const pending=h.quoteRequests.at(-1).result;
    h.route.paramMap.next(convertToParamMap({id:'39'}));
    assert.equal(pending.observed,false); assert.equal(h.component.selectedMarket.id,72); assert.equal(h.component.selectedMarket.streamId,39);
    assert.deepEqual(h.rangeBetCalls,[]); assert.deepEqual(h.betCalls,[]);
  } finally {h.destroy();}
});

test('an uncertain range submission retries the same intent even after the quote is refreshed with reordered fields', () => {
  const h=harness();
  try {
    h.component.chooseRound(h.market); answerQuote(h);
    h.component.confirmPrediction(h.market);
    const key=h.rangeBetCalls[0][2];
    h.rangeResponses[0].error(new HttpErrorResponse({status:0}));
    assert.equal(h.component.submitting,false);
    h.component.requestRangeQuote(h.market);
    const {args,result}=h.quoteRequests.at(-1);
    result.next({pricingModel:'demo_normal_v2',odds:3.25,rangeMax:args[2],rangeMin:args[1],marketId:args[0]}); result.complete();
    h.component.confirmPrediction(h.market);
    assert.equal(h.rangeBetCalls[1][2],key,'A retry generated a second stake intent');
    h.rangeResponses[1].error(new HttpErrorResponse({status:0}));
    h.component.rangeMaximums[71]++; h.component.requestRangeQuote(h.market); answerQuote(h);
    h.component.confirmPrediction(h.market);
    assert.equal(h.rangeBetCalls.length,2,'An uncertain earlier request allowed a different new intent');
    assert.match(h.component.confirmationHelp(h.market),/last request may have been accepted/i);
  } finally {h.destroy();}
});

test('a query change during a quote releases loading state and the next refresh requests matching odds', () => {
  const h=harness({round:'71'});
  try {
    h.query({round:'71',side:'over'}); answerQuote(h);
    assert.equal(h.component.quoteLoading,false);
    assert.equal(h.component.currentRangeQuote(h.market),undefined);
    h.query({round:'71',side:'range'}); h.component.load(true);
    assert.equal(h.quoteRequests.length,2); answerQuote(h);
    assert.equal(h.component.canConfirm(h.market),true);
    assert.deepEqual(h.rangeBetCalls,[]);
  } finally {h.destroy();}
});

test('a draft survives missing successors and attaches automatically when the next published round is available', () => {
  const h=harness();
  try {
    h.component.chooseRound(h.market);
    h.component.rangeMinimums[71]=12; h.component.rangeMaximums[71]=25; h.component.setStake(h.market,50);
    h.component.requestRangeQuote(h.market); answerQuote(h);
    h.component.now=Date.parse(h.market.bettingClosesAt);
    assert.equal(h.component.selectedMarket,undefined);
    assert.equal(h.component.composerMarket.id,71); assert.equal(h.component.editingSide,'range');
    assert.equal(h.component.confirmationLabel(h.market),'Waiting for the next round');
    assert.match(h.component.confirmationHelp(h.market),/draft.*saved/i);
    h.component.now=Date.parse(h.market.windowEnd);
    assert.deepEqual(h.component.activeMarkets,[]);
    assert.equal(h.component.composerMarket.id,71,'Draft disappeared with the expired round card');
    const now=h.component.now;
    const next={...h.market,id:72,threshold:80,bettingClosesAt:new Date(now+60000).toISOString(),windowStart:new Date(now+120000).toISOString(),windowEnd:new Date(now+150000).toISOString()};
    h.component.markets=[next]; h.component.rangeMinimums[72]=75; h.component.rangeMaximums[72]=85; h.component.stakes[72]=25;
    assert.equal(h.component.composerMarket.id,71); assert.equal(h.component.selectedMarket,undefined);
    h.component.confirmPrediction(next); assert.deepEqual(h.rangeBetCalls,[]);
    h.component.syncEntryRound();
    assert.equal(h.component.composerMarket.id,72); assert.equal(h.component.stakes[72],50);
    assert.deepEqual(h.quoteRequests.at(-1).args,[72,12,25]);
    assert.equal(h.component.canConfirm(next),false,'Old quote enabled a new round');
    answerQuote(h); assert.equal(h.component.canConfirm(next),true);
    assert.deepEqual(h.rangeBetCalls,[],'Transferring a draft placed a prediction');
  } finally {h.destroy();}
});

test('preparing values never spends credits and only an accepting round receives current odds', () => {
  const h=harness();
  try {
    assert.equal(h.component.composerMarket.id,71);
    h.component.now=Date.parse(h.market.bettingClosesAt);
    h.component.chooseSide(h.market,'range');
    const count=h.quoteRequests.length;
    h.component.rangeMinimums[71]=12; h.component.rangeMaximums[71]=25; h.component.setStake(h.market,50);
    h.component.rangeChanged(h.market);
    assert.equal(h.component.selectedMarket,undefined); assert.equal(h.component.quoteLoading,false);
    h.component.confirmPrediction(h.market);
    assert.equal(h.quoteRequests.length,count); assert.deepEqual(h.rangeBetCalls,[]); assert.deepEqual(h.betCalls,[]);
    const next={...h.market,id:72,bettingClosesAt:new Date(Date.parse(h.market.windowEnd)+30000).toISOString(),windowStart:new Date(Date.parse(h.market.windowEnd)+150000).toISOString(),windowEnd:new Date(Date.parse(h.market.windowEnd)+180000).toISOString()};
    h.component.markets.push(next); h.component.syncEntryRound();
    assert.deepEqual(h.quoteRequests.at(-1).args,[72,12,25]); assert.equal(h.component.stakes[72],50);
  } finally {h.destroy();}
});

test('manual round selection moves keyboard focus into the composer once; updates and stale callbacks never steal it', () => {
  const h=harness({},true);
  try {
    h.component.chooseRound(h.market); assert.equal(h.frames.size,1);
    h.render(); h.frame();
    assert.deepEqual(h.focused,[{id:'range-from-71',options:{preventScroll:true}}]);
    h.component.load(true); assert.equal(h.frames.size,0);
    h.component.chooseRound(h.market); const stale=h.frames.values().next().value;
    h.route.paramMap.next(convertToParamMap({id:'39'}));
    stale(); assert.equal(h.focused.length,1,'Old selection focused the next camera');
  } finally {h.destroy();}
});

test('confirmation tells the member what must be fixed without permitting an invalid or unquoted stake', () => {
  const h=harness();
  try {
    assert.match(h.component.confirmationLabel(h.market),/calculating/i);
    h.component.chooseRound(h.market);
    assert.match(h.component.confirmationLabel(h.market),/calculating/i);
    h.component.rangeMinimums[71]=26; h.component.rangeMaximums[71]=12;
    assert.match(h.component.confirmationLabel(h.market),/check your range/i);
    assert.match(h.component.confirmationHelp(h.market),/From must/);
    h.component.rangeMinimums[71]=12; h.component.rangeMaximums[71]=25;
    h.component.requestRangeQuote(h.market); answerQuote(h);
    h.component.stakes[71]=101;
    assert.match(h.component.confirmationLabel(h.market),/check your stake/i);
    assert.match(h.component.confirmationHelp(h.market),/maximum available stake/);
    h.component.setStake(h.market,100);
    assert.equal(h.component.confirmationLabel(h.market),'Place prediction');
    assert.match(h.component.confirmationHelp(h.market),/100 virtual credits/);
    assert.deepEqual(h.rangeBetCalls,[]);
  } finally {h.destroy();}
});

test('same-camera query navigation retains the newly displayed draft at cutoff and clears earlier receipts', () => {
  const h=harness({round:'71',side:'over'});
  try {
    h.component.stakes[71]=25; h.component.confirmPrediction(h.market);
    h.response.next({user:{...h.auth.user,balanceCredits:75}});
    assert.equal(h.component.hasAcceptedPrediction(h.market),true);
    const next={...h.market,id:72}; h.component.markets.push(next);
    h.component.rangeMinimums[72]=12; h.component.rangeMaximums[72]=25; h.component.stakes[72]=50;
    h.query({round:'72',side:'under'});
    assert.equal(h.component.message,''); assert.equal(h.component.hasAcceptedPrediction(next),false);
    h.component.now=Date.parse(next.bettingClosesAt);
    assert.equal(h.component.selectedMarket,undefined);
    assert.equal(h.component.composerMarket.id,72,'Cutoff restored an earlier camera draft');
    assert.equal(h.component.editingSide,'under'); assert.equal(h.component.stakes[72],50);
    assert.equal(h.betCalls.length,1);
  } finally {h.destroy();}
});

test('an all-balance success has a separate accepted state until the member explicitly starts another prediction', () => {
  const h=harness({round:'71',side:'over'});
  try {
    h.component.stakes[71]=100; h.component.confirmPrediction(h.market);
    h.response.next({user:{...h.auth.user,balanceCredits:0}});
    assert.equal(h.component.hasAcceptedPrediction(h.market),true);
    assert.equal(h.component.selectedSide,undefined); assert.equal(h.component.canConfirm(h.market),false);
    h.component.startAnotherPrediction(h.market);
    assert.equal(h.component.hasAcceptedPrediction(h.market),false);
    assert.equal(h.component.message,''); assert.equal(h.component.editingSide,'range');
    assert.match(h.component.confirmationHelp(h.market),/no credits available/i);
    assert.equal(h.betCalls.length,1); assert.deepEqual(h.rangeBetCalls,[]);
  } finally {h.destroy();}
});

test('an earlier submission cannot label a newly query-selected round as accepted', () => {
  const h=harness({round:'71',side:'over'});
  try {
    h.component.confirmPrediction(h.market);
    const next={...h.market,id:72}; h.component.markets.push(next);
    h.query({round:'72',side:'under'});
    h.response.next({user:{...h.auth.user,balanceCredits:75}});
    assert.equal(h.auth.user.balanceCredits,75,'Accepted server balance did not update');
    assert.equal(h.component.message,''); assert.equal(h.component.hasAcceptedPrediction(next),false);
    assert.equal(h.component.selectedMarket.id,72); assert.equal(h.component.selectedSide,'under');
  } finally {h.destroy();}
});

test('the form rolls to the earliest published successor at cutoff, retaining input but requiring its fresh quote and confirmation', () => {
  const h=harness({},true);
  try {
    assert.equal(h.frames.size,0,'Automatic target selection moved keyboard focus');
    h.component.rangeMinimums[71]=12; h.component.rangeMaximums[71]=25; h.component.setStake(h.market,50);
    h.component.requestRangeQuote(h.market); answerQuote(h);
    const end=Date.parse(h.market.windowEnd);
    const next={...h.market,id:72,bettingClosesAt:new Date(end+30000).toISOString(),windowStart:new Date(end+150000).toISOString(),windowEnd:new Date(end+180000).toISOString()};
    const later={...next,id:73,bettingClosesAt:new Date(end+210000).toISOString(),windowStart:new Date(end+330000).toISOString(),windowEnd:new Date(end+360000).toISOString()};
    h.component.markets=[later,next,h.market];
    h.component.now=Date.parse(h.market.bettingClosesAt); h.component.syncEntryRound();
    assert.equal(h.component.selectedMarket.id,72); assert.equal(h.component.composerMarket.id,72);
    assert.equal(h.component.stakes[72],50); assert.equal(h.component.rangeLabel(next,'range'),'12–25');
    assert.equal(h.component.targetingNextRound,true); assert.equal(h.component.observingRound.id,71); assert.equal(h.component.displayedRound.id,72,'Counting line does not match the prediction target');
    assert.deepEqual(h.quoteRequests.at(-1).args,[72,12,25]); assert.equal(h.component.canConfirm(next),false);
    assert.deepEqual(h.rangeBetCalls,[]); assert.deepEqual(h.betCalls,[]); assert.equal(h.frames.size,0);
    answerQuote(h); assert.equal(h.component.canConfirm(next),true);
    h.component.confirmPrediction(next);
    assert.equal(h.rangeBetCalls.length,1); assert.equal(h.rangeBetCalls[0][0].marketId,72);
    assert.equal(h.rangeBetCalls[0][1],50);
  } finally {h.destroy();}
});

test('pending or uncertain submissions are never silently rerouted into a second prediction', () => {
  const h=harness();
  try {
    answerQuote(h); h.component.confirmPrediction(h.market);
    const end=Date.parse(h.market.windowEnd);
    const next={...h.market,id:72,bettingClosesAt:new Date(end+30000).toISOString(),windowStart:new Date(end+150000).toISOString(),windowEnd:new Date(end+180000).toISOString()};
    h.component.markets.push(next); h.component.now=Date.parse(h.market.bettingClosesAt);
    h.component.syncEntryRound(); assert.equal(h.component.composerMarket.id,71,'A pending request moved to a new round');
    h.rangeResponses[0].error(new HttpErrorResponse({status:0}));
    assert.equal(h.component.uncertainSubmission,true);
    h.component.syncEntryRound(); assert.equal(h.component.composerMarket.id,71);
    assert.match(h.component.confirmationHelp(h.market),/last request may have been accepted/i);
    assert.equal(h.rangeBetCalls.length,1);
  } finally {h.destroy();}
});

test('a genuine round deep link continues to the next round after settlement removes the old public row', () => {
  const h=harness({round:'71',side:'range'});
  try {
    h.component.rangeMinimums[71]=12; h.component.rangeMaximums[71]=25;
    const end=Date.parse(h.market.windowEnd);
    const next={...h.market,id:72,bettingClosesAt:new Date(end+30000).toISOString(),windowStart:new Date(end+150000).toISOString(),windowEnd:new Date(end+180000).toISOString()};
    h.component.markets=[next]; h.component.now=end; h.component.syncEntryRound();
    assert.equal(h.component.selectedMarket.id,72); assert.equal(h.component.rangeLabel(next,'range'),'12–25');
    assert.deepEqual(h.rangeBetCalls,[]);
    h.query({round:'999',side:'range'});
    assert.equal(h.component.selectedMarket,undefined,'A missing foreign deep link inherited a trusted selection');
  } finally {h.destroy();}
});

test('a rollover names the new target once and its published line follows the prediction instead of the earlier count', () => {
  const h=harness();
  try {
    h.market.countingRules={mode:'versioned',version:1,definition:{label:'Earlier line'}};
    const previousSnapshot=structuredClone(h.market.countingRules);
    const end=Date.parse(h.market.windowEnd);
    const next={...h.market,id:72,countingRules:{mode:'versioned',version:2,definition:{label:'Future line'}},bettingClosesAt:new Date(end+30000).toISOString(),windowStart:new Date(end+150000).toISOString(),windowEnd:new Date(end+180000).toISOString()};
    assert.equal(h.component.rolloverNotice,undefined,'Initial preparation announced a nonexistent rollover');
    h.component.markets.push(next); h.component.now=Date.parse(h.market.bettingClosesAt); h.component.syncEntryRound();
    assert.deepEqual(h.component.rolloverNotice,{fromId:71,marketId:72,startsAt:next.windowStart});
    assert.equal(h.component.displayedRound.countingRules,next.countingRules);
    assert.equal(h.component.observingRound.id,71);
    assert.deepEqual(h.market.countingRules,previousSnapshot,'Showing future rules rewrote the earlier snapshot');
    const notice=h.component.rolloverNotice, quoteCount=h.quoteRequests.length;
    h.component.syncEntryRound(); h.component.syncEntryRound();
    assert.equal(h.component.rolloverNotice,notice,'An ordinary clock update repeated the rollover announcement');
    assert.equal(h.quoteRequests.length,quoteCount); assert.deepEqual(h.rangeBetCalls,[]);
    h.route.paramMap.next(convertToParamMap({id:'39'}));
    assert.equal(h.component.rolloverNotice,undefined,'A target-change message leaked into another camera');
  } finally {h.destroy();}
});

test('editing a stake after an uncertain result gives an actionable disabled label instead of inviting a new submission', () => {
  const h=harness();
  try {
    answerQuote(h); h.component.confirmPrediction(h.market);
    h.rangeResponses[0].error(new HttpErrorResponse({status:0}));
    h.component.setStake(h.market,50);
    assert.equal(h.component.canConfirm(h.market),false);
    assert.equal(h.component.confirmationLabel(h.market),'Check previous prediction');
    assert.match(h.component.confirmationHelp(h.market),/check My predictions/i);
    h.component.confirmPrediction(h.market); assert.equal(h.rangeBetCalls.length,1);
  } finally {h.destroy();}
});

test('round timers distinguish entry cutoff from counting time, round seconds upward and mark only the final open seconds as urgent', () => {
  const h=harness();
  try {
    const now=h.component.now;
    assert.equal(h.component.closesIn(h.market),'01:00');
    assert.equal(h.component.countdownTo(h.market.windowStart),'02:00');
    assert.equal(h.component.countdownTo(new Date(now+3600500).toISOString()),'01:00:01');
    assert.equal(h.component.countdownTo('invalid'),'—');
    h.component.now=Date.parse(h.market.bettingClosesAt)-10001;
    assert.equal(h.component.entryClosesSoon(h.market),false);
    h.component.now++;
    assert.equal(h.component.entryClosesSoon(h.market),true);
    h.component.now=Date.parse(h.market.bettingClosesAt)-1;
    assert.equal(h.component.closesIn(h.market),'00:01');
    h.component.now++;
    assert.equal(h.component.closesIn(h.market),'Closed');
    assert.equal(h.component.entryClosesSoon(h.market),false);
    assert.equal(h.component.countdownTo(h.market.bettingClosesAt),'00:00');
    h.component.now=Date.parse(h.market.windowEnd)+1000;
    assert.equal(h.component.countdownTo(h.market.windowEnd),'00:00');
    assert.deepEqual(h.rangeBetCalls,[]); assert.deepEqual(h.betCalls,[]);
  } finally {h.destroy();}
});


test('range confirmation rejects retired pricing and returns above the current 10x cap', () => {
  const h=harness();
  try {
    h.component.chooseRound(h.market);
    answerQuote(h,h.quoteRequests.length-1,{pricingModel:'demo_geometric_v1'});
    assert.equal(h.component.canConfirm(h.market),false);
    h.component.requestRangeQuote(h.market);
    answerQuote(h,h.quoteRequests.length-1,{odds:10.01});
    assert.equal(h.component.canConfirm(h.market),false);
    h.component.requestRangeQuote(h.market);
    answerQuote(h,h.quoteRequests.length-1,{odds:10});
    assert.equal(h.component.canConfirm(h.market),true);
    assert.deepEqual(h.rangeBetCalls,[]);
  } finally {h.destroy();}
});
