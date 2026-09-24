'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveContainedPath } = require('./path-security.cjs');

test('app resources cannot escape their root directory', () => {
  const root = path.resolve('application-root');
  assert.equal(resolveContainedPath(root, '/index.html'), path.join(root, 'index.html'));
  assert.equal(resolveContainedPath(root, 'js/app.js'), path.join(root, 'js', 'app.js'));
  assert.equal(resolveContainedPath(root, '../application-root-evil/secret.txt'), null);
});
