'use strict';

// Verifies the engine-level secondary-pane contract added to chart-next.js:
// options.panes, chart.setPaneData(id, points), chart.getPaneElement(id),
// and that a pane's render() receives coordinate mapping that matches the
// price plot's own layout (same xOfTime/domain, not a pane-local rescale).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

class FakeElement {
  constructor() {
    this.style = {};
    this.children = [];
    this.removed = false;
    this.handlers = new Map();
    this.attrs = {};
    this._innerHTML = '';
    this.dataset = {};
  }
  setAttribute(name, value) { this.attrs[name] = value; }
  getAttribute(name) { return this.attrs[name]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, handler) { this.handlers.set(name, handler); }
  dispatch(name, event = {}) { this.handlers.get(name)?.({ preventDefault() {}, ...event }); }
  getBoundingClientRect() { const width = this._width || 640; return { width, height: 320, left: 0, top: 0, right: width, bottom: 320 }; }
  remove() { this.removed = true; }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = value; }
  insertBefore(node) { this.children.push(node); return node; }
  querySelectorAll() { return []; }
}
class FakeResizeObserver {
  constructor(callback) { this.callback = callback; this.disconnected = false; }
  observe() { this.callback(); }
  disconnect() { this.disconnected = true; }
}

function makeContext() {
  return vm.createContext({
    console,
    AbortController,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    Element: FakeElement,
    ResizeObserver: FakeResizeObserver,
    document: {
      createElement: () => new FakeElement(),
      createElementNS: () => new FakeElement(),
    },
  });
}

async function loadChartModule(context) {
  const cache = new Map();
  const loadModule = async file => {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute);
    const module = new vm.SourceTextModule(fs.readFileSync(absolute, 'utf8'), { context, identifier: absolute });
    cache.set(absolute, module);
    await module.link(specifier => loadModule(path.resolve(path.dirname(absolute), specifier)));
    return module;
  };
  const module = await loadModule('chart-next.js');
  await module.evaluate();
  return module;
}

test('external chart toolbars remain visible in line mode with and without an interval wrapper', async () => {
  const module = await loadChartModule(makeContext());
  for (const wrapped of [true, false]) {
    const toolbar = new FakeElement();
    toolbar.style.display = 'flex';
    const interval = new FakeElement();
    interval.dataset.interval = 'auto';
    const line = new FakeElement();
    line.dataset.chartType = 'line';
    const candle = new FakeElement();
    candle.dataset.chartType = 'candlestick';
    const group = wrapped ? new FakeElement() : null;
    if (group) group.querySelectorAll = () => [interval];
    toolbar.querySelector = selector => selector === '.mq-timeframes' ? group : null;
    toolbar.querySelectorAll = selector => {
      if (selector === '[data-chart-type]') return [line, candle];
      if (selector === '[data-interval]' || selector === '[data-bucket-ms]') return [interval];
      return [];
    };
    const chart = module.namespace.createTimeSeriesChart(new FakeElement(), {
      type: 'candlestick', toolbar: { element: toolbar }, candleAnimation: false,
      data: [{ time: 1000, value: 100 }, { time: 61000, value: 102 }],
    });
    line.dispatch('click');
    assert.equal(chart.getState().type, 'line');
    assert.equal(toolbar.style.display, 'flex');
    assert.equal((group || interval).style.display, 'none');
    chart.setData([]);
    assert.equal(toolbar.style.display, 'flex');
    candle.dispatch('click');
    assert.equal(chart.getState().type, 'candlestick');
    assert.equal(toolbar.style.display, 'flex');
    assert.notEqual((group || interval).style.display, 'none');
    assert.equal(interval.attrs['aria-pressed'], 'true');
    chart.destroy();
  }
});

