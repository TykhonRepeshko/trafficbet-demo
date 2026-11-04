import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpRequest } from '@angular/common/http';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { BehaviorSubject, Subject, of } from 'rxjs';

// Exercise the actual Angular classes through dependency injection without a browser or DOM renderer.
const output = new URL(`.frontend-regressions-${process.pid}.mjs`, import.meta.url);
const bundle = await build({
  stdin: { contents: `
    export * from './services/round-state';
    export * from './services/session.interceptor';
    export { AuthService } from './services/auth.service';
    export { ApiService } from './services/api.service';
    export { StreamDetailComponent } from './pages/stream-detail.component';
    export { AdminComponent } from './pages/admin.component';
    export { LoginComponent } from './pages/login.component';
    export { routes } from './app.routes';
  `, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }
});
await writeFile(output, bundle.outputFiles[0].text);
const { roundPhase, acceptsPredictions, sessionInterceptor, AuthService, ApiService, StreamDetailComponent, AdminComponent, LoginComponent, routes } = await import(output.href);
await unlink(output);

const start = Date.parse('2030-01-01T12:00:00Z');
const round = { id: 1, streamId: 1, status: 'open', bettingClosesAt: new Date(start - 30_000).toISOString(), windowStart: new Date(start).toISOString(), windowEnd: new Date(start + 60_000).toISOString() };
const stream = { id: 1, isActive: true, streamType: 'hls', streamUrl: '/api/media/streams/1/index.m3u8', updatedAt: '2030-01-01T11:00:00Z' };
const user = { id: 1, balanceCredits: 100, role: 'user', displayName: 'Test account' };

function loginHarness(query = {}, role = 'user') {
  const response = new Subject(), calls = [], navigation = [];
  const route = { snapshot: { queryParamMap: convertToParamMap(query) } };
  const auth = { user: { ...user, role }, isAdmin: role === 'admin', login: (...args) => { calls.push(args); return response; } };
  const injector = createEnvironmentInjector([
    { provide: AuthService, useValue: auth },
    { provide: ActivatedRoute, useValue: route },
    { provide: Router, useValue: { navigateByUrl: (url) => { navigation.push(url); return Promise.resolve(true); } } }
  ]);
  const component = runInInjectionContext(injector, () => new LoginComponent());
  component.email = ' operator@example.com '; component.password = 'password';
  return { component, response, calls, navigation, route, destroy: () => injector.destroy() };
}

test('the public admin entry sends guests and members to administrator sign-in; administrators pass both guards', () => {
  const adminRoute = routes.find((route) => route.path === 'admin');
  assert.equal(adminRoute.canActivate.length, 2);
  for (const role of ['guest', 'user', 'admin']) {
    const redirects = [], auth = { user: role === 'guest' ? null : { ...user, role }, isAdmin: role === 'admin' };
    const injector = createEnvironmentInjector([
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: { createUrlTree: (commands, extras) => { const tree = { commands, ...extras }; redirects.push(tree); return tree; } } }
    ]);
    try {
      const signedIn = runInInjectionContext(injector, () => adminRoute.canActivate[0]({}, { url: '/admin' }));
      if (role === 'guest') {
        assert.deepEqual(signedIn, { commands: ['/login'], queryParams: { returnUrl: '/admin' } });
        continue;
      }
      assert.equal(signedIn, true);
      const administrator = runInInjectionContext(injector, () => adminRoute.canActivate[1]({}, { url: '/admin' }));
      if (role === 'admin') { assert.equal(administrator, true); assert.equal(redirects.length, 0); }
      else assert.deepEqual(administrator, { commands: ['/login'], queryParams: { returnUrl: '/admin', admin: 'required' } });
    } finally { injector.destroy(); }
  }
});

test('member sign-in cannot continue to admin and does not leave a submitted password in the form', () => {
  const { component, response, calls, navigation, destroy } = loginHarness({ returnUrl: '/admin', admin: 'required' });
  try {
    assert.equal(component.adminRequired, true);
    component.submit();
    assert.deepEqual(calls, [['operator@example.com', 'password']]);
    assert.equal(component.loading, true);
    response.next({ user }); response.complete();
    assert.equal(component.loading, false);
    assert.equal(component.password, '');
    assert.match(component.error, /administrator account is required/i);
    assert.deepEqual(navigation, []);
  } finally { destroy(); }
});

