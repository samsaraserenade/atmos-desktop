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

test('bundled extensions win, and only bundled ones can be system or first-party', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-catalog-'));
  try {
    const bundled = path.join(dir, 'bundled', 'plugins');
    const installed = path.join(dir, 'installed', 'plugins');
    makeExtension(bundled, 'background', { tier: 'system' });
    makeExtension(bundled, 'notes', { tier: 'first-party' });
    makeExtension(bundled, 'untagged', {});
    makeExtension(installed, 'notes', { tier: 'system' });     // shadowed by the bundled copy
    makeExtension(installed, 'clock', { tier: 'system' });     // installed → third-party regardless
    makeExtension(installed, 'Bad Name', {});
    const warnings = [];
    const catalog = createExtensionCatalog({
      bundledRoot: kind => (kind === 'plugins' ? bundled : null),
      installedRoot: kind => (kind === 'plugins' ? installed : null),
      warn: message => warnings.push(message),
    });
    const byId = Object.fromEntries(catalog.list('plugins').map(entry => [entry.id, entry]));
    assert.deepEqual(Object.keys(byId).sort(), ['background', 'clock', 'notes', 'untagged']);
    assert.equal(byId.background.tier, 'system');
    assert.equal(byId.notes.tier, 'first-party');
    assert.equal(byId.notes.source, 'bundled');
    assert.equal(byId.notes.path, path.join(bundled, 'notes'));
    assert.equal(byId.untagged.tier, 'first-party');
    assert.equal(byId.clock.tier, 'third-party');
    assert.equal(byId.clock.source, 'installed');
    assert.ok(warnings.some(message => message.includes("installed plugin 'notes'")));
    assert.ok(warnings.some(message => message.includes("'Bad Name'")));
    assert.equal(catalog.find('plugins', 'clock').kind, 'plugin');
    assert.equal(catalog.list('services').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
