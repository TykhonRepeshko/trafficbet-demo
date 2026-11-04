import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DOCUMENT } from '@angular/common';
import { DefaultIterableDiffer, createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Subject, of } from 'rxjs';

const output = new URL(`.admin-volume-${process.pid}.mjs`, import.meta.url);
const bundle = await build({ stdin: { contents: "export { AdminVolumeComponent } from './components/admin-volume.component'; export { AdminStakeDetailsComponent } from './components/admin-stake-details.component'; export { ApiService } from './services/api.service'; export { previewInterceptor } from './preview/preview.interceptor';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } } });
await writeFile(output, bundle.outputFiles[0].text);
const { AdminVolumeComponent, AdminStakeDetailsComponent, ApiService, previewInterceptor } = await import(output.href);
await unlink(output);
const amounts = (extra = {}) => ({ totalBetCount: 0, totalStakeCredits: 0, pendingBetCount: 0, pendingStakeCredits: 0, pendingOverBetCount: 0, pendingOverCredits: 0, pendingUnderBetCount: 0, pendingUnderCredits: 0, settledStakeCredits: 0, refundedStakeCredits: 0, ...extra });
const camera = (id = 1, extra = {}) => ({ streamId: id, title: 'Camera', city: 'Test', isActive: true, rounds: [], ...amounts(), ...extra });
const snapshot = (credits = 100) => ({ asOf: '2030-01-01T12:00:00Z', totals: amounts({ pendingStakeCredits: credits }), historicalTotals: amounts(), cameras: [camera()] });

function harness(hidden = false) {
  const calls = [], listeners = new Set(), timers = new Map(); let timerId = 0;
  const document = { hidden, addEventListener: (event, callback) => { assert.equal(event, 'visibilitychange'); listeners.add(callback); }, removeEventListener: (event, callback) => { assert.equal(event, 'visibilitychange'); listeners.delete(callback); }, defaultView: { setInterval: (callback, ms) => { assert.equal(ms, 5000); timers.set(++timerId, callback); return timerId; }, clearInterval: (id) => timers.delete(id) } };
  const injector = createEnvironmentInjector([{ provide: DOCUMENT, useValue: document }, { provide: ApiService, useValue: { stakeVolume: () => { const response = new Subject(); calls.push(response); return response; } } }]);
  const component = runInInjectionContext(injector, () => new AdminVolumeComponent());
  const tick = () => { for (const callback of timers.values()) callback(); };
  return { component, calls, document, timers, listeners, tick, visibility: (hidden) => { document.hidden = hidden; for (const callback of listeners) callback(); }, destroy: () => { if (!injector.destroyed) { component.ngOnDestroy(); injector.destroy(); } } };
}

test('volume polls every five seconds without overlapping requests, pauses while hidden and resumes on visibility', () => {
  const h = harness();
  try {
    h.component.ngOnInit(); assert.equal(h.calls.length, 1);
    h.tick(); h.component.refresh(); assert.equal(h.calls.length, 1);
    h.calls[0].next(snapshot(100)); h.calls[0].complete();
    h.tick(); assert.equal(h.calls.length, 2);
    h.calls[1].next(snapshot(250)); h.calls[1].complete();
    assert.equal(h.component.snapshot.totals.pendingStakeCredits, 250);
    h.visibility(true); h.tick(); h.component.refresh(); assert.equal(h.calls.length, 2);
    h.visibility(false); assert.equal(h.calls.length, 3);
    h.destroy(); assert.equal(h.calls[2].observed, false); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
    h.calls[2].next(snapshot(900)); h.component.refresh();
    assert.equal(h.component.snapshot.totals.pendingStakeCredits, 250); assert.equal(h.calls.length, 3);
  } finally { h.destroy(); }
});

test('a failed update preserves and marks the last snapshot, then recovers without showing false zero', () => {
  const h = harness();
  try {
    h.component.ngOnInit(); h.calls[0].next(snapshot(500)); h.calls[0].complete();
    h.tick(); h.calls[1].error(new HttpErrorResponse({ status: 503 }));
    assert.ok(h.component.error); assert.equal(h.component.refreshing, false);
    assert.equal(h.component.snapshot.totals.pendingStakeCredits, 500);
    h.tick(); h.calls[2].next(snapshot(0)); h.calls[2].complete();
    assert.equal(h.component.error, ''); assert.equal(h.component.snapshot.totals.pendingStakeCredits, 0);
    h.calls[1].next(snapshot(999)); assert.equal(h.component.snapshot.totals.pendingStakeCredits, 0);
  } finally { h.destroy(); }
});

test('an initially hidden panel waits for visibility, and first-load errors do not fabricate a snapshot', () => {
  const h = harness(true);
  try {
    h.component.ngOnInit(); h.tick(); assert.equal(h.calls.length, 0);
    h.visibility(false); h.calls[0].error(new HttpErrorResponse({ status: 403 }));
    assert.equal(h.component.snapshot, undefined); assert.ok(h.component.error);
  } finally { h.destroy(); }
});

test('archived sources with stakes remain visible and refreshes preserve Angular camera and round identities', () => {
  const h = harness();
  try {
    h.component.snapshot = { ...snapshot(), cameras: [camera(1), camera(2, { isActive: false, totalBetCount: 1, pendingStakeCredits: 100 }), camera(3, { isActive: false })] };
    assert.deepEqual(h.component.visibleCameras.map((item) => item.streamId), [1, 2]);
    h.component.showAllCameras = true; assert.equal(h.component.visibleCameras.length, 3);
    const differ = new DefaultIterableDiffer(h.component.trackCamera); differ.diff(h.component.visibleCameras);
    h.component.snapshot = structuredClone(h.component.snapshot);
    const changes = differ.diff(h.component.visibleCameras), removed = [], added = [];
    changes?.forEachRemovedItem((row) => removed.push(row.item)); changes?.forEachAddedItem((row) => added.push(row.item));
    assert.deepEqual(removed, []); assert.deepEqual(added, []);
    assert.equal(h.component.trackRound(0, { marketId: 42 }), 42);
    assert.equal(h.component.overShare(amounts({ pendingStakeCredits: 400, pendingOverCredits: 100 })), 25);
    assert.equal(h.component.overShare(amounts()), 0);
  } finally { h.destroy(); }
});

test('round phases use the displayed server snapshot instead of a drifting client clock', () => {
  const h = harness();
  try {
    h.component.snapshot = snapshot();
    const round = { status: 'open', bettingClosesAt: '2030-01-01T12:00:01Z', windowStart: '2030-01-01T12:01:00Z', windowEnd: '2030-01-01T12:02:00Z' };
    assert.equal(h.component.phase(round, camera()), 'Entries open');
    assert.equal(h.component.phase(round, camera(1, { isActive: false })), 'Camera archived');
    h.component.snapshot.asOf = round.bettingClosesAt; assert.equal(h.component.phase(round, camera()), 'Entries closed');
    h.component.snapshot.asOf = round.windowStart; assert.equal(h.component.phase(round, camera()), 'Counting');
    h.component.snapshot.asOf = round.windowEnd; assert.equal(h.component.phase(round, camera()), 'Awaiting verification');
  } finally { h.destroy(); }
});

test('volume API is an authenticated read without a member-controlled query or mutation', () => {
  let request;
  const injector = createEnvironmentInjector([{ provide: HttpClient, useValue: { get: (...args) => { request = args; return of(snapshot()); } } }]);
  try { const api = runInInjectionContext(injector, () => new ApiService()); api.stakeVolume().subscribe(); assert.deepEqual(request, ['/api/admin/stake-volume', { withCredentials: true }]); }
  finally { injector.destroy(); }
});

test('design preview aggregation preserves camera identity and sums sample pending stakes', async () => {
  const { HttpRequest } = await import('@angular/common/http');
  const { firstValueFrom } = await import('rxjs');
  const next = () => { throw new Error('Preview unexpectedly contacted a server'); };
  await firstValueFrom(previewInterceptor(new HttpRequest('POST', '/api/auth/login', { email: 'admin@demo.local' }), next));
  const response = await firstValueFrom(previewInterceptor(new HttpRequest('GET', '/api/admin/stake-volume'), next));
  assert.equal(response.body.totals.pendingStakeCredits, 50);
  assert.equal(response.body.cameras.length, 3);
  assert.ok(response.body.cameras.every((item) => Number.isInteger(item.streamId) && typeof item.title === 'string' && Array.isArray(item.rounds)));
  assert.equal(response.body.cameras.reduce((sum, item) => sum + item.pendingStakeCredits, 0), 50);
});

function detailsHarness() {
  const calls = [], timers = new Map(), listeners = new Set(); let timerId = 0;
  const document = { hidden: false, addEventListener: (_event, fn) => listeners.add(fn), removeEventListener: (_event, fn) => listeners.delete(fn), defaultView: { setInterval: (fn, delay) => { assert.equal(delay, 5000); timers.set(++timerId, fn); return timerId; }, clearInterval: (id) => timers.delete(id) } };
  const injector = createEnvironmentInjector([{ provide: DOCUMENT, useValue: document }, { provide: ApiService, useValue: { stakeDetails: (...args) => { const response = new Subject(); calls.push({ args, response }); return response; } } }]);
  const component = runInInjectionContext(injector, () => new AdminStakeDetailsComponent());
  component.streamId = 41; component.ngOnChanges(); component.ngOnInit();
  return { component, calls, document, timers, listeners, tick: () => { for (const fn of timers.values()) fn(); }, visibility: (hidden) => { document.hidden = hidden; for (const fn of listeners) fn(); }, destroy: () => { if (!injector.destroyed) { component.ngOnDestroy(); injector.destroy(); } } };
}
const betPage = (extra = {}) => ({ asOf: '2030-01-01T12:00:00Z', streamId: 41, status: 'pending', items: [{ id: 101, userId: 1, displayName: 'Test member', email: 'member@example.test' }], total: 1, stakeCredits: 100, page: 1, pageSize: 25, totalPages: 1, ...extra });

test('camera and round selection has separate scopes; changing selection clears private rows and cancels old requests', () => {
  const h = detailsHarness();
  try {
    assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].args, [41, undefined, 'pending', 1, 25]);
    h.component.marketId = 72; h.component.ngOnChanges();
    assert.equal(h.calls[0].response.observed, false); assert.equal(h.component.result, undefined);
    h.calls[0].response.next(betPage()); assert.equal(h.component.result, undefined);
    h.calls[1].response.next(betPage({ marketId: 72 })); h.calls[1].response.complete();
    assert.equal(h.component.result.marketId, 72);
    h.component.streamId = 42; h.component.marketId = undefined; h.component.ngOnChanges();
    assert.equal(h.component.result, undefined); assert.equal(h.component.page, 1); assert.equal(h.component.status, 'pending');
    h.calls[2].response.next(betPage()); h.calls[2].response.complete();
    assert.equal(h.component.result, undefined); assert.match(h.component.error, /did not match/);
  } finally { h.destroy(); }
});

test('individual stake status and page changes preserve scope, reset stale rows, and accept server page clamping', () => {
  const h = detailsHarness();
  try {
    h.calls[0].response.next(betPage({ total: 63, totalPages: 3, stakeCredits: 410 })); h.calls[0].response.complete();
    h.component.changePage(3); assert.equal(h.component.result, undefined);
    assert.deepEqual(h.calls[1].args, [41, undefined, 'pending', 3, 25]);
    h.calls[1].response.next(betPage({ total: 26, totalPages: 2, page: 2 })); h.calls[1].response.complete();
    assert.equal(h.component.page, 2); assert.equal(h.component.rangeStart, 26);
    h.component.changeStatus('all'); assert.deepEqual(h.calls[2].args, [41, undefined, 'all', 1, 25]);
    h.component.changePageSize(50); assert.equal(h.calls[2].response.observed, false);
    assert.deepEqual(h.calls[3].args, [41, undefined, 'all', 1, 50]);
    h.component.changeStatus("' OR 1=1--"); h.component.changePageSize(999); assert.equal(h.calls.length, 4);
  } finally { h.destroy(); }
});

test('individual stakes poll while visible without overlap and mark old data on errors, then cancel and clear on close', () => {
  const h = detailsHarness();
  try {
    h.tick(); assert.equal(h.calls.length, 1);
    h.calls[0].response.next(betPage()); h.calls[0].response.complete();
    h.tick(); h.calls[1].response.error(new HttpErrorResponse({ status: 503 }));
    assert.ok(h.component.error); assert.equal(h.component.result.items[0].id, 101);
    h.visibility(true); h.tick(); assert.equal(h.calls.length, 2);
    h.visibility(false); assert.equal(h.calls.length, 3);
    h.calls[2].response.next(betPage({ items: [], total: 0, stakeCredits: 0 })); h.calls[2].response.complete();
    assert.equal(h.component.error, ''); assert.equal(h.component.result.total, 0);
    h.tick(); h.destroy(); assert.equal(h.calls[3].response.observed, false);
    assert.equal(h.component.result, undefined); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
    h.calls[3].response.next(betPage()); assert.equal(h.component.result, undefined);
  } finally { h.destroy(); }
});

test('summary selection distinguishes all camera rounds from one round without issuing a bet mutation', () => {
  const h = harness();
  try {
    h.component.selectRound(camera(41), { marketId: 72, title: 'Test round' });
    assert.deepEqual(h.component.selection, { streamId: 41, marketId: 72, roundTitle: 'Test round' });
    h.component.selectCamera(camera(42)); assert.deepEqual(h.component.selection, { streamId: 42 });
    assert.equal(h.calls.length, 0);
  } finally { h.destroy(); }
});

test('individual-stake API binds camera, round, status and pagination as authenticated query parameters', () => {
  const requests = [];
  const injector = createEnvironmentInjector([{ provide: HttpClient, useValue: { get: (...args) => { requests.push(args); return of({}); } } }]);
  try {
    const api = runInInjectionContext(injector, () => new ApiService());
    api.stakeDetails(41, 72, 'pending', 2, 50).subscribe(); api.stakeDetails(42, undefined, 'all', 1, 25).subscribe();
    assert.equal(requests[0][0], '/api/admin/stake-volume/bets'); assert.equal(requests[0][1].withCredentials, true);
    assert.equal(requests[0][1].params.get('streamId'), '41'); assert.equal(requests[0][1].params.get('marketId'), '72');
    assert.equal(requests[0][1].params.get('status'), 'pending'); assert.equal(requests[0][1].params.get('page'), '2');
    assert.equal(requests[1][1].params.has('marketId'), false);
  } finally { injector.destroy(); }
});

test('design preview drill-down returns the member, amount and outcome on the selected camera and round', async () => {
  const { HttpRequest, HttpParams } = await import('@angular/common/http');
  const { firstValueFrom } = await import('rxjs');
  const next = () => { throw new Error('Unexpected server request'); };
  await firstValueFrom(previewInterceptor(new HttpRequest('POST', '/api/auth/login', { email: 'admin@demo.local' }), next));
  const response = await firstValueFrom(previewInterceptor(new HttpRequest('GET', '/api/admin/stake-volume/bets', { params: new HttpParams().set('streamId', 1).set('marketId', 3).set('status', 'pending') }), next));
  assert.equal(response.body.total, 1); assert.equal(response.body.stakeCredits, 50);
  assert.equal(response.body.items[0].displayName, 'Alex'); assert.equal(response.body.items[0].side, 'over');
  assert.equal(response.body.items[0].marketId, 3);
});


test('design preview Play can request four narrow v2 ranges without contacting a backend', async () => {
  const {HttpRequest,HttpParams}=await import('@angular/common/http');
  const {firstValueFrom}=await import('rxjs');
  const next=()=>{throw new Error('Preview unexpectedly contacted a server');};
  await firstValueFrom(previewInterceptor(new HttpRequest('POST','/api/auth/login',{email:'user@demo.local'}),next));
  const before=await firstValueFrom(previewInterceptor(new HttpRequest('GET','/api/me'),next));
  const response=await firstValueFrom(previewInterceptor(new HttpRequest('GET','/api/bets/range-options',{params:new HttpParams().set('marketId',1)}),next));
  assert.equal(response.body.options.length,4);
  assert.deepEqual(response.body.options.map(q=>[q.rangeMin,q.rangeMax]),[[12,23],[24,35],[36,47],[48,59]]);
  for(const option of response.body.options) {
    assert.ok(option.rangeMax-option.rangeMin<=14);
    assert.equal(option.pricingModel,'demo_normal_v2');assert.ok(option.odds>=1 && option.odds<=10);
    const quote=await firstValueFrom(previewInterceptor(new HttpRequest('GET','/api/bets/range-quote',{params:new HttpParams().set('marketId',1).set('from',option.rangeMin).set('to',option.rangeMax)}),next));
    assert.deepEqual(option,quote.body);
  }
  const after=await firstValueFrom(previewInterceptor(new HttpRequest('GET','/api/me'),next));
  assert.equal(after.body.balanceCredits,before.body.balanceCredits);
});