test('administrator sign-in continues to the protected admin route once', () => {
  const { component, response, calls, navigation, destroy } = loginHarness({ returnUrl: '/admin' }, 'admin');
  try {
    component.submit(); component.submit();
    assert.equal(calls.length, 1, 'A second submit started a concurrent login');
    response.next({ user: { ...user, role: 'admin' } }); response.complete();
    assert.deepEqual(navigation, ['/admin']);
    assert.equal(component.error, ''); assert.equal(component.password, '');
  } finally { destroy(); }
});

test('sign-in return destinations reject external URLs, scheme-relative URLs and encoded route escapes', () => {
  for (const returnUrl of ['https://example.com/admin', '//example.com/admin', '/\\example.com/admin', 'javascript:alert(1)', '/%2f%2fexample.com', '/admin/../../account', '/admin?returnUrl=https://example.com', '/streams/1#//example.com']) {
    const { component, response, navigation, destroy } = loginHarness({ returnUrl }, 'admin');
    try {
      component.submit(); response.next({ user }); response.complete();
      assert.deepEqual(navigation, ['/'], `Unsafe return destination was accepted: ${returnUrl}`);
    } finally { destroy(); }
  }
  for (const returnUrl of ['/bets', '/account', '/streams/37']) {
    const { component, response, navigation, destroy } = loginHarness({ returnUrl });
    try {
      component.submit(); response.next({ user }); response.complete();
      assert.deepEqual(navigation, [returnUrl], 'An allowed internal destination was lost');
    } finally { destroy(); }
  }
});

test('rejected administrator credentials clear the password, report the failure and stay on sign-in', () => {
  const { component, response, navigation, destroy } = loginHarness({ returnUrl: '/admin' });
  try {
    component.submit(); response.error(new HttpErrorResponse({ status: 401 }));
    assert.equal(component.loading, false); assert.equal(component.password, '');
    assert.equal(component.error, 'The email address or password is incorrect.');
    assert.deepEqual(navigation, []);
  } finally { destroy(); }
});

test('a reused sign-in page updates administrator guidance and registration return links when query parameters change', () => {
  const { component, route, response, navigation, destroy } = loginHarness();
  try {
    assert.equal(component.adminRequired, false);
    route.snapshot = { queryParamMap: convertToParamMap({ returnUrl: '/admin', admin: 'required' }) };
    assert.equal(component.adminRequired, true, 'A reused sign-in page still presents ordinary member guidance');
    assert.deepEqual(component.returnParams, { returnUrl: '/admin' });
    route.snapshot = { queryParamMap: convertToParamMap({ returnUrl: '/account' }) };
    assert.equal(component.adminRequired, false, 'Administrator guidance persisted for an ordinary member route');
    assert.deepEqual(component.returnParams, { returnUrl: '/account' });
    component.submit(); response.next({ user }); response.complete();
    assert.deepEqual(navigation, ['/account']);
  } finally { destroy(); }
});

test('refreshing administrator data cancels the previous load and rejects its stale response', () => {
  const names = ['streams', 'markets', 'bets', 'users'];
  const requests = Array.from({ length: 3 }, () => Object.fromEntries(names.map((name) => [name, new Subject()])));
  let current = 0;
  const injector = createEnvironmentInjector([
    { provide: AuthService, useValue: { user: { ...user, role: 'admin' }, isAdmin: true } },
    { provide: ApiService, useValue: {
      adminStreams: () => requests[current].streams, listMarkets: () => requests[current].markets,
      adminBets: () => requests[current].bets, adminUserPage: () => requests[current].users
    } }
  ]);
  const component = runInInjectionContext(injector, () => new AdminComponent());
  const finish = (index, id) => {
    const values = { streams: [{ ...stream, id }], markets: [], bets: [], users: { items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 } };
    for (const name of names) { requests[index][name].next(values[name]); requests[index][name].complete(); }
  };
  try {
    component.load();
    assert.equal(requests[0].streams.observed, true);
    current = 1; component.load();
    for (const name of names) assert.equal(requests[0][name].observed, false, `The old ${name} request remains subscribed`);
    finish(1, 2);
    assert.equal(component.loading, false); assert.equal(component.loadFailed, false);
    assert.equal(component.streams[0].id, 2);
    finish(0, 1);
    assert.equal(component.streams[0].id, 2, 'A previous refresh replaced the latest camera catalog');
    current = 2; component.load();
    assert.equal(requests[2].streams.observed, true);
    injector.destroy();
    for (const name of names) assert.equal(requests[2][name].observed, false, `The destroyed page retained its ${name} request`);
  } finally { if (!injector.destroyed) injector.destroy(); }
});

