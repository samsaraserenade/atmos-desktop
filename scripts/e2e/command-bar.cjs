// Atmos's command bar (core/js/core/command-bar.js) end to end, with a
// developer-folder extension that adds commands (SDK 1.3):
//   - in a panel (the default): Alt+\ lays Atmos's bar along the bottom of
//     the panel you're in (a panel with no bar of its own), or over the bar
//     a panel declares (atmos.commands.bar); the list as wide as the panel;
//   - Atmos's commands (switch, settings <page>, extensions, sidebar), a
//     panel by name, Tab, Esc, the mouse;
//   - an extension's commands: listed by what's showing (only once typed
//     while nothing of it shows), run in its frame (its background frame
//     while its panel is away), what it lists as you type, its options
//     (a toggle, chips, a text field), a danger row, a next step it fills
//     in, an error, Atmos's own names refused, rev/ typed into its field
//     handing over to the bar (atmos.commands.open);
//   - Alt+\ inside an extension's frame;
//   - in the sidebar (Appearance → Command Bar): the footer row as the field.
// Alt+\ in a web page is in browser.cjs.
// Usage: node scripts/e2e/command-bar.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'command-bar'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env } = isolatedEnv('atmos-command-bar-');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, { timeout = 8000, every = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value || Date.now() > deadline) return value;
    await wait(every);
  }
}

// A developer folder with commands: its panel has a bar of its own and a
// field that hands rev/ to Atmos; its background frame runs rev/roll too.
const probe = path.join(home, 'command-probe');
fs.mkdirSync(probe, { recursive: true });
fs.writeFileSync(path.join(probe, 'extension.json'), JSON.stringify({
  apiVersion: 3,
  displayName: 'Command Probe',
  version: '1.0.0',
  contributes: {
    panel: { label: 'Probe', glass: true },
    sidebar: { label: 'Probe Widget', showIn: [] },
    boot: true,
    commands: [
      { name: 'roll', args: 'dice', about: 'Roll some dice', takesArgs: true },
      { name: 'pick', args: 'fruit', about: 'Pick a fruit', takesArgs: true, suggests: true },
      { name: 'wipe', about: 'Wipe the slate', suggests: true },
      { name: 'step', about: 'Two steps' },
      { name: 'boom', about: 'Breaks' },
      { name: 'look', about: 'Shows its panel' },
      { name: 'switch', about: 'Atmos\'s own name' },
    ],
  },
}, null, 2));
fs.writeFileSync(path.join(probe, 'panel.js'), `
import atmos from 'atmos-sdk';
// The SDK's standard bottom bar (ui.css .atmos-bar), with Atmos's shell glass.
const ui = document.createElement('link');
ui.rel = 'stylesheet';
ui.href = '/__atmos/ui.css';
document.head.append(ui);
document.body.innerHTML = '<main style="display:flex;flex-direction:column;height:100%"><div style="flex:1"></div>'
  + '<footer id="bar" class="atmos-bar" data-atmos-glass="shell"><input id="field" class="atmos-bar-input" placeholder="Say something, or rev/"></footer></main>';
const probe = window.__probe = { log: [], errors: [] };
atmos.surface.trackGlass();
atmos.commands.bar(document.getElementById('bar'));
const field = document.getElementById('field');
// rev/ typed here goes to Atmos's bar (keys typed before it has the keyboard follow).
atmos.commands.field(field, { options: { size: 'small' } });
// The bar opened with text of the probe's choosing (kept as sent; another's row is then never chosen for the user).
probe.open = text => atmos.commands.open(text).then(() => 'opened', error => error.message);
const FRUIT = ['Apple', 'Apricot', 'Banana', 'Cherry'];
atmos.commands.handle('roll', ({ args }) => ({ done: 'Rolled ' + (args || 'a die') + ' (panel)' }));
atmos.commands.handle('pick', ({ value, options }) => {
  probe.log.push({ value, options });
  return { done: 'Picked ' + value + ' (' + [options.size || 'medium', options.ripe ? 'ripe' : null, options.note || null].filter(Boolean).join(', ') + ')' };
}, {
  suggest: ({ args, options }) => ({
    rows: [{ heading: 'Fruit' }, ...FRUIT.filter(name => name.toLowerCase().startsWith(args.toLowerCase()))
      .map(name => ({ title: name, sub: 'A ' + (options.size || 'medium') + ' one', action: 'Pick', value: name.toLowerCase(), complete: name }))],
    options: [
      { id: 'ripe', type: 'toggle', label: 'ripe', value: options.ripe === true },
      { id: 'size', type: 'select', style: 'chips', value: options.size || 'medium', options: ['small', 'medium', 'large'].map(size => ({ value: size, label: size })) },
      { id: 'note', type: 'text', label: 'note', prefix: '#', placeholder: 'note', value: options.note || '' },
    ],
  }),
});
atmos.commands.handle('wipe', () => ({ done: 'Wiped' }), { suggest: () => [{ title: 'Wipe everything', sub: 'Can\\'t be undone', action: 'Wipe', danger: true }] });
atmos.commands.handle('step', () => ({ fill: 'rev/pick ', options: { size: 'large' }, done: 'Now pick one' }));
atmos.commands.handle('boom', () => { throw new Error('It broke'); });
atmos.commands.handle('switch', () => ({ done: 'never' }));
`);
fs.writeFileSync(path.join(probe, 'boot.js'), `
import atmos from 'atmos-sdk';
atmos.commands.handle('roll', ({ args }) => ({ done: 'Rolled ' + (args || 'a die') + ' (boot)' }));
atmos.commands.handle('look', async () => { await atmos.panel.show(); return { done: 'Looked' }; });
`);
fs.writeFileSync(path.join(probe, 'sidebar.js'), 'document.body.textContent = "Probe widget";\n');