test('secondary panes: engine hosts pane svgs, exposes setPaneData/getPaneElement, and hands panes the real price layout', async () => {
  const module = await loadChartModule(makeContext());
  const calls = [];
  const container = new FakeElement();
  const chart = module.namespace.createTimeSeriesChart(container, {
    type: 'line',
    data: [{ time: 1_000, value: 100 }, { time: 61_000, value: 110 }, { time: 121_000, value: 90 }],
    panes: [
      { id: 'cash-invested', height: 56, render(ctx) { calls.push(ctx); return `<rect data-len="${ctx.data.length}" />`; } },
      // invalid specs must be silently filtered, not crash the chart:
      { id: 'missing-height', height: 0, render() { return ''; } },
      { id: 'missing-render', height: 40 },
      { height: 40, render() { return ''; } },
    ],
  });

  const host = container.children[0];
  // host = priceHost + exactly one valid pane svg
  assert.equal(host.children.length, 2, 'only the priceHost plus the single valid pane should be mounted');
  const paneEl = chart.getPaneElement('cash-invested');
  assert.ok(paneEl, 'getPaneElement must return the mounted pane element for a valid pane id');
  assert.equal(paneEl, host.children[1], 'the pane element returned by the API must be the actual mounted DOM node');
  assert.equal(chart.getPaneElement('missing-height'), null, 'an invalid pane spec (height<=0) must not be mounted');
  assert.equal(chart.getPaneElement('missing-render'), null, 'an invalid pane spec (no render fn) must not be mounted');
  assert.equal(chart.getPaneElement('nope'), null, 'unknown pane id must return null');

  // render() is called during initial mount with empty pane data.
  assert.ok(calls.length >= 1, 'pane render() must be invoked during the initial chart render');
  const first = calls[calls.length - 1];
  assert.equal(first.data.length, 0, 'pane must start with empty data until setPaneData is called');
  assert.equal(typeof first.xOfTime, 'function', 'pane render context must expose the real xOfTime coordinate mapper');
  assert.equal(first.width, 640, 'pane width must match the shared chart width, not a pane-local size');
  assert.equal(first.height, 56, 'pane height must be the height declared in its spec');
  assert.ok(first.domain && Number.isFinite(first.domain.from) && Number.isFinite(first.domain.to), 'pane must receive the price plot\'s own time domain');
  assert.equal(paneEl.innerHTML, '<rect data-len="0" />', 'the markup returned by render() must be written into the pane svg');

  // xOfTime must be the SAME mapping the price plot itself uses: strictly
  // increasing across the domain and bounded to the shared pixel width.
  const { from, to } = first.domain;
  const xStart = first.xOfTime(from), xEnd = first.xOfTime(to);
  assert.ok(xEnd > xStart, 'xOfTime must map later times to larger x coordinates');
  assert.ok(xStart >= 0 && xEnd <= first.width + 1, 'xOfTime output must stay within the shared plot width');

  // setPaneData triggers a re-render with the new data, without touching the price series.
  calls.length = 0;
  chart.setPaneData('cash-invested', [{ t: 1_000, r: 0.5 }, { t: 61_000, r: 0.6 }]);
  assert.ok(calls.length >= 1, 'setPaneData must trigger a pane re-render');
  const afterSet = calls[calls.length - 1];
  assert.equal(afterSet.data.length, 2, 'setPaneData must pass the new points through to render()');
  assert.equal(paneEl.innerHTML, '<rect data-len="2" />');
  assert.equal(chart.getState().pointCount, 3, 'setPaneData must not alter the price series point count');

  // setPaneData for an id with no mounted element must not throw.
  assert.doesNotThrow(() => chart.setPaneData('does-not-exist', [{ t: 1 }]));

  // A pane render() that throws must not crash the chart or other panes.
  calls.length = 0;
  const throwingContainer = new FakeElement();
  assert.doesNotThrow(() => module.namespace.createTimeSeriesChart(throwingContainer, {
    type: 'line',
    data: [{ time: 1_000, value: 100 }, { time: 2_000, value: 101 }],
    panes: [{ id: 'boom', height: 30, render() { throw new Error('render failed'); } }],
  }), 'a throwing pane render() must be caught, not crash chart creation');

  chart.destroy();
  assert.equal(host.removed, true, 'destroying the chart must remove the whole host, panes included');
});

