# Atmos Browser

A web browser in an Atmos panel: tabs, an address bar that searches or goes
to an address, bookmarks, history, private tabs, downloads, find in page and
zoom, with a new-tab page and its settings in Atmos's own look. Official
(first-party); the panel's key is `[`.

## How it works

Web pages are **Core's**, not the plugin's. The plugin declares
`"permissions": { "web": true }` (only official, signed extensions can) and
drives pages through `atmos.web` (SDK 1.2, first-party):

- Core's web layer (`core/js/core/web-layer.js`) shows each open tab as a
  `<webview>` of the Atmos page, in the place the panel gives it
  (`atmos.web.setSurface`). The panel's frame is cut away there, so the page
  shows through it, and what the panel draws on purpose over the page
  (suggestions, prompts, find, downloads) stays on top. Atmos's own menus,
  Settings, Task View and glass draw over pages like over anything else.
- The main process (`core/js/core/web-host.cjs`) applies the browser's
  policy (`core/js/core/web-policy.cjs`, unit-tested) to every page,
  whatever the plugin asks: what may load, pop-ups, permissions, downloads,
  certificates, keys. The plugin can ask for a page, never loosen a rule.

The plugin itself is the browser's UI and its memory:

| File | What it is |
|---|---|
| `boot.js` | The background frame: the engine, alive while Atmos runs, so tabs stay open when the panel is switched away and links from Atmos have somewhere to go. |
| `src/engine.js` | Tabs and what their pages are doing, history, bookmarks, site icons, downloads, what pages ask; the views follow its changes. |
| `panel.js`, `src/ui/*` | The tab strip, toolbar and address bar, the new-tab page, History, the warning and error pages, prompts, find, downloads, menus. |
| `sidebar.js`, `sidebar-bookmarks.js` | The Tabs and Bookmarks widgets. |
| `settings.js` | Its section in Settings → Appearance (where Atmos shows extensions' settings). |
| `src/address.js` | What typed text means: an address or a search. |
| `src/tabs.js`, `src/history.js`, `src/bookmarks.js`, `src/store.js` | The tab list, history, bookmarks, and where they're kept. |
| `src/search-engines.json` | The search engines offered (DuckDuckGo by default). |

The panel and widgets find the engine with `atmos.background()` (they share
the plugin's own origin, `"isolation": "origin"`).

## What it keeps, and where

- **Tabs** (ordinary ones only): in `atmos.state`, restored at start. They
  load lazily: nothing loads until the panel shows, then only the tab you're
  on; the others load when you go to them.
- **History, bookmarks, site icons**: in IndexedDB in the plugin's own
  origin (`atmos-browser`). History keeps 90 days, 20,000 addresses at most.
- **Cookies, site data, cache**: Core's, in the browser's own session
  (`persist:atmos-browser`), apart from Atmos and from every extension.
- **Site permissions and per-site zoom**: Core's, in `browser/sites.json` in
  Atmos's user data.
- **Private tabs** keep nothing: their session (`atmos-browser-private`) is
  in memory, shared by the private tabs open at a time and cleared when the
  last one closes. No history, no restored tabs, zoom and permission answers
  for that session only. Files you download from them stay.

Tabs you haven't used for a while (30 minutes by default) or past the most
kept loaded (10) are **put away**: the page closes, the tab keeps its place,
address, title and icon, and loads again when you go back to it. A put-away
tab starts a new back/forward list. Tabs playing sound, asking something, in
fullscreen or private aren't put away.

## Security, in short

- Pages load only `http:`, `https:` and `about:blank`; Atmos's own schemes
  (`atmos-app:`, `atmos-ext:`, `atmos-resource:`), `file:`, `chrome:`,
  `devtools:` and the like never, not even in a frame. `javascript:` typed in
  the address bar is refused. Links to other programs (`mailto:`, `magnet:`…)
  ask first; a few that run programs on Windows (`ms-msdt:`, `search-ms:`…)
  and drive letters (`C:\…`) are refused outright.
- Pages are sandboxed and context-isolated, with web security on and no
  preload: nothing in a page can reach Atmos, Node or an extension.
- A pop-up asked for with a size (a sign-in window) opens as a small window
  of its own that keeps its opener, its site in its title; other new windows
  become tabs.
- Certificate errors show a warning with no way to continue. Mixed content
  stays blocked.
- Camera, microphone, location, notifications and reading the clipboard are
  denied unless you allow the site when it asks, in the browser's own prompt.
  Answers are remembered per site; take them back in Settings. Everything
  else (USB, serial, HID, Bluetooth, screen capture…) is refused.
- Downloads get safe file names; a downloaded program or script is never
  opened from Atmos ("Show in folder" only). By default Atmos asks where to
  save each file.
- The user agent is Chrome's own, with no Electron or Atmos token.
- A site's icon is decoded apart, in a sandboxed page of its own with no
  network, and drawn again by Core: nothing a site sends is decoded in the
  browser's own frames, which can do more than a page can.
- A page in fullscreen covers Atmos, so Atmos names its site with "Press
  Esc to exit" over it for a few seconds.
- A page that sets no background gets the browser's own (white, or dark
  for a dark page), not Atmos's wallpaper through it.

The full account is in `docs/ARCHITECTURE.md` ("Web pages") and
`docs/DECISIONS.md`.

### Compared with Chrome or Brave

- **The same:** Chromium's renderer sandbox and a process per site.
- **Stricter:** no `file:` pages, links to other programs ask first, every
  permission is off until you allow a site, no browser extensions, no
  saved passwords to steal, and downloaded programs are never opened from
  Atmos.
- **Weaker:** Chromium's security fixes arrive only with an Atmos release
  that brings a newer Electron, and Atmos doesn't update itself, where
  Chrome and Brave do within days. Keep Atmos up to date. There's no Safe
  Browsing (no warnings about phishing or malware sites or downloads), and
  no camera or microphone indicator in the browser (Windows shows its
  own).

For banking and the accounts that matter most, use a browser that updates
itself.

## Shortcuts

In a page or in the browser's own controls (Atmos's single-key shortcuts
never fire while you type in a page):

