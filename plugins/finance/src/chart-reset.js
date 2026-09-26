/** Measure the individual pane before the renderer's double-click reset. */
export function bindChartResetMeasurement(surface, getChart, context) {
  context.listen(surface, 'dblclick', event => {
    if (event.target?.closest?.('[role="toolbar"], .atmos-chart-controls')) return;
    getChart()?.resize();
  }, { capture: true });
}
