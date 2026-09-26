import { CHART_CONTROL_STYLES } from './src/chart-service.js';
/**
 * js/plugins/portfolio-tracker/panel.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The single chart-panel registration. Portfolio is the default mode and
 * Markets swaps its own data and toolbar into this same host when a ticker
 * is opened, so the panel switcher never exposes a second chart panel.
 *
 * Previously this lived in its own js/plugins/chart-view/ folder as a bare,
 * content-free skeleton purely to prove the registry could host a second
 * plugin (Step 11 of the migration log). It now lives here, next to the
 * total-chart.js it registers, and registers the real thing — so toggling
 * "Portfolio Chart" in the settings drawer hands the media panel over to
 * the balance chart instead of floating it above the panel.
 *
 * Imported for its side effect — same pattern js/plugins/index.js uses for
 * each sidebar.js today, and app.js imports this file for exactly that
 * reason.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { registerPanelPlugin } from './src/host/panel-registry.js';
import { colorForChange, onPriceColorChange } from './src/host/semantic-colors.js';
import { mount, unmount, mountPortfolioSection, setPriceAxisVisible, setTimeAxisVisible } from './src/total-chart.js';
import { setChartTypeIcons } from './src/toolbar-icons.js';
import { portfolioState } from './persist.js';
import { onStateLoaded, save } from './src/host/persist.js';
import { openMenu } from './src/host/context-menu.js';
import { indicatorContextMenuItems } from './src/sidebar-settings.js';
import { installAltChartSync } from './src/alt-chart-sync.js';
// The ticker picker (below) reuses the exact same watchlist data, active-
// ticker tracking, and pending-query mechanism the Markets sidebar accordion
// (markets/sidebar.js) and Markets' own ticker input (markets/panel.js)
// already use — no separate polling loop, no new state namespace.
import { tickerData, onUpdate as onTickerUpdate, updateTickerActive } from './markets/src/watchlist-data.js';
import { watchlistState, marketQueryState, onQueryRemembered } from './markets/persist.js';
import { chartLabel, parseMarketQuery, KNOWN_EXCHANGES } from './markets/src/query-engine.js';
import { queueMarketQuery } from './markets/src/session.js';

const CHART_MODE_EVENT = 'atmos:chart-mode';
let marketsPanelPromise = null;

function loadMarketsPanel() {
  marketsPanelPromise ??= import('./markets/panel.js');
  return marketsPanelPromise;
}

function createModeContext(parentContext) {
  const controller = new AbortController();
  const cleanups = [];
  let disposed = false;
  const onCleanup = cleanup => {
    if (typeof cleanup !== 'function') return cleanup;
    if (disposed) cleanup();
    else cleanups.push(cleanup);
    return cleanup;
  };
  return {
    signal: controller.signal,
    onCleanup,
    listen(target, type, listener, options) {
      target?.addEventListener(type, listener, options);
      return onCleanup(() => target?.removeEventListener(type, listener, options));
    },
    setTimeout(callback, delay) {
      const timer = globalThis.setTimeout(() => {
        if (!controller.signal.aborted) callback();
      }, delay);
      onCleanup(() => globalThis.clearTimeout(timer));
      return timer;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    },
    parent: parentContext,
  };
}

function mountChartPanel(contentEl, context) {
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = new URL('./assets/chart-workspace.css', import.meta.url).href;
  document.head.appendChild(style);
  const controlStyle = document.createElement('style');
  controlStyle.textContent = CHART_CONTROL_STYLES;
  document.head.appendChild(controlStyle);
  context.onCleanup(() => controlStyle.remove());
  context.onCleanup(() => style.remove());
  contentEl.innerHTML = `<div class="finance-workspace">
    <div class="finance-chart-body"><div class="finance-chart-grid" data-count="1"><div class="finance-chart-stage"></div></div></div>
  </div>`;
  const stage = contentEl.querySelector('.finance-chart-stage');
  const workspace = contentEl.querySelector('.finance-workspace');
  const grid = contentEl.querySelector('.finance-chart-grid');
  installAltChartSync(grid, context);
  const layoutPicker = document.createElement('div');
  layoutPicker.className = 'finance-layout-picker';
  layoutPicker.innerHTML = '<button type="button" class="mq-tool finance-layout-button" aria-label="Multiple charts" title="Multiple charts" aria-expanded="false"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M3 12h18"/></svg></button><div class="finance-layout-menu" role="group" aria-label="Chart layout" hidden><button type="button" data-count="1">One chart</button><button type="button" data-count="2" data-orientation="horizontal">Two · Side by side</button><button type="button" data-count="2" data-orientation="vertical">Two · Above / below</button><button type="button" data-count="3">Three charts</button><button type="button" data-count="4">Four charts</button></div>';
  const layoutButton = layoutPicker.querySelector('button');
  const layoutMenu = layoutPicker.querySelector('.finance-layout-menu');
  let extraContexts = [], layoutGeneration = 0;
  const refreshChartSizing = generation => requestAnimationFrame(() => {
    if (generation !== layoutGeneration || context.signal?.aborted) return;
    grid.querySelectorAll('.finance-chart-stage, .finance-extra-body').forEach(chartRoot => {
      chartRoot.dispatchEvent(new CustomEvent('finance:refresh-chart-sizing'));
    });
  });
  const closeLayout = () => { layoutMenu.hidden = true; layoutButton.setAttribute('aria-expanded', 'false'); };
  const setLayout = async (count, orientation = portfolioState.chartLayoutOrientation) => {
    orientation = orientation === 'vertical' ? 'vertical' : 'horizontal';
    count = [2, 3, 4].includes(count) ? count : 1;
    const generation = ++layoutGeneration;
    extraContexts.forEach(item => item.dispose()); extraContexts = [];
    grid.querySelectorAll('.finance-extra-chart').forEach(item => item.remove());
    grid.dataset.count = String(count);
    grid.dataset.orientation = orientation;
    portfolioState.chartLayoutOrientation = orientation;
    portfolioState.chartLayout = count; save();
    layoutMenu.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.count) === count && (count !== 2 || button.dataset.orientation === orientation))));
    closeLayout();
    if (count === 1) { refreshChartSizing(generation); return; }
    try {
      const { mountMarketsPanel } = await loadMarketsPanel();
      if (generation !== layoutGeneration || context.signal?.aborted) return;
      for (let index = 0; index < count - 1; index++) {
        const host = document.createElement('div');
        host.className = 'finance-extra-chart';
        host.setAttribute('aria-label', 'Chart ' + (index + 2));
        grid.appendChild(host);
        const child = createModeContext(context);
        extraContexts.push(child);
        const saved = portfolioState.extraCharts?.[index] || {};
        const update = patch => {
          const items = [...(portfolioState.extraCharts || [])];
          items[index] = { ...items[index], ...patch }; portfolioState.extraCharts = items; save();
        };
        let selectedSource = ['total', 'spot', 'perp', 'market'].includes(saved.source) ? saved.source : ['perp', 'spot', 'total'][index];
        const body = document.createElement('div'); body.className = 'finance-extra-body';
        host.append(body);
        let viewContext = null;
        let syncLabel = () => {};
        const render = () => {
          viewContext?.dispose(); body.replaceChildren();
          viewContext = createModeContext(child);
          if (selectedSource !== 'market') {
            mountPortfolioSection(body, viewContext, selectedSource, 'finance-extra-' + index);
          } else mountMarketsPanel(body, viewContext, {
            isolated: true, stateKey: 'finance-extra-' + index,
            query: portfolioState.extraCharts?.[index]?.query || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'][index], settings: portfolioState.extraCharts?.[index]?.settings,
            onQuery: query => { update({ query }); syncLabel(); },
            onSettings: patch => update({ settings: { ...portfolioState.extraCharts?.[index]?.settings, ...patch } }),
          });
          const toolbar = body.querySelector('.finance-portfolio-toolbar, .mq-toolbar');
          const { tickerPicker, syncTickerPickerLabel: syncExtraLabel } = createTickerPicker(viewContext,
            () => selectedSource === 'market' ? chartLabel(portfolioState.extraCharts?.[index]?.query || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'][index]) : 'Portfolio',
            query => {
              selectedSource = query ? 'market' : 'total';
              update(query ? { source: selectedSource, query } : { source: selectedSource });
              render();
            },
            () => selectedSource === 'market' ? (portfolioState.extraCharts?.[index]?.query || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'][index]) : null);
          syncLabel = syncExtraLabel;
          toolbar.prepend(tickerPicker);
          body.appendChild(createToolbarHandle(viewContext));
          const tabs = document.createElement('div');
          tabs.setAttribute('role', 'group');
          tabs.setAttribute('aria-label', 'Portfolio section');
          for (const key of selectedSource === 'market' ? [] : ['spot', 'perp', 'total']) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.portfolioSection = key;
            button.textContent = key[0].toUpperCase() + key.slice(1);
            button.classList.toggle('is-active', selectedSource === key);
            button.setAttribute('aria-pressed', String(selectedSource === key));
            viewContext.listen(button, 'click', () => {
              if (selectedSource === key) return;
              selectedSource = key; update({ source: key }); render();
            });
            tabs.appendChild(button);
          }
          if (tabs.childElementCount) toolbar.querySelector('.finance-toolbar-scroll').prepend(tabs);
          setChartTypeIcons(toolbar);
        };
        child.onCleanup(() => viewContext?.dispose());
        render();
      }
      refreshChartSizing(generation);
    } catch (error) {
      console.error('[finance] Could not open extra charts', error);
      if (generation === layoutGeneration) setLayout(1);
    }
  };
  context.listen(layoutButton, 'click', () => { layoutMenu.hidden = !layoutMenu.hidden; layoutButton.setAttribute('aria-expanded', String(!layoutMenu.hidden)); });
  context.listen(layoutMenu, 'click', event => { const button = event.target.closest('[data-count]'); if (button) setLayout(Number(button.dataset.count), button.dataset.orientation); });
  context.listen(document, 'pointerdown', event => { if (!layoutPicker.contains(event.target)) closeLayout(); });
  context.listen(layoutPicker, 'keydown', event => { if (event.key === 'Escape') { closeLayout(); layoutButton.focus(); } });
  context.onCleanup(() => { layoutGeneration++; extraContexts.forEach(item => item.dispose()); });
  setLayout(portfolioState.chartLayout);

  const syncTimeAxis = () => { workspace.dataset.timeAxis = portfolioState.timeAxisVisible === false ? 'hidden' : 'visible'; };
  syncTimeAxis();
  context.listen(document, 'finance:axes-change', syncTimeAxis);
  const stopTimeAxisSync = onStateLoaded(() => { syncTimeAxis(); document.dispatchEvent(new CustomEvent('finance:axes-change')); });
  if (typeof stopTimeAxisSync === 'function') context.onCleanup(stopTimeAxisSync);
  context.listen(grid, 'contextmenu', event => {
    if (!event.target.closest('.finance-plot-surface, .mq-chart-surface')) return;
    event.preventDefault(); event.stopPropagation();
    openMenu(event.clientX, event.clientY, indicatorContextMenuItems(), { title: 'Indicators' });
  });
  // chart-next owns the buttons and their immediate visual state; Finance
  // mirrors the result into its shared persisted axis preference so every
  // portfolio/market chart follows the same X/Y choice.
  context.listen(stage, 'click', event => {
    const button = event.target.closest('[data-axis-x], [data-axis-y]');
    if (!button) return;
    const visible = button.getAttribute('aria-pressed') === 'true';
    if (button.matches('[data-axis-x]')) setTimeAxisVisible(visible);
    else setPriceAxisVisible(visible);
  });

  // ── Toolbar dock/undock handle ──────────────────────────────────────────
  // A slim strip along the dock's own top edge (styled almost invisible in
  // chart-workspace.css) that can be dragged down to tuck the whole toolbar
  // out of the way — the chart reclaims that space — or dragged/clicked
  // again to bring it back. Created once here (like indicatorButton above)
  // and re-appended to `stage` on every showMode()
  // call so it survives Portfolio/Markets swaps. This toggles a class on
  // `workspace` and persists through portfolioState.
  const setToolbarCollapsed = (collapsed, { persist = true } = {}) => {
    workspace.classList.toggle('toolbar-hidden', collapsed);
    workspace.querySelectorAll('.finance-toolbar-handle').forEach(handle => {
      handle.setAttribute('aria-pressed', String(collapsed));
      handle.title = collapsed ? 'Drag up or click to show the toolbar' : 'Drag down or click to hide the toolbar';
    });
    if (persist) { portfolioState.toolbarCollapsed = collapsed; save(); }
  };
  setToolbarCollapsed(portfolioState.toolbarCollapsed === true, { persist: false });
  const stopToolbarSync = onStateLoaded(() => setToolbarCollapsed(portfolioState.toolbarCollapsed === true, { persist: false }));
  if (typeof stopToolbarSync === 'function') context.onCleanup(stopToolbarSync);
  function createToolbarHandle(context) {
    const toolbarHandle = document.createElement('div');
    toolbarHandle.className = 'finance-toolbar-handle';
    toolbarHandle.setAttribute('role', 'button');
    toolbarHandle.tabIndex = 0;
    toolbarHandle.setAttribute('aria-label', 'Show or hide the chart toolbar');
    let toolbarDrag = null;
    context.listen(toolbarHandle, 'pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      toolbarHandle.setPointerCapture(event.pointerId);
      toolbarDrag = { startY: event.clientY, moved: false, wasCollapsed: workspace.classList.contains('toolbar-hidden') };
    });
    context.listen(toolbarHandle, 'pointermove', event => {
      if (!toolbarDrag) return;
      const dy = event.clientY - toolbarDrag.startY;
      if (Math.abs(dy) > 3) toolbarDrag.moved = true;
      // Live-follow the drag rather than only snapping once the pointer is
      // released, with a little hysteresis so small jitter near the handle
      // (e.g. a click that lands on it by a few px) doesn't toggle anything.
      // Direction is what matters, not current state: drag down past the
      // threshold tucks it away, drag up past the threshold brings it back
      // — the same physical gesture whichever edge the handle is currently
      // sitting on. (Previously this compared against `wasCollapsed` instead
      // of direction, which meant dragging *up* to bring a hidden toolbar
      // back could never satisfy the reveal condition — only another
      // downward drag could. Fixed here.)
      if (dy > 28) toolbarDrag.pending = true;
      else if (dy < -28) toolbarDrag.pending = false;
      else return;
      workspace.classList.toggle('toolbar-hidden', toolbarDrag.pending);
    });
    const finishToolbarDrag = () => {
      if (!toolbarDrag) return;
      const { moved, wasCollapsed } = toolbarDrag;
      toolbarDrag = null;
      // A real drag keeps wherever it landed; a plain click/tap (no meaningful
      // movement) just toggles from whatever state it started in.
      setToolbarCollapsed(moved ? workspace.classList.contains('toolbar-hidden') : !wasCollapsed);
    };
    context.listen(toolbarHandle, 'pointerup', finishToolbarDrag);
    context.listen(toolbarHandle, 'pointercancel', finishToolbarDrag);
    context.listen(toolbarHandle, 'keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      setToolbarCollapsed(!workspace.classList.contains('toolbar-hidden'));
    });
  
      toolbarHandle.setAttribute('aria-pressed', String(workspace.classList.contains('toolbar-hidden')));
      return toolbarHandle;
  }

  const toolbarHandle = createToolbarHandle(context);

  // ── Ticker picker ────────────────────────────────────────────────────────
  // A dropdown pinned to the toolbar's far left (the reference the user
  // shared was an exchange's ticker-search dropdown) for jumping straight to
  // Portfolio or any watchlisted symbol, without hunting through Markets'
  // own ticker input or the sidebar's watchlist accordion. Scoped to the
  // data this plugin actually has, unlike the reference: there's no symbol
  // catalog/category service here, so this lists the same watchlist prices
  // the Markets sidebar already tracks (markets/src/watchlist-data.js polls
  // them continuously via a boot hook, regardless of chart mode) rather than
  // browsing the whole exchange. Portfolio is always the pinned first row.
  // getQuery(): the chart's current market query, or null while it shows the
  // portfolio. The exchange row starts from that query's exchanges (none
  // named = All) and applies to the current chart and to tickers picked here.
  function createTickerPicker(context, getLabel, onSelect, getQuery = () => null) {
    const tickerPicker = document.createElement('div');
    tickerPicker.className = 'finance-ticker-picker';
    const tickerPickerButton = document.createElement('button');
    tickerPickerButton.type = 'button';
    tickerPickerButton.className = 'finance-ticker-picker-button';
    // Doubles as the "what am I looking at" readout that used to live in
    // Markets' own separate ticker input (now hidden inside the shared dock
    // — see the .mq-ticker-form rule in chart-workspace.css) — one merged
    // control instead of two side-by-side lookalikes.
    tickerPickerButton.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg><span class="finance-ticker-picker-label">Portfolio</span>';
    tickerPickerButton.title = 'Switch chart';
    tickerPickerButton.setAttribute('aria-label', 'Switch chart');
    tickerPickerButton.setAttribute('aria-haspopup', 'listbox');
    tickerPickerButton.setAttribute('aria-expanded', 'false');
    const tickerPickerLabel = tickerPickerButton.querySelector('.finance-ticker-picker-label');
    // Read the selection belonging to this chart, including external updates.
    const syncTickerPickerLabel = () => {
      tickerPickerLabel.textContent = getLabel();
    };
    const tickerPickerPanel = document.createElement('div');
    tickerPickerPanel.className = 'finance-ticker-picker-panel';
    tickerPickerPanel.hidden = true;
    tickerPickerPanel.setAttribute('role', 'listbox');
    tickerPickerPanel.setAttribute('aria-label', 'Switch chart');
    tickerPickerPanel.innerHTML = `<input type="text" class="finance-ticker-picker-search" placeholder="Search or paste a ticker…" autocomplete="off" spellcheck="false" aria-label="Search tickers">
      <div class="finance-exchange-picker" role="group" aria-label="Exchanges"></div>
      <div class="finance-ticker-picker-list"></div>`;
    tickerPicker.append(tickerPickerButton, tickerPickerPanel);
    const tickerSearch = tickerPickerPanel.querySelector('.finance-ticker-picker-search');
    const tickerList = tickerPickerPanel.querySelector('.finance-ticker-picker-list');
    const exchangeRow = tickerPickerPanel.querySelector('.finance-exchange-picker');
    let selectedExchanges = [];
    const withExchanges = symbol => [symbol, ...selectedExchanges].join(' ');
    const renderExchanges = () => {
      exchangeRow.replaceChildren();
      for (const id of ['all', ...KNOWN_EXCHANGES]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'finance-exchange-chip';
        button.textContent = id === 'all' ? 'All' : id[0].toUpperCase() + id.slice(1);
        const active = id === 'all' ? !selectedExchanges.length : selectedExchanges.includes(id);
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
        context.listen(button, 'click', () => {
          if (id === 'all') selectedExchanges = [];
          else {
            const next = selectedExchanges.includes(id) ? selectedExchanges.filter(item => item !== id) : [...selectedExchanges, id];
            // Every exchange picked is the same as All.
            selectedExchanges = next.length === KNOWN_EXCHANGES.length ? [] : KNOWN_EXCHANGES.filter(item => next.includes(item));
          }
          renderExchanges();
          const current = getQuery();
          const symbol = current && parseMarketQuery(current).symbol;
          if (symbol) onSelect(withExchanges(symbol));
          tickerSearch.focus();
        });
        exchangeRow.appendChild(button);
      }
    };
  
    const formatTickerPrice = price => !Number.isFinite(price) ? '…'
      : price >= 1000 ? '$' + price.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : price >= 1 ? '$' + price.toFixed(2) : '$' + price.toPrecision(4);
    const formatTickerChange = change => change == null ? '' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
    // Core's shared semantic palette (positive/negative/neutral).
    const colorForTickerChange = colorForChange;
  
    const closeTickerPicker = () => {
      if (tickerPickerPanel.hidden) return;
      tickerPickerPanel.hidden = true;
      tickerPickerButton.setAttribute('aria-expanded', 'false');
    };
  
    const renderTickerPicker = () => {
      if (tickerPickerPanel.hidden) return;
      const query = tickerSearch.value.trim().toUpperCase();
      tickerList.replaceChildren();
      const portfolioRow = document.createElement('button');
      portfolioRow.type = 'button';
      portfolioRow.className = 'finance-ticker-picker-row finance-ticker-picker-portfolio';
      portfolioRow.setAttribute('role', 'option');
      portfolioRow.innerHTML = '<span class="finance-ticker-picker-symbol">Portfolio</span><span class="finance-ticker-picker-sub">Balance chart</span>';
      context.listen(portfolioRow, 'click', () => { closeTickerPicker(); onSelect(null); });
      tickerList.appendChild(portfolioRow);
      const tickers = [...watchlistState.tickers]
        .filter(symbol => !query || symbol.includes(query))
        .sort((a, b) => (tickerData[b]?.change ?? -Infinity) - (tickerData[a]?.change ?? -Infinity));
      for (const symbol of tickers) {
        const data = tickerData[symbol];
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'finance-ticker-picker-row';
        row.setAttribute('role', 'option');
        row.innerHTML = `<span class="finance-ticker-picker-symbol">${symbol}</span><span class="finance-ticker-picker-price">${formatTickerPrice(data?.price)}</span><span class="finance-ticker-picker-change">${formatTickerChange(data?.change)}</span>`;
        row.querySelector('.finance-ticker-picker-change').style.color = colorForTickerChange(data?.change ?? null);
        context.listen(row, 'click', () => {
          closeTickerPicker();
          onSelect(withExchanges(`${symbol}USDT`));
        });
        tickerList.appendChild(row);
      }
      if (!tickers.length && query) {
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'finance-ticker-picker-row finance-ticker-picker-jump';
        jump.setAttribute('role', 'option');
        jump.innerHTML = `<span class="finance-ticker-picker-symbol">Look up “${query}”</span>`;
        context.listen(jump, 'click', () => {
          closeTickerPicker();
          onSelect(withExchanges(/(?:USDT|USDC|USD)$/.test(query) ? query : `${query}USDT`));
        });
        tickerList.appendChild(jump);
      }
    };
    const openTickerPicker = () => {
      if (!tickerPickerPanel.hidden) return;
      tickerPickerPanel.hidden = false;
      tickerPickerButton.setAttribute('aria-expanded', 'true');
      tickerSearch.value = '';
      const current = getQuery();
      selectedExchanges = (current && parseMarketQuery(current).exchanges) || [];
      renderExchanges();
      renderTickerPicker();
      tickerSearch.focus();
    };
    context.listen(tickerPickerButton, 'click', () => (tickerPickerPanel.hidden ? openTickerPicker() : closeTickerPicker()));
    context.listen(tickerSearch, 'input', renderTickerPicker);
    context.listen(tickerSearch, 'keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { closeTickerPicker(); tickerPickerButton.focus(); return; }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const target = tickerSearch.value.trim()
        ? tickerList.querySelector('.finance-ticker-picker-row:not(.finance-ticker-picker-portfolio)')
        : tickerList.querySelector('.finance-ticker-picker-portfolio');
      target?.click();
    });
    context.listen(document, 'pointerdown', event => {
      if (tickerPickerPanel.hidden || tickerPicker.contains(event.target)) return;
      closeTickerPicker();
    });
    context.onCleanup(onTickerUpdate(() => { renderTickerPicker(); syncTickerPickerLabel(); }));
    context.onCleanup(onPriceColorChange(renderTickerPicker));
    renderTickerPicker();
  
    syncTickerPickerLabel();
    return { tickerPicker, syncTickerPickerLabel };
  }

  let activeMode = null;
  const { tickerPicker, syncTickerPickerLabel } = createTickerPicker(context,
    () => activeMode === 'markets' ? chartLabel(marketQueryState.lastQuery) : 'Portfolio',
    query => {
      if (!query) { showMode('portfolio'); return; }
      updateTickerActive(parseMarketQuery(query).symbol.replace(/USDT$/, ''));
      queueMarketQuery(query);
      showMode('markets');
    },
    () => activeMode === 'markets' ? marketQueryState.lastQuery : null);
  context.onCleanup(onQueryRemembered(() => syncTickerPickerLabel()));
  let requestedMode = 'portfolio';
  let disposeMode = () => {};
  // Builds the next mode's whole DOM tree off-screen (detached, not yet a
  // child of `stage`) and only swaps it in once it's fully ready. Markets
  // mode needs `await loadMarketsPanel()` — a dynamic import that, even
  // once the module is cached, still resolves on a later microtask/frame,
  // never synchronously — so the previous code's `stage.replaceChildren()`
  // *before* that await left the panel completely empty for however long
  // that took. That's the flash: chart vanishes, then pops back once the
  // import resolves. Building into a detached container first means the
  // outgoing mode's chart stays on screen the entire time the next one is
  // loading, and the only DOM change anyone sees is one atomic swap.
  const showMode = async mode => {
    const nextMode = mode === 'markets' ? 'markets' : 'portfolio';
    requestedMode = nextMode;
    if (nextMode === activeMode) return;
    const previousDispose = disposeMode;
    let nextDispose = () => {};
    // A plain block div would collapse — total-chart.js's and markets'
    // own root elements both assume `height:100%` resolves against a
    // definite-height parent, same as when they were direct children of
    // `stage` (which gets its height from flex:1 on its own parent).
    const container = document.createElement('div');
    container.style.cssText = 'width:100%; height:100%;';
    if (nextMode === 'markets') {
      const modeContext = createModeContext(context);
      try {
        const { mountMarketsPanel } = await loadMarketsPanel();
        if (requestedMode !== nextMode || context.signal?.aborted) {
          modeContext.dispose();
          return;
        }
        mountMarketsPanel(container, modeContext);
        nextDispose = () => modeContext.dispose();
      } catch (error) {
        modeContext.dispose();
        if (requestedMode !== nextMode) return;
        console.error('[portfolio-tracker] Markets chart failed to load:', error);
        showMode('portfolio');
        return;
      }
    } else {
      mount(container, context);
      nextDispose = () => unmount();
    }
    // Everything above ran without disturbing what's currently on screen.
    // From here on it's synchronous: dispose the old mode, swap the DOM in
    // one call, then move the persistent toolbar pieces (ticker picker,
    // indicators/settings, drag handle) into their new home — moving them
    // now, rather than before the swap, means they're never visibly absent
    // from the *old*, still-displayed toolbar for even a frame.
    previousDispose();
    stage.replaceChildren(container);
    disposeMode = nextDispose;
    activeMode = nextMode;
    // Persist which chart is showing so the next mount (panel switch away
    // and back, or an app restart) can restore it below instead of always
    // snapping back to Portfolio -- the ticker itself needs no separate
    // bookkeeping here since markets/panel.js already restores its own
    // last-viewed symbol from marketQueryState.lastQuery on mount.
    if (portfolioState.chartMode !== nextMode) { portfolioState.chartMode = nextMode; save(); }
    const toolbar = container.querySelector('.finance-portfolio-toolbar, .mq-toolbar');
    setChartTypeIcons(toolbar);
    toolbar.prepend(tickerPicker);
    toolbar.append(layoutPicker);
    stage.appendChild(toolbarHandle);
    syncTickerPickerLabel();
  };
  context.listen(document, CHART_MODE_EVENT, event => showMode(event.detail?.mode));
  context.onCleanup(() => disposeMode());
  // Restore whichever chart (Portfolio or a specific ticker) was showing
  // before this panel was last unmounted, instead of always opening back
  // on Portfolio. Boot hooks run after persisted state hydrates (see
  // boot.js), but this mount() can in principle still race it, so this
  // mirrors the toolbarCollapsed restore above: call it now with whatever
  // portfolioState currently holds, then once more after onStateLoaded in
  // case hydration was still pending -- showMode() itself is a no-op if
  // the mode hasn't actually changed, so the second call only matters
  // when the first one ran too early.
  const restoreMode = () => showMode(portfolioState.chartMode === 'markets' ? 'markets' : 'portfolio');
  restoreMode();
  const stopModeSync = onStateLoaded(restoreMode);
  if (typeof stopModeSync === 'function') context.onCleanup(stopModeSync);
}

registerPanelPlugin('portfolio-tracker', {
  legacyIds: ['chart-view'],
  panelAppearance: true,
  // For the future panel-switcher UI — not rendered anywhere yet (same
  // status as audio-player's icon/label).
  icon: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 8l-5 5-3-3-4 4"/></svg>`,
  label: 'Finance',
  mount: mountChartPanel,
  unmount,
});