function directoryHarness() {
  const requests = [];
  const injector = createEnvironmentInjector([
    { provide: AuthService, useValue: { isAdmin: true } },
    { provide: ApiService, useValue: { adminUserPage: (...args) => { const response = new Subject(); requests.push({ args, response }); return response; } } }
  ]);
  const component = runInInjectionContext(injector, () => new AdminComponent());
  component.loading = false;
  return { component, requests, destroy: () => { if (!injector.destroyed) { component.ngOnDestroy(); injector.destroy(); } } };
}

test('account search cancels prior pages, resets pagination and keeps only the latest result', () => {
  const h = directoryHarness();
  try {
    h.component.loadUsers(3);
    h.component.userSearch = '  D\'Arcy %_  '; h.component.applyUserSearch();
    assert.deepEqual(h.requests.map((r) => r.args), [[3, 25, ''], [1, 25, "D'Arcy %_"]]);
    assert.equal(h.requests[0].response.observed, false);
    h.requests[1].response.next({ items: [user], total: 1, page: 1, pageSize: 25, totalPages: 1 }); h.requests[1].response.complete();
    h.requests[0].response.next({ items: [], total: 500, page: 3, pageSize: 25, totalPages: 20 });
    assert.equal(h.component.userTotal, 1); assert.deepEqual(h.component.users, [user]);
    assert.equal(h.component.userRangeStart, 1); assert.equal(h.component.userRangeEnd, 1);
    h.component.changeUserPageSize(50);
    assert.deepEqual(h.requests[2].args, [1, 50, "D'Arcy %_"]);
    h.component.clearUserSearch();
    assert.equal(h.requests[2].response.observed, false);
    assert.deepEqual(h.requests[3].args, [1, 50, '']);
    h.destroy(); assert.equal(h.requests[3].response.observed, false);
  } finally { h.destroy(); }
});

test('account pagination respects server-clamped pages and errors cannot leave stale results visible', () => {
  const h = directoryHarness();
  try {
    h.component.loadUsers(3);
    h.requests[0].response.next({ items: [user], total: 26, page: 2, pageSize: 25, totalPages: 2 }); h.requests[0].response.complete();
    assert.equal(h.component.userPage, 2); assert.equal(h.component.userRangeStart, 26);
    h.component.changeUserPage(3); h.component.changeUserPage(-1); h.component.changeUserPageSize(1000000);
    assert.equal(h.requests.length, 1);
    h.component.changeUserPage(1); assert.deepEqual(h.requests[1].args, [1, 25, '']);
    h.requests[1].response.error(new HttpErrorResponse({ status: 503 }));
    assert.equal(h.component.usersLoading, false); assert.deepEqual(h.component.users, []);
    assert.ok(h.component.userError); assert.equal(h.component.userRangeStart, 0);
    h.component.changeUserPage(2); assert.equal(h.requests.length, 2);
    h.component.loadUsers(1); assert.equal(h.requests.length, 3);
  } finally { h.destroy(); }
});

test('camera archiving requires the selected confirmation and restoration sends only its ID', () => {
  const calls = []; let response = new Subject();
  const injector = createEnvironmentInjector([
    { provide: AuthService, useValue: {} },
    { provide: ApiService, useValue: { archiveStream: (...args) => { calls.push(['archive', ...args]); return response; }, restoreStream: (...args) => { calls.push(['restore', ...args]); return response; } } }
  ]);
  const component = runInInjectionContext(injector, () => new AdminComponent());
  component.load = () => {};
  try {
    component.toggleStream(stream); assert.deepEqual(calls, []);
    component.archiveCandidateId = stream.id; component.toggleStream(stream); component.toggleStream(stream);
    assert.deepEqual(calls, [['archive', stream.id]]); assert.equal(component.busy, true);
    response.next({}); response.complete(); assert.equal(component.busy, false); assert.equal(component.showArchived, true);
    assert.equal(component.archiveCandidateId, undefined);
    response = new Subject(); component.toggleStream({ ...stream, isActive: false });
    assert.deepEqual(calls[1], ['restore', stream.id]);
    response.next(stream); response.complete(); assert.match(component.message, /restored/);
  } finally { component.ngOnDestroy(); injector.destroy(); }
});

