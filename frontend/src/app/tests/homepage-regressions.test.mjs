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

test('the single camera directory prioritizes open entries and composes availability, city and search filters', () => {
  const h=harness();
  try {
    const first=camera(38,{city:'Bergen',title:'City approach'}), second=camera(39,{city:'Oslo',title:'Bridge traffic'}), third=camera(40,{city:'Oslo',title:'Tunnel approach'});
    h.component.loading=false; h.component.streams=[first,second,third];
    h.component.markets={38:[],39:[market(71,39),market(72,39)],40:[market(73,40)]};
    assert.deepEqual(h.component.filtered.map(item=>item.id),[39,40,38]);
    assert.equal(h.component.openCameraCountLabel,2,'Counted two rounds on one camera as two cameras');
    h.component.availability='open';
    assert.deepEqual(h.component.filtered.map(item=>item.id),[39,40]);
    h.component.city='Oslo'; h.component.search='bridge';
    assert.deepEqual(h.component.filtered.map(item=>item.id),[39]);
    assert.equal(h.component.hasCameraFilters,true);
    h.component.clearFilters();
    assert.equal(h.component.hasCameraFilters,false); assert.equal(h.component.availability,'all');
    assert.deepEqual(h.component.filtered.map(item=>item.id),[39,40,38]);
    assert.deepEqual(h.betCalls,[],'Discovery filtering placed a prediction');
  } finally { h.destroy(); }
});

test('entry status keeps failed updates unknown and rejects foreign rounds in camera actions', () => {
  const h=harness();
  try {
    h.component.loading=false; h.component.streams=[camera(38),camera(39)];
    h.component.markets={38:[market(70,39)],39:[market(71,39)]};
    assert.equal(h.component.nextRound(38),undefined,'A card linked to a round belonging to another camera');
    assert.equal(h.component.currentRound(38),undefined);
    assert.equal(h.component.cameraStateLabel(38),'Waiting for a round');
    assert.equal(h.component.cameraStateLabel(39),'Entries open');
    h.component.marketErrors[39]=true;
    assert.equal(h.component.cameraStateLabel(39),'Update unavailable');
    assert.equal(h.component.openCameraCountLabel,'—');
    assert.equal(h.component.nextRound(39),undefined,'A stale failed update enabled the prediction action');
    h.component.availability='open'; assert.deepEqual(h.component.filtered,[]);
    h.component.marketsLoading=true;
    assert.equal(h.component.cameraStateLabel(38),'Checking entries');
  } finally { h.destroy(); }
});

test('availability ordering retains camera DOM identity when entry windows close or a new camera opens', () => {
  const h=harness();
  try {
    h.component.streams=[camera(38),camera(39)]; h.component.markets={38:[],39:[market(71,39,now+1000)]};
    const differ=new DefaultIterableDiffer(h.component.trackCamera);
    differ.diff(h.component.filtered);
    h.component.now=now+1000;
    const changes=differ.diff(h.component.filtered), added=[],removed=[];
    changes?.forEachAddedItem(row=>added.push(row.item.id)); changes?.forEachRemovedItem(row=>removed.push(row.item.id));
    assert.deepEqual(added,[]); assert.deepEqual(removed,[]);
    assert.equal(h.component.cameraStateLabel(39),'Entries closed');
    h.component.markets[38]=[market(72,38,now+10000)];
    assert.deepEqual(h.component.filtered.map(item=>item.id),[38,39]);
  } finally { h.destroy(); }
});

test('deadline urgency applies only to a still-open final ten seconds', () => {
  const h=harness();
  try {
    assert.equal(h.component.entryClosesSoon(market(71,38,now+10001)),false);
    assert.equal(h.component.entryClosesSoon(market(71,38,now+10000)),true);
    assert.equal(h.component.entryClosesSoon(market(71,38,now)),false);
    assert.equal(h.component.entryClosesSoon({bettingClosesAt:'invalid'}),false);
    assert.equal(h.component.durationSeconds(market(71,38,now+60000,{windowStart:new Date(now+120000).toISOString(),windowEnd:new Date(now+150000).toISOString()})),30);
  } finally { h.destroy(); }
});