test('resizable panes: drag handle mounts only when opted in, live-resizes with clamping, and emits paneResize', async () => {
  const module = await loadChartModule(makeContext());
  const renderCalls = [];
  const container = new FakeElement();
  const chart = module.namespace.createTimeSeriesChart(container, {
    type: 'line',
    data: [{ time: 1_000, value: 100 }, { time: 61_000, value: 110 }],
    panes: [
      {
        id: 'resizable-pane', height: 56, minHeight: 30, maxHeight: 120,
        resizable: true, render(ctx) { renderCalls.push(ctx.height); return ''; },
      },
      { id: 'fixed-pane', height: 40, render() { return ''; } },
    ],
  });

  const host = container.children[0];
  // priceHost + [handle, resizable pane svg] + [fixed pane svg, no handle] = 4 children.
  assert.equal(host.children.length, 4, 'only the resizable pane gets a drag-handle sibling');
  const handle = host.children[1];
  const resizablePaneEl = host.children[2];
  const fixedPaneEl = host.children[3];
  assert.equal(resizablePaneEl, chart.getPaneElement('resizable-pane'));
  assert.equal(fixedPaneEl, chart.getPaneElement('fixed-pane'));
  assert.equal(chart.getPaneHeight('resizable-pane'), 56);
  assert.equal(chart.getPaneHeight('fixed-pane'), 40);
  assert.equal(chart.getPaneHeight('nope'), null, 'an unknown pane id must report no height');

  const resizeEvents = [];
  chart.on('paneResize', event => resizeEvents.push(event));

  // Drag the handle UP by 20px -- since the handle sits above its pane,
  // that must GROW the pane by 20px, matching how a TradingView-style RSI
  // pane resizes from its own top edge.
  handle.dispatch('pointerdown', { clientY: 100, pointerId: 1 });
  handle.dispatch('pointermove', { clientY: 80, pointerId: 1 });
  assert.equal(chart.getPaneHeight('resizable-pane'), 76, 'dragging the handle up must grow the pane by the same amount');
  assert.equal(resizablePaneEl.style.height, '76px', 'the pane element\'s own style height must track the live size');
  assert.ok(renderCalls.includes(76), 'the pane\'s render() must be called with the new LIVE height, not the original spec height');
  handle.dispatch('pointerup', { clientY: 80, pointerId: 1 });

  assert.equal(resizeEvents.length, 1);
  assert.equal(resizeEvents[0].id, 'resizable-pane');
  assert.equal(resizeEvents[0].height, 76);

  // Dragging further than maxHeight must clamp, not overshoot.
  handle.dispatch('pointerdown', { clientY: 100, pointerId: 1 });
  handle.dispatch('pointermove', { clientY: -500, pointerId: 1 });
  assert.equal(chart.getPaneHeight('resizable-pane'), 120, 'growing past maxHeight must clamp to maxHeight');
  handle.dispatch('pointermove', { clientY: 900, pointerId: 1 });
  assert.equal(chart.getPaneHeight('resizable-pane'), 30, 'shrinking past minHeight must clamp to minHeight');
  handle.dispatch('pointerup', {});

  // A pointermove with no preceding pointerdown must be a no-op, not resize
  // from a stale drag.
  const before = chart.getPaneHeight('resizable-pane');
  handle.dispatch('pointermove', { clientY: 0 });
  assert.equal(chart.getPaneHeight('resizable-pane'), before);

  // The fixed pane never got a handle, but its height is still settable
  // programmatically -- `resizable` only gates the drag-handle UI, not the
  // underlying API, so callers can still manage layout in code.
  chart.setPaneHeight('fixed-pane', 999);
  assert.equal(chart.getPaneHeight('fixed-pane'), 400, 'setPaneHeight must clamp to the engine default max when the pane spec sets none');
  chart.setPaneHeight('fixed-pane', 1);
  assert.equal(chart.getPaneHeight('fixed-pane'), 24, 'setPaneHeight must clamp to the engine default min when the pane spec sets none');
  assert.equal(chart.setPaneHeight('does-not-exist', 50), chart.setPaneHeight('does-not-exist', 50), 'setPaneHeight on an unknown pane id must not throw');

  // Setting the same (clamped) height again must not re-emit paneResize.
  resizeEvents.length = 0;
  chart.setPaneHeight('fixed-pane', 24);
  assert.equal(resizeEvents.length, 0, 'setting an unchanged height must not fire a redundant paneResize event');

  chart.destroy();
});

