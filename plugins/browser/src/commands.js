/**
 * Atmos Browser's rev/ commands in Atmos's command bar (SDK 1.3), declared
 * in extension.json ("contributes.commands") and answered here, in the
 * background frame where the engine and its tabs live (boot.js), so they
 * work whichever panel is showing:
 *
 *   new-tab [address or search]   a new tab, going there (private with its option)
 *   tab <name>                    go to one of your tabs
 *   close-tab [name]              close a tab: the one showing, or one by name
 *
 * `engine` is src/engine.js's. Rows and results are plain text: Atmos draws
 * them. A row's value is a tab's id, or a key to an address it listed (an
 * address can be longer than a value Atmos hands back); anything else is
 * ignored, and what's typed is read as the address bar reads it.
 */
import atmos from 'atmos-sdk';
import { displayUrl, interpret, isPageUrl, siteName } from './address.js';

const MAX_ROWS = 8;
const KEPT_ADDRESSES = 200;
const TYPED = 'typed';  // the row that goes where the text says, as the address bar does
const lower = value => String(value ?? '').toLowerCase().trim();

/** A tab's name in the bar: its title, else its address, else "New tab". */
export function tabName(tab) {
  if (tab.kind === 'history') return 'History';
  return String(tab.title || displayUrl(tab.url) || 'New tab').replace(/\s+/g, ' ').trim().slice(0, 120) || 'New tab';
}

/** Tabs matching `query` (title or address): titles that start with it first. All of them, showing first, for nothing typed. */
export function findTabs(tabs, query) {
  const q = lower(query);
  if (!q) return [...tabs].sort((a, b) => Number(b.selected) - Number(a.selected));
  const starts = [], contains = [];
  for (const tab of tabs) {
    const name = lower(tabName(tab));
    if (name.startsWith(q)) starts.push(tab);
    else if (name.includes(q) || lower(tab.url).includes(q)) contains.push(tab);
  }
  return [...starts, ...contains];
}

const tabRow = (tab, action) => ({
  title: tabName(tab),
  sub: [tab.private ? 'Private' : null, siteName(tab.url) || null, tab.selected ? 'Current tab' : null].filter(Boolean).join(' · ') || undefined,
  action,
  value: String(tab.id),
  complete: tabName(tab),
});

/** The tab a row named (by id), or the first one matching what's typed, or (`showing`) the one showing. */
function chosenTab(engine, { args, value }, { showing = false } = {}) {
  const tabs = engine.tabs();
  if (value != null && value !== '') {
    const tab = tabs.find(item => String(item.id) === String(value));
    if (!tab) throw new Error('That tab is closed now.');
    return tab;
  }
  if (lower(args)) {
    const tab = findTabs(tabs, args)[0];
    if (!tab) throw new Error(`No tab matches “${String(args).trim()}”.`);
    return tab;
  }
  if (showing) return tabs.find(item => item.selected) || null;
  throw new Error('Type part of a tab’s name.');
}

export function handleCommands(engine) {
  // Addresses rev/new-tab listed, by the key its rows carry.
  const listed = new Map();
  let listings = 0;
  const keyFor = url => {
    const key = `u${(listings += 1)}`;
    listed.set(key, url);
    while (listed.size > KEPT_ADDRESSES) listed.delete(listed.keys().next().value);
    return key;
  };

  // rev/new-tab: what's typed is an address or a search, as in the address bar.
  atmos.commands.handle('new-tab', async ({ args, value, options }) => {
    const text = String(args ?? '').trim();
    const isPrivate = options?.private === true;
    const url = value !== TYPED && isPageUrl(listed.get(value)) ? listed.get(value) : '';
    // What the address bar refuses opens nothing (and the tab showing stays).
    const meaning = url || !text ? null : interpret(text, { searchTemplate: '' });
    if (meaning?.kind === 'refused') throw new Error(meaning.reason);
    const before = engine.selectedId();
    let tab;
    if (url || !text) {
      tab = engine.newTab({ url, private: isPrivate });
    } else {
      tab = engine.newTab({ private: isPrivate });
      const result = await engine.navigate(tab.id, text);
      if (!result?.ok) {
        engine.closeTab(tab.id);
        if (engine.tab(before)) engine.selectTab(before);
        throw new Error(result?.reason || 'That can’t be opened.');
      }
    }
    await atmos.panel.show().catch(() => {});
    const where = siteName(engine.tab(tab.id)?.url || url);
    return { done: where ? `Opened ${where}${isPrivate ? ' in a private tab' : ''}.` : `Opened a new${isPrivate ? ' private' : ''} tab.` };
  }, {
    suggest: async ({ args, options }) => {
      const text = String(args ?? '').trim();
      const privateOption = [{ id: 'private', type: 'toggle', label: 'private', value: options?.private === true }];
      if (!text) return { rows: [{ title: 'New tab', sub: 'An empty tab', action: 'Open' }], options: privateOption };
      const items = await engine.suggest(text, { limit: MAX_ROWS });
      const rows = items.map(item => ({
        title: item.kind === 'search' ? item.title : (item.title || displayUrl(item.url)),
        sub: item.kind === 'search' ? `Search ${item.engine}` : item.kind === 'url' ? 'Go to this address' : `${item.kind === 'bookmark' ? 'Bookmark' : 'History'} · ${siteName(item.url)}`,
        action: 'Open',
        // The address typed goes as the address bar sends it (its error page
        // can then offer a search); the rest by key, whatever their length.
        value: item.kind === 'url' ? TYPED : keyFor(item.url),
      }));
      return { rows: rows.length ? rows : [{ note: 'That can’t be opened as an address or a search.' }], options: privateOption };
    },
  });

  // rev/tab: go to a tab, by name.
  atmos.commands.handle('tab', async input => {
    const tab = chosenTab(engine, input);
    engine.selectTab(tab.id);
    await atmos.panel.show().catch(() => {});
    return { done: `Showing ${tabName(tab)}.` };
  }, {
    suggest: ({ args }) => {
      const rows = findTabs(engine.tabs(), args).slice(0, MAX_ROWS).map(tab => tabRow(tab, 'Go'));
      return rows.length ? rows : [{ note: `No tab matches “${String(args).trim()}”.` }];
    },
  });

  // rev/close-tab: the current tab first. Ctrl+Shift+T in the browser brings
  // most back; a private one only while another private tab is open, so its
  // row is marked.
  atmos.commands.handle('close-tab', async input => {
    const tab = chosenTab(engine, input, { showing: true });
    if (!tab) throw new Error('There’s no tab to close.');
    // What Ctrl+Shift+T can bring back: a tab that had a page (an empty one
    // isn't kept), and a private one only while another private tab is open.
    const kept = tab.kind !== 'new' && (!tab.private || engine.tabs().some(other => other.private && other.id !== tab.id));
    engine.closeTab(tab.id);
    return { done: kept ? `Closed ${tabName(tab)}. Ctrl+Shift+T in the browser brings it back.` : `Closed ${tabName(tab)}.` };
  }, {
    suggest: ({ args }) => {
      const rows = findTabs(engine.tabs(), args).slice(0, MAX_ROWS)
        .map(tab => ({ ...tabRow(tab, 'Close'), ...(tab.private ? { danger: true } : {}) }));
      return rows.length ? rows : [{ note: `No tab matches “${String(args).trim()}”.` }];
    },
  });
}