| Keys | |
|---|---|
| Ctrl+L, F6 | Address bar |
| Ctrl+T / Ctrl+Shift+T | New tab / reopen the last closed tab |
| Ctrl+Shift+N | New private tab |
| Ctrl+W, Ctrl+F4 | Close the tab |
| Ctrl+Tab, Ctrl+PageDown / Ctrl+Shift+Tab, Ctrl+PageUp | Next / previous tab (in the strip's order; outside the browser, Ctrl+Tab is still Atmos's Task View) |
| Ctrl+1…8, Ctrl+9 | That tab, the last tab |
| Ctrl+R, F5 / Ctrl+Shift+R, Shift+F5 | Reload / reload without the cache |
| Alt+← / Alt+→ | Back / forward |
| Ctrl+F | Find in page (Enter, Shift+Enter, Escape) |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in, out, back to 100% (kept per site) |
| Ctrl+D | Bookmark the page (or take the bookmark away) |
| Ctrl+H, Ctrl+J | History, downloads |
| Ctrl+P | Print |
| Escape | Out of a page's fullscreen |

In the address bar, Alt+Enter opens in a new tab and a leading `?` always
searches.

## Settings

Settings → Appearance → Atmos Browser: the search engine; **Open links in
Atmos Browser** (off by default: links that Atmos and its extensions would
send to your default browser open in a new tab here instead); whether to ask
where to save each file; when tabs are put away; site permissions to take
back; clearing history, cookies and site data, cached files, or site
permissions and zoom.

## Not in this version

- **Saved passwords and autofill.** Sites' own "remember me" works (cookies
  are kept). Later, moderate: Electron has no password manager; one would
  need a vault of its own (`safeStorage`, like Matrix Chat's) and careful
  form filling.
- **Ad blocking.** Later, fairly cheap: a filter list applied to the
  browser's session (`webRequest`), such as uBlock's lists through an
  existing Electron ad-blocking library.
- **Chrome extensions.** Electron supports only part of the extensions API,
  and they would run with a page's reach; not planned.
- **Sync** between computers.
- **Protected video (DRM).** Electron ships no Widevine, so Netflix and
  similar services won't play.
- **Safe Browsing.** Electron has none: Atmos Browser does **not** warn
  about known phishing or malware sites. Downloads aren't scanned either
  (Windows Defender may still scan files as they are saved).
- **Reader mode.** Later, fairly cheap (Readability.js run in the page by
  Core, shown by the panel).
- **A PDF viewer.** PDFs download instead of opening (plugins are off).
- Developer tools for pages, spellcheck, bookmark folders, pinned tabs, tab
  groups, and keeping a tab's back/forward list across a restart or after
  it's put away.

## Known limits

- A site that **checks** a permission before asking sees "denied" while you
  haven't answered (Electron can only answer yes or no to a check), so it may
  say the permission is blocked instead of asking. Asking always shows the
  prompt. Answer once and it's remembered.
- Location in a page depends on the system: Electron has no Google location
  service, so it may be unavailable on some computers.
- Downloads are listed for the session; the files stay where they were
  saved.

## Tests

- `tests/`: the address bar (address or search), the tab list and putting
  pages away, history and bookmarks and their storage, and the engine
  against the fake Atmos (tabs restored and loaded lazily, private tabs,
  prompts, links from Atmos). Run with the other extensions' tests:
  `npm run test:all`.
- Core's policy: `core/js/core/web-policy.test.cjs`, `web-settings.test.cjs`.
- End to end: `scripts/e2e/browser.cjs` (see `scripts/e2e/README.md`).
