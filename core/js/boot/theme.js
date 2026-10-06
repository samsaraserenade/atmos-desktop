// Loaded by index.html before the first paint (a file, not inline: the page's
// Content-Security-Policy allows no inline scripts).
// Apply the saved theme before the first paint. The full Appearance service
// validates and reapplies it during normal startup; this tiny bootstrap only
// prevents the splash from flashing the dark defaults first.
(function () {
  try {
    var saved = JSON.parse(localStorage.getItem('samsara_v4') || localStorage.getItem('samsara_v3') || '{}');
    var theme = saved.coreState && saved.coreState.appearance && saved.coreState.appearance.data
      ? saved.coreState.appearance.data.theme
      : null;
    var themes = {
      'atmos-dark':  { ink: '255,255,255', surface: '22,22,24', workspace: '5,5,6', panelTint: '0,0,0', scheme: 'dark' },
      'amoled':      { ink: '255,255,255', surface: '0,0,0', workspace: '0,0,0', panelTint: '0,0,0', scheme: 'dark' },
      'atmos-light': { ink: '15,15,18', surface: '255,255,255', workspace: '228,229,233', panelTint: '250,250,252', scheme: 'light' }
    };
    if (!themes[theme]) return;
    document.documentElement.style.setProperty('--ink-rgb', themes[theme].ink);
    document.documentElement.style.setProperty('--surface-rgb', themes[theme].surface);
    document.documentElement.style.setProperty('--workspace-rgb', themes[theme].workspace);
    document.documentElement.style.setProperty('--panel-tint-rgb', themes[theme].panelTint);
    document.documentElement.style.colorScheme = themes[theme].scheme;
    document.documentElement.dataset.appTheme = theme;
  } catch (error) { /* use the CSS defaults when saved state is unavailable */ }
})();
