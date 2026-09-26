'use strict';
// Currency's part of the services contract test
// (scripts/service-core-v2-contract.test.cjs loads it when the service is there).
const fs = require('node:fs');
const path = require('node:path');

module.exports = ({ test, assert, read, serviceRoot }) => {
  // A library: pure modules that also run inside framed consumers, so no
  // Core imports and no state of its own.
  test('currency is a stateless library', () => {
    assert.equal(JSON.parse(read('currency/extension.json')).library, true);
    assert.equal(fs.existsSync(path.join(serviceRoot, 'currency', 'persist.js')), false);
    for (const file of ['converter.js', 'rates.js']) {
      assert.doesNotMatch(read(`currency/${file}`), /atmos-core|localStorage|registerStateNamespace/, file);
    }
  });
};