test('pane visibility: hiding a pane hides its resize handle too, and toggling is idempotent', async () => {
  const module = await loadChartModule(makeContext());
  const renderCalls = [];
  const container = new FakeElement();
  const chart = module.namespace.createTimeSeriesChart(container, {
    type: 'line',
    data: [{ time: 1_000, value: 100 }, { time: 61_000, value: 110 }],
    panes: [
      { id: 'resizable-pane', height: 56, resizable: true, render(ctx) { renderCalls.push(ctx); return '<g/>'; } },
      { id: 'fixed-pane', height: 40, render() { return '<g/>'; } },
    ],
  });

  const host = container.children[0];
  const handle = host.children[1];
  const resizablePaneEl = host.children[2];
  const fixedPaneEl = host.children[3];

  assert.equal(chart.getPaneVisible('resizable-pane'), true, 'panes must start visible by default');
  assert.equal(chart.getPaneVisible('nope'), null, 'an unknown pane id must report no visibility state');

  // The bug this test guards: hiding a resizable pane must also hide its
  // drag handle -- a handle left behind with no pane under it to resize is
  // a dangling, confusing control.
  chart.setPaneVisible('resizable-pane', false);
  assert.equal(resizablePaneEl.style.display, 'none', 'the pane svg must hide');
  assert.equal(handle.style.display, 'none', 'the pane\'s resize handle must hide along with the pane');
  assert.equal(chart.getPaneVisible('resizable-pane'), false);
  assert.equal(fixedPaneEl.style.display, undefined, 'other panes must be unaffected');

  // A hidden pane's render() must be skipped -- no point re-drawing markup
  // nobody can see -- while a visible one keeps rendering normally.
  renderCalls.length = 0;
  chart.setPaneData('resizable-pane', [{ t: 1 }]);
  assert.equal(renderCalls.length, 0, 'setPaneData on a hidden pane must not trigger its render()');

  // Showing it again must restore both the pane and its handle.
  chart.setPaneVisible('resizable-pane', true);
  assert.equal(resizablePaneEl.style.display, '');
  assert.equal(handle.style.display, '');
  assert.equal(chart.getPaneVisible('resizable-pane'), true);
  renderCalls.length = 0;
  chart.setPaneData('resizable-pane', [{ t: 1 }]);
  assert.ok(renderCalls.length >= 1, 'a re-shown pane must resume rendering');

  // setPaneVisible on an unknown pane id must not throw.
  assert.doesNotThrow(() => chart.setPaneVisible('does-not-exist', false));

  chart.destroy();
});


test('batches render once, nested exceptions flush, and unchanged status is a no-op', async () => {
  const module = await loadChartModule(makeContext());
  let renders = 0;
  const chart = module.namespace.createTimeSeriesChart(new FakeElement(), {
    type: 'line', data: [{ time: 1000, value: 1 }],
    panes: [{ id: 'probe', height: 40, render() { renders++; return '<path />'; } }],
  });
  let writes = 0;
  Object.defineProperty(chart.getPaneElement('probe'), 'innerHTML', { set() { writes++; } });
  renders = 0;
  chart.batch(() => { chart.setStatus([{ key: 'test', value: '1' }]); chart.append({ time: 2000, value: 2 }); chart.setPaneData('probe', []); });
  assert.equal(renders, 1);
  assert.equal(writes, 0, 'unchanged pane markup must retain its DOM');
  chart.setStatus([{ key: 'test', value: '1' }]);
  assert.equal(renders, 1);
  assert.throws(() => chart.batch(() => chart.batch(() => { chart.append({ time: 3000, value: 3 }); throw new Error('test'); })), /test/);
  assert.equal(renders, 2);
  chart.append({ time: 4000, value: 4 });
  assert.equal(renders, 3);
  chart.destroy();
});


