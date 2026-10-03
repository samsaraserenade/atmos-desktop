'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splashHtml, splashBounds } = require('./startup-splash.cjs');

test('the splash page runs no script and loads nothing but its own image', () => {
  const html = splashHtml('data:image/png;base64,AAAA');
  assert.match(html, /default-src 'none'; img-src data:; style-src 'unsafe-inline'/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<img alt="" src="data:image\/png;base64,AAAA">/);
  assert.match(html, /Starting Atmos…/);
  assert.match(splashHtml('data:,', 'Glia gossip.'), /<p>Glia gossip\.<\/p>/);
  assert.match(splashHtml('data:,', '<b>"It\'s"</b> & co'), /<p>&lt;b&gt;&quot;It&#39;s&quot;&lt;\/b&gt; &amp; co<\/p>/);
});

test('it opens where the Atmos window will be', () => {
  const display = { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };
  const primary = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const screen = { getDisplayMatching: () => display, getPrimaryDisplay: () => primary };
  const defaults = { width: 1280, height: 800 };
  assert.deepEqual(splashBounds({}, { defaults, screen }), defaults, 'no saved state: the default size');
  assert.deepEqual(splashBounds({ bounds: { x: 2000, y: 50, width: 1400, height: 900 } }, { defaults, screen }), { x: 2000, y: 50, width: 1400, height: 900 });
  assert.deepEqual(splashBounds({ bounds: { x: 2000, y: 50, width: 1400, height: 900 }, isMaximized: true }, { defaults, screen }), display.workArea);
  assert.deepEqual(splashBounds({ bounds: { x: 2000, y: 50, width: 1400, height: 900 }, isFullScreen: true }, { defaults, screen }), display.bounds);
  assert.deepEqual(splashBounds({ bounds: { width: 1400, height: 900 }, isMaximized: true }, { defaults, screen }), primary.workArea, 'no position: the primary display');
});