test('directory API binds query parameters and restoration uses an empty, authenticated PATCH', () => {
  const calls = [];
  const injector = createEnvironmentInjector([{ provide: HttpClient, useValue: { get: (...args) => { calls.push(['get', ...args]); return of({}); }, patch: (...args) => { calls.push(['patch', ...args]); return of({}); } } }]);
  try {
    const api = runInInjectionContext(injector, () => new ApiService());
    api.adminUserPage(2, 50, "' OR 1=1-- & q=other").subscribe();
    assert.equal(calls[0][1], '/api/admin/users'); assert.equal(calls[0][2].params.get('page'), '2');
    assert.equal(calls[0][2].params.get('q'), "' OR 1=1-- & q=other"); assert.equal(calls[0][2].withCredentials, true);
    api.restoreStream(41).subscribe();
    assert.deepEqual(calls[1], ['patch', '/api/admin/streams/41/restore', {}, { withCredentials: true }]);
  } finally { injector.destroy(); }
});

test('round phases change at the exact deadline, start and end boundaries', () => {
  assert.equal(roundPhase(round, start - 30_001), 'open');
  assert.equal(roundPhase(round, start - 30_000), 'locked');
  assert.equal(roundPhase(round, start), 'counting');
  assert.equal(roundPhase(round, start + 60_000), 'verifying');
});

test('invalid times and observation gaps cannot enable predictions', () => {
  for (const invalid of [
    { ...round, bettingClosesAt: 'invalid' }, { ...round, windowStart: 'invalid' },
    { ...round, windowEnd: round.windowStart },
    { ...round, bettingClosesAt: new Date(start - 29_999).toISOString() }
  ]) assert.equal(acceptsPredictions(invalid, start - 60_000, stream), false);
  assert.equal(acceptsPredictions(round, Number.NaN, stream), false);
});

test('archived cameras and periodic recordings cannot accept predictions', () => {
  assert.equal(acceptsPredictions(round, start - 60_000, stream), true);
  assert.equal(acceptsPredictions(round, start - 60_000, { ...stream, isActive: false }), false);
  for (const streamType of ['mp4', 'image', 'rtsp', 'iframe']) {
    assert.equal(acceptsPredictions(round, start - 60_000, { ...stream, streamType }), false);
  }
  for (const status of ['draft', 'void', 'settled']) {
    assert.equal(acceptsPredictions({ ...round, status }, start - 60_000, stream), false);
    assert.equal(roundPhase({ ...round, status }, start - 60_000), status);
  }
});

test('camera navigation cancels prior requests; background updates retain the player and hide completed rounds', () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = { setInterval: () => 1, clearInterval: () => {} };
  globalThis.document = { hidden: false };
  const params = new BehaviorSubject(convertToParamMap({ id: '1' }));
  const firstCamera = new Subject(), secondCamera = new Subject();
  let completed = false;
  const api = {
    getStream: (id) => id === 1 ? firstCamera : completed ? of({ ...stream, id: 2 }) : secondCamera,
    listPublicMarkets: (_id, status) => {
      assert.equal(status, 'open');
      return of(completed ? [{ ...round, status: 'settled', actualCount: 10 }, { ...round, id: 2, status: 'draft' }] : []);
    },
    listMetrics: () => of([])
  };
  const injector = createEnvironmentInjector([
    { provide: AuthService, useValue: { user } }, { provide: ApiService, useValue: api },
    { provide: ActivatedRoute, useValue: { paramMap: params } }
  ]);
  const component = runInInjectionContext(injector, () => new StreamDetailComponent());
  try {
    component.ngOnInit();
    assert.equal(firstCamera.observed, true);
    params.next(convertToParamMap({ id: '2' }));
    assert.equal(firstCamera.observed, false, 'The previous route request remains subscribed');
    firstCamera.next(stream); firstCamera.complete();
    assert.equal(component.stream, undefined, 'A stale camera response changed the current page');
    secondCamera.next({ ...stream, id: 2 }); secondCamera.complete();
    assert.equal(component.stream.id, 2);
    const playerInput = component.stream;
    completed = true;
    component.load(true);
    assert.equal(component.stream, playerInput, 'A status-only refresh reset the video player');
    assert.equal(component.loading, false);
    assert.equal(component.markets.length, 0, 'Draft and completed rounds should not enter the camera list');
    assert.deepEqual(component.activeMarkets, []);
  } finally {
    component.ngOnDestroy(); injector.destroy();
    globalThis.window = oldWindow; globalThis.document = oldDocument;
  }
});

