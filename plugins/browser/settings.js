/**
 * Atmos Browser's settings (Settings → Browser, a page of their own that
 * Core gives the browser's settings): the search engine, links from Atmos,
 * downloads, blocking ads and trackers, how long tabs stay loaded, what sites
 * may do, and clearing what the browser keeps.
 */
import atmos from 'atmos-sdk';
import { engine, follow } from './src/ui/engine-client.js';
import { h, soon } from './src/ui/dom.js';
import { PERMISSION_NAMES } from './src/ui/icons.js';

document.head.append(h('link', { rel: 'stylesheet', href: new URL('./assets/browser.css', import.meta.url).href }));
const root = h('div', { class: 'br-settings' });
document.body.append(root);

/** A label or heading whose explanation shows when you hover over it (or focus it). */
const tip = (hint, attrs = {}) => (hint ? { ...attrs, class: `${attrs.class || ''} br-tip`.trim(), tabindex: '0', 'aria-description': hint, 'data-tip': hint } : attrs);
const row = (label, hint, control) => h('div', { class: 'atmos-row' },
  h('span', { class: 'atmos-label' }, h('span', tip(hint), label)),
  h('span', { class: 'atmos-control' }, control));
const heading = (text, hint) => h('div', { class: 'atmos-heading' }, h('span', tip(hint), text));

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
let updating = false;
const status = h('div', { class: 'atmos-status', hidden: true });