test('camera actions target the earliest accepting counting interval regardless of API order', () => {
  const h=harness();
  try {
    h.component.streams=[camera()];
    const earliest=market(71,38,now+30000,{windowStart:new Date(now+150000).toISOString(),windowEnd:new Date(now+180000).toISOString()});
    const later=market(72,38,now+210000,{windowStart:new Date(now+330000).toISOString(),windowEnd:new Date(now+360000).toISOString()});
    const foreign=market(70,39,now+10000);
    const received=[later,foreign,earliest]; h.component.markets={38:received};
    assert.equal(h.component.nextRound(38),earliest);
    assert.equal(h.component.currentRound(38),earliest);
    assert.deepEqual(received.map(item=>item.id),[72,70,71],'Choosing an interval mutated the API result order');
    assert.equal(h.component.cameraStateLabel(38),'Entries open');
    assert.equal(h.component.predictsNextRound(38),false);
    assert.deepEqual(h.betCalls,[]);
  } finally {h.destroy();}
});

test('at each entry cutoff the camera immediately links to its next published round while the old count stays visible', () => {
  const h=harness();
  try {
    h.component.streams=[camera()]; h.component.loading=false;
    const first=market(71,38,now+30000,{windowStart:new Date(now+150000).toISOString(),windowEnd:new Date(now+180000).toISOString()});
    const second=market(72,38,now+210000,{windowStart:new Date(now+330000).toISOString(),windowEnd:new Date(now+360000).toISOString()});
    const third=market(73,38,now+390000,{windowStart:new Date(now+510000).toISOString(),windowEnd:new Date(now+540000).toISOString()});
    h.component.markets={38:[third,second,first]};
    assert.equal(h.component.nextRound(38).id,71);
    h.component.now=now+30000;
    assert.equal(h.component.nextRound(38).id,72);
    assert.equal(h.component.currentRound(38).id,71,'Upcoming prediction replaced the current counting-zone context');
    assert.equal(h.component.cameraStateLabel(38),'Next round open');
    assert.equal(h.component.openCameraCountLabel,1);
    assert.equal(h.component.predictsNextRound(38),true);
    h.component.availability='open'; assert.deepEqual(h.component.filtered.map(item=>item.id),[38]);
    h.component.now=now+150000;
    assert.equal(h.component.currentRound(38).id,71); assert.equal(h.component.nextRound(38).id,72);
    h.component.now=now+210000;
    assert.equal(h.component.currentRound(38).id,72); assert.equal(h.component.nextRound(38).id,73);
    assert.equal(h.component.cameraStateLabel(38),'Next round open');
    assert.deepEqual(h.betCalls,[],'Automatic discovery of the next interval submitted a stake');
  } finally {h.destroy();}
});

test('a future-round offer stays unknown after an update failure and recovers without changing camera identity', () => {
  const h=harness();
  try {
    h.component.streams=[camera()]; h.component.loading=false;
    const closed=market(71,38,now-1000,{windowStart:new Date(now+120000).toISOString(),windowEnd:new Date(now+150000).toISOString()});
    const upcoming=market(72,38,now+180000,{windowStart:new Date(now+300000).toISOString(),windowEnd:new Date(now+330000).toISOString()});
    h.component.markets={38:[upcoming,closed]};
    const differ=new DefaultIterableDiffer(h.component.trackCamera); differ.diff(h.component.filtered);
    assert.equal(h.component.cameraStateLabel(38),'Next round open');
    h.component.marketErrors[38]=true;
    assert.equal(h.component.cameraStateLabel(38),'Update unavailable'); assert.equal(h.component.nextRound(38),undefined); assert.equal(h.component.predictsNextRound(38),false);
    h.component.marketErrors[38]=false;
    assert.equal(h.component.nextRound(38),upcoming); assert.equal(h.component.cameraStateLabel(38),'Next round open');
    const changes=differ.diff(h.component.filtered),added=[],removed=[];
    changes?.forEachAddedItem(item=>added.push(item.item.id)); changes?.forEachRemovedItem(item=>removed.push(item.item.id));
    assert.deepEqual(added,[]); assert.deepEqual(removed,[]);
  } finally {h.destroy();}
});