function sessionHarness() {
  const injector = createEnvironmentInjector([{ provide: HttpClient, useValue: { post: () => of({ user }) } }]);
  const auth = runInInjectionContext(injector, () => new AuthService());
  const child = createEnvironmentInjector([{ provide: AuthService, useValue: auth }], injector);
  auth.updateUser(user);
  return { auth, child, destroy: () => { child.destroy(); injector.destroy(); } };
}

test('authenticated API 401 clears account state and marks the session expired', () => {
  const { auth, child, destroy } = sessionHarness();
  try {
    const response = new Subject();
    runInInjectionContext(child, () => sessionInterceptor(new HttpRequest('GET', '/api/bets/my'), () => response)).subscribe({ error: () => {} });
    response.error(new HttpErrorResponse({ status: 401 }));
    assert.equal(auth.user, null); assert.equal(auth.sessionExpired, true);
  } finally { destroy(); }
});

test('failed sign-in and unrelated requests do not clear an existing session', () => {
  const { auth, child, destroy } = sessionHarness();
  try {
    for (const url of ['/api/auth/login', 'https://example.com/api/me']) {
      const response = new Subject();
      runInInjectionContext(child, () => sessionInterceptor(new HttpRequest('GET', url), () => response)).subscribe({ error: () => {} });
      response.error(new HttpErrorResponse({ status: 401 }));
      assert.equal(auth.user, user);
    }
  } finally { destroy(); }
});

test('a stale 401 cannot expire a new session for the same account', () => {
  const { auth, child, destroy } = sessionHarness();
  try {
    const response = new Subject();
    runInInjectionContext(child, () => sessionInterceptor(new HttpRequest('GET', '/api/me'), () => response)).subscribe({ error: () => {} });
    auth.login('test@example.com', 'password').subscribe();
    response.error(new HttpErrorResponse({ status: 401 }));
    assert.equal(auth.user, user); assert.equal(auth.sessionExpired, false);
  } finally { destroy(); }
});

test('a profile response received after sign-out cannot restore the old account', () => {
  const response = new Subject();
  const injector = createEnvironmentInjector([{ provide: HttpClient, useValue: { get: () => response, post: () => of({ ok: true }) } }]);
  const auth = runInInjectionContext(injector, () => new AuthService());
  try {
    auth.updateUser(user);
    auth.refreshMe().subscribe();
    auth.logout().subscribe();
    response.next(user); response.complete();
    assert.equal(auth.user, null);
  } finally { injector.destroy(); }
});

test('a prediction response from an earlier session cannot replace a fresh balance after signing in again', () => {
  const response = new Subject(), freshUser = { ...user, balanceCredits: 200 };
  const injector = createEnvironmentInjector([{ provide: HttpClient, useValue: { post: () => of({ user: freshUser }) } }]);
  const auth = runInInjectionContext(injector, () => new AuthService());
  const child = createEnvironmentInjector([
    { provide: AuthService, useValue: auth },
    { provide: ApiService, useValue: { createBet: () => response } },
    { provide: ActivatedRoute, useValue: {} }
  ], injector);
  const component = runInInjectionContext(child, () => new StreamDetailComponent());
  try {
    auth.updateUser(user); component.stream = stream; component.stakes[round.id] = 25;
    component.placeBet(round, 'over');
    assert.equal(component.submitting, true);
    auth.logout().subscribe(); auth.login('test@example.com', 'password').subscribe();
    response.next({ user: { ...user, balanceCredits: 75 } }); response.complete();
    assert.equal(component.submitting, false);
    assert.equal(auth.user.balanceCredits, 200, 'An earlier prediction response overwrote the new session balance');
  } finally { component.ngOnDestroy(); child.destroy(); injector.destroy(); }
});

