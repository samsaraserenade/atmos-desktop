/**
 * Pure SVG renderer for the live portfolio allocation. The caller supplies
 * normalized entries (currently individual holdings from the sidebar).
 * Keeping this DOM-free makes the layout independently testable and avoids
 * coupling totals.js to the chart panel.
 */

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function shortName(value, max = 22) {
  const name = String(value || 'Connection');
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

export function buildAllocation(connections) {
  let entries = connections
    .map(connection => ({ ...connection, value: Math.max(0, Number(connection.value) || 0) }))
    .filter(connection => connection.value > 0)
    .sort((a, b) => b.value - a.value);
  // The sidebar chart is deliberately compact. Preserve every value in the
  // donut while grouping the long tail so labels never overlap vertically.
  if (entries.length > 7) {
    const leading = entries.slice(0, 6);
    const remainder = entries.slice(6);
    entries = [...leading, {
      id: '__other-holdings',
      name: 'Other',
      value: remainder.reduce((sum, entry) => sum + entry.value, 0),
      groupedCount: remainder.length,
    }];
  }
  const total = entries.reduce((sum, connection) => sum + connection.value, 0);
  return entries.map(connection => ({
    ...connection,
    share: total ? connection.value / total : 0,
  }));
}

export function renderAllocationSVG({
  connections, W, H, bottomInset = 42, monotone = false,
}) {
  const allocation = buildAllocation(connections);
  const plotBottom = Math.max(72, H - bottomInset);
  const maxShare = allocation.reduce((max, entry) => Math.max(max, entry.share), 0) || 1;
  const MIN_ALPHA = 0.32;
  const colorFor = entry => (monotone
    ? '#ffffff'
    : `rgba(var(--ink-rgb),${(MIN_ALPHA + (1 - MIN_ALPHA) * (entry.share / maxShare)).toFixed(3)})`);
  if (!allocation.length) {
    return {
      count: 0,
      markup: `<text x="${(W / 2).toFixed(1)}" y="${(plotBottom / 2).toFixed(1)}"
        text-anchor="middle" fill="rgba(var(--ink-rgb),.34)" font-size=".65rem"
        font-family="var(--app-font-family, 'Segoe UI', Roboto, sans-serif)">No live connection values</text>`,
    };
  }

  const centreX = Math.max(70, Math.min(W * 0.235, W - 170));
  const centreY = plotBottom / 2;
  const radius = Math.max(32, Math.min(plotBottom * 0.38, W * 0.17));
  const strokeWidth = Math.max(12, radius * 0.30);
  const circumference = 2 * Math.PI * radius;
  const gap = allocation.length > 1 ? Math.min(2.2, circumference * 0.006) : 0;
  let offset = 0;
  const arcs = allocation.map(entry => {
    const color = colorFor(entry);
    const length = circumference * entry.share;
    const visible = Math.max(0, length - gap);
    const arc = `<circle cx="${centreX.toFixed(1)}" cy="${centreY.toFixed(1)}" r="${radius.toFixed(1)}"
      fill="none" stroke="${color}" stroke-width="${strokeWidth.toFixed(1)}"
      stroke-linecap="butt" stroke-dasharray="${visible.toFixed(2)} ${(circumference - visible).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${centreX.toFixed(1)} ${centreY.toFixed(1)})"/> `;
    offset += length;
    return arc;
  }).join('');

  const legendX = Math.max(centreX + radius + strokeWidth, W * 0.53);
  const legendWidth = Math.max(75, W - legendX - 12);
  const rowHeight = Math.max(11, Math.min(22, (plotBottom - 16) / allocation.length));
  const startY = centreY - ((allocation.length - 1) * rowHeight) / 2;
  const legend = allocation.map((entry, index) => {
    const color = colorFor(entry);
    const y = startY + index * rowHeight;
    const percent = `${(entry.share * 100).toFixed(entry.share < 0.01 ? 1 : 0)}%`;
    return `
      <circle cx="${legendX.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="${color}"/>
      <text x="${(legendX + 10).toFixed(1)}" y="${y.toFixed(1)}" dominant-baseline="middle"
        fill="rgba(var(--ink-rgb),.68)" font-size=".7rem"
        font-family="var(--app-font-family, 'Segoe UI', Roboto, sans-serif)">${escapeXml(shortName(entry.name))}</text>
      <text x="${(legendX + legendWidth).toFixed(1)}" y="${y.toFixed(1)}" dominant-baseline="middle"
        text-anchor="end" fill="rgba(var(--ink-rgb),.9)" font-size=".72rem"
        font-weight="600" font-variant-numeric="tabular-nums"
        font-family="var(--app-font-family, 'Segoe UI', Roboto, sans-serif)">${percent}</text>`;
  }).join('');

  return {
    count: allocation.length,
    markup: `<g class="tc-allocation-chart">${arcs}${legend}</g>`,
  };
}
