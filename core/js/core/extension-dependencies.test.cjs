'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, satisfies, isValidVersion, isValidRange } = require('./extension-version.cjs');
const { normalizeDependencies, resolveDependencies, dependentsOf } = require('./extension-dependencies.cjs');
const { orderExtensions } = require('./extension-host.cjs');

test('versions compare like semver, pre-releases before releases', () => {
  const sorted = ['1.0.0', '0.9.0', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-alpha', '1.10.0', '1.2.0'].sort(compareVersions);
  assert.deepEqual(sorted, ['0.9.0', '1.0.0-alpha', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0', '1.2.0', '1.10.0']);
  assert.equal(compareVersions('1.2.3+build.5', '1.2.3'), 0);
  for (const bad of ['1', '1.2', 'v1.2.3', '01.2.3', '1.2.3-', '1.2.3-01', '', null]) assert.equal(isValidVersion(bad), false, String(bad));
  assert.throws(() => compareVersions('1.0', '1.0.0'), /Invalid version/);
});

test('ranges: exact, caret, tilde, at-least and any', () => {
  const cases = [
    ['1.2.3', '1.2.3', true], ['1.2.4', '1.2.3', false],
    ['1.9.0', '^1.2.0', true], ['2.0.0', '^1.2.0', false], ['1.1.9', '^1.2.0', false],
    ['0.4.7', '^0.4.0', true], ['0.5.0', '^0.4.0', false], ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.0', true], ['1.3.0', '~1.2.0', false],
    ['3.0.0', '>=1.2.0', true], ['1.1.0', '>=1.2.0', false],
    ['0.0.1', '*', true],
    ['1.3.0-beta.1', '^1.2.0', false], ['1.3.0-beta.2', '^1.3.0-beta.1', true], ['1.3.0', '^1.3.0-beta.1', true],
  ];
  for (const [version, range, expected] of cases) assert.equal(satisfies(version, range), expected, `${version} in ${range}`);
  assert.equal(satisfies(undefined, '^1.0.0'), false);
  assert.equal(isValidRange('^1.x'), false);
  assert.equal(isValidRange('>=1.0.0'), true);
});

test('dependencies: bare ids are services, prefixes pick the kind, bad entries are reported', () => {
  const { list, errors } = normalizeDependencies({
    dependencies: {
      charting: '^1.2.0',
      'market-data': { version: '^0.4.0', optional: true },
      'plugin:notes': '*',
      'Bad Id': '1.0.0',
      clock: 'soon',
      weather: { optional: 'yes' },
    },
  });
  assert.deepEqual(list, [
    { ref: 'service:charting', kind: 'service', id: 'charting', range: '^1.2.0', optional: false },
    { ref: 'service:market-data', kind: 'service', id: 'market-data', range: '^0.4.0', optional: true },
    { ref: 'plugin:notes', kind: 'plugin', id: 'notes', range: '*', optional: false },
  ]);
  assert.equal(errors.length, 3);
  assert.deepEqual(normalizeDependencies({}).list, []);
  assert.deepEqual(normalizeDependencies({ dependencies: { 'market-data': { version: '^0.4.0', optional: true, recommended: true } } }).list[0].recommended, true);
  assert.match(normalizeDependencies({ dependencies: { charting: { version: '*', recommended: true } } }).errors[0], /on an optional dependency/);
  assert.match(normalizeDependencies({ dependencies: ['charting'] }).errors[0], /must be an object/);
});

function ext(kind, id, version, dependencies, extra = {}) {
  return { kind, id, manifest: { version, dependencies, displayName: extra.name || id } };
}

test('a missing, switched-off or wrong-version dependency stops what needs it, down the chain', () => {
  const entries = [
    ext('service', 'charting', '1.2.0'),
    ext('service', 'currency', '1.0.0'),
    ext('service', 'market-data', '0.4.0'),
    ext('service', 'old-lib', '0.9.0'),
    ext('plugin', 'finance', '1.0.0', { charting: '^1.2.0', currency: '^1.0.0', 'market-data': { version: '^0.4.0', optional: true } }, { name: 'Finance' }),
    ext('plugin', 'needs-missing', '1.0.0', { weather: '^1.0.0' }),
    ext('plugin', 'needs-old', '1.0.0', { 'old-lib': '^1.0.0' }),
    ext('service', 'middle', '1.0.0', { 'old-lib': '^1.0.0' }),
    ext('plugin', 'top', '1.0.0', { middle: '*' }),
    ext('plugin', 'needs-off', '1.0.0', { currency: '*' }),
  ];
  const off = new Set(['service:market-data']);
  let result = resolveDependencies(entries, entry => !off.has(`${entry.kind}:${entry.id}`));
  assert.equal(result.get('plugin:finance').ok, true);
  assert.deepEqual(result.get('plugin:finance').optionalMissing, ['service:market-data']);
  assert.equal(result.get('plugin:needs-missing').ok, false);
  assert.match(result.get('plugin:needs-missing').problems[0], /Needs Weather \^1\.0\.0, which is not installed/);
  assert.match(result.get('plugin:needs-old').problems[0], /but version 0\.9\.0 is installed/);
  assert.equal(result.get('service:middle').ok, false);
  assert.equal(result.get('plugin:top').ok, false);
  assert.match(result.get('plugin:top').problems[0], /Needs middle, which is missing a dependency/);

  off.add('service:currency');
  result = resolveDependencies(entries, entry => !off.has(`${entry.kind}:${entry.id}`));
  assert.equal(result.get('plugin:finance').ok, false);
  assert.match(result.get('plugin:finance').problems.join('\n'), /Needs currency, which is not loading/);
  assert.equal(result.get('plugin:needs-off').ok, false);
  // Switched off on its own account: not usable, but no dependency problem.
  assert.equal(result.get('service:currency').ok, false);
  assert.deepEqual(result.get('service:currency').problems, []);

  const dependents = dependentsOf(entries);
  assert.deepEqual(dependents.get('service:market-data'), [{ ref: 'plugin:finance', optional: true }]);
  assert.deepEqual(dependents.get('service:currency').map(item => item.ref), ['plugin:finance', 'plugin:needs-off']);
});

test('dependencies order startup within a kind, with the older "after" still honoured', () => {
  const order = orderExtensions([
    { id: 'tagger', kind: 'service', manifest: { dependencies: { 'library-index': '^1.0.0' } } },
    { id: 'library-index', kind: 'service', manifest: {} },
    { id: 'aardvark', kind: 'service', manifest: { after: ['zebra'] } },
    { id: 'zebra', kind: 'service', manifest: {} },
    { id: 'alpha', kind: 'service', manifest: { dependencies: { 'plugin:zebra': '*' } } }, // other kind: no effect
  ], () => {}).map(entry => entry.id);
  assert.ok(order.indexOf('library-index') < order.indexOf('tagger'));
  assert.ok(order.indexOf('zebra') < order.indexOf('aardvark'));
  assert.equal(order[0], 'alpha');
});
