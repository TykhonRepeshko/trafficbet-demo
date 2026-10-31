import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Subject, of } from 'rxjs';

const output = new URL(`.preparation-${process.pid}.mjs`, import.meta.url);
// Class/lifecycle tests only. Angular's production build checks the actual HTML;
// this fixture deliberately does not render or resolve an external template.
const bundle = await build({ stdin: { contents: "export { PreparationComponent } from './pages/preparation.component'; export { ApiService } from './services/api.service'; export { AccountSecurityComponent } from './components/account-security.component';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, plugins: [{ name: 'controlled-component-template', setup(builder) { builder.onLoad({ filter: /[\\/]preparation\.component\.ts$/ }, async ({ path }) => ({ contents: (await readFile(path, 'utf8')).replace(/templateUrl: '[^']+', styleUrl: '[^']+'/, "template: ''"), loader: 'ts' })); } }], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } } });
await writeFile(output, bundle.outputFiles[0].text); const { PreparationComponent, ApiService, AccountSecurityComponent } = await import(output.href); await unlink(output);
function harness() {
 const calls = [], timers = new Map(); let timer = 0; const oldWindow = globalThis.window, oldDocument = globalThis.document;
 globalThis.window = { setInterval: (callback) => { timers.set(++timer, callback); return timer; }, clearInterval: (id) => timers.delete(id) }; globalThis.document = { hidden: false };
 const api = new Proxy({}, { get: (_target, method) => (...args) => { const response = new Subject(); calls.push({ method, args, response }); return response; } });
 const injector = createEnvironmentInjector([{ provide: ApiService, useValue: api }]); const component = runInInjectionContext(injector, () => new PreparationComponent());
 return { component, calls, timers, destroy: () => { component.ngOnDestroy(); injector.destroy(); globalThis.window = oldWindow; globalThis.document = oldDocument; } };
}
test('switching camera cancels an old private response and exiting stops polling', () => { const h = harness(); try { h.component.ngOnInit(); h.component.selectCamera(41); const old = h.calls.at(-1); h.component.selectCamera(42); assert.equal(old.response.observed, false); old.response.next({ streamId: 41 }); assert.equal(h.component.preparation, undefined); h.calls.at(-1).response.next({ streamId: 42, profiles: [], references: [], sourceFingerprint: 'b' }); assert.equal(h.component.preparation.streamId, 42); h.destroy(); assert.equal(h.timers.size, 0); assert.ok(h.calls.every((call) => !call.response.observed)); } finally { if (h.timers.size) h.destroy(); } });
test('operator forms never infer verified timing or allow settlement from an older review', () => { const h = harness(); try { h.component.detail = { market: { id: 5 }, reviews: [{ outcome: 'needs_review' }, { outcome: 'verified', proposedCount: 12 }], observations: [] }; h.component.settle(); assert.equal(h.calls.length, 0); h.component.outcome = 'verified'; h.component.proposedCount = 0; h.component.note = 'Zero is only valid after complete independent evidence.'; h.component.saveReview(); assert.equal(h.calls.length, 0); assert.match(h.component.error, /timing, coverage and framing/); h.component.timeOK = h.component.coverageOK = h.component.framingOK = true; h.component.saveReview(); assert.equal(h.calls[0].method, 'saveRoundReview'); assert.equal(h.calls[0].args[1].proposedCount, 0); h.component.saveReview(); assert.equal(h.calls.length, 1); h.calls[0].response.error(new HttpErrorResponse({ status: 503 })); assert.equal(h.component.busy, false); assert.match(h.component.error, /Refresh before retrying/); } finally { h.destroy(); } });

test('disabled retained video blocks versioned verification and settlement even with an old evidence ID', () => {
 const h = harness();
 try {
  h.component.detail = { market: { id: 8 }, snapshot: { profileId: 4 }, reviews: [{ outcome: 'verified', proposedCount: 0 }], observations: [] };
  h.component.settle(); assert.equal(h.calls.length, 0); assert.equal(h.component.confirmedReview, undefined);
  h.component.outcome = 'verified'; h.component.proposedCount = 0; h.component.note = 'Capture UTC needs retained evidence beyond checked boxes.';
  h.component.timeOK = h.component.coverageOK = h.component.framingOK = true;
  h.component.saveReview(); assert.equal(h.calls.length, 0); assert.match(h.component.error, /Retained video is currently disabled/);
  for (const invalid of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
   h.component.evidenceId = invalid; h.component.saveReview(); assert.equal(h.calls.length, 0); assert.match(h.component.error, /Retained video is currently disabled/);
  }
  h.component.evidenceId = 23; h.component.saveReview();
  assert.equal(h.calls.length, 0);
  h.component.detail.reviews[0].evidenceId = 23;
  h.component.settle(); assert.equal(h.calls.length, 0); assert.equal(h.component.confirmedReview, undefined);
  h.component.evidenceId = 24; h.component.openReview(9); assert.equal(h.component.evidenceId, undefined);
 } finally { h.destroy(); }
});
test('transport state becomes stale after source changes and drafts do not mutate saved rules', () => { const h = harness(); try { const camera = { sourceFingerprint: 'new', observation: { sourceFingerprint: 'old', observedAt: new Date().toISOString() } }; assert.equal(h.component.stale(camera), true); camera.observation.sourceFingerprint = 'new'; assert.equal(h.component.stale(camera), false); const profile = { referenceId: 8, definition: { classes: ['car'], lineStart: { x: .1, y: .5 } } }; h.component.copyProfile(profile); h.component.definition.classes.push('truck'); h.component.definition.lineStart.x = .2; assert.deepEqual(profile.definition.classes, ['car']); assert.equal(profile.definition.lineStart.x, .1); } finally { h.destroy(); } });
test('security actions send credentials only in authenticated bodies and clear them on failure', () => { const calls = []; const response = new Subject(); const injector = createEnvironmentInjector([{ provide: HttpClient, useValue: { post: (...args) => { calls.push(args); return response; }, get: () => of({ sessions: [] }) } }]); try { const component = runInInjectionContext(injector, () => new AccountSecurityComponent()); component.password = 'private password'; component.action('revoke', 7); component.action('revoke', 7); assert.equal(calls.length, 1); assert.equal(calls[0][0], '/api/me/security/revoke'); assert.equal(calls[0][1].sessionId, 7); assert.equal(calls[0][2].withCredentials, true); response.error(new HttpErrorResponse({ status: 400 })); assert.equal(component.password, ''); assert.equal(component.busy, false); } finally { injector.destroy(); } });
