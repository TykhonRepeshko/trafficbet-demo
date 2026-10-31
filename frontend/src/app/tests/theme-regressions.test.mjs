import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { DOCUMENT } from '@angular/common';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';

const output = new URL(`.theme-regressions-${process.pid}.mjs`, import.meta.url);
const bundle = await build({
  stdin: { contents: "export * from './services/theme.service';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }
});
await writeFile(output, bundle.outputFiles[0].text);
const { ThemeService, themeStorageKey } = await import(output.href);
await unlink(output);
const earlyScript = await readFile(new URL('../../theme-init.js', import.meta.url), 'utf8');

function browserHarness({ dark = false, stored = null, blocked = false, writeBlocked = false } = {}) {
  const mediaListeners = new Set(), storageListeners = new Set(), attributes = new Map(), values = new Map(), writes = [];
  if (stored !== null) values.set(themeStorageKey, stored);
  values.set('unrelated-setting', 'preserved');
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { if (writeBlocked) throw new Error('Quota exceeded'); values.set(key, value); writes.push([key, value]); }
  };
  const media = {
    matches: dark,
    addEventListener: (event, listener) => { assert.equal(event, 'change'); mediaListeners.add(listener); },
    removeEventListener: (event, listener) => mediaListeners.delete(listener)
  };
  const browser = {
    get localStorage() { if (blocked) throw new Error('Storage access denied'); return storage; },
    matchMedia: (query) => { assert.equal(query, '(prefers-color-scheme: dark)'); return media; },
    addEventListener: (event, listener) => { assert.equal(event, 'storage'); storageListeners.add(listener); },
    removeEventListener: (event, listener) => storageListeners.delete(listener)
  };
  const document = { defaultView: browser, documentElement: { setAttribute: (key, value) => attributes.set(key, value) } };
  const injector = createEnvironmentInjector([{ provide: DOCUMENT, useValue: document }]);
  const service = runInInjectionContext(injector, () => new ThemeService());
  return {
    service, browser, document, attributes, values, writes, mediaListeners, storageListeners,
    changeSystem: (value) => { media.matches = value; for (const listener of mediaListeners) listener({ matches: value }); },
    storageEvent: (key, newValue) => { for (const listener of storageListeners) listener({ key, newValue }); },
    destroy: () => injector.destroy()
  };
}

test('theme follows the system until a member explicitly chooses a palette', () => {
  const h = browserHarness({ dark: true });
  try {
    assert.equal(h.service.current(), 'dark'); assert.equal(h.service.isDark(), true);
    assert.equal(h.attributes.get('data-theme'), 'dark'); assert.deepEqual(h.writes, []);
    h.changeSystem(false); assert.equal(h.service.current(), 'light');
    h.service.toggle(); assert.equal(h.service.current(), 'dark');
    h.changeSystem(true); h.changeSystem(false);
    assert.equal(h.service.current(), 'dark', 'A system change overwrote a manual preference');
  } finally { h.destroy(); }
});

test('stored light and dark selections override the operating system and survive a fresh service', () => {
  for (const theme of ['light', 'dark']) {
    const h = browserHarness({ stored: theme, dark: theme !== 'dark' });
    try {
      assert.equal(h.service.current(), theme);
      h.service.toggle();
      const selected = theme === 'light' ? 'dark' : 'light';
      assert.deepEqual(h.writes, [[themeStorageKey, selected]]);
      assert.equal(h.values.get('unrelated-setting'), 'preserved');
      const restored = browserHarness({ stored: h.values.get(themeStorageKey), dark: selected !== 'dark' });
      try { assert.equal(restored.service.current(), selected); } finally { restored.destroy(); }
    } finally { h.destroy(); }
  }
});

test('invalid stored values never become DOM attributes or block the system preference', () => {
  for (const stored of ['', 'Dark', 'auto', '<script>alert(1)</script>']) {
    const h = browserHarness({ stored, dark: true });
    try {
      assert.equal(h.service.current(), 'dark'); assert.equal(h.attributes.get('data-theme'), 'dark');
      h.changeSystem(false); assert.equal(h.service.current(), 'light'); assert.deepEqual(h.writes, []);
    } finally { h.destroy(); }
  }
});

test('blocked or full local storage still permits switching for the current page session', () => {
  for (const options of [{ blocked: true }, { writeBlocked: true }]) {
    const h = browserHarness({ ...options, dark: true });
    try {
      assert.equal(h.service.current(), 'dark');
      assert.doesNotThrow(() => h.service.toggle()); assert.equal(h.service.current(), 'light');
      h.changeSystem(false); h.changeSystem(true); assert.equal(h.service.current(), 'light');
      h.service.toggle(); assert.equal(h.service.current(), 'dark');
    } finally { h.destroy(); }
  }
});

test('cross-tab changes read only the stored preference and clearing it resumes system updates', () => {
  const h = browserHarness({ stored: 'light', dark: true });
  try {
    h.values.set(themeStorageKey, 'dark'); h.storageEvent('another-key', 'dark');
    assert.equal(h.service.current(), 'light');
    h.storageEvent(themeStorageKey, '<untrusted event payload>'); assert.equal(h.service.current(), 'dark');
    h.values.delete(themeStorageKey); h.storageEvent(null, null); assert.equal(h.service.current(), 'dark');
    h.changeSystem(false); assert.equal(h.service.current(), 'light'); assert.deepEqual(h.writes, []);
  } finally { h.destroy(); }
});

test('theme service releases system and storage listeners when its injector is destroyed', () => {
  const h = browserHarness();
  assert.equal(h.mediaListeners.size, 1); assert.equal(h.storageListeners.size, 1);
  h.destroy();
  assert.equal(h.mediaListeners.size, 0); assert.equal(h.storageListeners.size, 0);
});

test('the external before-paint script matches service selection for stored, system and unavailable-storage cases', () => {
  for (const options of [{ dark: true }, { dark: false }, { dark: true, stored: 'light' }, { dark: false, stored: 'dark' }, { dark: true, stored: 'invalid' }, { dark: true, blocked: true }]) {
    const h = browserHarness(options);
    try {
      const earlyAttributes = new Map();
      runInNewContext(earlyScript, { window: h.browser, document: { documentElement: { setAttribute: (key, value) => earlyAttributes.set(key, value) } } });
      assert.equal(earlyAttributes.get('data-theme'), h.service.current()); assert.deepEqual(h.writes, []);
    } finally { h.destroy(); }
  }
});

test('the external before-paint script falls back to light when browser preference APIs are unavailable', () => {
  let selected;
  runInNewContext(earlyScript, { window: {}, document: { documentElement: { setAttribute: (key, value) => { assert.equal(key, 'data-theme'); selected = value; } } } });
  assert.equal(selected, 'light');
});