test('hover updates only the separate interaction surface; dragging still renders', async () => {
  const context = makeContext();
  let pending;
  context.requestAnimationFrame = callback => { pending = callback; return 1; };
  context.cancelAnimationFrame = () => { pending = null; };
  const module = await loadChartModule(context);
  const container = new FakeElement();
  let paneCalls = 0;
  const chart = module.namespace.createTimeSeriesChart(container, {
    type: 'candlestick', candleAnimation: false, bucketMs: 60000,
    data: Array.from({ length: 250 }, (_, i) => ({ t0: i * 60000, t1: (i + 1) * 60000, o: 10, h: 15, l: 5, c: 12 })),
    panes: [{ id: 'volume', height: 40, render() { paneCalls++; return '<path />'; } }],
  });
  const host = container.children[0].children[0];
  const svg = host.children[0], overlay = host.children[1];
  assert.equal(overlay.attrs.class, 'atmos-chart__interaction');
  assert.equal(svg.children.length, 3, 'indicators, content and candle bitmap are separate from pointer graphics');
  const axes = host.children[2];
  assert.equal(axes.attrs.class, 'atmos-chart__axes-layer');
  assert.match(axes.style.cssText, /overflow:visible/, 'axis labels may run past the plot edge to the screen edge');
  const content = svg.children[1];
  const markup = content.innerHTML;
  let svgWrites = 0;
  svg.setAttribute = () => { svgWrites++; };
  let contentWrites = 0;
  Object.defineProperty(content, 'innerHTML', { get: () => markup, set: () => { contentWrites++; } });
  const initialCalls = paneCalls;
  let hoverEvents = 0;
  chart.on('hover', () => { hoverEvents++; });
  const move = (x, y) => {
    host.dispatch('pointermove', { clientX: x, clientY: y });
    const callback = pending; pending = null; callback();
  };
  move(100, 50); move(150, 70);
  assert.equal(paneCalls, initialCalls, 'hover does not invoke pane renderers');
  assert.equal(svgWrites, 0, 'hover does not touch the candle SVG attributes');
  assert.equal(contentWrites, 0, 'hover does not rewrite candle markup');
  assert.equal(hoverEvents, 2);
  assert.equal(overlay.children[0].attrs.y1, '70.0');
  assert.equal(overlay.children[1].attrs.x1, '150.0');
  host.dispatch('pointerleave');
  assert.equal(overlay.children[0].style.display, 'none');
  assert.equal(paneCalls, initialCalls);
  host.dispatch('pointerdown', { clientX: 100, clientY: 50, ctrlKey: true });
  move(140, 60);
  assert.equal(overlay.children[2].attrs.width, '40.0');
  host.dispatch('pointercancel');
  assert.equal(overlay.children[2].style.display, 'none');
  const beforeDrag = paneCalls;
  host.dispatch('pointerdown', { clientX: 100, clientY: 50 });
  move(160, 50);
  assert.ok(paneCalls > beforeDrag, 'panning still renders the changed viewport');
  host.dispatch('pointerup', { clientX: 160, clientY: 50 });
  chart.destroy();
});

test('pane hover coalesces moves, maps sorted samples, and cancels on leave/destroy', async () => {
  const context = makeContext();
  const frames = new Map(); let id = 0;
  context.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  context.cancelAnimationFrame = handle => frames.delete(handle);
  const module = await loadChartModule(context);
  const chart = module.namespace.createTimeSeriesChart(new FakeElement(), {
    type: 'line', data: [{ time: 0, value: 1 }, { time: 100, value: 2 }],
    panes: [{ id: 'ratio', height: 40, hover: true, render: () => '' }],
  });
  chart.setPaneData('ratio', [{ t: 0 }, { t: 100 }]);
  const pane = chart.getPaneElement('ratio');
  const events = []; let leaves = 0;
  chart.on('paneHover', event => events.push(event));
  chart.on('paneLeave', () => { leaves++; });
  pane.dispatch('pointermove', { clientX: 10 });
  pane.dispatch('pointermove', { clientX: 600 });
  assert.equal(frames.size, 1);
  const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn());
  assert.equal(events.length, 1);
  assert.equal(events[0].time, 100);
  assert.equal(events[0].id, 'ratio');
  pane.dispatch('pointermove', { clientX: 10 });
  pane.dispatch('pointerleave');
  assert.equal(frames.size, 0);
  assert.equal(leaves, 1);
  pane.dispatch('pointermove', { clientX: 10 });
  chart.destroy();
  assert.equal(frames.size, 0);
});

