const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = async name => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '..', name), 'utf8')).toString('base64'));

test('shared controls preserve interval choices and escape custom labels', async () => {
  const { CHART_INTERVALS, chartControlMarkup } = await load('toolbar.js');
  const markup = chartControlMarkup('timeframe');
  assert.equal((markup.match(/data-interval=/g) || []).length, CHART_INTERVALS.length);
  assert.match(markup, /data-interval="4h"/);
  assert.equal((chartControlMarkup('type').match(/data-chart-type=/g) || []).length, 3);
  assert.match(chartControlMarkup('axes'), /^<button[^>]*data-axis-x[^>]*>X<\/button><button[^>]*data-axis-y[^>]*>Y<\/button>$/);
  assert.match(chartControlMarkup('range', { ranges: [{ value: 'x', label: '<img>' }] }), /&lt;img&gt;/);
});

test('custom timeframe input validates, normalizes, dispatches, and disposes', async () => {
  const { bindIntervalInput } = await load('intervals.js');
  const element = () => ({ handlers: new Map(), classList: { toggle() {}, remove() {} },
    addEventListener(name, fn) { this.handlers.set(name, fn); },
    removeEventListener(name, fn) { if (this.handlers.get(name) === fn) this.handlers.delete(name); } });
  const input = element(), form = element(), values = [];
  const dispose = bindIntervalInput(input, form, ms => values.push(ms));
  input.value = '120s'; form.handlers.get('submit')({ preventDefault() {} });
  assert.equal(input.value, '2m'); assert.deepEqual(values, [120000]);
  input.value = '500ms'; form.handlers.get('submit')({ preventDefault() {} });
  assert.deepEqual(values, [120000]);
  dispose(); assert.equal(input.handlers.size + form.handlers.size, 0);
});