function settlementHarness() {
  const requests = [];
  const injector = createEnvironmentInjector([
    { provide: AuthService, useValue: { refreshMe: () => of(user) } },
    { provide: ApiService, useValue: { settleMarket: (...args) => { requests.push(args); return of({}); } } }
  ]);
  const component = runInInjectionContext(injector, () => new AdminComponent());
  component.load = () => {};
  component.now = start + 120_000;
  component.settleValues[round.id] = 42;
  return { component, requests, destroy: () => injector.destroy() };
}

test('manual settlement requires capture, coverage, unchanged framing and an evidence note', () => {
  const { component, requests, destroy } = settlementHarness();
  try {
    component.settlementVerified[round.id] = true;
    component.settlementCoverageVerified[round.id] = true;
    component.settlementEvidence[round.id] = 'Source clock checked; northbound lanes and crossing line remained visible.';
    component.settle(round);
    assert.equal(requests.length, 0, 'Missing framing confirmation allowed a settlement');
    assert.match(component.error, /counting zone/);
    component.settlementFramingVerified[round.id] = true;
    for (const note of ['', 'too short', 'Evidence has a control\ncharacter in a long enough note.', '\nLeading control in a long enough note.', 'a'.repeat(2001)]) {
      component.settlementEvidence[round.id] = note;
      component.settle(round);
      assert.equal(requests.length, 0, 'Invalid evidence note allowed a settlement');
    }
    component.settlementEvidence[round.id] = ' Source clock checked; northbound lanes and crossing line remained visible. ';
    component.settle(round);
    assert.deepEqual(requests, [[round.id, 42, {
      captureTimeVerified: true, coverageVerified: true, framingVerified: true,
      evidenceNote: 'Source clock checked; northbound lanes and crossing line remained visible.'
    }]]);
    assert.equal(component.settlementFramingVerified[round.id], false, 'A completed round retained its confirmation');
  } finally { destroy(); }
});

test('settlement API forwards operator evidence without manufacturing confirmations', () => {
  let request;
  const injector = createEnvironmentInjector([{ provide: HttpClient, useValue: {
    patch: (...args) => { request = args; return of({}); }
  } }]);
  try {
    const api = runInInjectionContext(injector, () => new ApiService());
    const verification = { captureTimeVerified: true, coverageVerified: false, framingVerified: false, evidenceNote: 'Unverified interval for transport regression.' };
    api.settleMarket(7, 42, verification).subscribe();
    assert.equal(request[0], '/api/admin/markets/7/settle');
    assert.deepEqual(request[1], { actualCount: 42, verification });
    assert.equal(request[2].withCredentials, true);
  } finally { injector.destroy(); }
});

test('admin round filters find exact historical rounds and limit recent cards without modifying source data', () => {
  const component = Object.create(AdminComponent.prototype);
  const rows = Array.from({length:125}, (_,i) => ({...round, id:7000+i, streamId:i%2?49:45, streamTitle:i%2?'Jamboree':'Ball Road', title:'Line crossing', status:i%3?'settled':'open', windowStart:new Date(start+i*60000).toISOString()}));
  Object.assign(component, {markets:rows, roundSearch:'', roundCameraId:0, roundStatus:'all', roundLimit:40});
  assert.equal(component.visibleRounds.length,40); assert.equal(component.visibleRounds[0].id,7124);
  component.roundSearch='#7001'; assert.deepEqual(component.visibleRounds.map(m=>m.id),[7001]);
  component.roundSearch=''; component.roundCameraId=49; component.roundStatus='settled';
  assert.ok(component.matchingRounds.length); assert.ok(component.matchingRounds.every(m=>m.streamId===49 && m.status==='settled'));
  component.roundCameraId=0; component.roundStatus='all'; component.roundSearch='045';
  assert.ok(component.matchingRounds.every(m=>m.streamId===45)); assert.equal(rows[0].id,7000);
  component.roundSearch='does not exist'; assert.equal(component.visibleRounds.length,0);
});
