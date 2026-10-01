# Atmos Browser

A web browser in an Atmos panel: tabs, an address bar that searches or goes
to an address, bookmarks, history, private tabs, downloads, find in page and
zoom, ads and trackers blocked (like Brave's shields), with a new-tab page
(bookmarks, most visited, what's been blocked) and its settings in Atmos's
own look. Official (first-party); the panel's
key is `[`.

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
- **Site permissions, shields and per-site zoom**: Core's, in
  `browser/sites.json` in Atmos's user data.
- **The ad blocker's lists and engine**: Core's, in `browser/adblock/`
  (about 15 MB), with the total it has blocked (ordinary tabs only).
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
- Pages are sandboxed and context-isolated, with web security on. Core's
  one script in them, in a world of its own the page can't reach, gives
  `window.chrome` the members Chrome's pages have (Google's sign-in checks
  for them) and asks Core for the ad blocker's styles and scriptlets for
  that page, which Core answers only for the page's own address: nothing
  in a page can reach Atmos, Node or an extension.
- A page opens a tab or a window only just after you click, tap or press
  a key in it (5 s, one each), as with Chrome's pop-up blocker; one it
  tries without shows "Pop-up blocked" with Open and Always allow (the
  site's pop-ups from then on; take it back in Settings). A pop-up asked for with a
  size (a sign-in window) opens as a small window of its own that keeps its
  opener, its site in its title, and can't go fullscreen; other new windows
  become tabs.
- Certificate errors show a warning with no way to continue. Mixed content
  stays blocked. A site that asks for a certificate from your computer (a
  work or ID card's) gets none.
- Camera, microphone, location, notifications and reading the clipboard are
  denied unless you allow the site when it asks, in the browser's own prompt.
  A frame embedded in a page asks as that page, and its notifications are
  refused. Answers are remembered per site; take them back in Settings.
  Everything else (USB, serial, HID, Bluetooth, screen capture…) is
  refused. The prompt (like the other buttons drawn over a page) takes no
  click for a moment after it appears, nor a click before the pointer has
  moved onto it, so a page can't slip it under a click you were making.
- Downloads get safe file names; Atmos opens only documents, pictures,
  music, videos and archives from its list ("Show in folder" for anything
  else). A page starts one download on its own, and one more each time you
  click in it; more are stopped, with "Download blocked" and a Download
  button. By default Atmos asks where to save each file.
- The user agent is Chrome's own, with no Electron or Atmos token, and
  pages see what Chrome's see: `window.chrome`, the client hints sent with
  a navigation, and no FedCM (which Electron can't show), so sites use a
  sign-in pop-up for "Sign in with Google".
- Ads and trackers are blocked by Core, in the main process, with uBlock
  Origin's own lists, EasyList and EasyPrivacy in Ghostery's engine:
  requests to ad and tracking servers, the ad slots left behind, and (with
  small page scripts, scriptlets) the harder cases. The scriptlets and the
  stand-ins it redirects to ship with Atmos; the lists only choose among
  them, and lists that aren't uBlock Origin's own can't use the ones that
  need trust, nor can a copy of uBlock Origin's own that didn't come from
  its GitHub. A page's own address is never blocked, only what it loads.
  The shield turns it off per site; Settings for all.
- A site's icon is fetched without your cookies, and Atmos checks it isn't
  on your own network (by its name, and by what the name resolves to)
  unless the page is there too.
- The address bar shows an address without a user name or password in
  front of the site (`https://bank.example@other.example/` shows as
  `https://other.example/`).
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
  permission is off until you allow a site, no client certificate is ever
  sent, no browser extensions, no saved passwords to steal, and only
  documents and media are opened from the downloads list. Like Brave (and
  unlike Chrome), ads and trackers are blocked from the start.
- **Like Chrome's, simpler:** pop-ups and repeated downloads need a click,
  as with Chrome's pop-up blocker and download limiter, but Atmos knows
  which page was clicked, not which frame in it, so after a click anywhere
  in a page any frame in it (an ad's too) can open one pop-up.
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
where to save each file; **blocking ads and trackers** (on by default), when
its lists were updated, and the sites where it's off; when tabs are put
away; site permissions to take back; clearing history, cookies and site
data, cached files, or site permissions, shields and zoom.

The shield in the address bar shows how many ads and trackers were blocked
on the page, which sites they came from, and turns blocking off (or on
again) for the site; the page reloads.

## Not in this version

- **Saved passwords and autofill.** Sites' own "remember me" works (cookies
  are kept). Later, moderate: Electron has no password manager; one would
  need a vault of its own (`safeStorage`, like Matrix Chat's) and careful
  form filling.
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

- **Sites that sign you in with a certificate from your computer** (some
  work and government sites) don't work: Atmos sends none, where Chrome
  asks which to send. Use your system browser for those.
- **A tap on a touch screen** inside a frame embedded in a page (another
  site's: a "Sign in with Google" button is one) isn't seen by Atmos, so a
  pop-up it opens is blocked. Use the notice's Always allow, then tap
  again (Open opens the address in a tab, which can't finish a sign-in
  that answers its page). Taps on the page itself count. With "Open links
  in Atmos Browser" on, a link you tap in an extension opens in a tab
  behind, for the same reason.
- **A page's `alert()` and `confirm()`** are Electron's dialogs, over all
  of Atmos, and don't name the site (Chrome's say "example.com says").
  From a page's second one, a box stops it showing more.
- **"Leave site?"** is a native dialog that holds all of Atmos until you
  answer (Electron needs the answer at once). After you answer Cancel, the
  same page stays without asking again for half a minute.

- A site that **checks** a permission before asking sees "denied" while you
  haven't answered (Electron can only answer yes or no to a check), so it may
  say the permission is blocked instead of asking. Asking always shows the
  prompt. Answer once and it's remembered.
- Location in a page depends on the system: Electron has no Google location
  service, so it may be unavailable on some computers.
- Downloads are listed for the session; the files stay where they were
  saved.
- The ad blocker hides and scripts the page itself, not the frames inside
  it (their ads are mostly blocked as requests), and doesn't run uBlock
  Origin's procedural filters (`:has-text()` and the like). YouTube's ads
  are an arms race: the lists' fixes arrive every few days, their newer
  scriptlets only with an Atmos release.
- On a first start, pages load unblocked for the few seconds the lists take
  to download and build.

## Tests

- `tests/`: the address bar (address or search), the tab list and putting
  pages away, history and bookmarks and their storage, and the engine
  against the fake Atmos (tabs restored and loaded lazily, private tabs,
  prompts, links from Atmos). Run with the other extensions' tests:
  `npm run test:all`.
- Core's policy: `core/js/core/web-policy.test.cjs`, `web-settings.test.cjs`;
  the blocker: `web-adblock.test.cjs`, `web-page-preload.test.cjs`.
- End to end: `scripts/e2e/browser.cjs` (see `scripts/e2e/README.md`).
