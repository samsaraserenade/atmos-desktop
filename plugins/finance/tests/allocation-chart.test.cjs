'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

const source = readFileSync(`${__dirname}/../src/allocation-chart.js`, 'utf8')
  .replace(/\bexport\s+/g, '');
const result = vm.runInNewContext(`${source}
({
  allocation: buildAllocation([
    { id: 'small', name: 'Small', value: 25 },
    { id: 'large', name: 'Large', value: 75 },
    { id: 'empty', name: 'Empty', value: 0 },
  ]),
  rendered: renderAllocationSVG({
    connections: [
      { id: 'small', name: 'Small & Safe', value: 25 },
      { id: 'large', name: 'Large', value: 75 },
    ],
    W: 300, H: 134, bottomInset: 0,
  }),
  monotone: renderAllocationSVG({
    connections: [
      { id: 'small', name: 'Small', value: 25 },
      { id: 'large', name: 'Large', value: 75 },
    ],
    W: 300, H: 134, bottomInset: 0, monotone: true,
  }),
  grouped: buildAllocation(Array.from({ length: 9 }, (_, i) => ({
    id: 'asset-' + i, name: 'Asset ' + i, value: 9 - i,
  }))),
})`);

assert.equal(result.allocation.length, 2, 'zero-value connections must not create empty slices');
assert.equal(result.allocation[0].id, 'large', 'legend and slices must be largest first');
assert.equal(result.allocation[0].share, 0.75);
assert.equal(result.allocation[1].share, 0.25);
assert.equal(result.rendered.count, 2);
assert.match(result.rendered.markup, /tc-allocation-chart/);
assert.match(result.rendered.markup, /cx="70\.5" cy="67\.0" r="50\.9"/,
  'sidebar donut should sit left of centre with room for its legend');
assert.match(result.rendered.markup, />75%<\/text>/);
assert.match(result.rendered.markup, /Small &amp; Safe/, 'connection names must be safely escaped');
assert.doesNotMatch(result.rendered.markup, /ALLOCATION|100\.00|[\$£]100/, 'donut centre must stay uncluttered');
assert.equal((result.monotone.markup.match(/stroke="#ffffff"/g) || []).length, 2,
  'monotone mode must render every slice in white');
assert.equal((result.monotone.markup.match(/fill="#ffffff"/g) || []).length, 2,
  'monotone mode must render every legend marker in white');
assert.equal(result.grouped.length, 7, 'a long asset tail must be grouped for the compact legend');
assert.equal(result.grouped.find(entry => entry.id === '__other-holdings').groupedCount, 3);
assert.ok(Math.abs(result.grouped.reduce((sum, entry) => sum + entry.share, 0) - 1) < 1e-12,
  'grouping must preserve the complete allocation');
console.log('Passed: readable connection allocation percentages and clean-centred donut SVG');
