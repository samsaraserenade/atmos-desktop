'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWebSettings, DEFAULT_OPTIONS } = require('./web-settings.cjs');

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-web-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a site\'s permission choices are kept, listed and revoked', t => {
  const dir = folder(t);
  const settings = createWebSettings({ dir });
  assert.equal(settings.permission('https://a.example', 'camera'), undefined);
  settings.setPermission('https://a.example', 'camera', 'allow');
  settings.setPermission('https://a.example', 'geolocation', 'block');
  settings.setPermission('https://b.example', 'notifications', 'allow');
  assert.equal(settings.permission('https://a.example', 'camera'), 'allow');
  assert.equal(settings.permission('https://a.example', 'geolocation'), 'block');
  assert.equal(settings.permission('https://a.example', 'microphone'), undefined);
  assert.deepEqual(settings.listPermissions(), [
    { origin: 'https://a.example', name: 'camera', value: 'allow' },
    { origin: 'https://a.example', name: 'geolocation', value: 'block' },
    { origin: 'https://b.example', name: 'notifications', value: 'allow' },
  ]);
  // Remembered across starts.
  const again = createWebSettings({ dir });
  assert.equal(again.permission('https://a.example', 'camera'), 'allow');
  again.revoke('https://a.example', 'camera');
  assert.equal(again.permission('https://a.example', 'camera'), undefined);
  again.revoke('https://a.example');
  assert.deepEqual(again.listPermissions(), [{ origin: 'https://b.example', name: 'notifications', value: 'allow' }]);
  assert.deepEqual(createWebSettings({ dir }).listPermissions(), [{ origin: 'https://b.example', name: 'notifications', value: 'allow' }]);
});

test('only prompted permissions of http(s) sites, and only allow or block, are stored', t => {
  const settings = createWebSettings({ dir: folder(t) });
  assert.throws(() => settings.setPermission('https://a.example', 'midi', 'allow'), /not a site permission/);
  assert.throws(() => settings.setPermission('file:///x', 'camera', 'allow'), /not a site/);
  assert.throws(() => settings.setPermission('https://a.example/path', 'camera', 'allow'), /not a site/);
  assert.throws(() => settings.setPermission('https://a.example', 'camera', 'maybe'), /allow', 'block' or null/);
});

test('a hand-edited file loses what isn\'t a known choice', t => {
  const dir = folder(t);
  fs.writeFileSync(path.join(dir, 'sites.json'), JSON.stringify({
    permissions: {
      'https://ok.example': { camera: 'allow', usb: 'allow', geolocation: 'always' },
      'file:///etc': { camera: 'allow' },
      'https://path.example/x': { camera: 'allow' },
    },
    zoom: { 'ok.example': 1.5, 'huge.example': 50, 'nan.example': 'x' },
  }));
  const settings = createWebSettings({ dir });
  assert.deepEqual(settings.listPermissions(), [{ origin: 'https://ok.example', name: 'camera', value: 'allow' }]);
  assert.equal(settings.zoom('ok.example'), 1.5);
  assert.equal(settings.zoom('huge.example'), 1);
  assert.equal(settings.zoom('nan.example'), 1);
});

test('private tabs\' choices stay in memory, apart from ordinary ones, and go with the private session', t => {
  const dir = folder(t);
  const settings = createWebSettings({ dir });
  settings.setPermission('https://a.example', 'camera', 'allow', { private: true });
  assert.equal(settings.permission('https://a.example', 'camera', { private: true }), 'allow');
  assert.equal(settings.permission('https://a.example', 'camera'), undefined, 'not in ordinary tabs');
  assert.deepEqual(settings.listPermissions(), []);
  assert.equal(fs.existsSync(path.join(dir, 'sites.json')), false, 'nothing written');
  settings.setPermission('https://a.example', 'geolocation', 'allow');
  assert.equal(settings.permission('https://a.example', 'geolocation', { private: true }), undefined, 'ordinary choices aren\'t used in private tabs');
  settings.clearPrivate();
  assert.equal(settings.permission('https://a.example', 'camera', { private: true }), undefined);
});

test('zoom per site, with private tabs starting from the ordinary zoom and keeping their own', t => {
  const dir = folder(t);
  const settings = createWebSettings({ dir });
  assert.equal(settings.zoom('a.example'), 1);
  settings.setZoom('a.example', 1.25);
  assert.equal(createWebSettings({ dir }).zoom('a.example'), 1.25);
  assert.equal(settings.zoom('a.example', { private: true }), 1.25);
  settings.setZoom('a.example', 2, { private: true });
  assert.equal(settings.zoom('a.example', { private: true }), 2);
  assert.equal(settings.zoom('a.example'), 1.25);
  settings.setZoom('a.example', 1);
  assert.equal(createWebSettings({ dir }).zoom('a.example'), 1, '100% isn\'t stored');
  settings.clearPrivate();
  assert.equal(settings.zoom('a.example', { private: true }), 1);
});

test('options: links off, ask where to save, block ads; only known booleans kept', t => {
  const dir = folder(t);
  const settings = createWebSettings({ dir });
  assert.deepEqual(settings.options(), { ...DEFAULT_OPTIONS });
  assert.deepEqual(DEFAULT_OPTIONS, { openLinks: false, askWhereToSave: true, blockAds: true });
  settings.setOptions({ openLinks: true, askWhereToSave: 'no', blockAds: false, extra: true });
  assert.deepEqual(createWebSettings({ dir }).options(), { openLinks: true, askWhereToSave: true, blockAds: false });
});

test('a site\'s shield: ads allowed per site, kept; private tabs follow unless they choose', t => {
  const dir = folder(t);
  const settings = createWebSettings({ dir });
  assert.equal(settings.adsAllowed('https://a.example'), false);
  settings.setPermission('https://a.example', 'ads', 'allow');
  assert.equal(settings.adsAllowed('https://a.example'), true);
  assert.equal(createWebSettings({ dir }).adsAllowed('https://a.example'), true, 'kept across starts');
  assert.deepEqual(settings.listPermissions(), [{ origin: 'https://a.example', name: 'ads', value: 'allow' }]);
  // Blocking is the default: 'block' just forgets the exception.
  settings.setPermission('https://a.example', 'ads', 'block');
  assert.equal(settings.adsAllowed('https://a.example'), false);
  assert.deepEqual(settings.listPermissions(), []);
  // A private tab sees the ordinary choice; its own stays in memory.
  settings.setPermission('https://b.example', 'ads', 'allow');
  assert.equal(settings.adsAllowed('https://b.example', { private: true }), true);
  settings.setPermission('https://c.example', 'ads', 'allow', { private: true });
  assert.equal(settings.adsAllowed('https://c.example', { private: true }), true);
  assert.equal(settings.adsAllowed('https://c.example'), false);
  assert.equal(createWebSettings({ dir }).adsAllowed('https://c.example', { private: true }), false);
  settings.clearPrivate();
  assert.equal(settings.adsAllowed('https://c.example', { private: true }), false);
  assert.throws(() => settings.setPermission('https://a.example', 'popups', 'allow'), /not a site permission/);
});

test('clearing site settings', t => {
  const dir = folder(t);
  const settings = createWebSettings({ dir });
  settings.setPermission('https://a.example', 'camera', 'allow');
  settings.setZoom('a.example', 1.5);
  settings.clear({ permissions: true });
  assert.deepEqual(settings.listPermissions(), []);
  assert.equal(settings.zoom('a.example'), 1.5);
  settings.clear({ zoom: true });
  assert.equal(createWebSettings({ dir }).zoom('a.example'), 1);
});
