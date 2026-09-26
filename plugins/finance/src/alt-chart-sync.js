const CHART_ROOT_SELECTOR = '.finance-chart-stage, .finance-extra-body';
const PLOT_SELECTOR = '.atmos-chart__price-host';
const CONTROL_ATTRIBUTES = [
  'data-axis-x', 'data-axis-y', 'data-timeline', 'data-scale', 'data-bridge',
  'data-indicator', 'data-follow', 'data-chart-type', 'data-interval', 'data-range',
];

function chartRoots(grid) {
  return [...grid.querySelectorAll(CHART_ROOT_SELECTOR)]
    .filter(root => root.querySelector(PLOT_SELECTOR));
}

function chartRootFor(grid, target) {
  return chartRoots(grid).find(root => root.contains(target)) || null;
}

function matchingControl(root, source) {
  for (const attribute of CONTROL_ATTRIBUTES) {
    if (!source.hasAttribute(attribute)) continue;
    const value = source.getAttribute(attribute);
    return [...root.querySelectorAll(`[${attribute}]`)]
      .find(candidate => candidate.getAttribute(attribute) === value) || null;
  }
  return null;
}

function mappedPoint(event, source, target) {
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const xRatio = from.width ? (event.clientX - from.left) / from.width : 0.5;
  const yRatio = from.height ? (event.clientY - from.top) / from.height : 0.5;
  return {
    clientX: to.left + Math.max(0, Math.min(1, xRatio)) * to.width,
    clientY: to.top + Math.max(0, Math.min(1, yRatio)) * to.height,
  };
}

function pointerEvent(type, source, point) {
  const EventType = globalThis.PointerEvent || globalThis.MouseEvent;
  return new EventType(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: source.pointerId,
    pointerType: source.pointerType,
    isPrimary: source.isPrimary,
    button: source.button,
    buttons: source.buttons,
    pressure: source.pressure,
    altKey: true,
    ctrlKey: source.ctrlKey,
    metaKey: source.metaKey,
    shiftKey: source.shiftKey,
    ...point,
  });
}

/**
 * Finance-only multichart gesture fan-out. The charting service keeps owning
 * every actual action; this layer merely repeats an Alt-modified interaction
 * against the equivalent control or plot in the sibling Finance charts.
 */
export function installAltChartSync(grid, context) {
  const relayed = new WeakSet();
  let gesture = null;

  const peersFor = sourceRoot => chartRoots(grid).filter(root => root !== sourceRoot);
  const dispatchRelayed = (target, event) => {
    relayed.add(event);
    target.dispatchEvent(event);
  };

  context.listen(grid, 'click', event => {
    if (!event.altKey || relayed.has(event)) return;
    const control = event.target.closest(CONTROL_ATTRIBUTES.map(attribute => `[${attribute}]`).join(','));
    const sourceRoot = control && chartRootFor(grid, control);
    if (!sourceRoot || chartRoots(grid).length < 2) return;
    for (const peer of peersFor(sourceRoot)) {
      const match = matchingControl(peer, control);
      if (!match || match.disabled) continue;
      dispatchRelayed(match, new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
    }
  });

  context.listen(grid, 'wheel', event => {
    if (!event.altKey || relayed.has(event)) return;
    const sourcePlot = event.target.closest(PLOT_SELECTOR);
    const sourceRoot = sourcePlot && chartRootFor(grid, sourcePlot);
    if (!sourceRoot || chartRoots(grid).length < 2) return;
    for (const peer of peersFor(sourceRoot)) {
      const targetPlot = peer.querySelector(PLOT_SELECTOR);
      if (!targetPlot) continue;
      const point = mappedPoint(event, sourcePlot, targetPlot);
      dispatchRelayed(targetPlot, new WheelEvent('wheel', {
        bubbles: true, cancelable: true, altKey: true,
        ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
        deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ,
        deltaMode: event.deltaMode, ...point,
      }));
    }
  });

  context.listen(grid, 'pointerdown', event => {
    if (!event.altKey || event.button !== 0 || relayed.has(event)) return;
    const sourcePlot = event.target.closest(PLOT_SELECTOR);
    const sourceRoot = sourcePlot && chartRootFor(grid, sourcePlot);
    if (!sourceRoot || chartRoots(grid).length < 2) return;
    gesture = {
      sourcePlot,
      targets: peersFor(sourceRoot).map(root => root.querySelector(PLOT_SELECTOR)).filter(Boolean),
    };
    for (const target of gesture.targets) {
      const point = mappedPoint(event, sourcePlot, target);
      // Synthetic pointers cannot be captured by the browser. The chart only
      // uses capture to keep real drags routed to itself; this coordinator
      // routes the mirrored drag explicitly, so a no-op is correct here.
      const capture = target.setPointerCapture;
      try {
        target.setPointerCapture = () => {};
        dispatchRelayed(target, pointerEvent('pointerdown', event, point));
      } finally {
        if (capture) target.setPointerCapture = capture;
        else delete target.setPointerCapture;
      }
    }
  });

  const relayGesture = type => event => {
    if (!gesture || relayed.has(event)) return;
    for (const target of gesture.targets) {
      dispatchRelayed(target, pointerEvent(type, event, mappedPoint(event, gesture.sourcePlot, target)));
    }
    if (type !== 'pointermove') gesture = null;
  };
  context.listen(grid, 'pointermove', relayGesture('pointermove'));
  context.listen(grid, 'pointerup', relayGesture('pointerup'));
  context.listen(grid, 'pointercancel', relayGesture('pointercancel'));
  context.onCleanup(() => { gesture = null; });
}

