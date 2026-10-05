'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExtensionCatalog } = require('./extension-catalog.cjs');

function makeExtension(root, id, manifest) {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  if (manifest) fs.writeFileSync(path.join(root, id, 'extension.json'), JSON.stringify(manifest));
}

test('system services come from Core; bundled extensions win; only bundled ones are first-party unsigned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-catalog-'));
  try {
    const core = path.join(dir, 'core', 'services');
    const bundled = path.join(dir, 'bundled', 'plugins');
    const installed = path.join(dir, 'installed', 'plugins');
    const bundledServices = path.join(dir, 'bundled', 'services');
    makeExtension(core, 'wallpaper', { tier: 'system' });
    makeExtension(bundledServices, 'wallpaper', {});          // shadowed: part of Atmos
    makeExtension(bundledServices, 'claims', { tier: 'system' }); // a bundled manifest can't claim system
    makeExtension(bundled, 'notes', { tier: 'first-party' });
    makeExtension(bundled, 'untagged', {});
    makeExtension(installed, 'notes', { tier: 'system' });     // shadowed by the bundled copy
    makeExtension(installed, 'clock', { tier: 'system' });     // installed → third-party regardless
    makeExtension(installed, 'Bad Name', {});
    const warnings = [];
    const catalog = createExtensionCatalog({
      coreRoot: kind => (kind === 'services' ? core : null),
      bundledRoot: kind => (kind === 'plugins' ? bundled : bundledServices),
      installedRoot: kind => (kind === 'plugins' ? installed : null),
      warn: message => warnings.push(message),
    });
    const byId = Object.fromEntries(catalog.list('plugins').map(entry => [entry.id, entry]));
    assert.deepEqual(Object.keys(byId).sort(), ['clock', 'notes', 'untagged']);
    assert.equal(byId.notes.tier, 'first-party');
    assert.equal(byId.notes.source, 'bundled');
    assert.equal(byId.notes.path, path.join(bundled, 'notes'));
    assert.equal(byId.untagged.tier, 'first-party');
    assert.equal(byId.clock.tier, 'third-party');
    assert.equal(byId.clock.source, 'installed');
    assert.ok(warnings.some(message => message.includes("installed plugin 'notes'")));
    assert.ok(warnings.some(message => message.includes("'Bad Name'")));
    assert.equal(catalog.find('plugins', 'clock').kind, 'plugin');
    const wallpaper = catalog.find('services', 'wallpaper');
    assert.deepEqual([wallpaper.tier, wallpaper.source, wallpaper.path], ['system', 'core', path.join(core, 'wallpaper')]);
    assert.ok(warnings.some(message => message.includes("bundled service 'wallpaper'") && message.includes('part of Atmos')));
    assert.equal(catalog.find('services', 'claims').tier, 'first-party');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the old system services Atmos 0.11 installed as packages are ignored, so the official Location can take the id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-catalog-'));
  try {
    const installed = path.join(dir, 'installed', 'services');
    const bundled = path.join(dir, 'bundled', 'services');
    makeExtension(installed, 'location', { apiVersion: 2, tier: 'system', version: '1.0.0', publisher: 'atmos' });
    makeExtension(installed, 'wallpaper', { apiVersion: 2, tier: 'system', version: '1.0.0' });
    makeExtension(installed, 'clock', { tier: 'system' }); // anything else claiming it: a community extension, as before
    const warnings = [];
    let catalog = createExtensionCatalog({ bundledRoot: () => null, installedRoot: kind => (kind === 'services' ? installed : null), warn: message => warnings.push(message) });
    assert.deepEqual(catalog.list('services').map(entry => `${entry.id}:${entry.tier}`), ['clock:third-party']);
    assert.ok(warnings.some(message => message.includes("installed service 'location'") && message.includes('0.11')));
    // Running from source (or once the official one is installed): that one.
    makeExtension(bundled, 'location', { apiVersion: 4, tier: 'first-party', version: '1.0.0' });
    catalog = createExtensionCatalog({ bundledRoot: kind => (kind === 'services' ? bundled : null), installedRoot: kind => (kind === 'services' ? installed : null), warn() {} });
    const location = catalog.find('services', 'location');
    assert.equal(location.source, 'bundled');
    assert.equal(location.tier, 'first-party');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
