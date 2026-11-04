import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { of, throwError, Subject } from 'rxjs';

const output = new URL(`.public-counter-${process.pid}.mjs`, import.meta.url);
const bundle = await build({ stdin: { contents: `export { LiveCameraCounterComponent } from './components/live-camera-counter.component'; export { ApiService } from './services/api.service'; export { pickObservedMarket } from './services/play-logic';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } } });
await writeFile(output, bundle.outputFiles[0].text);
const { LiveCameraCounterComponent, ApiService, pickObservedMarket } = await import(output.href);
await unlink(output);
const start = Date.parse('2026-11-03T22:00:00Z'), iso = ms => new Date(ms).toISOString();
const market = (id, offset = 0, extra = {}) => ({ id, streamId: 47, status: 'open', windowStart: iso(start+offset), windowEnd: iso(start+offset+30_000), countingRules: { mode: 'versioned', sourceFingerprint: 'camera-47', version: 4 }, ...extra });

test('the observer chooses a counting window independently of a future bet, camera and source', () => {
  const current=market(1), future=market(2,60_000), foreign=market(3,0,{streamId:48}), manual=market(4,500,{countingRules:{mode:'legacy_manual'}}), changed=market(5,1000,{countingRules:{mode:'versioned',sourceFingerprint:'other'}});
  assert.equal(pickObservedMarket([future,foreign,manual,changed,current],47,start+15_000,'camera-47').id,1);
  assert.equal(pickObservedMarket([future],47,start+15_000,'camera-47').id,2);
  assert.equal(pickObservedMarket([market(6,-150_000)],47,start+15_000,'camera-47'),undefined);
});

function harness() {
  const saved={window:globalThis.window,document:globalThis.document,now:Date.now};let now=start+15_000, shown=start/1000+5, released=0, syncs=0;
  const timers=new Map();let nextTimer=0;globalThis.window={setInterval:cb=>{timers.set(++nextTimer,cb);return nextTimer;},clearInterval:id=>timers.delete(id)};globalThis.document={hidden:false};Date.now=()=>now;
  let markets=[market(1),market(2,60_000)], automatic=true, fail=false;
  let live={marketId:1,streamId:47,status:'open',windowStart:markets[0].windowStart,windowEnd:markets[0].windowEnd,live:{vehicleCount:2,crossings:[{at:start/1000+2},{at:start/1000+8}],segments:[{seq:1,startUtc:start/1000,duration:10}],processedUntil:start/1000+12,updatedAt:iso(now),highlights:[{at:start/1000+5,boxes:[]}]}};
  let response;const calls=[];
  const api={health:()=>of({automaticSettlement:automatic}),listPublicMarkets:id=>{calls.push(['markets',id]);return of(markets);},liveRound:id=>{calls.push(['live',id]);return response ?? (fail?throwError(()=>new Error('temporary')):of(id === live.marketId ? live : { marketId:id, streamId:47, status:'open', windowStart:markets.find(m=>m.id===id).windowStart, windowEnd:markets.find(m=>m.id===id).windowEnd, live:null }));}};
  const injector=createEnvironmentInjector([{provide:ApiService,useValue:api}]);const c=runInInjectionContext(injector,()=>new LiveCameraCounterComponent());c.stream={id:47,streamType:'hls',streamUrl:'camera',countingGuide:{sourceFingerprint:'camera-47'}};c.player={syncToAnalysis:()=>syncs++,releaseAnalysisSync:()=>released++,displayedCaptureTime:()=>shown};
  return {c,calls,timers,start:()=>c.ngOnChanges(),advance(ms,position=shown,fresh=true){now+=ms;shown=position;if(live.live && fresh) live.live.updatedAt=iso(now);c.tick();},setLive(value){live=value;},get live(){return live;},setMarkets(value){markets=value;},manual(){automatic=false;},fail(){fail=true;},pending(){response=new Subject();return response;},get released(){return released;},get syncs(){return syncs;},cleanup(){c.ngOnDestroy();injector.destroy();globalThis.window=saved.window;globalThis.document=saved.document;Date.now=saved.now;}};
}

test('a viewer sees a synchronized count and frozen line without any account or bet', () => {
  const h=harness();try{h.start();assert.equal(h.c.visible,true);assert.equal(h.c.count,1);assert.equal(h.c.phase,'counting');assert.equal(h.c.snapshot.version,4);assert.match(h.c.statusText,/Live/);assert.ok(h.syncs);assert.deepEqual(h.calls,[['markets',47],['live',1]]);}finally{h.cleanup();}
});

test('rollover keeps the old frame and line until the video finishes, then observes the next window', () => {
  const h=harness();try{h.start();h.setLive({...h.live,status:'settled',actualCount:2});h.setMarkets([market(2,60_000)]);h.advance(25_000,start/1000+20);assert.equal(h.c.market.id,1);assert.equal(h.c.count,2);assert.equal(h.c.phase,'counting');h.advance(4000,start/1000+31);assert.equal(h.c.phase,'result');h.advance(4000);assert.equal(h.c.market.id,2);assert.equal(h.c.phase,'waiting');assert.equal(h.c.count,0);}finally{h.cleanup();}
});

test('temporary API failures clear boxes and label the last count as reconnecting', () => {
  const h=harness();try{h.start();h.fail();h.advance(2000);assert.equal(h.c.unavailable,true);assert.equal(h.c.highlights,undefined);assert.match(h.c.statusText,/reconnecting/);assert.ok(h.released);}finally{h.cleanup();}
});

test('disabling the counter cancels outstanding reads and clears the previous count', () => {
  const h=harness();try{h.start();const response=h.pending();h.advance(2000);h.c.enabled=false;h.c.ngOnChanges();response.next({...h.live,actualCount:999});assert.equal(h.c.visible,false);assert.equal(h.c.round,undefined);assert.equal(h.c.count,null);assert.equal(h.timers.size,0);assert.ok(h.released);}finally{h.cleanup();}
});

test('manual settlement does not advertise an AI counter', () => {
  const h=harness();try{h.manual();h.start();assert.equal(h.c.visible,false);assert.equal(h.c.count,null);assert.equal(h.calls.some(([kind])=>kind==='live'),false);}finally{h.cleanup();}
});


test('changing cameras clears old counts and ignores the previous camera response', () => {
  const h=harness();try{h.start();const response=h.pending();h.advance(2000);h.c.stream={id:48,streamType:'hls',streamUrl:'other-camera',countingGuide:{sourceFingerprint:'camera-48'}};h.c.ngOnChanges();response.next({...h.live,actualCount:999});assert.equal(h.c.round,undefined);assert.equal(h.c.market,undefined);assert.equal(h.c.count,null);}finally{h.cleanup();}
});


test('a missing previous analysis does not strand a public viewer after a newer round starts', () => {
  const h=harness();try{h.start();h.setLive({...h.live,live:null});h.advance(2000);h.setMarkets([market(2,60_000)]);h.advance(48_000,start/1000+61);assert.equal(h.c.market.id,2);assert.equal(h.c.count,null);assert.match(h.c.statusText,/Waiting for AI/);}finally{h.cleanup();}
});


test('a temporary HLS seek cannot spoil the final count or discard the current green window', () => {
  const h=harness();try {
    h.start(); assert.equal(h.c.count,1);
    h.setLive({...h.live,status:'settled',actualCount:2});h.setMarkets([market(2,60_000)]);
    h.advance(25_000,null);
    assert.equal(h.c.market.id,1);assert.equal(h.c.phase,'counting');assert.equal(h.c.count,1);
    assert.equal(h.c.displayed,null,'missing clock must still hide green boxes');
    assert.match(h.c.statusText,/Synchronizing video/);
    h.advance(4000,null);assert.equal(h.c.market.id,1);assert.equal(h.c.count,1);
    h.advance(4000,start/1000+31);assert.equal(h.c.phase,'result');assert.equal(h.c.count,2);
    h.advance(4000);assert.equal(h.c.market.id,2);assert.equal(h.c.phase,'waiting');
  } finally {h.cleanup();}
});

test('a settled round without retained live progress shows its final result, never Waiting for AI', () => {
  const h=harness();try{h.start();h.setLive({...h.live,status:'settled',actualCount:17,live:null});h.advance(20_000,null);assert.equal(h.c.count,17);assert.equal(h.c.statusText,'Final');assert.equal(h.c.analysisDelayed,false);}finally{h.cleanup();}
});
test('missing analysis becomes an explicit delay and releases playback instead of an endless spinner', () => {
  const h=harness();try{h.start();h.setLive({...h.live,live:null});h.advance(2000);assert.match(h.c.statusText,/AI delayed/);assert.equal(h.c.analysisDelayed,true);assert.equal(h.c.count,null);assert.equal(h.c.highlights,undefined);assert.ok(h.released);}finally{h.cleanup();}
});

test('stale progress cannot keep pausing or rewinding the broadcast on every timer tick', () => {
  const h=harness();try{h.start();const synced=h.syncs;h.advance(20_000,undefined,false);assert.equal(h.c.analysisDelayed,true);assert.equal(h.c.unavailable,false);assert.match(h.c.statusText,/AI delayed/);assert.equal(h.syncs,synced);assert.ok(h.released);assert.equal(h.c.highlights,undefined);}finally{h.cleanup();}
});
