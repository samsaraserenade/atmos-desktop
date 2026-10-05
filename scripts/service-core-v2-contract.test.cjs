'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Test the repo's services (the source of truth); set ATMOS_SERVICE_ROOT to
// check an installed copy instead.
const serviceRoot = process.env.ATMOS_SERVICE_ROOT || path.join(__dirname, '..', 'services');

// The released services (release.json) must be present; checks that belong
// to one service live beside it (services/<id>/tests/service-contract.cjs,
// loaded at the end), so they come and go with the service.
const released = (() => {
  try { return new Set(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'release.json'), 'utf8')).services); }
  catch { return new Set(); }
})();

let installedServiceEntries = [];
let serviceTestsUnavailable = null;
try {
  installedServiceEntries = fs.readdirSync(serviceRoot, { withFileTypes: true });
  const installedIds = new Set(installedServiceEntries.filter(entry => entry.isDirectory()).map(entry => entry.name));
  if (![...released].some(id => installedIds.has(id))) {
    serviceTestsUnavailable = 'the contract services are not installed';
  }
} catch (error) {
  serviceTestsUnavailable = `installed service root is unavailable: ${error.code || error.message}`;
}
const serviceTest = serviceTestsUnavailable
  ? (name, fn) => test(name, { skip: serviceTestsUnavailable }, fn)
  : test;

const read = relative => fs.readFileSync(path.join(serviceRoot, relative), 'utf8');
// The system services are part of Core (core/system).
const systemRoot = path.join(__dirname, '..', 'core', 'system');
const readSystem = relative => fs.readFileSync(path.join(systemRoot, relative), 'utf8');

serviceTest('installed services declare compatible Core API v2 manifests', () => {
  const installed = installedServiceEntries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  for (const id of released) assert.ok(installed.includes(id), `missing released service: ${id}`);

  for (const id of installed) {
    const manifest = JSON.parse(read(path.join(id, 'extension.json')));
    // A framed service (Now Playing: a widget, SDK 1.x) is apiVersion 4, as framed plugins are.
    assert.equal(manifest.apiVersion, manifest.runtime === 'frame' ? 4 : 2, `${id} must target Core API v2 (or 4, framed)`);
    assert.equal(manifest.requires?.['extensions.manifest'], 1, `${id} must require manifest support`);
  }
});

serviceTest('service renderer modules and CommonJS entries parse', () => {
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      // Dependencies and snapshot folders are not loadable service code.
      if (['node_modules', 'backups', '_to_delete'].includes(entry.name) || entry.name.startsWith('.')) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const source = fs.readFileSync(target, 'utf8');
        new vm.SourceTextModule(source, { identifier: target });
        for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(\.\.?\/[^'"]+)\1/g)) {
          const resolved = path.resolve(path.dirname(target), match[2]);
          assert.ok(fs.existsSync(resolved), `${target} imports missing ${match[2]}`);
        }
      } else if (entry.isFile() && entry.name.endsWith('.cjs')) {
        new vm.Script(fs.readFileSync(target, 'utf8'), { filename: target });
      }
    }
  };
  visit(serviceRoot);
});

serviceTest('privileged services use scoped Core handlers and capabilities', () => {
  const metadataMain = read('media-metadata/main.cjs');
  assert.match(metadataMain, /context\.handle\('read-file-bytes'/);
  assert.match(metadataMain, /context\.handle\('write-cover-art'/);
  assert.match(metadataMain, /context\.provide\('media-metadata'/);
  assert.doesNotMatch(metadataMain, /ipcMain\.handle/);

  const metadataRenderer = read('media-metadata/renderer.js');
  // A library: the consumer hands it the route to main.cjs.
  assert.match(metadataRenderer, /export function setInvoke/);
  assert.doesNotMatch(metadataRenderer, /window\.atmos|window\.electronFS|atmos-core/);
  assert.equal(JSON.parse(read('media-metadata/extension.json')).library, true);
});

test('Location is an official service (0.21): framed, its geolocation declared, Atmos only reading what it kept before', () => {
  assert.equal(fs.existsSync(path.join(systemRoot, 'location')), false, 'no longer part of Core');
  const manifest = JSON.parse(read('location/extension.json'));
  assert.equal(manifest.runtime, 'frame');
  assert.equal(manifest.isolation, 'origin');
  assert.deepEqual(manifest.permissions.browser, ['geolocation']);
  assert.deepEqual(manifest.permissions.network, ['geocoding-api.open-meteo.com', 'nominatim.openstreetmap.org']);
  assert.deepEqual(Object.keys(manifest.contributes).sort(), ['boot', 'settings']);
  // Detect asks Atmos first; the location goes out through Atmos.
  assert.match(read('location/settings.js'), /atmos\.location\.allowDetect\(\)/);
  assert.match(read('location/boot.js'), /atmos\.location\.publish\(/);
  assert.match(read('location/boot.js'), /atmos\.location\.takeEarlier\(\)/);
  // What Atmos kept before: its old namespace, read once.
  const legacy = fs.readFileSync(path.join(systemRoot, '..', 'js', 'core', 'location-legacy.js'), 'utf8');
  assert.match(legacy, /registerStateNamespace\('location'/);
  assert.match(legacy, /location-legacy-v1/);
});

serviceTest('main-process service entry points register only their Core-owned surfaces', async () => {
  const metadata = require(path.join(serviceRoot, 'media-metadata', 'main.cjs'));
  const metadataHandlers = new Map();
  let metadataCapability = null;
  await metadata({
    handle(name, handler) { metadataHandlers.set(name, handler); },
    provide(name, value) { if (name === 'media-metadata') metadataCapability = value; },
  });
  assert.deepEqual([...metadataHandlers.keys()].sort(), ['read-file-bytes', 'write-cover-art']);
  assert.equal(typeof metadataCapability?.readFileBytes, 'function');
  assert.equal(typeof metadataCapability?.writeCoverArt, 'function');
});

// A service's own contract checks: services/<id>/tests/service-contract.cjs
// exports function ({ test, assert, read, serviceRoot }).
for (const entry of installedServiceEntries) {
  const file = path.join(serviceRoot, entry.name, 'tests', 'service-contract.cjs');
  if (entry.isDirectory() && fs.existsSync(file)) require(file)({ test: serviceTest, assert, read, serviceRoot });
}