/** "3 hours ago", roughly. */
function ago(ms) {
  if (!ms) return 'never';
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
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

  const siteRow = item => {
    const remove = h('button', { class: 'atmos-button', text: item.name === 'ads' || item.name === 'popups' ? 'Block again' : 'Remove' });
    remove.addEventListener('click', async () => {
      sites = await engine.setSitePermission(item.origin, item.name, null).catch(() => sites);
      render();
    });
    return h('div', { class: 'br-site-row' },
      h('span', { class: 'br-site-origin', text: item.origin, title: item.origin }),
      h('span', { class: `br-site-what ${item.value}`, text: `${PERMISSION_NAMES[item.name] || item.name}: ${item.value === 'allow' ? 'allowed' : 'blocked'}` }),
      remove);
  };
  const adSites = sites.filter(item => item.name === 'ads');
  const permissionSites = sites.filter(item => item.name !== 'ads');

  // Ads and trackers: on or off, the lists, and the sites allowed them.
  const blocker = engine.adblock();
  const blocking = options.blockAds !== false;
  const update = h('button', { class: 'atmos-button', text: updating ? 'Checking…' : 'Update lists', disabled: updating || !blocking });
  update.addEventListener('click', async () => {
    updating = true;
    render();
    try {
      const after = await engine.updateFilters();
      say(after.error ? after.error : `Filter lists checked: ${(after.rules || 0).toLocaleString()} rules`, !after.error);
    } catch (error) { say(error.message, false); }
    updating = false;
    render();
  });
  // One short line; the rest is in the hover.
  const listState = !blocking ? 'Off'
    : !blocker || blocker.state === 'loading' || blocker.state === 'off' ? 'Getting the lists ready…'
      : blocker.state === 'error' && !blocker.updatedAt ? 'Couldn’t fetch the lists; trying again hourly'
        : `${(blocker.total || 0).toLocaleString()} blocked · lists updated ${ago(blocker.updatedAt)}`;
  const listDetail = [
    blocker?.rules ? `${blocker.rules.toLocaleString()} rules.` : '',
    blocker?.error ? `Last check: ${blocker.error}.` : '',
  ].filter(Boolean).join(' ');
  // uBlock Origin's own lists keep the page scripts that need their trust
  // only as GitHub serves them (Core's rule): say when a copy came from elsewhere.
  const fallback = blocking && Array.isArray(blocker?.untrusted) && blocker.untrusted.length
    ? `${blocker.untrusted.join(', ')} came from a backup copy (not GitHub), so the page scripts that need uBlock Origin’s trust are off until GitHub answers (asked hourly).`
    : '';

  const siteRows = permissionSites.length
    ? permissionSites.map(siteRow)
    : [h('div', { class: 'br-settings-note', text: 'None yet' })];

  const clearHistory = h('button', { class: 'atmos-button', text: 'Clear history' });
  const clearCookies = h('button', { class: 'atmos-button', text: 'Clear cookies', title: 'Cookies and site data: sites will ask you to sign in again' });
  const clearCache = h('button', { class: 'atmos-button', text: 'Clear cache' });
  const resetSites = h('button', { class: 'atmos-button', text: 'Reset site settings', title: 'Site permissions, shields and zoom' });
  clearHistory.addEventListener('click', () => clear({ history: true }, 'History cleared'));
  clearCookies.addEventListener('click', () => clear({ cookies: true }, 'Cookies and site data cleared: sites will ask you to sign in again'));
  clearCache.addEventListener('click', () => clear({ cache: true }, 'Cached files cleared'));
  resetSites.addEventListener('click', async () => {
    await clear({ siteSettings: true }, 'Site permissions, shields and zoom reset');
    sites = await engine.sitePermissions().catch(() => []);
    render();
  });

  root.replaceChildren(
    h('section', { class: 'atmos-section' },
      heading('Browsing', 'Pages open in a browser session of their own, apart from Atmos and its extensions; private tabs share another, kept only in memory. Not yet: phishing and malware warnings, saved passwords, sync, protected video (Netflix and the like).'),
      row('Search engine', 'What the address bar searches with', select(engines.map(item => ({ value: item.id, label: item.name })), current,
        value => engine.setSettings({ searchEngine: value }), 'Search engine')),
      row('Open links here', 'Links that Atmos and its extensions open go to a new tab in Atmos Browser instead of your default browser',
        toggle(options.openLinks === true, value => engine.setOptions({ openLinks: value }), 'Open links in Atmos Browser')),
      row('Ask where to save', 'Off: downloads go straight to your Downloads folder',
        toggle(options.askWhereToSave !== false, value => engine.setOptions({ askWhereToSave: value }), 'Ask where to save each file'))),
    h('section', { class: 'atmos-section' },
      heading('Ads and trackers', 'Lists: uBlock Origin’s own (ads, privacy, badware risks, unbreak, quick fixes), EasyList and EasyPrivacy, checked every few days; engine: Ghostery’s. The scripts that get past harder ads come with Atmos, never from the lists, and the ones that can change what a site sends run only for uBlock Origin’s own lists, as its GitHub serves them.'),
      row('Block ads and trackers', 'On every site, unless you turn it off for one with the shield in the address bar',
        toggle(blocking, value => engine.setOptions({ blockAds: value }), 'Block ads and trackers')),
      row(h('span', { class: 'br-settings-state', text: listState }), listDetail || null, update),
      fallback ? h('div', { class: 'br-settings-note', text: fallback }) : null,
      ...adSites.map(siteRow)),
    h('section', { class: 'atmos-section' },
      heading('Tabs', 'A put-away tab keeps its place and reloads when you go back to it'),
      row('Put away after', 'Tabs left unused this long are put away', select([
        { value: 0, label: 'Never' }, { value: 10, label: '10 minutes' }, { value: 30, label: '30 minutes' }, { value: 60, label: '1 hour' }, { value: 240, label: '4 hours' },
      ], settings.putAwayAfterMinutes, value => engine.setSettings({ putAwayAfterMinutes: Number(value) }), 'Put away tabs left for')),
      row('Most kept loaded', 'Past this, the tabs used least recently are put away', select([
        { value: 0, label: 'No limit' }, { value: 5, label: '5' }, { value: 10, label: '10' }, { value: 20, label: '20' },
      ], settings.maxLoadedTabs, value => engine.setSettings({ maxLoadedTabs: Number(value) }), 'Most tabs kept loaded'))),
    h('section', { class: 'atmos-section' },
      heading('Site permissions', 'Sites ask before using your camera, microphone, location, notifications or clipboard. Your answers show here to take back, with the sites whose pop-ups you always allow.'),
      ...siteRows),
    h('section', { class: 'atmos-section' },
      heading('Clear browsing data'),
      h('div', { class: 'br-clear-row' }, clearHistory, clearCookies, clearCache, resetSites),
      status),
  );
});

follow(change => { if (change.type === 'settings' || change.type === 'adblock') render(); });
sites = await engine.sitePermissions().catch(() => []);
render();
void engine.adblockStatus();