const report = { home, checks: {}, details: {} };
const check = (name, ok, detail) => {
  report.checks[name] = !!ok;
  if (!ok && detail !== undefined) report.details[name] = detail;
};

(async () => {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [repo, `--extensions-root=${repo}`, `--dev-extension=${probe}`, '--no-sandbox', '--disable-gpu'],
    cwd: repo, env,
  });
  const page = await atmosWindow(app);
  const errors = [];
  const consoleLines = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    consoleLines.push(message.text());
    if (['error', 'warning'].includes(message.type()) && !/TUNNEL|rate fetch|save\(\) called before|Electron Security Warning|VPS unavailable|portfolio|cannot handle rev\/switch|developing|Atmos Browser/i.test(message.text())) errors.push(`${message.type()}: ${message.text()}`);
  });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 45000 });
  await wait(2000);

  const state = () => page.evaluate(async () => {
    const field = document.getElementById('command-bar-field');
    const list = document.getElementById('command-bar-list');
    const footer = document.getElementById('sidebar-footer');
    const input = field?.isConnected ? document.getElementById('command-bar-input') : footer?.classList.contains('is-commanding') ? document.getElementById('sidebar-command-input') : null;
    const settings = document.getElementById('settings-menu');
    const box = element => { if (!element?.isConnected) return null; const rect = element.getBoundingClientRect(); return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height), bottom: Math.round(rect.bottom) }; };
    const firstText = element => (element?.firstChild?.textContent ?? '').trim();
    return {
      open: !!input,
      where: field?.isConnected ? (field.classList.contains('is-own') ? 'own bar' : 'panel bar') : footer?.classList.contains('is-commanding') ? 'footer' : null,
      focused: !!input && document.activeElement === input,
      value: input?.value ?? null,
      sidebar: document.body.classList.contains('drawer-open'),
      rows: [...(list?.querySelectorAll('.command-bar-item-title, .command-bar-note, .command-bar-heading') || [])].map(row => (row.classList.contains('command-bar-item-title') ? firstText(row) : row.textContent.trim())),
      sources: [...(list?.querySelectorAll('.command-bar-item') || [])].map(item => item.querySelector('.command-bar-item-source')?.textContent.trim() || ''),
      subs: [...(list?.querySelectorAll('.command-bar-item-sub') || [])].map(sub => sub.textContent.trim()),
      active: firstText(list?.querySelector('.command-bar-item.active .command-bar-item-title')) || null,
      danger: [...(list?.querySelectorAll('.command-bar-item.danger .command-bar-item-title') || [])].map(firstText),
      chips: [...(list?.querySelectorAll('.command-bar-chip') || [])].map(chip => `${chip.textContent.trim()}${chip.classList.contains('on') ? '*' : ''}`),
      status: list?.querySelector('.command-bar-status')?.textContent.trim() || null,
      statusError: !!list?.querySelector('.command-bar-status.is-error'),
      flash: document.querySelector('.command-bar-flash')?.textContent.trim() || null,
      field: box(field), list: box(list), footer: box(footer),
      panel: (await import('atmos-core/core/panel-registry.js')).getActivePanelPluginId(),
      settings: !!settings?.classList.contains('open'),
      settingsPage: settings?.classList.contains('open') ? settings.querySelector('.sm-nav-item.active .sm-nav-label')?.textContent.trim() ?? null : null,
      activeTag: document.activeElement?.tagName,
    };
  });
  const press = async key => { await page.keyboard.press(key); await wait(300); };
  const type = async text => { await page.keyboard.type(text, { delay: 25 }); await wait(400); };
  const closeSettings = () => page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).closeSettingsMenu());
  const panelBox = id => page.evaluate(selector => {
    const frame = document.querySelector(selector);
    const rect = frame?.getBoundingClientRect();
    return rect ? { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height), bottom: Math.round(rect.bottom) } : null;
  }, `iframe[data-extension="${id}"].atmos-extension-frame-panel`);
  const probeFrame = () => page.frames().find(frame => frame.url().includes('ext=plugin%3Acommand-probe') && frame.url().includes('surface=panel'));
  const clickRow = async title => {
    const point = await page.evaluate(text => {
      const item = [...document.querySelectorAll('#command-bar-list .command-bar-item')].find(row => row.querySelector('.command-bar-item-title')?.firstChild?.textContent.trim() === text);
      const box = item?.getBoundingClientRect();
      return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
    }, title);
    if (point) await page.mouse.click(point.x, point.y);
    await wait(500);
    return !!point;
  };
  const clickChip = async label => {
    const point = await page.evaluate(text => {
      const chip = [...document.querySelectorAll('#command-bar-list .command-bar-chip')].find(element => element.textContent.trim() === text);
      const box = chip?.getBoundingClientRect();
      return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
    }, label);
    if (point) await page.mouse.click(point.x, point.y);
    await wait(600);
    return !!point;
  };

  try {
    await page.evaluate(async () => (await import('atmos-core/core/sidebar-shell.js')).closeSidebar());
    await wait(400);
    report.panels = await page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).listPanelPlugins().map(panel => `${panel.id}:${panel.label}`));
    const summary = await page.evaluate(async () => (await window.atmosCore.listPlugins()).find(plugin => plugin.id === 'command-probe')?.trust?.permissionSummary
      ?? (await window.atmosCore.listPlugins()).find(plugin => plugin.id === 'command-probe')?.permissionSummary ?? null);
    check('the extension\'s commands are on what it\'s approved on, never Atmos\'s own names',
      Array.isArray(summary) && summary.includes('Adds commands to Atmos\'s command bar: rev/roll, rev/pick, rev/wipe, rev/step, rev/boom, rev/look'), summary);

    // ── In a panel with no bar of its own (Atmos Browser) ────────────────
    const browser = await panelBox('plugin:browser');
    await press('Alt+Backslash');
    let now = await state();
    check('Alt+\\ opens Atmos\'s bar along the bottom of the panel, with the keyboard, the sidebar left closed',
      now.where === 'own bar' && now.focused && !now.sidebar, now);
    check('…54 px, as wide as the panel, on its bottom edge',
      now.field && browser && now.field.height === 54 && Math.abs(now.field.width - browser.width) <= 1 && Math.abs(now.field.bottom - browser.bottom) <= 1 && Math.abs(now.field.left - browser.left) <= 1, { field: now.field, browser });
    check('the list rises from it, as wide', now.list && Math.abs(now.list.bottom - now.field.top) <= 1 && now.list.width === now.field.width, { list: now.list, field: now.field });
    const headings = await page.evaluate(() => [...document.querySelectorAll('#command-bar-list .command-bar-heading')].map(item => item.textContent.trim()));
    check('every command, under its extension\'s name: the browser\'s first (the panel it\'s for), then Atmos\'s, then the rest by name',
      JSON.stringify(now.rows.slice(0, 12)) === JSON.stringify(['Atmos Browser', 'rev/new-tab', 'rev/tab', 'rev/close-tab', 'Atmos', 'rev/sidebar', 'rev/sidebar-side', 'rev/settings', 'rev/extensions', 'rev/switch', 'rev/wallpaper', 'rev/reload'])
      && JSON.stringify(headings) === JSON.stringify(['Atmos Browser', 'Atmos', 'Audio Player', 'Command Probe · community', 'Finance', 'Matrix Chat'])
      && now.rows.includes('rev/roll') && now.rows.includes('rev/chart') && now.rows.includes('rev/go') && now.sources.every(source => source === ''), { rows: now.rows, headings, sources: now.sources });
    await page.screenshot({ path: path.join(out, '01-own-bar.png') });

    await type('ro');
    now = await state();
    check('typed, an extension\'s command is there, saying whose (a community one\'s says so)', JSON.stringify(now.rows) === JSON.stringify(['rev/roll']) && now.sources[0] === 'Command Probe · community', now);
    await press('Enter');
    now = await state();
    check('Enter on a command that takes something gives it a space', now.value === 'rev/roll ' && now.open, now.value);
    await type('2d6');
    await press('Enter');
    await wait(300);
    now = await state();
    check('with its panel away, it runs in its background frame; the bar closes and says what happened',
      !now.open && now.flash === 'Rolled 2d6 (boot)', now);
    await page.screenshot({ path: path.join(out, '02-flash.png') });
    await wait(3600);

    // Shift+Enter: and go there. Alt+Enter: stay here, whatever the command asks.
    const panelNow = () => page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).getActivePanelPluginId());
    await press('Alt+Backslash');
    await type('rev/look');
    const foot = await page.evaluate(() => document.querySelector('#command-bar-list .command-bar-foot')?.textContent.trim());
    await page.keyboard.press('Alt+Enter');
    await wait(800);
    const stayed = { panel: await panelNow(), flash: (await state()).flash };
    await wait(3600);
    await press('Alt+Backslash');
    await type('rev/look');
    await press('Enter');
    await wait(800);
    const looked = { panel: await panelNow(), flash: (await state()).flash };
    await page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('browser'));
    await wait(3600);
    await press('Alt+Backslash');
    await type('rev/roll 3');
    await page.keyboard.press('Shift+Enter');
    await wait(800);
    const went = { panel: await panelNow(), flash: (await state()).flash };
    check('Alt+Enter runs a command where you are (its panel.show() does nothing); Enter as it does; Shift+Enter goes to its panel after; the keys line says so',
      stayed.panel === 'browser' && stayed.flash === 'Looked' && looked.panel === 'command-probe' && looked.flash === 'Looked'
      && went.panel === 'command-probe' && went.flash === 'Rolled 3 (boot)' && /Shift\+Enter go there · Alt\+Enter stay here/.test(foot || ''),
      { foot, stayed, looked, went });
    await page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('browser'));
    await wait(3600);

    // Atmos's own: a panel by name, settings pages, Tab, Esc, the mouse.
    await press('Alt+Backslash');
    await type('rev/switch/');
    now = await state();
    check('rev/switch/ lists the panels', ['Browser', 'Finance', 'Music', 'Chat', 'Probe'].every(label => now.rows.includes(label)), now.rows);
    await press('Escape');
    now = await state();
    check('Esc clears what\'s typed first', now.open && now.value === '', now);
    await type('fin');
    await press('Enter');
    now = await state();
    check('a panel by name: Enter switches to it and the bar closes', now.panel === 'portfolio-tracker' && !now.open, now);
    await press('Alt+Backslash');
    await type('rev/settings/appearance');
    await press('Enter');
    await wait(500);
    now = await state();
    check('rev/settings/appearance opens Settings on it', now.settings && now.settingsPage === 'Appearance', now);
    await closeSettings();
    await wait(300);
    await press('Alt+Backslash');
    await type('ext');
    await press('Tab');
    now = await state();
    check('Tab completes a command', now.value === 'rev/extensions', now.value);
    await press('Enter');
    await wait(500);
    now = await state();
    check('rev/extensions opens Settings on Extensions', now.settings && now.settingsPage === 'Extensions', now);
    await press('Alt+Backslash');
    await wait(300);
    now = await state();
    check('Alt+\\ over Settings closes it and opens the bar', !now.settings && now.open && now.focused, now);
    await press('Alt+Backslash');
    now = await state();
    check('Alt+\\ again closes it', !now.open, now);
    await press('Alt+Backslash');
    await type('rev/sidebar');
    await press('Enter');
    now = await state();
    check('rev/sidebar opens the sidebar', now.sidebar && !now.open, now);
    await press('Alt+Backslash');
    await type('sidebar');
    await press('Enter');
    now = await state();
    check('…and closes it', !now.sidebar && !now.open, now);
    await press('Alt+Backslash');
    await type('a b');
    now = await state();
    check('typing in the bar is only typing (Tab, Space reach no shortcut)', now.open && !now.sidebar && now.value === 'a b', now);
    await press('Escape'); await press('Escape');

    // Alt+\ inside an extension's frame (Finance's panel).
    const finance = await panelBox('plugin:finance');
    if (finance) await page.mouse.click(finance.left + finance.width / 2, finance.top + 120);
    await wait(400);
    const inFrame = await page.evaluate(() => document.activeElement?.tagName);
    await press('Alt+Backslash');
    now = await state();
    check('Alt+\\ inside an extension\'s frame opens the bar over that panel', inFrame === 'IFRAME' && now.open && now.focused && now.field && finance && Math.abs(now.field.bottom - finance.bottom) <= 1, { inFrame, now, finance });
    await press('Escape');
    now = await state();
    check('Esc gives the frame its keyboard back', !now.open && now.activeTag === 'IFRAME', now);

    // ── Over a panel's own bar (the probe's) ───────────────────────────────
    await page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('command-probe'));
    await wait(1800);
    const probeBox = await panelBox('plugin:command-probe');
    const standard = await probeFrame()?.evaluate(() => {
      const bar = document.getElementById('bar');
      const style = getComputedStyle(bar);
      return { height: bar.getBoundingClientRect().height, shadow: style.boxShadow, padding: style.padding };
    });
    const glass = await page.evaluate(() => [...document.querySelectorAll('.atmos-frame-glass[data-material="shell"]')].map(piece => Math.round(piece.getBoundingClientRect().height)));
    check('the SDK\'s standard bar (ui.css .atmos-bar): 54 px, a hairline on top, Atmos\'s shell glass under it',
      standard?.height === 54 && /inset/.test(standard.shadow) && standard.padding === '0px 18px 0px 14px' && glass.includes(54), { standard, glass });
    await press('Alt+Backslash');
    now = await state();
    check('over a panel that has a bar, Atmos\'s bar lies on it', now.where === 'panel bar' && probeBox && Math.abs(now.field.bottom - probeBox.bottom) <= 1 && now.field.height === 54, { now, probeBox });
    check('its commands come first while it shows, under its name, then Atmos\'s; never Atmos\'s names from it',
      JSON.stringify(now.rows.slice(0, 15)) === JSON.stringify(['Command Probe · community', 'rev/roll', 'rev/pick', 'rev/wipe', 'rev/step', 'rev/boom', 'rev/look', 'Atmos', 'rev/sidebar', 'rev/sidebar-side', 'rev/settings', 'rev/extensions', 'rev/switch', 'rev/wallpaper', 'rev/reload'])
      && now.rows.filter(row => row === 'rev/switch').length === 1, now);
    await page.screenshot({ path: path.join(out, '03-panel-bar.png') });
    await type('rev/roll 3');
    await press('Enter');
    now = await state();
    check('with its panel showing, the panel runs it', now.flash === 'Rolled 3 (panel)', now.flash);

    // What it lists, and its options.
    await press('Alt+Backslash');
    await type('rev/pick ');
    now = await until(async () => { const value = await state(); return value.rows.includes('Apple') ? value : null; }) || await state();
    check('a command that lists: its rows and options', JSON.stringify(now.rows) === JSON.stringify(['Fruit', 'Apple', 'Apricot', 'Banana', 'Cherry'])
      && JSON.stringify(now.chips) === JSON.stringify(['ripe', 'small', 'medium*', 'large', '#*']), now);
    await type('ap');
    now = await until(async () => { const value = await state(); return value.rows.length === 3 ? value : null; }) || await state();
    check('…narrowed as you type (what\'s typed goes to it alone)', JSON.stringify(now.rows) === JSON.stringify(['Fruit', 'Apple', 'Apricot']), now.rows);
    await clickChip('large');
    await clickChip('ripe');
    now = await until(async () => { const value = await state(); return value.subs.every(sub => sub === 'A large one') && value.chips.includes('ripe*') ? value : null; }) || await state();
    check('options change what it lists, and stay chosen', now.subs.length === 2 && now.subs.every(sub => sub === 'A large one') && now.chips.includes('large*') && now.chips.includes('ripe*') && now.focused, now);
    await page.screenshot({ path: path.join(out, '04-options.png') });
    const note = await page.evaluate(() => {
      const element = document.querySelector('#command-bar-list input[data-option="note"]');
      const box = element?.getBoundingClientRect();
      return box ? { x: box.left + 10, y: box.top + box.height / 2 } : null;
    });
    if (note) await page.mouse.click(note.x, note.y);
    await type('gift');
    now = await state();
    const noteFocused = await page.evaluate(() => document.activeElement?.dataset?.option === 'note' && document.activeElement.value === 'gift');
    check('a text option keeps its focus as you type in it', noteFocused, now);
    await press('Escape'); // back to the bar's own field
    await press('ArrowDown');
    now = await state();
    check('↓ moves to the next row', now.active === 'Apricot' && now.focused, now);
    await press('Tab');
    now = await until(async () => { const value = await state(); return value.value === 'rev/pick Apricot' && value.rows.length === 2 ? value : null; }) || await state();
    check('Tab types what the row says to (its name, not its value)', now.value === 'rev/pick Apricot' && JSON.stringify(now.rows) === JSON.stringify(['Fruit', 'Apricot']) && now.chips.includes('large*'), now);
    await press('Enter');
    now = await state();
    const picked = await probeFrame()?.evaluate(() => window.__probe.log.at(-1));
    check('Enter runs it with the row\'s value and the options', now.flash === 'Picked apricot (large, ripe, gift)' && picked?.value === 'apricot', { now, picked });
    await page.screenshot({ path: path.join(out, '05-picked.png') });

    // A danger row, a next step, an error.
    await press('Alt+Backslash');
    await type('rev/wipe');
    // Enter twice at once: the first gives it a space, the second comes before its row shows.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    now = await until(async () => { const value = await state(); return value.danger.length ? value : null; }) || await state();
    await wait(300);
    now = await state();
    check('a command that lists what it would do waits for a second Enter, drawn as destructive (one pressed before it showed doesn\'t run it, and says so)',
      now.open && now.value === 'rev/wipe ' && JSON.stringify(now.danger) === JSON.stringify(['Wipe everything']) && !now.flash && now.status === 'Press Enter again to do it.', now);
    await press('Tab');
    now = await state();
    check('Tab on a row with nothing to type passes over it, never runs it', now.open && now.value === 'rev/wipe ' && !now.flash && now.active === 'Wipe everything', now);
    await press('Enter');
    now = await state();
    check('…which does it', !now.open && now.flash === 'Wiped', now);
    await press('Alt+Backslash');
    await type('rev/step');
    await press('Enter');
    now = await until(async () => { const value = await state(); return value.chips.includes('large*') ? value : null; }) || await state();
    check('a next step: the bar takes its text and options, saying so', now.open && now.value === 'rev/pick ' && now.status === 'Now pick one' && now.chips.includes('large*'), now);
    await press('Escape');
    await type('rev/boom');
    await press('Enter');
    now = await state();
    check('an error stays in the bar', now.open && now.status === 'It broke' && now.statusError, now);
    await press('Escape'); await press('Escape');
    check('Atmos\'s own names can\'t be taken (the SDK says why)', consoleLines.some(text => /cannot handle rev\/switch: rev\/switch isn't a command plugin:command-probe declares/.test(text)), consoleLines.filter(text => /rev\//.test(text)));

    // rev/ typed into the extension's own field hands over to the bar.
    const fieldPoint = await probeFrame()?.evaluate(() => { const box = document.getElementById('field').getBoundingClientRect(); return { x: box.left + 20, y: box.top + box.height / 2 }; });
    if (fieldPoint && probeBox) await page.mouse.click(probeBox.left + fieldPoint.x, probeBox.top + fieldPoint.y);
    await wait(300);
    await page.keyboard.type('rev/', { delay: 60 });
    await wait(500);
    await page.keyboard.type('pick b', { delay: 60 });
    now = await until(async () => { const value = await state(); return value.rows.includes('Banana') ? value : null; }) || await state();
    check('rev/ typed into an extension\'s field opens the bar there, with its preset options', now.open && now.where === 'panel bar' && now.value === 'rev/pick b' && now.chips.includes('small*'), now);
    await press('Escape'); await press('Escape');
    now = await state();
    const backIn = await page.evaluate(() => document.activeElement?.dataset?.extension);
    const fieldBack = await probeFrame()?.evaluate(() => document.activeElement?.id);
    check('…and closing it gives the field back, with the keyboard', !now.open && backIn === 'plugin:command-probe' && fieldBack === 'field', { now, backIn, fieldBack });
    // Typed fast: the keys that land in the field before the bar has the keyboard follow it.
    await page.keyboard.type('rev/pick ch', { delay: 0 });
    now = await until(async () => { const value = await state(); return value.value === 'rev/pick ch' && value.rows.includes('Cherry') ? value : null; }) || await state();
    const leftInField = await probeFrame()?.evaluate(() => document.getElementById('field').value);
    check('typed fast, every key reaches the bar, in order, and none stays in the field', now.open && now.value === 'rev/pick ch' && leftInField === '', { value: now.value, leftInField });
    await press('Escape'); await press('Escape');
    // Text the extension puts in the bar: its own command, Atmos's, and another
    // extension's, which isn't chosen for the user (Enter does nothing until they pick it).
    const openFromProbe = async text => {
      if (fieldPoint && probeBox) await page.mouse.click(probeBox.left + fieldPoint.x, probeBox.top + fieldPoint.y);
      await wait(200);
      const opened = await probeFrame()?.evaluate(value => window.__probe.open(value), text);
      await wait(400);
      return { opened, now: await state() };
    };
    const own = await openFromProbe('rev/roll 3');
    await press('Escape'); await press('Escape');
    const atmosOwn = await openFromProbe('rev/switch finance');
    await press('Escape'); await press('Escape');
    check('an extension opens the bar with text: its own command, Atmos\'s, chosen as usual',
      own.opened === 'opened' && own.now.value === 'rev/roll 3' && own.now.active === 'rev/roll 3'
      && atmosOwn.now.value === 'rev/switch finance' && atmosOwn.now.active === 'Finance', { own: own.now, atmosOwn: atmosOwn.now });
    const other = await openFromProbe('rev/nex');
    await press('Enter');
    const afterEnter = await state();
    // Backspace into its text and typing it again, or Tab, doesn't choose it either.
    await press('Backspace');
    await type('x');
    await press('Tab');
    const retyped = await state();
    await press('ArrowDown');
    const pickedNext = (await state()).active;
    await press('Enter');
    now = await until(async () => { const value = await state(); return value.status ? value : null; }) || await state();
    check('…another extension\'s it lines up isn\'t chosen for the user (nor by Tab, nor after Backspace): Enter does nothing until they pick it',
      other.now.value === 'rev/nex' && other.now.rows.includes('rev/next') && other.now.active === null
      && afterEnter.open && afterEnter.value === 'rev/nex' && !afterEnter.flash && !afterEnter.status
      && retyped.open && retyped.value === 'rev/nex' && retyped.active === null && !retyped.flash
      && pickedNext === 'rev/next' && /Nothing to play yet/.test(now.status || ''), { other: other.now, afterEnter, retyped, pickedNext, now });
    await press('Escape'); await press('Escape');

    // ── In the sidebar (Appearance → Command Bar) ──────────────────────────
    await page.evaluate(async () => (await import('atmos-core/core/appearance.js')).setCommandBarPlace('sidebar'));
    await press('Alt+Backslash');
    now = await state();
    check('in the sidebar: the footer row is the field, the sidebar opens with it', now.where === 'footer' && now.focused && now.sidebar, now);
    const listOk = now.list && now.footer && Math.abs(now.list.bottom - now.footer.top) <= 1 && now.list.width >= Math.max(now.footer.width, 380) - 1;
    check('…the list on the footer, at least 380 px wide', listOk, { list: now.list, footer: now.footer });
    await page.screenshot({ path: path.join(out, '06-sidebar.png') });
    await press('Escape');
    now = await state();
    check('…and closing it closes the sidebar again', !now.open && !now.sidebar, now);
    await page.evaluate(async () => (await import('atmos-core/core/sidebar-shell.js')).openSidebar());
    await wait(300);
    await page.click('.sidebar-footer-name');
    await wait(300);
    now = await state();
    check('there, the ATMOS wordmark opens it too', now.where === 'footer' && now.focused, now);
    await press('Escape');
    await page.evaluate(async () => (await import('atmos-core/core/appearance.js')).setCommandBarPlace('panel'));
    await page.click('.sidebar-footer-name');
    await wait(300);
    now = await state();
    check('in a panel, the wordmark does nothing', !now.open, now);
  } catch (error) {
    report.error = error.stack || error.message;
  } finally {
    report.errors = errors;
    report.failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name);
    report.summary = `${Object.values(report.checks).filter(Boolean).length}/${Object.keys(report.checks).length} checks passed`;
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await app.close().catch(() => {});
  }
})();
