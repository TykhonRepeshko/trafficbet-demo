import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';

const output = new URL(`.streaming-lab-${process.pid}.mjs`, import.meta.url);
const bundle = await build({ stdin: { contents: "export { StreamingLabComponent } from './pages/streaming-lab.component'; export { ApiService } from './services/api.service'; export { AuthService } from './services/auth.service'; export { routes } from './app.routes';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } } });
await writeFile(output, bundle.outputFiles[0].text);
const { StreamingLabComponent, ApiService, AuthService, routes } = await import(output.href);
await unlink(output);

test('streaming lab requires an administrator, including direct navigation', () => {
  const route = routes.find((r) => r.path === 'admin/media-lab');
  assert.equal(route.canActivate.length, 2);
  for (const role of [undefined, 'user', 'admin']) {
    const auth = { user: role ? { role } : null, isAdmin: role === 'admin' };
    const injector = createEnvironmentInjector([
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: { createUrlTree: (path, options) => ({ path, options }) } }
    ]);
    try {
      const results = route.canActivate.map((guard) => runInInjectionContext(injector, () => guard({}, { url: '/admin/media-lab' })));
      assert.equal(results.every((result) => result === true), role === 'admin');
    } finally { injector.destroy(); }
  }
});

test('external player starts only on request, expires at the presence limit, and stops on exit', () => {
  const timers = new Map(); let timerId = 0;
  const oldSetTimeout = globalThis.setTimeout, oldClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay) => { assert.equal(delay, 600000); timers.set(++timerId, callback); return timerId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const injector = createEnvironmentInjector([{ provide: ApiService, useValue: {} }]);
  try {
    const c = runInInjectionContext(injector, () => new StreamingLabComponent());
    assert.equal(c.playing, false); assert.equal(timers.size, 0);
    c.start(); assert.equal(c.playing, true); assert.equal(timers.size, 1);
    c.start(); assert.equal(timers.size, 1, 'Repeated starts accumulated timers');
    [...timers.values()][0]();
    assert.equal(c.playing, false); assert.equal(c.presenceExpired, true); assert.equal(timers.size, 0);
    c.start(); assert.equal(c.playing, true); assert.equal(c.presenceExpired, false);
    c.ngOnDestroy(); assert.equal(c.playing, false); assert.equal(timers.size, 0);
    c.preview = true; c.start(); assert.equal(c.playing, false); assert.equal(timers.size, 0);
  } finally { injector.destroy(); globalThis.setTimeout = oldSetTimeout; globalThis.clearTimeout = oldClearTimeout; }
});

test('reference selection excludes archived and unsupported cameras and cancels pending reads on exit', () => {
  const response = new Subject();
  const injector = createEnvironmentInjector([{ provide: ApiService, useValue: { listStreams: () => response } }]);
  const c = runInInjectionContext(injector, () => new StreamingLabComponent());
  c.ngOnInit();
  response.next([{ id: 1, isActive: false, streamType: 'hls' }, { id: 2, isActive: true, streamType: 'mp4' }, { id: 38, isActive: true, streamType: 'hls' }]);
  assert.equal(c.reference.id, 38); assert.equal(c.playing, false);
  c.ngOnDestroy(); injector.destroy(); assert.equal(response.observed, false);
});

test('lab CSP adds only the exact public embed and preserves application network restrictions', async () => {
  for (const file of ['../../../nginx.conf', '../../../angular.json']) {
    const content = await readFile(new URL(file, import.meta.url), 'utf8');
    const frame = content.match(/frame-src ([^;]+);/)[1].split(/\s+/);
    assert.deepEqual(frame.sort(), ['https://www.youtube-nocookie.com', 'https://rtsp.me/embed/5tYtr3zD/'].sort());
    const connect = content.match(/connect-src ([^;]+);/)[1];
    assert.ok(!connect.includes('rtsp.me') && !connect.includes('*'));
    assert.match(content, /camera=\(\), microphone=\(\), geolocation=\(\)/);
  }
});
