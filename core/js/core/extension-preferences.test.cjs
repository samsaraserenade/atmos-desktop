'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExtensionPreferences } = require('./extension-preferences.cjs');

test('extensions default enabled and explicit disablement survives reload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-extension-preferences-'));
  try {
    const file = path.join(root, 'preferences.json');
    const preferences = createExtensionPreferences(file);
    assert.equal(preferences.isEnabled('plugin', 'example'), true);
    preferences.setEnabled('plugin', 'example', false);
    assert.equal(createExtensionPreferences(file).isEnabled('plugin', 'example'), false);
    assert.deepEqual([...preferences.disabledIds('plugin')], ['example']);
    preferences.setEnabled('plugin', 'example', true);
    assert.equal(preferences.isEnabled('plugin', 'example'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extension enablement rejects invalid kinds and ids', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-extension-preferences-'));
  try {
    const preferences = createExtensionPreferences(path.join(root, 'preferences.json'));
    assert.throws(() => preferences.setEnabled('plugin', '../escape', false), /Invalid/);
    assert.throws(() => preferences.setEnabled('unknown', 'example', false), /Invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