test('label positioning options preserve external layouts without chart-internal CSS', async () => {
  const context = makeContext(); let pending;
  context.requestAnimationFrame = callback => { pending = callback; return 1; };
  const module = await loadChartModule(context);
  const container = new FakeElement();
  const chart = module.namespace.createTimeSeriesChart(container, {
    data: [{ time: 0, value: 1 }, { time: 100, value: 2 }],
    showTimeHoverLabel: false, priceLabelRight: -20, statsOffset: { top: -8, left: -12 },
  });
  const host = container.children[0].children[0];
  const find = name => host.children.find(el => el.className === name);
  assert.equal(find('atmos-chart__price-label').style.right, '-20px');
  assert.equal(find('atmos-chart__stats').style.top, '-8px');
  host.dispatch('pointermove', { clientX: 100, clientY: 50 }); pending();
  assert.equal(find('atmos-chart__hover-time').style.display, 'none');
  assert.equal(find('atmos-chart__hover-value').style.display, 'block');
  chart.setOptions({ showTimeHoverLabel: true });
  assert.equal(find('atmos-chart__hover-time').style.display, 'block');
  chart.destroy();
});

test('canvas candles reuse pixels on hover and redraw on data, scale, DPR, and mode changes', async () => {
  const context = makeContext(); const calls = [];
  const ctx = Object.fromEntries(['clearRect','save','restore','beginPath','moveTo','lineTo','stroke','fillRect','setTransform','rect','clip','closePath','fill','roundRect'].map(name => [name, (...args) => calls.push([name,...args])]));
  context.devicePixelRatio = 2;
  context.document.createElement = tag => { const el = new FakeElement(); if(tag === 'canvas') el.getContext = () => ctx; return el; };
  let pending; context.requestAnimationFrame = fn => { pending = fn; return 1; };
  const module = await loadChartModule(context); const container = new FakeElement();
  const chart = module.namespace.createTimeSeriesChart(container, { type:'candlestick', candleAnimation:false, indicator:null,
    data:[{t0:0,t1:60000,o:10,h:15,l:5,c:12},{t0:60000,t1:120000,o:12,h:18,l:8,c:14}] });
  const host=container.children[0].children[0],svg=host.children[0],layer=svg.children[2],canvas=layer.children[0];
  assert.equal(canvas.width,1280); assert.equal(canvas.height,640);
  assert.ok(calls.some(c=>c[0]==='fillRect')); assert.doesNotMatch(svg.children[1].innerHTML, /<rect/);
  const count=calls.length; host.dispatch('pointermove',{clientX:100,clientY:50}); pending(); assert.equal(calls.length,count);
  chart.updateLatest({t0:60000,t1:120000,o:12,h:20,l:8,c:19}); assert.ok(calls.length>count);
  chart.setOptions({priceScale:'log',bridgeFromPreviousClose:true,upColor:'#123456'});
  assert.equal(ctx.fillStyle,'#123456');
  context.devicePixelRatio=1.25;chart.resize();assert.equal(canvas.width,800);
  chart.setType('line');assert.equal(layer.style.display,'none');
  chart.setType('heiken-ashi');assert.equal(layer.style.display,'');
  chart.setData([]);assert.equal(layer.style.display,'none');
  chart.destroy();
});

