import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

// Resolve through the real CLI callers: a successful Angular build alone does
// not exercise package preparation, ignore rules or signature target matching.
const require = createRequire(import.meta.url);
const cliRequire = createRequire(require.resolve('@angular/cli'));
const pacoteRequire = createRequire(cliRequire.resolve('pacote'));
const PackageJson = pacoteRequire('@npmcli/package-json');
const cache = pacoteRequire('cacache');
const packlistRequire = createRequire(pacoteRequire.resolve('npm-packlist'));
const walk = packlistRequire('ignore-walk');
const sigstoreRequire = createRequire(pacoteRequire.resolve('sigstore'));
const sigstoreTufRequire = createRequire(sigstoreRequire.resolve('@sigstore/tuf'));
const tufRequire = createRequire(sigstoreTufRequire.resolve('tuf-js'));
const { Targets } = tufRequire('@tufjs/models');

async function fixture(t) {
  const parent = resolve(tmpdir());
  const path = await mkdtemp(join(parent, 'trafficbet-tooling-'));
  t.after(async () => {
    const target = resolve(path);
    assert.equal(dirname(target), parent);
    assert.ok(basename(target).startsWith('trafficbet-tooling-'));
    await rm(target, { recursive: true, force: true });
  });
  return path;
}

test('CLI package preparation still discovers readme, native build metadata, manual pages and executables', async (t) => {
  const path = await fixture(t);
  await mkdir(join(path, 'bin'));
  await mkdir(join(path, 'man'));
  await Promise.all([
    writeFile(join(path, 'package.json'), JSON.stringify({ name: 'tooling-fixture', version: '1.0.0', directories: { bin: 'bin', man: 'man' } })),
    writeFile(join(path, 'README.md'), 'Local tooling fixture.\n'),
    writeFile(join(path, 'binding.gyp'), '{}'),
    writeFile(join(path, 'bin', 'trafficbet'), '#!/usr/bin/env node\n'),
    writeFile(join(path, 'man', 'trafficbet.1'), 'Local manual.\n'),
  ]);
  const pkg = await PackageJson.prepare(path, { steps: ['gypfile', 'readme', 'mans', 'binDir'] });
  assert.equal(pkg.content.readme, 'Local tooling fixture.\n');
  assert.equal(pkg.content.gypfile, true);
  assert.equal(pkg.content.scripts.install, 'node-gyp rebuild');
  assert.deepEqual(pkg.content.bin, { trafficbet: 'bin/trafficbet' });
  assert.deepEqual(pkg.content.man, ['man/trafficbet.1']);
});

test('CLI package ignore rules and delegated update targets retain their boundaries', async (t) => {
  const path = await fixture(t);
  await mkdir(join(path, 'public'));
  await mkdir(join(path, 'private'));
  await Promise.all([
    writeFile(join(path, '.npmignore'), '.env\n*.secret\nprivate/\n!public/keep.secret\n'),
    writeFile(join(path, '.env'), 'NOT_A_REAL_SECRET=fixture'),
    writeFile(join(path, 'hidden.secret'), 'fixture'),
    writeFile(join(path, 'private', 'hidden.txt'), 'fixture'),
    writeFile(join(path, 'public', 'keep.secret'), 'public fixture'),
    writeFile(join(path, 'public', 'index.js'), 'export {};'),
  ]);
  const files = await walk({ path, ignoreFiles: ['.npmignore'] });
  assert.ok(files.includes('public/keep.secret'));
  assert.ok(files.includes('public/index.js'));
  assert.ok(!files.includes('.env'));
  assert.ok(!files.includes('hidden.secret'));
  assert.ok(!files.some(file => file.startsWith('private/')));
  const targets = Targets.fromJSON({
    _type: 'targets', spec_version: '1.0.31', version: 1, expires: '2030-01-01T00:00:00Z', targets: {},
    delegations: { keys: {}, roles: [{ name: 'tooling-fixture', keyids: ['fixture-key'], threshold: 1, terminating: true, paths: ['targets/*.json'] }] },
  });
  assert.deepEqual([...targets.delegations.rolesForTarget('targets/valid.json')], [{ role: 'tooling-fixture', terminating: true }]);
  for (const target of ['targets/nested/invalid.json', 'other/invalid.json', 'targets/invalid.txt']) {
    assert.deepEqual([...targets.delegations.rolesForTarget(target)], []);
  }
});

test('CLI cache verification traverses files without losing valid package content', async (t) => {
  const path = join(await fixture(t), 'cache');
  await cache.put(path, 'tooling-fixture', 'verified fixture content');
  const result = await cache.verify(path);
  assert.equal(result.verifiedContent, 1);
  assert.equal(result.badContentCount, 0);
  assert.equal((await cache.get(path, 'tooling-fixture')).data.toString(), 'verified fixture content');
});
