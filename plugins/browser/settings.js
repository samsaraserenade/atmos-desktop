/**
 * Atmos Browser's settings (a section of Settings → Appearance, where Atmos
 * shows extensions' settings): the search engine, links from Atmos,
 * downloads, how long tabs stay loaded, what sites may do, and clearing
 * what the browser keeps.
 */
import atmos from 'atmos-sdk';
import { engine, follow } from './src/ui/engine-client.js';
import { h, soon } from './src/ui/dom.js';
import { PERMISSION_NAMES } from './src/ui/icons.js';

document.head.append(h('link', { rel: 'stylesheet', href: new URL('./assets/browser.css', import.meta.url).href }));
const root = h('div', { class: 'br-settings' });
document.body.append(root);

const row = (label, hint, control) => h('div', { class: 'atmos-row' },
  h('span', { class: 'atmos-label' }, label, hint ? h('small', { text: hint }) : null),
  h('span', { class: 'atmos-control' }, control));

function select(options, value, onChange, label) {
  const element = h('select', { class: 'atmos-select', 'aria-label': label },
    ...options.map(option => h('option', { value: String(option.value), text: option.label, selected: String(option.value) === String(value) })));
  element.addEventListener('change', () => onChange(element.value));
  return element;
}

function toggle(checked, onChange, label) {
  const element = h('input', { type: 'checkbox', class: 'atmos-switch', 'aria-label': label, checked });
  element.addEventListener('change', () => onChange(element.checked));
  return element;
}

let sites = [];
const status = h('div', { class: 'atmos-status', hidden: true });
function say(text, ok = true) {
  status.textContent = text;
  status.className = `atmos-status ${ok ? 'ok' : 'err'}`;
  status.hidden = false;
  clearTimeout(say.timer);
  say.timer = setTimeout(() => { status.hidden = true; }, 4000);
}

async function clear(what, done) {
  try { await engine.clearData(what); say(done); } catch (error) { say(error.message, false); }
}

const render = soon(() => {
  const settings = engine.settings();
  const options = engine.options();
  const engines = engine.searchEngines();
  const current = engine.searchEngine();

  const siteRows = sites.length
    ? sites.map(item => {
      const remove = h('button', { class: 'atmos-button', text: 'Remove' });
      remove.addEventListener('click', async () => {
        sites = await engine.setSitePermission(item.origin, item.name, null).catch(() => sites);
        render();
      });
      return h('div', { class: 'br-site-row' },
        h('span', { class: 'br-site-origin', text: item.origin, title: item.origin }),
        h('span', { class: `br-site-what ${item.value}`, text: `${PERMISSION_NAMES[item.name] || item.name}: ${item.value === 'allow' ? 'allowed' : 'blocked'}` }),
        remove);
    })
    : [h('div', { class: 'br-settings-note', text: 'Sites ask before using your camera, microphone, location, notifications or clipboard. What you answer shows here, to take back.' })];

  const clearHistory = h('button', { class: 'atmos-button', text: 'Clear history' });
  const clearCookies = h('button', { class: 'atmos-button', text: 'Clear cookies and site data' });
  const clearCache = h('button', { class: 'atmos-button', text: 'Clear cached files' });
  const resetSites = h('button', { class: 'atmos-button', text: 'Reset site permissions and zoom' });
  clearHistory.addEventListener('click', () => clear({ history: true }, 'History cleared'));
  clearCookies.addEventListener('click', () => clear({ cookies: true }, 'Cookies and site data cleared: sites will ask you to sign in again'));
  clearCache.addEventListener('click', () => clear({ cache: true }, 'Cached files cleared'));
  resetSites.addEventListener('click', async () => {
    await clear({ siteSettings: true }, 'Site permissions and zoom reset');
    sites = await engine.sitePermissions().catch(() => []);
    render();
  });

  root.replaceChildren(
    h('section', { class: 'atmos-section' },
      h('div', { class: 'atmos-heading', text: 'Browsing' }),
      row('Search engine', 'What the address bar searches with', select(engines.map(item => ({ value: item.id, label: item.name })), current,
        value => engine.setSettings({ searchEngine: value }), 'Search engine')),
      row('Open links in Atmos Browser', 'Links Atmos and its extensions open go to a new tab here instead of your default browser',
        toggle(options.openLinks === true, value => engine.setOptions({ openLinks: value }), 'Open links in Atmos Browser')),
      row('Ask where to save each file', 'Off: downloads go straight to your Downloads folder',
        toggle(options.askWhereToSave !== false, value => engine.setOptions({ askWhereToSave: value }), 'Ask where to save each file'))),
    h('section', { class: 'atmos-section' },
      h('div', { class: 'atmos-heading', text: 'Tabs' }),
      row('Put away tabs left for', 'A put-away tab keeps its place and reloads when you go back to it', select([
        { value: 0, label: 'Never' }, { value: 10, label: '10 minutes' }, { value: 30, label: '30 minutes' }, { value: 60, label: '1 hour' }, { value: 240, label: '4 hours' },
      ], settings.putAwayAfterMinutes, value => engine.setSettings({ putAwayAfterMinutes: Number(value) }), 'Put away tabs left for')),
      row('Most tabs kept loaded', 'Past this, the tabs used least recently are put away', select([
        { value: 0, label: 'No limit' }, { value: 5, label: '5' }, { value: 10, label: '10' }, { value: 20, label: '20' },
      ], settings.maxLoadedTabs, value => engine.setSettings({ maxLoadedTabs: Number(value) }), 'Most tabs kept loaded'))),
    h('section', { class: 'atmos-section' },
      h('div', { class: 'atmos-heading', text: 'Site permissions' }),
      ...siteRows),
    h('section', { class: 'atmos-section' },
      h('div', { class: 'atmos-heading', text: 'Clear browsing data' }),
      h('div', { class: 'br-clear-row' }, clearHistory, clearCookies, clearCache, resetSites),
      status),
    h('section', { class: 'atmos-section' },
      h('div', { class: 'atmos-heading', text: 'About' }),
      h('div', { class: 'br-settings-note', text: 'Pages open in a browser session of their own, apart from Atmos and its extensions; private tabs share another, kept only in memory. Atmos Browser has no Safe Browsing (it doesn’t warn about known dangerous sites), no saved passwords, ad blocking, Chrome extensions or sync, and plays no DRM-protected video (Netflix and the like).' })),
  );
});

follow(change => { if (change.type === 'settings') render(); });
sites = await engine.sitePermissions().catch(() => []);
render();