test('indicator canvas caches hover, refreshes latest data, and hides when disabled', async () => {
  const context = makeContext(), contexts = [];
  context.devicePixelRatio = 2;
  context.document.createElement = tag => {
    const el = new FakeElement();
    if (tag === 'canvas') {
      const calls=[]; const ctx=Object.fromEntries(['clearRect','save','restore','beginPath','moveTo','lineTo','stroke','fillRect','setTransform','rect','clip','closePath','fill','roundRect'].map(name=>[name,(...args)=>calls.push([name,...args])]));
      contexts.push({ctx,calls});el.getContext=()=>ctx;
    }return el;
  };
  let pending;context.requestAnimationFrame=fn=>{pending=fn;return 1;};
  const module=await loadChartModule(context),container=new FakeElement();
  const data=Array.from({length:260},(_,i)=>({t0:i*60000,t1:(i+1)*60000,o:100,h:120,l:80,c:100+10*Math.sin(i/9)}));
  const chart=module.namespace.createTimeSeriesChart(container,{type:'candlestick',data,indicator:{},candleAnimation:false});
  const host=container.children[0].children[0],layer=host.children[0].children[0],canvas=layer.children[0];
  const calls=contexts[1].calls;
  assert.equal(canvas.width,1280);assert.ok(calls.some(c=>c[0]==='clip'));assert.ok(calls.some(c=>c[0]==='stroke'));
  const draws=()=>calls.filter(c=>c[0]==='clearRect').length;
  const before=draws();host.dispatch('pointermove',{clientX:100,clientY:50});pending();assert.equal(draws(),before);
  const oldPaths=JSON.stringify(calls.filter(c=>c[0]==='lineTo'));
  calls.length=0;chart.updateLatest({...data.at(-1),c:115});
  assert.ok(draws()>0);assert.notEqual(JSON.stringify(calls.filter(c=>c[0]==='lineTo')),oldPaths);
  chart.setOptions({indicator:null});assert.equal(layer.style.display,'none');
  chart.setOptions({indicator:{}});assert.equal(layer.style.display,'');
  context.devicePixelRatio=1.25;chart.resize();assert.equal(canvas.width,800);
  chart.setData([]);assert.equal(layer.style.display,'none');chart.destroy();
});

test('double-click restores a resolution-based candle or line density', async () => {
  const module = await loadChartModule(makeContext());
  const candleData = Array.from({ length: 500 }, (_, index) => ({
    t0: index * 60_000, t1: (index + 1) * 60_000, o: 100, h: 110, l: 90, c: 102,
  }));
  const candleContainer = new FakeElement();
  const candleChart = module.namespace.createTimeSeriesChart(candleContainer, {
    type: 'candlestick', bucketMs: 60_000, data: candleData,
  });
  const candleHost = candleContainer.children[0].children[0];
  candleHost.dispatch('dblclick');
  assert.equal(candleChart.getState().viewport.pan.win, 107 * 60_000,
    'a 640px plot resets to approximately one candle per 6px');

  const lineContainer = new FakeElement();
  const lineChart = module.namespace.createTimeSeriesChart(lineContainer, {
    type: 'line', data: candleData.map(candle => ({ time: candle.t0, value: candle.c })),
  });
  lineContainer.children[0].children[0].dispatch('dblclick');
  assert.equal(lineChart.getState().viewport.pan.win, 213,
    'line resets use tighter three-pixel point spacing');
  candleChart.destroy();
  lineChart.destroy();
});

test('built-in toolbar follows Core shell appearance and places X/Y controls on the right', async () => {
  const module = await loadChartModule(makeContext());
  const container = new FakeElement();
  const chart = module.namespace.createTimeSeriesChart(container, {
    type: 'line', toolbar: true, showPriceAxis: true,
    data: [{ time: 1_000, value: 100 }, { time: 2_000, value: 101 }],
  });
  const priceHost = container.children[0].children[0];
  const toolbar = priceHost.children.find(child => child.className === 'atmos-chart__toolbar');
  assert.ok(toolbar);
  assert.match(toolbar.style.cssText, /blur\(var\(--shell-blur, 30px\)\)/);
  assert.match(toolbar.style.cssText, /rgba\(var\(--surface-rgb\),var\(--shell-opacity, \.88\)\)/);
  const axes = toolbar.children.at(-1);
  assert.equal(axes.className, 'atmos-chart__axes');
  const [x, y] = axes.children;
  assert.equal(x.textContent, 'X'); assert.equal(y.textContent, 'Y');
  assert.equal(x.attrs['aria-pressed'], 'false'); assert.equal(y.attrs['aria-pressed'], 'true');
  x.dispatch('click'); y.dispatch('click');
  assert.equal(chart.getState().showTimeAxis, true);
  assert.equal(chart.getState().showPriceAxis, false);
  assert.equal(x.attrs['aria-pressed'], 'true'); assert.equal(y.attrs['aria-pressed'], 'false');
  chart.destroy();
});

