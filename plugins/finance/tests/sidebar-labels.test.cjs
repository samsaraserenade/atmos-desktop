'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const sidebar = fs.readFileSync(`${__dirname}/../markets/sidebar.js`, 'utf8');

assert.match(sidebar, /registerSection\('portfolio-futures',[\s\S]*?label: 'Futures'/,
  'the leveraged holdings accordion is labelled Futures');
assert.match(sidebar, /registerSection\('markets',[\s\S]*?label: 'Watchlist'/,
  'the markets accordion is labelled Watchlist');
assert.match(sidebar, /id: 'finance\.futures\.sort'[\s\S]*?label: 'Sort by'/,
  'the Futures sort menu uses the CoreV3 header menu contract');

console.log('Passed: Finance sidebar uses Watchlist and Futures labels');
