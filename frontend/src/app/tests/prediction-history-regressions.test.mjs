import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { Subject, of } from 'rxjs';

const output = new URL(`.prediction-history-${process.pid}.mjs`, import.meta.url);
const bundle = await build({
  stdin: { contents: "export { BetsComponent } from './pages/bets.component'; export { ApiService } from './services/api.service'; export { AuthService } from './services/auth.service';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
});
await writeFile(output, bundle.outputFiles[0].text);
const { BetsComponent, ApiService, AuthService } = await import(output.href);
await unlink(output);

const bet = (id, status) => ({ id, marketId: 70 + id, userId: 1, side: 'range', rangeMin: 12, rangeMax: 25, stakeCredits: 100, potentialPayoutCredits: 325, status, createdAt: '2030-01-01T12:00:00Z' });
function harness() {
  const requests = [], mutations = [];
  let refreshes = 0;
  const injector = createEnvironmentInjector([
    { provide: AuthService, useValue: { user: { id: 1, balanceCredits: 900 }, refreshMe: () => { refreshes++; return of({ id: 1, balanceCredits: 900 }); } } },
    { provide: ApiService, useValue: { myBets: () => { const response = new Subject(); requests.push(response); return response; }, createBet: (...args) => { mutations.push(args); throw new Error('History must not create a stake'); } } },
  ]);
  const component = runInInjectionContext(injector, () => new BetsComponent());
  return { component, requests, mutations, refreshes: () => refreshes, destroy: () => { if (!injector.destroyed) injector.destroy(); } };
}

test('history distinguishes a possible return, a winning return, a loss and an exact original-stake refund', () => {
  const h = harness();
  try {
    const predictions = ['pending', 'won', 'lost', 'void'].map((status, index) => bet(index + 1, status));
    const before = structuredClone(predictions);
    assert.deepEqual(predictions.map(item => h.component.returnAmount(item)), [325, 325, 0, 100]);
    assert.deepEqual(predictions.map(item => h.component.returnLabel(item)), ['Potential return', 'Returned', 'Returned', 'Refunded']);
    assert.match(h.component.returnHint(predictions[0]), /If you win/);
    assert.match(h.component.returnHint(predictions[1]), /includes your stake/);
    assert.match(h.component.returnHint(predictions[2]), /no credits returned/);
    assert.match(h.component.returnHint(predictions[3]), /Original stake returned/);
    assert.deepEqual(predictions, before, 'Displaying return amounts modified accepted financial records');
    assert.deepEqual(h.mutations, []);
  } finally { h.destroy(); }
});

test('awaiting-results filtering keeps all accepted history, identities and totals available without a write', () => {
  const h = harness();
  try {
    h.component.bets = [bet(1, 'pending'), bet(2, 'won'), bet(3, 'pending'), bet(4, 'void')];
    h.component.filter = 'pending';
    assert.deepEqual(h.component.visibleBets.map(item => item.id), [1, 3]);
    assert.equal(h.component.pending, 2); assert.equal(h.component.bets.length, 4);
    const first = h.component.visibleBets[0];
    assert.equal(h.component.trackBet(0, first), first.id);
    assert.match(h.component.predictionLabel(first), /12–25 vehicles/);
    h.component.filter = 'all'; assert.equal(h.component.visibleBets.length, 4);
    assert.deepEqual(h.mutations, []); assert.equal(h.requests.length, 0);
  } finally { h.destroy(); }
});

test('a refresh cancels stale reads, restores only the current history and releases requests on navigation', () => {
  const h = harness();
  try {
    h.component.ngOnInit(); h.component.load();
    assert.equal(h.requests[0].observed, false);
    h.requests[1].next([bet(2, 'void')]); h.requests[1].complete();
    assert.equal(h.component.loading, false); assert.equal(h.component.bets[0].id, 2); assert.equal(h.refreshes(), 1);
    h.requests[0].next([bet(1, 'pending')]);
    assert.equal(h.component.bets[0].id, 2, 'Older history replaced the refreshed result');
    h.component.load(); h.destroy();
    assert.equal(h.requests[2].observed, false);
    assert.deepEqual(h.mutations, []);
  } finally { h.destroy(); }
});
