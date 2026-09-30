'use strict';
// permissions.network as a contract: what a host entry may be, what it
// covers, and what an update adds, compared as data.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePermissions, describePermissions, isValidHost, hostAllowed, hostCovered, permissionsAdded,
} = require('./extension-permissions.cjs');

test('a network entry is a public host name, "*.host" or "*", and nothing that could mean more', () => {
  for (const entry of ['api.example.com', '*.example.com', '*', 'a.b.c.example.org', 'xn--bcher-kva.example', 'api-2.example.io']) {
    assert.equal(isValidHost(entry), true, entry);
  }
  for (const entry of [
    'api.weather.example *', // a CSP source list: "*" would allow anything
    'api.example.com; script-src *', 'https://api.example.com', 'api.example.com:8443', 'api.example.com/v1',
    'example', 'localhost', '*.localhost', 'app.localhost', 'printer.local', 'nas.lan', 'db.internal', 'router.home.arpa',
    '127.0.0.1', '192.168.1.1', '0x7f.1', '10.0.0.1', '[::1]', '*.*.example.com', '*example.com', '-bad.example.com', '',
  ]) {
    assert.equal(isValidHost(entry), false, entry);
  }
  assert.throws(() => normalizePermissions({ network: ['api.example.com', '192.168.1.1'] }), /public host names/);
  assert.deepEqual(normalizePermissions({ network: ['B.example.com', 'a.example.com', 'b.example.com'] }).network,
    ['a.example.com', 'b.example.com'], 'lowercased, sorted, once each');
});

test('"*.example.com" covers its subdomains, not example.com itself (as in CSP)', () => {
  const network = ['*.example.com', 'api.other.example'];
  assert.equal(hostAllowed('img.example.com', network), true);
  assert.equal(hostAllowed('a.b.example.com', network), true);
  assert.equal(hostAllowed('example.com', network), false);
  assert.equal(hostAllowed('badexample.com', network), false);
  assert.equal(hostAllowed('api.other.example.', network), true, 'a trailing dot is the same host');
  assert.equal(hostAllowed('anything.example', ['*']), true);
  assert.equal(hostCovered('*.img.example.com', network), true);
  assert.equal(hostCovered('*.example.com', ['example.com']), false);
});

test('what an update adds is compared as data: a swapped fifth host shows, a covered one doesn\'t', () => {
  const five = ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com', 'e.example.com'];
  const swapped = [...five.slice(0, 4), 'evil.example'];
  // The old English lines are identical ("… and 1 more"): the reason for comparing data.
  assert.deepEqual(describePermissions({ network: five }), describePermissions({ network: swapped }));
  assert.deepEqual(permissionsAdded({ network: swapped }, { network: five }), { network: ['evil.example'] });
  assert.deepEqual(describePermissions(permissionsAdded({ network: swapped }, { network: five }), { everyHost: true }), ['Connect to evil.example']);

  assert.equal(permissionsAdded({ network: ['api.example.com'] }, { network: ['*.example.com'] }), null);
  assert.equal(permissionsAdded({ network: ['api.example.com'] }, { network: ['*'] }), null);
  assert.deepEqual(permissionsAdded({ network: ['*'] }, { network: ['api.example.com'] }), { network: ['*'] });
  assert.deepEqual(permissionsAdded({ browser: ['notifications'], invokes: ['service:location'] }, { browser: [] }),
    { browser: ['notifications'], invokes: ['service:location'] });
  assert.equal(permissionsAdded({ network: ['b.example.com', 'a.example.com'] }, { network: ['a.example.com', 'b.example.com'] }), null, 'order doesn\'t matter');
  // An approval saved by an older Atmos that can't be read now: everything counts as new.
  assert.deepEqual(permissionsAdded({ network: ['api.example.com'] }, { uses: ['old-capability'] }), { network: ['api.example.com'] });
});

test('everyHost names every host; otherwise four and a count', () => {
  const six = ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com', 'e.example.com', 'f.example.com'];
  assert.deepEqual(describePermissions({ network: six }), ['Connect to a.example.com, b.example.com, c.example.com, d.example.com and 2 more']);
  assert.deepEqual(describePermissions({ network: six }, { everyHost: true }), [`Connect to ${six.join(', ')}`]);
  assert.deepEqual(describePermissions({ invokes: ['service:location', 'service:audio'] }), ['Play audio', 'Know your location, as set in Atmos']);
});

test('"web" is true or false, described, and an update that adds it says so', () => {
  assert.equal(normalizePermissions({}).web, false);
  assert.equal(normalizePermissions({ web: true }).web, true);
  assert.throws(() => normalizePermissions({ web: 'yes' }), /web/);
  assert.ok(describePermissions({ web: true }).some(line => /web pages/i.test(line)));
  assert.ok(!describePermissions({ web: false }).some(line => /web pages/i.test(line)));
  assert.deepEqual(permissionsAdded({ web: true }, { web: false }), { web: true });
  assert.equal(permissionsAdded({ web: true }, { web: true }), null);
});
