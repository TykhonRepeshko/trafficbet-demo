import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DOCUMENT } from '@angular/common';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpRequest } from '@angular/common/http';
import { Subject, of, firstValueFrom } from 'rxjs';

const output = new URL(`.round-schedules-${process.pid}.mjs`, import.meta.url);
const bundle = await build({ stdin: { contents: "export { AdminRoundSchedulesComponent } from './components/admin-round-schedules.component'; export { ApiService } from './services/api.service'; export { previewInterceptor } from './preview/preview.interceptor';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } } });
await writeFile(output, bundle.outputFiles[0].text);
const { AdminRoundSchedulesComponent, ApiService, previewInterceptor } = await import(output.href);
await unlink(output);
const settings = () => ({ enabled: true, countingRule: 'Vehicle centers crossing the mid-frame line', threshold: 30, oddsOver: 1.9, oddsUnder: 1.9, entrySeconds: 30, leadSeconds: 30, countingSeconds: 30 });
const schedule = (extra = {}) => ({ ...settings(), streamId: 41, streamTitle: 'Bergen', isActive: true, supported: true, nextRunAt: '2030-01-01T12:12:00Z', lastCheckedAt: '2030-01-01T12:00:00Z', lastMarketId: 11, awaitingVerification: 1, ...extra });
const snapshot = (extra = {}) => ({ asOf: '2030-01-01T12:00:00Z', schedules: [schedule(extra)] });

function harness() {
  const gets = [], puts = [], timers = new Map(), listeners = new Set(); let nextTimer = 0;
  const document = { hidden: false, addEventListener: (_event, callback) => listeners.add(callback), removeEventListener: (_event, callback) => listeners.delete(callback), defaultView: { setInterval: (callback, ms) => { assert.equal(ms, 10000); timers.set(++nextTimer, callback); return nextTimer; }, clearInterval: (id) => timers.delete(id) } };
  const injector = createEnvironmentInjector([{ provide: DOCUMENT, useValue: document }, { provide: ApiService, useValue: {
    roundSchedules: () => { const response = new Subject(); gets.push(response); return response; },
    saveRoundSchedule: (id, body) => { const response = new Subject(); puts.push({ id, body, response }); return response; }
  } }]);
  const component = runInInjectionContext(injector, () => new AdminRoundSchedulesComponent());
  return { component, gets, puts, timers, listeners, document, tick: () => { for (const callback of timers.values()) callback(); }, destroy: () => { if (!injector.destroyed) { component.ngOnDestroy(); injector.destroy(); } } };
}

test('schedule polling avoids overlap, pauses while hidden, retains stale data and tears down on exit', () => {
  const h = harness();
  try {
    h.component.ngOnInit(); h.tick(); assert.equal(h.gets.length, 1);
    h.gets[0].next(snapshot()); h.gets[0].complete();
    h.document.hidden = true; h.tick(); assert.equal(h.gets.length, 1);
    h.document.hidden = false; for (const listener of h.listeners) listener();
    h.gets[1].error(new HttpErrorResponse({ status: 503 }));
    assert.ok(h.component.error); assert.equal(h.component.snapshot.schedules[0].threshold, 30);
    h.tick(); assert.equal(h.gets.length, 3);
    h.destroy(); assert.equal(h.gets[2].observed, false); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
    h.gets[2].next(snapshot({ threshold: 999 })); assert.equal(h.component.snapshot.schedules[0].threshold, 30);
  } finally { h.destroy(); }
});

test('background refresh keeps unsaved edits and save cancels a stale read before publishing only editable fields', () => {
  const h = harness();
  try {
    h.component.ngOnInit(); h.gets[0].next(snapshot()); h.gets[0].complete();
    h.component.edit(h.component.snapshot.schedules[0]); h.component.draft.threshold = 123;
    h.tick(); h.gets[1].next(snapshot({ threshold: 50 })); h.gets[1].complete();
    assert.equal(h.component.draft.threshold, 123); assert.equal(h.component.snapshot.schedules[0].threshold, 50);
    h.tick(); assert.equal(h.gets[2].observed, true);
    h.component.save(); assert.equal(h.gets[2].observed, false);
    assert.equal(h.puts[0].id, 41); assert.deepEqual(h.puts[0].body, { ...settings(), threshold: 123 });
    h.component.save(); h.tick(); assert.equal(h.puts.length, 1); assert.equal(h.gets.length, 3);
    h.puts[0].response.error(new HttpErrorResponse({ status: 500 }));
    assert.equal(h.component.editingId, 41); assert.equal(h.component.draft.threshold, 123); assert.ok(h.component.saveError);
    h.component.save(); h.puts[1].response.next({ saved: true }); h.puts[1].response.complete();
    assert.equal(h.component.editingId, undefined); assert.ok(h.component.message); assert.equal(h.gets.length, 4);
    h.gets[3].next(snapshot({ threshold: 123 })); assert.equal(h.component.error, '');
  } finally { h.destroy(); }
});

test('invalid schedule input never reaches the API and a disabled schedule preserves all configuration fields', () => {
  const h = harness();
  try {
    for (const extra of [{ leadSeconds: 29 }, { entrySeconds: 0 }, { countingSeconds: 1.5 }, { threshold: -1 }, { oddsOver: 1.999 }, { countingRule: 'x\nline' }, { countingRule: 'é'.repeat(81) }]) {
      h.component.edit(schedule(extra)); h.component.save(); assert.ok(h.component.saveError); assert.equal(h.puts.length, 0);
    }
    h.component.edit(schedule()); h.component.draft.enabled = false; h.component.save();
    assert.deepEqual(h.puts[0].body, { ...settings(), enabled: false });
  } finally { h.destroy(); }
});

test('enabled status requires recent server worker evidence and archive/source state takes precedence', () => {
  const h = harness();
  try {
    h.component.snapshot = snapshot();
    assert.equal(h.component.state(schedule()), 'Enabled');
    assert.equal(h.component.state(schedule({ lastCheckedAt: null })), 'Starting');
    assert.equal(h.component.state(schedule({ lastCheckedAt: '2030-01-01T11:58:00Z' })), 'Worker overdue');
    assert.equal(h.component.state(schedule({ isActive: false })), 'Camera archived');
    assert.equal(h.component.state(schedule({ supported: false })), 'Live source required');
    assert.equal(h.component.state(schedule({ enabled: false })), 'Disabled');
  } finally { h.destroy(); }
});

test('schedule API uses authenticated bounded paths and never posts generated timestamps or round IDs', () => {
  const calls = [];
  const injector = createEnvironmentInjector([{ provide: HttpClient, useValue: { get: (...args) => { calls.push(args); return of(snapshot()); }, put: (...args) => { calls.push(args); return of({ saved: true }); } } }]);
  try {
    const api = runInInjectionContext(injector, () => new ApiService()); api.roundSchedules().subscribe(); api.saveRoundSchedule(41, settings()).subscribe();
    assert.deepEqual(calls, [['/api/admin/round-schedules', { withCredentials: true }], ['/api/admin/round-schedules/41', settings(), { withCredentials: true }]]);
  } finally { injector.destroy(); }
});

test('design preview protects schedule configuration and keeps changes in memory without claiming a running worker', async () => {
  const request = async (method, path, body) => (await firstValueFrom(previewInterceptor(new HttpRequest(method, path, body), () => { throw new Error('Unexpected network request'); }))).body;
  await assert.rejects(request('GET', '/api/admin/round-schedules', null), (error) => error.status === 401);
  await request('POST', '/api/auth/login', { email: 'user@demo.local' });
  await assert.rejects(request('PUT', '/api/admin/round-schedules/1', settings()), (error) => error.status === 403);
  await request('POST', '/api/auth/login', { email: 'admin@demo.local' });
  await request('PUT', '/api/admin/round-schedules/1', settings());
  const data = await request('GET', '/api/admin/round-schedules', null);
  assert.equal(data.schedules[0].enabled, true); assert.equal(data.schedules[0].lastCheckedAt, null); assert.equal(data.schedules[0].lastMarketId, null);
  await assert.rejects(request('PUT', '/api/admin/round-schedules/3', settings()), (error) => error.status === 409);
  await request('POST', '/api/auth/logout', {});
});