test('a selected weekly view stays live through forced data refreshes until double-click', async () => {
  const module = await loadChartModule(makeContext());
  const candle = index => ({
    t0: index * 3_600_000, t1: (index + 1) * 3_600_000, o: 100, h: 110, l: 90, c: 102,
  });
  const data = Array.from({ length: 24 * 30 }, (_value, index) => candle(index));
  const container = new FakeElement();
  const chart = module.namespace.createTimeSeriesChart(container, {
    type: 'candlestick', bucketMs: 3_600_000, data,
  });
  const host = container.children[0].children[0];

  chart.setOptions({ activeRangeKey: '1w' });
  const preferred = chart.getState();
  assert.equal(preferred.viewport.activeRangeKey, '1w');

  chart.setData([...data, candle(data.length)], { preserveViewport: false });
  const updated = chart.getState();
  assert.equal(updated.viewport.activeRangeKey, '1w',
    'a refresh request cannot override the user-selected weekly range');
  assert.equal(updated.range.to - updated.range.from, 7 * 24 * 3_600_000,
    'the weekly span remains selected');
  assert.equal(updated.range.to, preferred.range.to + 3_600_000,
    'the weekly view continues following live candle data');

  host.dispatch('dblclick');
  const reset = chart.getState();
  assert.equal(reset.viewport.activeRangeKey, null);
  assert.equal(reset.viewport.pan.live, true,
    'double-click explicitly returns the chart to the live optimal view');
  assert.equal(reset.viewport.pan.win, 107 * 3_600_000);
  chart.destroy();
});

test('resolution-based sizing is available to callers for initial chart layout', async () => {
  const module = await loadChartModule(makeContext());
  const data = Array.from({ length: 500 }, (_, index) => ({
    t0: index * 60_000, t1: (index + 1) * 60_000, o: 100, h: 110, l: 90, c: 102,
  }));
  const container = new FakeElement();
  const chart = module.namespace.createTimeSeriesChart(container, {
    type: 'candlestick', bucketMs: 60_000, data,
  });
  assert.equal(typeof chart.snapDefaultView, 'function');
  chart.snapDefaultView();
  assert.equal(chart.getState().viewport.pan.win, 107 * 60_000);
  chart.destroy();
});

test('resolution-based sizing follows its own chart cell while a grid layout settles', async () => {
  const module = await loadChartModule(makeContext());
  const data = Array.from({ length: 500 }, (_, index) => ({
    t0: index * 60_000, t1: (index + 1) * 60_000, o: 100, h: 110, l: 90, c: 102,
  }));
  const container = new FakeElement();
  const chart = module.namespace.createTimeSeriesChart(container, {
    type: 'candlestick', bucketMs: 60_000, data,
  });
  chart.snapDefaultView();
  const priceHost = container.children[0].children[0];
  priceHost._width = 320;
  chart.resize();
  assert.equal(chart.getState().viewport.pan.win, 53 * 60_000,
    'a chart narrowed to a 320px plot recalculates independently to one candle per 6px');
  chart.destroy();
});

test('state-keyed charts restore their viewport after panel unmount and remount', async () => {
  const stored = new Map();
  const context = makeContext();
  const module = await loadChartModule(context);
  // Charting keeps nothing itself; the consumer hands it storage.
  module.namespace.configureChartStorage({
    get: key => stored.get(key) ?? null,
    set: (key, value) => stored.set(key, value),
  });
  const data = Array.from({ length: 500 }, (_, index) => ({
    t0: index * 60_000, t1: (index + 1) * 60_000, o: 100, h: 110, l: 90, c: 102,
  }));
  const firstContainer = new FakeElement();
  const first = module.namespace.createTimeSeriesChart(firstContainer, {
    stateKey: 'remount-test', type: 'candlestick', bucketMs: 60_000, data,
  });
  firstContainer.children[0].children[0].dispatch('wheel', { deltaY: 100 });
  const beforeUnmount = first.getState().viewport.candleSpanMs;
  first.destroy();

  const second = module.namespace.createTimeSeriesChart(new FakeElement(), {
    stateKey: 'remount-test', type: 'candlestick', bucketMs: 60_000, data,
  });
  assert.equal(second.getState().viewport.candleSpanMs, beforeUnmount,
    'remount keeps the saved zoom span instead of fitting all data');
  assert.ok(stored.has('charting-instance:remount-test'), 'view state goes to the consumer\'s storage');
  second.destroy();
});
