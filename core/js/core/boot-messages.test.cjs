'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseBootMessages, pickBootMessage } = require('./boot-messages.cjs');

test('the main process reads the boot splash\'s lines exactly as the page has them', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'boot', 'splash.js'), 'utf8');
  const start = source.indexOf('var BOOT_MESSAGES = [');
  const literal = source.slice(start + 'var BOOT_MESSAGES = '.length, source.indexOf('];', start) + 1);
  const expected = JSON.parse(JSON.stringify(vm.runInNewContext(`(${literal})`)));
  const parsed = parseBootMessages(source);
  assert.ok(parsed.length > 20);
  assert.deepEqual(parsed, expected);
});

test('escapes, both quote styles and comments', () => {
  const src = "var BOOT_MESSAGES = [\n  // a comment with 'quotes'\n  'It\\'s here',\n  \"Rev said \\\"hi\\\"\",\n  'Caf\\u00e9'\n];";
  assert.deepEqual(parseBootMessages(src), ["It's here", 'Rev said "hi"', 'Café']);
  assert.deepEqual(parseBootMessages('nothing here'), []);
});

test('a line is picked at random, with its number for the page', () => {
  assert.deepEqual(pickBootMessage(['a', 'b', 'c'], () => 0.5), { index: 1, text: 'b' });
  assert.deepEqual(pickBootMessage(['a'], () => 0.999), { index: 0, text: 'a' });
  assert.equal(pickBootMessage([]), null);
});
