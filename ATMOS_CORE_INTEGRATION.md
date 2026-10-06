# Atmos extension guide

How to build extensions for Atmos, and how Atmos runs them.

Atmos is a web browser with a workspace around it. The browser (Atmos
Browser) is built in; everything beside it comes from extensions: panels
that sit next to pages, widgets in the sidebar, background work and shared
services. Other browsers' extensions reach into the pages; Atmos's add to
the place you work, around them.

An extension is a folder with an `extension.json` and some JavaScript. Each
panel, sidebar widget or background task it has runs in a sandboxed frame,
and talks to Atmos only through the **Atmos SDK** (`import atmos from
'atmos-sdk'`). Atmos owns the workspace around it: layouts, the sidebar,
Settings, the theme, permissions and routing between extensions.

| Section | | Who needs it |
|---|---|---|
| 1 | [Start here](#1-start-here): make, run, test and share an extension | everyone |
| 2 | [How an extension works](#2-how-an-extension-works): files, surfaces, what Atmos owns | everyone |
| 3 | [The manifest](#3-the-manifest) (`extension.json`) | everyone |
| 4 | [The Atmos SDK](#4-the-atmos-sdk) | everyone |
| 5 | [Services and libraries](#5-services-and-libraries) | when you share code or data between extensions |
| 6 | [Main-process code](#6-main-process-code-maincjs) (`main.cjs`) | official extensions only |
| 7 | [Permissions and security](#7-permissions-and-security) | everyone; the second half is Atmos's own machinery |
| 8 | [Tools: typings, tests, licensing](#8-tools-typings-tests-licensing) | everyone |
| 9 | [Checklist](#9-checklist) | before you share one |
| 10 | [Compatibility](#10-compatibility) | when upgrading an older extension |

Parts marked **Official extensions only** describe what Atmos gives the
extensions it signs itself. Atmos refuses those parts to community
extensions, so you can skip them if you're writing your own.

## 1. Start here

### Make one from the template

The Atmos repository has a template: a panel with a counter and a sidebar
widget that asks GitHub for a number, with tests. In a clone of
[atmos-desktop](https://github.com/samsaraserenade/atmos-desktop):

```sh
npm install
npm run new:extension -- ../weather --name "Weather" --publisher you
```

The folder's name (`weather`) is the extension's **id**: lowercase letters,
numbers and hyphens. You get:

| File | |
|---|---|
| `extension.json` | The manifest: its name, the Atmos it needs, its surfaces and its permissions (section 3) |
| `panel.js`, `sidebar.js` | A panel and a sidebar widget, each its own frame |
| `src/` | Code both use, kept apart from the page so it can be tested in Node |
| `styles.css`, `icon.svg` | Styles (Atmos's theme arrives as CSS variables) and an icon drawn in the text colour |
| `tests/` | Tests against a fake Atmos: `npm test` |
| `.atmos-sdk/` | Copied from Atmos: the SDK's typings, the manifest's schema and the test kit (section 8). Never served to a frame |

### Run it while you write it

Start Atmos with the folder as a **developer extension**:

```sh
# Atmos installed on Windows
"%LOCALAPPDATA%\Programs\Atmos\Atmos.exe" --dev-extension="C:\path\to\weather"

# Atmos from source (in the repository)
npm start -- --dev-extension="C:\path\to\weather"
```

- It loads straight from that folder, without asking for approval, as a
  community extension with a **Developer** badge in Settings → Extensions.
- Its frames reload whenever you save a file. A changed `extension.json` is
  read again first (new permissions and hosts apply at once). A surface
  added or removed needs a restart, and Settings says so.
- Quit Atmos first: it runs one copy at a time, and a second one only brings
  the first to the front.
- Add `--devtools` to open the developer tools (F12) and see your frames'
  consoles.
- Atmos from source also runs on Linux and macOS (`npm start -- …` as
  above). As root on Linux, add `--no-sandbox`. `--remote-debugging-port=9222`
  lets Playwright or Chrome's DevTools attach, for tests that drive the real
  Atmos.
- For a service, use `--dev-service=<folder>`. Either flag can be given more
  than once.
- If you've also installed an extension with the same id, Atmos loads the
  installed copy and ignores the folder, since the folder would otherwise
  use that copy's data. Settings says so on its card; remove the installed
  copy, or rename your folder.

A developer folder has exactly the limits of any community extension: it
can't have a `main.cjs`, and reaches only what it declares.

### Test it

```sh
cd weather
npm test
```

The tests run in Node against a fake Atmos that has the SDK's shape and
refuses what a real one would (an undeclared host, say). Section 8 has the
details.

### Share it

**From your GitHub repository** (Atmos 0.19.3): raise `"version"`, run
`npm run pack` (`node .atmos-sdk/pack.cjs`), and attach the two files it
writes to `dist/` (`<id>-<version>.atmos` and `index.json`) to a GitHub
release. Atmos reads the latest release. People add your repository on the
Extensions page (sources → Add a source → `github.com/you/repo`), install
it from Available and, after a restart, approve what it asks for; every
new version asks them again. Section 7, "Publishing from GitHub", has the
details, and signing.

**By hand:** copy the folder (you can leave out `node_modules`, `tests` and
`.atmos-sdk`) into `%APPDATA%\atmos\plugins\` on the other computer, or
`services\` for a service, and restart Atmos. Nothing of it shows yet: the
footer's Extensions button turns red ("Weather needs your approval"), and
Settings → Extensions lists it under **Waiting for your approval** with a
Review button that takes you to its card further down, under Plugins →
Community. The card lists its
permissions and what it shares; **Approve** loads it at once, with no second
restart. Any later change to its files asks for approval again (section 7).

### The smallest extension by hand

Two files are enough. `extension.json`:

```json
{
  "apiVersion": 4,
  "engines": { "atmos": ">=0.15.0" },
  "version": "0.1.0",
  "displayName": "Hello",
  "permissions": {}
}
```

and `panel.js`:

```js
import atmos from 'atmos-sdk';

const saved = await atmos.state.get();
const visits = (saved.visits ?? 0) + 1;
await atmos.state.update({ visits });
document.body.textContent = `Hello from ${atmos.extension.id}: visit ${visits}`;
```

## 2. How an extension works

### Plugins, services and libraries

- A **plugin** is what people use: panels, sidebar widgets, a settings
  page and background work.
- A **service** supplies behaviour or data to other extensions: methods its
  background frame exposes, or (official only) main-process handlers.
- A **library** is a service marked `"library": true`: modules other
  extensions import into their own frames, with no lifecycle, interface or
  state of its own.

Section 5 says when to use which.

### Files and surfaces

```text
weather/
├── extension.json       # the manifest (section 3)
├── panel.js             # a panel
├── sidebar.js           # a sidebar widget (more with "contributes")
├── settings.js          # a settings page (Settings → Appearance)
├── boot.js              # a background frame for the whole session
├── main.cjs             # official extensions only: main-process code (section 6)
├── src/
└── assets/
```

Atmos makes a frame for each entry file:

| File | Surface | The frame |
|---|---|---|
| `panel.js` | panel | fills the panel while it is shown |
| `sidebar.js` | sidebar widget | sized to its content |
| `settings.js` | settings page | the extension's settings, on Settings → Appearance (Atmos Browser's have a Browser page of their own) |
| `boot.js` | background | hidden, running for the whole session |

**How tall a frame is.** A panel's frame fills the panel. A sidebar
widget's and a settings page's frame is as tall as the content of its
`<body>`: the SDK measures `<body>` and Atmos sizes the frame to match, as
the content changes. Atmos sets `html` and `body` to `height: auto` in those
frames (a `height: 100%` reset would make the frame as tall as itself, and
a settings page 0 px), and content that is `position: absolute` or `fixed`,
or floated, doesn't count. A frame that measures 0 px with something in it
says so in its console.

A frame lives exactly as long as its surface: switching panels, hiding a
widget or changing the layout removes it, and showing it again makes a new
one. Only the background frame lasts all session (see section 4, "Keeping
work alive").

**Labels, icons and options** come from `"contributes"` in `extension.json`.
Without it, the files above are used with `displayName`. With it, only the
surfaces it lists are created, so list each one (`"boot": {}` is enough for
`boot.js`):

```json
{
  "contributes": {
    "panel":    { "label": "Weather", "icon": "icon.svg", "glass": true },
    "sidebar":  [{ "label": "Forecast", "order": 10, "defaultHeight": 120 },
                 { "id": "alerts", "entry": "alerts-sidebar.js", "label": "Alerts" }],
    "settings": { "label": "Weather" },
    "boot":     { "entry": "boot.js" }
  }
}
```

Every entry takes `label`, `icon` (a file in the extension) and `entry` (a
file other than the conventional one). A second sidebar widget needs an
`id`. The other options:

| Option | On | What it does |
|---|---|---|
| `"order": 10` | panel, widget | Where it goes among the others (lower first) |
| `"default": true` | panel | Asks to be the panel Atmos opens on. Atmos Browser, which Atmos ships with, comes first (from Atmos 0.18); otherwise the first extension to ask gets it, and any other is passed over with a line in the log |
| `"glass": true` | panel | Atmos draws its frosted glass under the frame where the frame asks (`atmos.surface.trackGlass`, section 4), following the panel's blur and opacity. A frame's own `backdrop-filter` can't blur the wallpaper behind it |
| `"defaultHeight": 120` | widget | Its height before the user resizes it |
| `"defaultEnabled": false` | widget | Starts hidden until the user shows it |
| `"resizable": false` | widget | Its height always follows its content |
| `"showIn": ["audio-player"]` | widget | The panels it shows beside until the user chooses otherwise. Absent: beside the extension's own panel (every panel if it has none). `[]`: every panel |
| `"legacyId"`, `"drawer"`, boot `"keys"` | | Official extensions only (section 4) |

`"commands"` beside the surfaces (SDK 1.3, Atmos 0.20) declares rev/
commands for Atmos's command bar (section 4, "Commands in Atmos's bar").

Panels have no keys of their own from Atmos 0.19.1: `"shortcut"` and
`"shortcutToggles"` are still accepted, so a manifest that has them stays
valid, and ignored.

Labels are plain text and icons are drawn as a mask in the current text
colour, so single-colour SVGs work best. Nothing an extension declares is
ever put into Atmos as markup.

### What a frame loads

Every file a frame loads is an ES module (or stylesheet, image, font…)
served from the extension's own origin (`atmos-ext://…`), so relative
imports, `new URL('./x.css', import.meta.url)`, fonts and images work as on
the web.

- **Scripts** load only from the extension's own files and from the library
  services it declares in `invokes`.
- **Stylesheets and fonts** load only from its own files (fonts also as
  `data:` URLs).
- **The network** (`fetch()`, WebSockets, images, media) reaches only the
  hosts in `permissions.network`. For APIs that send no CORS headers, use
  `atmos.fetch()` (section 4).
- **WebAssembly** needs `"wasm"` in `permissions.browser`.
- **Never served:** folders named `data`, `tests`, `backups` and
  `_to_delete`, anything whose name starts with `.`, and any link that
  points outside the extension's folder.

### What Atmos owns

Atmos owns the shell around every surface; the extension owns what's in its
frame.

- **Panels.** Atmos supplies the layouts (single, columns, rows, stacks, a
  grid of four, and four floating windows the user moves and resizes),
  switching, the panel history (the mouse back button; hold it for Task
  View) and saved placement. The frame fills its section at its real size;
  `atmos.surface.presentation` says whether that is `'full'`, `'tile'` or
  `'window'`. Atmos draws no header, toolbar or visual identity for a
  panel, so design it from the extension's own purpose, and don't copy
  another extension's interactions.
- **Sidebar widgets.** Atmos owns the section: its label row,
  expand/collapse, drag ordering, hiding, and which panels it shows beside
  (every widget's header menu offers "everywhere" or one panel). Open
  widgets can be resized by dragging their lower edge, in 28 px steps;
  double-click goes back to the natural height. The SDK keeps the frame's
  height matched to its content, even while its section is collapsed or
  the sidebar closed.
- **Settings.** Settings lists every extension on its Plugins, Services
  and System pages, where it is switched on or off (at the next start),
  approved, and its permissions and dependencies shown. Settings →
  Extensions installs, updates and removes packages. An extension's own
  preferences belong in its own surfaces, or its settings page.
- **Theme.** Frames get Atmos's CSS variables (`--ink-rgb`,
  `--surface-rgb`, `--app-font-family`, and the semantic colours
  `--color-positive`, `--color-negative`, `--color-neutral`…) and any font
  imported in Appearance, and follow changes.
- **Keys.** Keys pressed inside a frame that aren't typing reach Atmos's
  own shortcuts, so they work whichever panel has focus (section 4, "What a
  frame can't do").

### Where extensions come from

| Source | Where |
|---|---|
| Part of Atmos | `core/system/<id>`: the system services (Wallpaper, Audio) only. Location was one until 0.21; it's an official service now |
| Built in | Atmos Browser, which an installer carries (`core/built-in-extensions.json`, Atmos 0.18): official, never offered in the first-start picker, switched off rather than removed, and updated by a newer signed package like any other |
| Bundled | the repository's `plugins/` and `services/` when running from source (`npm start`). An installer bundles only the built-in ones: it offers the rest as packages on the first start |
| Installed | `%APPDATA%\atmos\{plugins,services}\<id>\` on Windows (`~/Library/Application Support/atmos` on macOS, `~/.config/atmos` on Linux), by Settings → Extensions or by hand |
| Developer | a folder named with `--dev-extension` or `--dev-service` |

Where an extension sits doesn't decide who vouches for it; its signature
does. Settings shows one of three **tiers**:

| Tier | Settings shows | Which extensions |
|---|---|---|
| `system` | System | In `core/system`: part of Atmos. Always on. Nothing elsewhere can claim it |
| `first-party` | Official | Running from the repository, or installed with a valid signature from an official key (section 7). Can be switched off |
| `third-party` | Community | Everything else: installed and not officially signed, and developer folders. What a manifest says about its tier is ignored |

When the same id is in several places, a system service always wins. Among
official copies the highest `version` wins (the bundled one on a tie), and
the next one down is kept as a fallback that loads if the winner can't (a
damaged update, say; Settings says so). A community copy never replaces an
official one, and a developer folder never replaces an installed copy.
Ignored copies are logged.

Extensions are found when Atmos starts, so a new or removed one needs a
restart (a developer folder's changes don't). Installs from before the
`services` rename used a `service/` folder, which Atmos moves on first
launch.

## 3. The manifest

Every extension has an `extension.json`. A typical community one:

```json
{
  "$schema": "./.atmos-sdk/extension.schema.json",
  "apiVersion": 4,
  "engines": { "atmos": ">=0.15.0" },
  "version": "1.0.0",
  "publisher": "you",
  "displayName": "Weather",
  "description": "Today's weather in the sidebar.",
  "contributes": { "sidebar": { "label": "Weather", "icon": "icon.svg" } },
  "permissions": {
    "network": ["api.open-meteo.com"],
    "invokes": ["service:location"]
  },
  "dependencies": { "location": "^1.0.0" }
}
```

`"$schema"` lets an editor check the file and complete it (section 8).

| Key | Meaning | See |
|---|---|---|
| `apiVersion` | The extension API it's written for: `4` for SDK 1.x | below |
| `engines` | The Atmos versions it runs on: `{ "atmos": ">=0.15.0" }` | below |
| `version` | Its own version, `MAJOR.MINOR.PATCH`. Needed to be packaged, and for others to depend on it | below |
| `publisher` | Who publishes it. `"atmos"` for official extensions, and it must match the key that signs them | 7 |
| `displayName`, `description` | Its name in Settings (and default label), and one line about it | 2 |
| `contributes` | Its surfaces: labels, icons, entry files and options | 2 |
| `permissions` | Everything it uses: network hosts, browser permissions, other extensions | 7 |
| `exports` | What it shares with other extensions, with whom, and (Atmos 0.16) what each gives | 7 |
| `dependencies` | Services (or plugins) it needs, with version ranges; also its start order | below |
| `library` | `true` on a service that is a library | 5 |
| `isolation` | `"origin"`: official extensions only (section 4, "Storage") | 4 |
| `legacyStorage` | Official extensions only: data kept elsewhere before (section 4) | 4 |
| `after`, `supersedesServices` | Start order only (prefer `dependencies`), and legacy services an official plugin replaces | below |
| `auditExclude` | Folders the permission audit skips | 7 |
| `contract` | A service's own API description (formerly `service.json`). Atmos doesn't read it; the service's tests do | 5 |
| `requires` | Capabilities of older Atmos versions (section 10). Not needed with `engines` | 10 |
| `runtime` | `"frame"`, for Atmos 0.11 and older only (section 10) | 10 |
| `tier` | Ignored by Atmos. Bundled manifests say `"first-party"` (`"system"` in `core/system`), which the tests check | 2 |

Unknown keys are ignored, except in `permissions` and `exports`, where they
make the block invalid.

### Which Atmos it runs on

- **`engines.atmos`** is a version range, as in npm: `">=0.15.0"`, `"^1.0.0"`
  and so on. Short forms work: `">=0.15"`, `"^1"`, and `"0.15"` for any
  0.15.x. Atmos doesn't load an extension whose range leaves it out, and
  the extension manager doesn't offer it; Settings says "not for this
  Atmos" and what it needs.
- **`apiVersion: 4`** marks an SDK 1.x extension. Atmos 0.14 and older don't
  read `engines`, but they do refuse an `apiVersion` above their own, so
  this keeps them from loading it.
- **Something new in SDK 1.1** (marked "1.1" in section 4) needs
  `">=0.16.0"`: Atmos 0.15 reads `engines` and says the extension isn't for
  it, rather than running it without the call. SDK 1.2's `atmos.web`
  (official only) needs `">=0.17.0"`; SDK 1.3's `atmos.commands` and
  `"commands"`, `">=0.20.0"`; SDK 1.4's `atmos.nowPlaying`, `">=0.21.0"`.

### Versions and dependencies

```json
{
  "version": "1.0.0",
  "dependencies": {
    "charting": "^1.2.0",
    "currency": "^1.0.0",
    "market-data": { "version": "^0.4.0", "optional": true }
  }
}
```

- A bare id is a service; write `"plugin:<id>"` for a plugin.
- Ranges: `1.2.3` (exactly), `^1.2.3` (compatible: below `2.0.0`, or below
  `0.5.0` for `^0.4.x`), `~1.2.3` (patch updates), `>=1.2.3` and `*`.
- List every service and plugin in `permissions.invokes` as a dependency,
  so Atmos can say what's missing. The system services (`audio`,
  `wallpaper`) are part of Atmos and always there, so a community
  extension needn't list them. Location (and Now Playing) are official
  services, installed with what names them: list them (the example above
  does), or the user has to install them themselves. The
  bundled extensions list them anyway: `npm run test:permissions` checks
  that every invoke is a dependency, along with the ranges and that a
  released extension's required dependencies are released too.

At startup, an extension whose **required** dependency is missing,
switched off, can't load, or has a version outside the range doesn't load
either, and Settings says why ("Needs Charting, which is switched off"). The
dependency's own row lists what uses it.

An **optional** dependency never stops loading: the extension checks for it
and hides what needs it. A library that isn't loading this session can't be
imported (`atmos.library()` rejects), which is how a frame checks. Finance
does this before it mounts (`plugins/finance/src/host/market-data.js`) and,
without Market Data, hides its market charts.

The extension manager installs required dependencies with an extension,
and **offers** optional ones ("Optional: <name>" with its own Install
button) when a source has a version in range. One marked `"recommended":
true` is installed with the extension the first time, but stays optional:
it can be removed, switched off or fail without stopping the extension,
and an update doesn't bring it back. An update that recommends it for the
first time installs it too (Atmos 0.21), so its users get what a new
install gets; but once the user removed it, or cancelled its install, no
extension's recommendation brings it back:

```json
"market-data": { "version": "^0.4.0", "optional": true, "recommended": true }
```

### Start order

Extensions of the same kind start in alphabetical order, after their
dependencies of that kind; services always start before plugins. This
decides when each `main.cjs` activates and the order frames are made (and
so the default panel order).

The older `"after": ["media-metadata"]` still orders startup and nothing
else: only installed, enabled ids of the same kind count, missing ones are
ignored, and a cycle is logged and broken alphabetically. Bundled
extensions use `dependencies` instead (the tests refuse `after` in them).

An official plugin replacing a legacy standalone service may declare
`"supersedesServices": ["old-service-id"]`, which stops that service's
`main.cjs` from starting while the plugin is installed. Atmos ignores it
from community plugins.

## 4. The Atmos SDK

### Using it

Entry files import `atmos-sdk` and render into their own `document`. Atmos
serves the SDK to every frame; the typings in `.atmos-sdk/` are only for
your editor.

```js
import atmos from 'atmos-sdk';

document.body.innerHTML = '<main class="weather"></main>';

const saved = await atmos.state.get();
await atmos.state.update({ city: saved.city ?? 'London' });
atmos.lifecycle.onCleanup(atmos.state.onChange(next => render(next)));   // other frames' changes

const response = await atmos.fetch('https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.1&current=temperature_2m',
  { signal: atmos.lifecycle.signal });
render(await response.json());

document.addEventListener('contextmenu', event => {
  event.preventDefault();
  atmos.contextMenu.open(event.clientX, event.clientY, [
    { id: 'refresh', label: 'Refresh', run: () => load() },
  ]);
});
```

Every call is asynchronous and checked by Atmos against the manifest. A
refused call rejects with an `AtmosPermissionError` naming what to declare.
Subscriptions (`events.on`, `listen`, the `onChange`s) don't reject: a
refusal is logged in the frame's console.

**What SDK 1.x promises.** `atmos.SDK_VERSION` is `'1.6.0'` (Atmos 0.23),
and a later 1.x only adds. What 1.1 added is marked **1.1**; 1.2 added
only `atmos.web`, for official extensions; 1.3, `atmos.commands` (with
`"commands"` in the manifest) and ui.css's bar; 1.4, `atmos.nowPlaying`; 1.5, `atmos.web.close(tabId, { sleep })` for official extensions, and Atmos's own keys taken before a frame's code sees them; 1.6, a command's `aliases`. Everything below is **stable** unless marked
**experimental** (it may still change in a minor version). The calls in
"Official extensions only" at the end of this section may change in a
minor version too, and Atmos refuses them to community extensions.

### This frame

| Call | What it gives |
|---|---|
| `atmos.extension` | `{ id, kind, tier, version }`: which extension this frame belongs to |
| `atmos.surface` | `{ type, id, presentation, glass, drawer }`: `type` is `'panel'`, `'sidebar'`, `'settings'` or `'boot'`; `presentation` is `'full'`, `'tile'` or `'window'` (panels) and never changes, since a layout change makes a new frame |
| `atmos.ready` | A promise that resolves once the frame is connected. Entry files already run after it |
| `atmos.SDK_VERSION` | `'1.6.0'` (Atmos 0.23); `'1.5.0'` in Atmos 0.22, `'1.4.0'` in Atmos 0.21, `'1.3.0'` in Atmos 0.20, `'1.2.0'` in Atmos 0.17 to 0.19, `'1.1.0'` in Atmos 0.16, `'1.0.0'` in Atmos 0.15 |

### State and events

| Call | What it does | Needs |
|---|---|---|
| `atmos.state.get()` / `set(value)` / `update(patch)` / `onChange(fn)` | JSON state shared by all the extension's frames (at most 1 MB), saved in a file of its own shortly after each change. `update` merges top-level keys in one step, so two frames changing different keys keep both | — |
| `atmos.events.emit(name, payload)` / `on(name, fn)` | The extension's own events. `on('<id>:<name>')` hears another extension's, if it shares them (`exports.events`) | `invokes` for another extension's |

For more than 1 MB, use IndexedDB or `localStorage` in the frame: every
extension has an origin of its own (see "Storage" below).

### Appearance, menus, glass

| Call | What it does | Needs |
|---|---|---|
| `atmos.appearance.get()` / `onChange(fn)` | `{ theme, colorScheme, vars, font }`. The variables and any imported font are already applied to the frame; this is for drawing (a canvas, a chart) | — |
| `atmos.contextMenu.open(x, y, items)` | An Atmos menu at frame coordinates. Resolves with the chosen row's id, the last `{ id, value }` a control changed, or `null`. Background frames can't open menus | — |
| `atmos.contextMenu.close()` | Close the menu this frame has open | — |
| `atmos.surface.setMenu(items)` | Sidebar widgets: items Atmos adds to the widget header's right-click menu. Call again when they change (a `checked` flag, say) | — |
| `atmos.surface.trackGlass()` | Panels with `"glass": true`: every element marked `data-atmos-glass="panel"` (or `"shell"`) gets Atmos's frosted glass under it, kept up to date as layout changes. `data-atmos-glass-inset="top right bottom left"` (px) shrinks it; its CSS border radius is used. Leave those areas transparent. Returns a function that stops | `"glass"` on the panel |
| `atmos.surface.setGlass(regions)` | The same by hand: `[{ x, y, width, height, material: 'panel' \| 'shell', radius }]` in frame pixels (`'panel'`: the panel's blur and opacity; `'shell'`: the shell's). At most 24; `radius` at most 40. `[]` clears it | `"glass"` on the panel |

**Menu items** are plain data; Atmos draws them. A menu has at most 50 rows,
labels are cut at 120 characters, and any row may have an `icon` (SVG
markup, of which Atmos keeps only plain shapes).

| Item | Shape |
|---|---|
| A row | `{ id, label, run, checked?, hold?, tone? }`. `checked` shows a tick; `hold: true` asks for a press and hold before it runs; `tone: 'danger'` draws it in the negative colour |
| A row of buttons | `{ type: 'buttons', buttons: [{ id, label, icon?, title?, run }] }` (at most 12): a click runs that button and closes the menu |
| A toggle | `{ type: 'toggle', id, label, checked, run(value) }` |
| A slider | `{ type: 'range', id, label, min, max, step, value, suffix?, zeroLabel?, run(value) }` |
| A number | `{ type: 'number', id, label, min, max, step, value, suffix?, run(value) }` |
| Text | `{ type: 'text', id, label, value, placeholder?, maxLength?, run(value) }`: runs on Enter with the trimmed text, then closes |
| A dropdown | `{ type: 'select', id, label, value, options: [{ value, label }], run(value) }` (at most 50 options) |
| Colours | `{ type: 'colors', id, label, values: ['#rrggbb'], run(value) }` (at most 6) |
| Decoration | `{ type: 'separator' }`, `{ type: 'heading', label }`, `{ type: 'meta', label }` |

Every row and control takes a `label` (shown beside the control) and an
`icon`; `id` is what `open()` resolves with. Controls stay open while they
are changed; add `closeOnChange: true` to close on the first change.

### Network, location, lifecycle

| Call | What it does | Needs |
|---|---|---|
| `atmos.fetch(input, init)` | `fetch()`, made by Atmos for the frame: for APIs the frame can't read itself because they send no CORS headers. Same arguments and result as `fetch()` | the host in `permissions.network` |
| `atmos.location.get()` / `onChange(fn)` | The location the user set in Atmos (Settings → Appearance → Location), read-only: `{ lat, lon, label, mode }` (`mode` is `'auto'` or `'manual'`), or `null` when none is set or the Location service isn't installed. It's an official service since Atmos 0.21: list it as a dependency (`"location": "^1.0.0"`) so it comes with your extension | `"invokes": ["service:location"]` |
| `atmos.lifecycle` | The frame's lifetime, for cleaning up after it (below) | — |

**`atmos.fetch()` rules.** Atmos's main process makes the request, and
checks everything again there:

- `https://` only, on the default port, to hosts in `permissions.network`.
  Every redirect is checked the same way, and an `Authorization` header
  doesn't follow a redirect to another host.
- Never a private or local address (this computer, the local network,
  Tailscale's range), checked on the address actually connected to.
- No cookies and none of the user's credentials: only what the frame sends.
  Headers only a browser sets (`Cookie`, `Host`, `Origin`, `Referer`,
  `Sec-*`…) are dropped, and `Set-Cookie` never comes back.
- Limits: 30 s per request (from when it gets its turn), 5 MB up, 10 MB
  down after decompression. Six requests run at once per extension and up
  to 24 more wait (32 MB of bodies at most); beyond that, and beyond 32 in
  flight from one frame, a request is refused at once.
- It rejects with a `TypeError` for network failures (as `fetch()` does),
  an `AtmosPermissionError` for an undeclared host, a `TimeoutError`, or an
  `AbortError` when its `signal` aborts.

A frame's own `fetch()` still works for APIs that do send CORS headers, and
for WebSockets.

**`atmos.lifecycle`** cleans up what a frame hands to things that outlive
it (a listener on the background frame's objects, a timer, a request in
flight):

| Member | |
|---|---|
| `signal` | Aborts as the frame goes: pass it to `fetch()`, `addEventListener` and your own work |
| `onCleanup(fn)` | Run `fn` as the frame goes (the last added runs first). Returns a function that cancels it. Handy with anything that returns an unsubscribe: `atmos.lifecycle.onCleanup(atmos.state.onChange(render))` |
| `listen(target, type, fn, options)` | `addEventListener`, removed as the frame goes; returns a function that removes it now |
| `setTimeout(fn, ms)` / `setInterval(fn, ms)` | Cleared as the frame goes |

### Wallpaper and audio

| Call | What it does | Needs |
|---|---|---|
| `atmos.wallpaper.set(file)` / `get()` / `onChange(fn)` | Set an image `File` or `Blob` as the wallpaper; `{ mode, opacity, thumbnail, canRestore }` now and whenever it changes (`thumbnail` is a small JPEG data URL, for sampling colours). Atmos keeps the image yours replaced, and Settings → Appearance says "Set by Weather" with a Restore previous button | `"invokes": ["service:wallpaper"]` |
| `atmos.wallpaper.restore()` **1.1** | Put back the wallpaper your image replaced. Resolves `false` when the image showing isn't yours (the user or another extension changed it since); `canRestore` says beforehand. After several extensions in a row, what comes back is still what the user had | `"invokes": ["service:wallpaper"]` |
| `atmos.audio.load(source, { id, position, play, loop })` | This extension's own playback channel, which lives all session and keeps playing whatever frames come and go. `source` is a `Blob`/`File`, or an `atmos-resource://` URL from a provider it registers (official). `id` is your own label, reported back as `id`. **1.1:** `loop: true` starts it over at the end inside Atmos, with no `'ended'` and no frame involved (a soundscape keeps looping when its panel closes). Resolves with the state | `"invokes": ["service:audio"]` |
| `atmos.audio.play()` / `pause()` / `seek(s)` / `setVolume(0–1)` / `stop()` / `state()` / `onChange(fn)` | Control it; `play()` resolves whether it started. `{ type, id, source, loop, playing, currentTime, duration, volume, ended, error }` on every change, in every frame of the extension. `id` and `loop` are **1.1**; `source` is the same label as `id` (all Atmos 0.15 reports) | `"invokes": ["service:audio"]` |

### Now Playing (1.4)

Atmos's Now Playing widget shows what's playing, from any extension: Music,
a tab in Atmos Browser, yours. The widget belongs to the Now Playing
service (installed with the first extension that names it); your extension
only says what it plays and takes the controls back. Atmos sits between
the two, so no extension sees what another plays, and the widget can only
ask yours for what you listed.

```js
atmos.nowPlaying.set({
  title: 'Rain on a tin roof', artist: 'Field recordings',
  artwork: coverBlob,                 // PNG, JPEG, WebP or GIF, 1 MB at most
  duration: 1800, position: 42, playing: true, volume: 70,
  actions: ['toggle', 'seek', 'volume'],
});
atmos.nowPlaying.onControl(({ action, value }) => {
  if (action === 'toggle') togglePlayback();
  else if (action === 'seek') seekTo(value);       // seconds
  else if (action === 'volume') setVolume(value);  // 0–100
});
```

| Call | What it does | Needs |
|---|---|---|
| `atmos.nowPlaying.set(session, key?)` | Say what plays, the whole session each time: what you leave out is gone, so send the artwork and the current position with every change (while `playing`, the widget moves the position on by itself, so only a jump needs one). `key` (1–64 letters, digits, `- _ . :`; `'main'` by default) names one of several, a tab say. Past 20 calls a second, the newest for each session waits for the next second (it resolves once it's in, or once a newer one replaced it); 16 sessions and 4 MB of artwork all together | `"invokes": ["service:now-playing"]` |
| `atmos.nowPlaying.clear(key?)` | That session ends; with no key, all of yours. They also end when your extension's last frame goes | the same |
| `atmos.nowPlaying.onControl(fn)` | `fn({ key, action, value })` when the widget asks: `value` is seconds for `seek`, 0–100 for `volume`, else `null`. Only actions the session lists arrive. Every frame of yours that listens hears it, so listen in one (the background frame). Returns an unsubscribe function | the same |

A session is `{ title, artist?, album?, from?, artwork?, duration?,
position?, playing?, actions?, volume?, startedByUser? }` (`startedByUser:
false` when playback began without the user, so it shows only when nothing
else plays). Atmos checks every field and
rejects the call with a `TypeError` naming the one that's wrong: text is
shown as plain text on one line (title and artist 200 characters at most,
`from`, where it plays, 80); `duration` and `position` are seconds;
`artwork` is an image `Blob` or a `data:` URL of a PNG, JPEG, WebP or GIF,
1 MB and 4096 pixels a side at most, which Atmos reads by its bytes, not
the type it claims (never SVG, never an address for Atmos to fetch);
`actions` are any of `toggle`, `next`, `previous`, `seek`, `volume`. A
problem with the artwork rejects the whole call, so drop it and set the
rest again. Under the title the widget shows the artist and `from`, else which
extension it comes from (always for a community extension, marked as one).

Atmos Browser publishes its tabs too: a tab whose page plays shows with
what the page's Media Session says (else the tab's title and site icon),
always with its site, and the widget's controls reach the page. A page that
starts playing by itself (a background tab, nothing done in it just
before) shows only when nothing else plays.

Which one shows: the one picked with the widget's dots (shown only with
two or more), until something starts after that; else the one that started
playing last; else the one that played last. Paused for less than 3
seconds and playing again isn't a start. A community extension's start
counts only within 5 seconds of a click in one of its frames (Atmos sees
where clicks land), or of the user using its controls in the widget; otherwise its session shows only when nothing else
plays, so one can't take the widget by itself. And what shows doesn't
change while the pointer moves over the widget, so a click acts on what
was there. Declare the Now Playing service
as a dependency with `"optional": true, "recommended": true` so it comes
with your extension; without it the calls still work and nothing shows.

### Other extensions

| Call | What it does | Needs |
|---|---|---|
| `atmos.call('service:x', method, ...args)` | A method another extension's background frame exposes (waits up to 15 s for that frame to start) | `invokes`, and the method in its `exports.methods` |
| `atmos.expose({ method() {} })` | From `boot.js`: offer methods to `call()`. Arguments and results must be structured-cloneable (no functions or DOM nodes) | — |
| `atmos.library('service:x', file)` | The URL of a library's module, to `import()` into this frame | `invokes` |
| `atmos.invoke('service:x', channel, ...args)` | An official extension's main-process handler: the extension's own, or one another shares | `invokes`, and the handler in its `exports.ipc` |
| `atmos.listen('plugin:<id>', channel, fn)` | Events a `main.cjs` sends with `context.send()`; `fn(...args)`. Returns an unsubscribe function | `invokes` and `exports.events` for another extension's |

An extension's own frames can always `call`, `invoke` and `listen` to
itself (`'plugin:<own id>'`) without declaring anything.

### Small things

| Call | What it does | Needs |
|---|---|---|
| `atmos.clipboard.writeText(text)` / `writeImage(pngBlob, text?)` | Write the clipboard through Atmos. A frame can write it itself only while it has focus, and a menu choice runs while Atmos has focus, so a menu's "Copy" uses this | — |
| `atmos.panel.show()` | Switch Atmos to this extension's panel | — |
| `atmos.notifications.show({ title, body?, tag?, silent? })` | **Experimental** (not yet seen working on Windows). A system notification, shown by Atmos for the frame (Chromium refuses the `Notification` API in frames). Resolves `true` once shown, `false` where the system has none | `"notifications"` in `permissions.browser` |
| `atmos.notifications.onClick(fn)` | **Experimental.** The user clicked one of this extension's notifications: `fn({ tag })` in every frame of it, after Atmos comes to the front | — |

### Commands in Atmos's bar (1.3)

Atmos's command bar (Alt+\\ from anywhere, or the sidebar's ATMOS
wordmark when it lives there) takes `rev/` commands: Atmos's own
(`rev/sidebar`, `rev/settings [page]`, `rev/extensions`, `rev/switch
<panel>`, `rev/widget <widget> [show|fold|unfold|top|bottom|release|hide]`,
`rev/sidebar-side`, `rev/wallpaper paste|choose`, `rev/reload`) and those
extensions declare. Your widget's label is what `rev/widget` knows it by. It opens over the bottom bar of
the panel you're in (Settings → Appearance → Sidebar → Command Bar can put
it in the sidebar's footer instead). Every command is listed, under its
extension's name, by what's showing: the panel the bar is for, other
panels on screen, widgets on screen, Atmos's own, then the rest by name.
Once a
name is typed: Atmos's commands, panels and pages of Settings whose name
starts so, an extension's command called exactly that, panels and pages
with a later word that starts so (`rev/play` finds Music), then
extensions' commands that start so, so no command can push Atmos's own
places down. A command's row says whose it is (a community extension's
says so too). When two extensions declare one name, both are listed:
typed in full, the one listed first runs (what's on screen first), or, in
a bar an extension opened with its text, that extension's own; choosing
the other's row runs that one, and its suggestions then say whose they
are. What's typed after a command's name goes to its extension alone.

Declare each command in `extension.json`, at most 30, beside the surfaces:

```json
"contributes": {
  "panel": { "label": "Chat" },
  "commands": [
    { "name": "go", "args": "room or person", "about": "Open one of your rooms", "takesArgs": true, "suggests": true },
    { "name": "mute", "about": "Mute this room" }
  ]
}
```

| Key | What it is |
|---|---|
| `name` | What's typed after `rev/`: a-z, digits and `-`, 30 at most. Atmos's own names (`sidebar`, `settings`, `extensions`, `switch`) aren't allowed |
| `args`, `about` | A hint of what follows the name, and a line saying what it does (plain text) |
| `takesArgs` | It takes something after its name: Enter on the command gives it a space to type it, rather than running it at once |
| `aliases` | **1.6.** Other names it's found and run by, at most 3: Audio Player's `play` has `["pause"]`, so `rev/pause` is the same command, listed once. Not Atmos's names, nor another of your commands'. The handler always hears its own `name` |
| `suggests` | It lists choices as you type (below): Enter gives it a space too, then runs the row chosen |

Settings shows a community extension's commands on its approval card
("Adds commands to Atmos's command bar: rev/go, rev/mute").

Then handle them, in the frame that can do them. A background frame's
handlers work whatever is showing; a panel's while the panel is open, a
widget's while it's in the sidebar. When several of your frames handle a
command, the one on screen runs it; when none does (its panel isn't open),
the bar says to open yours. Handle them in your background frame if they
should work from anywhere (Matrix Chat's, Music's, Finance's and Atmos
Browser's do).

**Show your panel only when the result is something to look at.** A chart
or a room you opened, yes (`atmos.panel.show()`); music played, a tab
closed or a setting changed, no: the bar says what happened where it was,
and the user stays where they are. The user can ask otherwise (Atmos
0.20.1): Shift+Enter runs your command and then shows your panel, and
Alt+Enter runs it where they are, `atmos.panel.show()` doing nothing while
it runs. Your `run` hears which as `go` (`true`, `false`, or absent for a
plain Enter); with `false`, do what you'd have shown so that it's there
when your panel next shows.

```js
atmos.commands.handle('go', async ({ args, value }) => {
  await openRoom(value);
  await atmos.panel.show();
  return { done: 'Opened.' };
}, {
  suggest: ({ args }) => rooms.filter(room => room.name.includes(args)).map(room => ({
    title: room.name, sub: room.topic, action: 'Open', value: room.id, complete: room.name,
  })),
});
```

| Call | What it does |
|---|---|
| `atmos.commands.handle(name, run, { suggest })` | `run({ args, value, options, go })` when the command is chosen: `args` is what follows its name, `value` the chosen row's, `options` your options' values as the user left them, `go` Shift+Enter (`true`) or Alt+Enter (`false`), if either (above). Return nothing (the bar closes), `{ done }` (a line shown where the bar was), `{ keep: true, done? }` (it stays open), or `{ fill, options?, done? }` (the bar takes that text and option values: a next step), or throw (the bar shows the error). `suggest({ args, options })` returns rows, or `{ rows, options }`. 2 s to list, 15 s to run. Returns a function that stops handling it |
| `atmos.commands.bar(element)` | Panels: the bar along the bottom of your panel (`.atmos-bar`, below). The command bar opens over it while the keyboard is in your panel; without one Atmos lays a bar of its own along the panel's bottom. One per frame. Returns `stop()` |
| `atmos.commands.field(input, { options })` | A text field of yours that also takes commands (a message bar): `rev/` typed into it opens the bar there with what's typed, so commands have one list in one place. Keys typed before the bar has the keyboard follow it (while nothing has been typed in the bar), and Enter in that moment sends nothing from your field; when the bar closes, the field has the keyboard again. If the bar can't open, the text stays. To hand over text of your own (Enter in an empty view: `rev/go <what was typed>`), put it in the field and send an `input` event. `options` presets your command's option values. Returns `stop()` |
| `atmos.commands.open(text, options?)` | Open the bar with `text` yourself. Only while your frame has focus and the user has just typed or clicked. `options` presets your command's option values |
| `atmos.commands.refresh()` | Your suggestions changed (results arrived late): the bar asks again |

Rows are `{ title, sub?, action?, value?, complete?, danger? }`, `{ heading }`
or `{ note }`: plain text, at most 50. `value` comes back to `run`;
`complete` is what Tab types after the name (without it, Tab moves on);
`danger` marks a row that destroys something. Options are drawn above the
rows, at most 8: `{ id, type: 'toggle', label, value }`,
`{ id, type: 'select', label?, value, options: [{ value, label }], style: 'chips' | 'dropdown' }`
or `{ id, type: 'text', label?, value, prefix?, suffix?, placeholder? }`.
A change asks `suggest` again with the new values. While the user types,
the bar shows your last answer (dimmed) until the next arrives; Enter
waits for the answer to what's typed now (a click runs the row as shown).
A `danger` row runs only once it has been in the list half a second, by
Enter or a click: sooner, the bar says to press Enter (or click) again,
and an Enter pressed before the row showed never runs it.

What an extension puts in the bar (`field`, `open`, a result's `fill`) is
text, kept as sent. While any of a command's name it typed is there (typed
on, or partly backspaced), the bar chooses none of another extension's
rows for the user, as the first row or by Tab; they pick one with ↑↓ or a
click. In a bar an extension opened, or while text one put there is in
it (even a bare `rev/`), another extension's `danger` rows are never
chosen for the user, whoever typed the name. So an extension
can't line up another's command (Matrix Chat's `rev/leave`) for the
user's next Enter; the cost is that another extension's command typed fast
into your field (or pasted) needs ↓ before Enter. Your preset options
apply to your own commands only. Atmos cleans what a frame sends and draws
it as text, never as markup; a row's `value` is only handed back to you,
so it comes back as you sent it.

A message bar that also takes commands needs the `rev/` prefix to tell the
two apart; in Atmos's own bar it's optional (`switch finance`).

### Looking like Atmos: `ui.css` (1.1)

The rows and controls of Atmos's own Settings → Appearance page are in a
stylesheet every frame can use, so a settings page sits among Atmos's own
sections without matching them by eye:

```css
@import url("/__atmos/ui.css");
```

```html
<section class="atmos-section">
  <div class="atmos-row">
    <span class="atmos-label">Stars <small>Shown over the sky</small></span>
    <span class="atmos-control"><input type="checkbox" class="atmos-switch" aria-label="Stars"></span>
  </div>
</section>
```

| Class | For |
|---|---|
| `atmos-section`, `atmos-heading` | A group of rows, and a heading like Atmos's section headings |
| `atmos-row`, `atmos-label` (a `<small>` in it is a hint), `atmos-control` | A row: label left, control right |
| `atmos-switch` | An `<input type="checkbox">` drawn as Atmos's on/off switch |
| `atmos-slider` with `atmos-range` and an `<output>` | A slider and its value |
| `atmos-select`, `atmos-input`, `atmos-button`, `atmos-segmented` | A dropdown, a text field, a button, a choice of a few buttons (`.active` or `aria-checked="true"` marks the chosen one) |
| `atmos-status` (`.ok`, `.err`), `atmos-details` | A line of status; rows that fold away under a `<summary>` |
| `atmos-bar`, `atmos-bar-input` (1.3) | A panel's bottom bar, as Atmos's own: 54 px, in line with the sidebar's footer, a hairline on top. Give it `data-atmos-glass="shell"` for Atmos's shell glass, and `atmos.commands.bar()` it |

It styles only elements with these classes, and follows Atmos's theme.
`/__atmos/ui.css` is served to every frame in Atmos 0.16 and later.
Paths in a frame are relative to the extension's files only in its
modules and stylesheets (`new URL('./x.css', import.meta.url)`): the
document itself is `/__atmos/frame.html`, so `<link href="./x.css">` from
a script doesn't find your file.

### Keeping work alive: the background frame and views

Panels and widgets come and go, and each is a separate page. Anything that
must outlive them or be shared between them (a socket, a poller, a player,
a cache) belongs in `boot.js`, which runs for the whole session.

**One engine, many views.** Make the background frame the engine: it
fetches and polls, `emit()`s what changed, and `expose()`s a `snapshot()`
for frames that open later. The panel and widgets are views: they apply
what the engine publishes and never fetch themselves. They `call()` the
engine's `ready()` first.

- Publish what changed, not everything: number the engine's data with a
  revision, send a newly opened view a full `snapshot()`, and after that
  only the change since the last event. A view that sees a gap in the
  revisions asks for a snapshot.
- Revisions start again when the engine does (Atmos restarts, and a
  developer folder reloads every frame on save, `boot.js` included), so a
  view that ignores anything older than what it has would ignore
  everything. Give each run of the engine an epoch (a random id made when
  it starts) and send it with every revision; a view that sees a new epoch
  takes a fresh snapshot.
- `call()` waits for the engine's frame to `expose()` its methods (up to
  15 s), not for its data. Expose once `snapshot()` has something to give,
  or have `ready()` and `snapshot()` await the engine's own start. Another
  extension's frames can start before yours (start order is alphabetical),
  and would otherwise get an empty snapshot.
- Keep settings in `atmos.state` with each field its own top-level key
  (Finance uses `ns:<namespace>:<field>`), so every frame sees every change
  and writes only the fields it changed. `update()` merges top-level keys in
  one step; writing a whole object from a frame's own copy would undo
  another frame's change. Something too big for state (an imported font)
  goes in the origin's `localStorage`.
- Audio Player is the reference: its engine (`src/engine.js`) keeps the
  queue and library in the background frame and plays through the Audio
  service, and its views follow it (`src/client.js`).

**Several frames, one extension.** A panel and widgets that used to share
one page's memory can run the same code in different roles: preferences in
`atmos.state` (every frame gets `onChange`), larger data in the origin's
storage (other frames see `storage` events), and changes announced with an
event. A widget that needs the panel to do something (an import) records
the request in state and calls `atmos.panel.show()`, so a panel that is
only just starting still sees it.

Whatever a view hands to something that outlives it, clean it up with
`atmos.lifecycle`.

### Storage

Each community extension has an origin of its own
(`atmos-ext://plugin-<id>` or `atmos-ext://service-<id>`). An origin is a
storage partition and a process: all of the extension's frames share its
`localStorage` and IndexedDB, and no other extension can read, overwrite or
script them. `atmos.state` is kept in a file of its own
(`extension-state/<kind>-<id>.json` in Atmos's user data).

### What a frame can't do

- Read or script the Atmos page, other extensions' frames, `window.atmos`,
  `window.atmosCore` or Electron.
- Connect to hosts outside `permissions.network`, or load Atmos's own
  resources (`atmos-app:`, or `atmos-resource:` providers that aren't its
  own). Its Content-Security-Policy refuses them.
- Navigate itself away from its origin, navigate Atmos, open windows or
  dialogs (`alert`, `confirm`, `prompt`: use your own interface), or embed
  frames. Links and `window.open()` to the web open in Atmos Browser (or
  in the user's default browser, when they turned that off): the SDK hands
  them to Atmos. A **community** extension's link opens straight away only
  after a click or key in its own frame; one from a timer, a background
  frame or a tap makes Atmos ask the user first ("Weather wants to open
  example.com"), and the user can block its links until a restart. Open
  links from a click handler, not on load or on a schedule (Atmos 0.19.4).
- Listen for keys pressed outside it.
- Use browser permissions it didn't declare (and the user didn't approve).
- Draw outside its surface or catch input outside it. Only Atmos draws
  across the workspace.

Atmos's own keys are Atmos's in every frame, even while typing in a field:
Alt+` (switch panels), Alt+\ (the command bar), Ctrl+` (Settings) and
Ctrl+Shift+` (the sidebar). The SDK takes them before any of your code
sees them, so you can't use them, and they type nothing. The full list is
in Settings → Atmos (and `core/js/core/keymap.mjs`). Everything else is
yours: Tab, Ctrl+Tab, Ctrl+Shift+V and any other key.

Other keys pressed inside a focused frame that aren't typing are passed on
to Atmos after your code has seen them: modifier combinations, F-keys,
Escape (one press closes the topmost thing: a menu, the switcher,
Settings), and a key an official extension's background frame declared
(Audio Player's Space) outside fields and buttons. A key the frame handled
itself (`preventDefault()`) stays its own; a declared key it didn't handle
is Atmos's only (the frame doesn't also scroll). Ctrl+R in a frame reloads
that frame.

### Official extensions only

These are for the extensions Atmos signs. Atmos refuses them to community
extensions, and they may change in a minor version.

**Drawer panels.** `"drawer": { "bar": 54, "keys": true }` on a panel: on the
full workspace the panel lives in a drawer that slides up from the bottom,
with everything around it passing clicks through to the wallpaper. Atmos
moves it (wheel anywhere on the workspace, swipes, Escape twice to close),
remembers where it rests and draws its glass; the frame lays out a
`bar`-px bar and the rest. With `"keys": true`, characters typed on the
workspace while it's open go to the frame. In a tile or window it is pinned
open. Audio Player's Music panel is one.

| Call | What it does |
|---|---|
| `atmos.drawer.state` / `onChange(fn)` / `onKey(fn)` | `{ open, expanded, placement, barPlacement, locked, bar }`. While it moves, `--atmos-drawer-visible-h` on `:root` is the visible height below the bar (pinned open, it's unset: use `var(--atmos-drawer-visible-h, calc(100vh - <bar>px))`). Wheel and swipes in the frame move the drawer, except over elements marked `data-atmos-drawer-scroll` |
| `atmos.drawer.open()` / `close()` / `expand()` / `collapse()` | Bar only, hidden, fully open, back to the bar. Nothing happens while it's pinned open |
| `atmos.drawer.setBarPlacement('top' \| 'bottom')` / `setPlacement(0–2)` | Dock the bar at the bottom (the rest revealed upward); place it (0 open, 1 bar, 2 hidden) to carry over an old position |

**The Now Playing service's calls (1.4).** `atmos.nowPlaying.sessions(fn)`
(every extension's sessions, as section 4's "Now Playing" describes them,
with `id`, `source { id, name, community }`, `artwork` as a Blob Atmos
made and `artworkKey`, `positionAt`, `playingSince` and `lastActive`) and
`atmos.nowPlaying.control(id, action, value)` are refused to anything but
the official `service:now-playing` (services/now-playing).

**The Location service's calls (1.4).** `atmos.location.publish(location)`
(where you are, for readers; `null`: not set), `takeEarlier()` (the
location Atmos kept itself before 0.21, or `null`), `forgetEarlier()` (the
service has saved it: Atmos's copy goes, once the service's state is on
disk) and `allowDetect()` (after a real click on its Detect button, its
frame may use the browser's location for 15 s) are refused to anything but
the official `service:location` (services/location).

**Boot keys.** `"keys": ["Space"]` on the boot contribution:
`KeyboardEvent.code` values its frame hears with `atmos.surface.onKey(fn)`
(`fn({ code })`) wherever they are pressed in Atmos, except in a text field
or a frame that uses the key itself.

**Live objects from the engine.** `atmos.background({ timeout })` resolves
with the `window` of the extension's own background frame once it has
started (waiting up to 15 s, or `timeout` ms), for views that use the
engine's live objects rather than snapshots (a chat timeline of thousands
of events, say). The extension's frames share its origin, so this is a
same-origin window in the same process. Objects from it belong to that
realm (`instanceof Array` is false for its arrays; use `Array.isArray`),
and a view must remove every listener it gives them when its frame goes
(`atmos.lifecycle`).

**Web pages (1.2, Atmos 0.17).** With `"permissions": { "web": true }`, an
official extension shows web pages in its panel: Atmos Browser does. The
pages are Core's, not the extension's (section 7, "What is enforced"):
each open tab's page is a `<webview>` Core keeps in a layer under the
panel, in a browsing session of its own, and the main process decides what
it may load and do. The extension names its tabs (1–64 letters, digits,
`-` or `_`), says which one shows and where, and hears what pages do.

| Call | What it does |
|---|---|
| `atmos.web.open(tabId, { url, private })` / `close(tabId, { sleep })` | A page for the tab, loading `url` (`private: true` for the in-memory session); the page goes (the tab is the extension's to keep), its `beforeunload`, `pagehide` and `unload` first. With `sleep: true` (putting a background tab away), only if the page lets go: one with unsaved changes stays, without a dialog, and it resolves `false` |
| `atmos.web.show(tabId \| null)` / `list()` | Which tab's page the panel shows; the pages open, with their state |
| `atmos.web.setSurface({ x, y, width, height, over })` / `setSurface(null)` | Panel only: where the page goes, in the frame's pixels. The frame is cut away there, so the page shows through; `over` (up to 8 rectangles) is where the frame draws over the page itself (suggestions, prompts), and keeps. The page follows the panel through layout changes; a panel frame that goes takes it off screen |
| `atmos.web.navigate(tabId, url)`, `back`, `forward`, `reload(tabId, { hard })`, `stop`, `zoom(tabId, 'in' \| 'out' \| 'reset')`, `find(tabId, text, { forward, findNext })`, `stopFind`, `print`, `mute(tabId, muted)`, `edit(tabId, 'copy' …)`, `download(tabId, url)`, `copyImage(tabId, x, y)`, `focus`, `state` | What a browser does to a page. `navigate` is checked in the main process like any navigation; zoom is kept per site. A page's state has `blocked` (ads and trackers blocked on it) and `shield` (`'on'`, `'off'`, `'disabled'` or `'none'`) |
| `atmos.web.shield(tabId, on)` / `blocked(tabId)` | The site's shield: `false` lets its ads and trackers through, `true` blocks them again (kept per site; a private tab's choice stays with the private session); what was blocked on the page, `{ count, hosts }` |
| `atmos.web.adblock.status()` / `update()` | The ad and tracker blocker: `{ enabled, state, error, updatedAt, rules, total, lists }`; checking every list now |
| `atmos.web.onEvent(fn)` | What pages do, `{ type, tabId, … }`: `opened`, `closed`, `state`, `navigated`, `progress`, `favicon`, `load-failed` (with `certificate`), `refused`, `crashed`, `memory` (`bytes`: the page's process passed 2 GB, then each 2 GB more; Atmos 0.19.2), `find`, `fullscreen`, `context-menu`, `command` (the browser's shortcuts, taken before the page sees them), `open-tab`, `open-link` (a link from the rest of Atmos, when the user turned that on; `background` when there was no click in Atmos just before), `popup-blocked` and `download-blocked` (a page tried one without a click, or, with `insecure`, a secure page's download over plain http; `url` to open or fetch it, as Core's own), `https-fallback` (`url`, `site`: Atmos tried the page over https first and it loads over http; `redirected` when the site sent it back itself; Atmos 0.19.2), `download`, `download-removed`, `permission-request` (`origin` is the page's site, whichever frame asks), `permission-settled`, `external-request` (`site`, the asking page's), `private-ended`, `adblock` (the blocker's status changed), `media` (1.4: what plays in the page, `{ title, artist, album, artwork, playing, position, duration, actions }` from its Media Session and media elements, in the page's own words checked by Atmos, `artwork` a JPEG Atmos drew from the page's image; `null` when nothing does any more; `userActed`: the user acted in the page, or moved it from the browser, in the 5 seconds before) |
| `atmos.web.media(tabId, action, value)` | 1.4: what plays in the page: `'toggle'`, `'next'`, `'previous'` or `'seek'` (`value` in seconds), as its `media` event lists. Done through the page's own Media Session handlers where it has them, as Chrome's media controls do, else on the media element |
| `atmos.web.permissions.respond(requestId, { allow, remember })` / `list()` / `set(origin, name, 'allow' \| 'block' \| null)` | Answer a site's request (the extension draws the prompt; Atmos keeps the answer per site); the remembered answers, to show or take back. Besides the prompted permissions, `ads` (the site's shield down) and `popups` (its pop-ups allowed without a click), each only ever `'allow'` |
| `atmos.web.external.respond(requestId, allow)` | Answer a link to another program (`mailto:`…) |
| `atmos.web.downloads.list()` / `open(id)` / `show(id)` / `cancel(id)` / `pause(id)` / `resume(id)` / `remove(id)` | This session's downloads. `open` refuses a program or script |
| `atmos.web.options()` / `setOptions({ openLinks, askWhereToSave, blockAds })` / `clearData({ cookies, cache, siteSettings })` | "Open links in Atmos Browser" (on by default from Atmos 0.18; off before), asking where to save, blocking ads and trackers (on by default); clearing the ordinary session's data (`siteSettings` includes the shields) |

**Its own origin.** An official extension with `"isolation": "origin"` has
`atmos-ext://first-party-<kind>-<id>` to itself. Without it, official
extensions share `atmos-ext://first-party`, and with it each other's storage
and frames. Every bundled plugin has it; the bundled services are libraries,
with no frames of their own.

**Leaving the shared origin.** An official extension that kept data in the
shared origin lists it, and Atmos carries it across:

```json
"isolation": "origin",
"legacyStorage": {
  "sharedOrigin": {
    "indexedDB": ["finance-assets"],
    "localStorage": ["finance:state:*", "atmos:charting-*"]
  }
}
```

- At the first start with this manifest, before any of its frames open,
  Atmos copies those databases (schema and every record, Blobs included) and
  keys (exact names, or `"prefix*"` of at least four characters) into the
  extension's own origin, then counts what arrived.
- If the copy fails, the extension runs from the shared origin that
  session, Settings → Extensions says so, and Atmos tries again at the next
  start.
- Atmos deletes the shared copies at a later start, once the extension has
  run from its own origin. It touches nothing it wasn't told about. The
  record is `extension-origin-moves.json` in user data.
- `"sharedOriginIndexedDB": ["name", "prefix*"]` deletes databases from the
  shared origin once, without copying (for an extension that starts afresh,
  as Matrix Chat did); recorded in `shared-origin-cleanup-v2.json`, and a
  changed list runs again.

**Data from the Atmos page.** Extensions that moved into frames from the
page (before Atmos 0.12) read their old data once. `"legacyStorage"` lists
what, and these read it:

| Call | What it does |
|---|---|
| `atmos.legacy.readIndexedDB(name)` | A database listed in `"legacyStorage": { "indexedDB": [...] }`: `{ version, stores: { name: [[key, value], …] } }`, or `null`. An entry `{ "name": "db", "keys": ["prefix*", "exact"] }` returns only matching records |
| `atmos.legacy.readState(namespace)` | A state namespace listed in `"state"`, or `null` |
| `atmos.legacy.readLocalStorage(keys)` | Keys listed in `"localStorage"` (a `"prefix*"` entry returns every match): `{ key: value \| null }` |
| `atmos.legacy.deleteIndexedDB()` | Delete the page databases listed in `"deleteIndexedDB"` (names, or `"prefix*"` of at least four characters). Resolves the names deleted |

**Saved layouts.** `"legacyId": "old-widget-id"` on a panel or widget keeps
the id it had before the extension moved into frames, so saved layouts,
order and visibility still apply.

## 5. Services and libraries

A **service** owns a lifecycle and offers something to others. A
**library** is code that others import; it can't own a lifecycle, an
interface or privileged state.

| | Service | Library (`"library": true`) |
|---|---|---|
| Runs | Once per session, as itself: `boot.js` in its own background frame, and (official) `main.cjs` in the main process | Once per consumer frame, inside it |
| Identity, permissions, storage | Its own | The consumer's |
| Lifecycle | Starts, stops and keeps running | None: nothing runs until a consumer imports and calls it |
| Interface | May contribute panels, widgets and settings | None of its own; it may render into elements the consumer passes it |
| State | May keep state, shared by all its consumers | None it keeps; the consumer passes state in |
| Privileged access (files, IPC, Electron) | Official ones, through `main.cjs` and its permissions | Never directly; only through a route the consumer hands it |
| Consumers reach it with | `call()` (methods its background frame exposes), events, `invoke()` (its IPC), as far as it shares them (`exports`) | `import()` of `atmos.library()` |

**Choosing.** Use a library for pure computation and rendering: conversion,
formatting, parsing, charts. Use a service when something must exist once
for everyone (a rate poller, a socket, a cache), outlive a view, hold shared
state, or touch privileged APIs. Each consumer gets its own copy of a
library's module state, so anything that must be shared is a service.

**Library rules**

1. **It imports only its own files**, by relative path: no `atmos-core`, no
   `atmos-sdk`, no other extension, no bare packages.
2. **No entry points.** No `boot.js`, `panel.js`, `sidebar.js`,
   `settings.js` or `persist.js`, no `"contributes"` and no `"runtime"`.
   Atmos never runs a library's files itself and gives it no frames.
3. **No Atmos globals** (`window.atmos`, `window.atmosCore`). What it needs
   from Atmos, the consumer passes in (a function, a store, an element).
4. **No state of its own.** It doesn't write `localStorage`,
   `sessionStorage`, IndexedDB or cookies, which would land in the
   consumer's storage under the library's name. It takes values as
   arguments, or a store object from the consumer. In-memory caches that die
   with the document are fine.
5. **It runs with the consumer's permissions.** A host the library contacts
   must be declared by the consumer (and by the library, for the audit);
   so must a browser permission it needs. A library's own declarations are
   for the audit and Settings only. A consumer also declares
   `"invokes": ["service:<id>"]` to import it.

**A service with a library.** An extension may be both: a service side in
`main.cjs` that does the privileged work, and library modules that are its
client. The consumer gives the library the route to the service:

```js
// Media Metadata: main.cjs reads files; renderer.js is the client library.
const metadata = await import(await atmos.library('service:media-metadata', 'renderer.js'));
metadata.setInvoke((channel, ...args) => atmos.invoke('service:media-metadata', channel, ...args));
const tags = await metadata.readTags(path);
```

A service that needs an interface, state or a background frame is an
ordinary service, and can ship its client as a separate library.

**Examples in Atmos**

| Extension | Kind | Notes |
|---|---|---|
| Charting, Currency, Fullscreen Viewer | Libraries | Imported into the frames that use them; free for community extensions to use too (below) |
| Media Metadata | Service with a library | `main.cjs` reads and writes files (any path), shared with official extensions only; `renderer.js` parses tags and takes `setInvoke()` |
| Audio Player's engine | Service inside a plugin | Lives in `boot.js`, `expose()`s methods, emits changes |

`npm run test:permissions` audits every bundled library against these rules
(`auditLibrary()` in `scripts/extension-audit.cjs`); an exception would be
listed by file in `scripts/extension-permissions.test.cjs`, never granted by
a manifest (there are none).

### The shared libraries

Atmos has three libraries any extension can use: Charting, Currency and
Fullscreen Viewer. Declare `"invokes": ["service:<id>"]` and a dependency on
it with a version range, then, in the frame that needs it,
`const lib = await import(await atmos.library('service:<id>', '<file>'))`.
Each frame that imports it gets its own copy, which runs with your
permissions, and each library's API follows semver by its `version`, so a `^`
range brings fixes and additions but no breaking change.

#### Charting

Time-series charts (line, candlestick, Heikin Ashi) drawn in an element you
give it, with zoom, pan and hover built in. It fetches nothing.

```json
"dependencies": { "charting": "^1.2.0" },
"permissions": { "invokes": ["service:charting"] }
```

Import `api.js`.

| Call | What it does |
|---|---|
| `createTimeSeriesChart(element, options)` | Draw a chart in `element` and return its handle (below) |
| `configureChartStorage({ get, set })` | Where Charting saves the shared settings and named charts' views: `get(key)` returns a string or `null`, `set(key, value)` stores a string, both synchronous (`localStorage` works). Without it, settings last as long as the frame and named charts' views aren't kept |
| `getChartSettings()` / `setChartSettings(patch)` / `onChartSettingsChange(fn, { signal })` | Settings shared by every chart in this frame: `smoothing` (0–100), `lineOpacity` and `backgroundOpacity` (0–1), `showCurrentPriceLine`, `candleAnimation`, and `samsara` (the overlay's parts). Charts follow a change at once |
| `lineColorForTrend(points, { up, down }, valueOf?)` | `down` if the last value is below the first, otherwise `up`. `valueOf` defaults to `p => p.value` |
| `sma`, `ema`, `wma`, `hma`, `dema` `(values, length)`, `rsi(values, length = 14)` | Indicator maths on an array of numbers; `null` where there aren't enough values yet |

**Points.** A line point is `{ time, value }`, with `time` in milliseconds (a
number or a `Date`; strings are dropped). A candle is `{ start, end, open,
high, low, close }` or `{ t0, t1, o, h, l, c }`. Line points given to a
candle chart are grouped into candles. Your other fields are kept.

**Options** (all optional; all but `data`, `signal`, `toolbar` and
`stateKey` can be changed later with `setOptions`):

| Option | What it does |
|---|---|
| `type` | `'line'` (default), `'candlestick'` or `'heiken-ashi'` |
| `data` | The first points |
| `signal` | An `AbortSignal`; aborting it destroys the chart. Pass `atmos.lifecycle.signal` |
| `indicator` | The Samsara trading overlay (moving averages, RSI and session marks; candles coloured by session) is **on** unless you pass `null` |
| `showPriceAxis`, `showTimeAxis` | `true` to draw the axes; both are off by default |
| `timelineMode`, `priceScale` | `'gapless'` (default: points evenly spaced) or `'gaps'` (placed by their real time); `'linear'` (default) or `'log'` |
| `lineColor`, `upColor`, `downColor`, `gridColor`, `textColor` | Colours |
| `formatValue(value)`, `formatTime(time)` | Label text (defaults: a local number, and hours and minutes) |
| `showPointCount`, `showTooltip`, `showCrosshair`, `showHoverLabels` | On by default; `false` hides the visible-point count (top left), the tooltip, the crosshair, and the value and time labels that follow the pointer |
| `bucketMs` | Candle charts made from line points: the time a candle covers. `null` (default) picks one, aiming at about 250 candles |
| `maxPoints` | How many points it keeps (5000); older ones are dropped |
| `toolbar` | `true` for Atmos's chart controls, shown while the pointer is over the chart; `{ controls: ['type', 'range', 'fit'], prepend: [element], append: [element] }` to choose them and add your own |
| `stateKey` | A name for this chart: its type, axes, scale and view are saved through `configureChartStorage` and restored next time |

The handle:

| Call | What it does |
|---|---|
| `setData(points)` | Replace the points. The view the user zoomed or panned to is kept |
| `append(point)` / `appendMany(points)` / `updateLatest(point)` | Add newer points, or replace the last. A view at the newest edge follows them |
| `setOptions(patch)` / `setType(type)` | Change options |
| `fitContent()` | Show all the data |
| `setHiddenRanges([{ from, to }])` | Leave out these times (the user makes them with Ctrl-drag) |
| `setStatus([{ key, value, title?, color? }])` | Small labels at the top left (red unless `color`); `null` clears them |
| `batch(fn)` | Several synchronous changes, drawn once |
| `on(name, fn)` | `'data'` and `'settings'` (`fn(getState())`), `'range'` (`{ from, to }` shown), `'hover'` (`{ time, value, point }`), `'hiddenRanges'` (`[{ tStart, tEnd }]`). Returns an unsubscribe function |
| `getState()` | `{ type, pointCount, range, hiddenRanges, destroyed, … }` |
| `timeToCoordinate(t)`, `priceToCoordinate(v)`, `coordinateToTime(x)`, `coordinateToPrice(y)` | Convert between data and pixels in the chart |
| `destroy()` | Remove it and give the element back as it was |

```js
import atmos from 'atmos-sdk';

const charting = await import(await atmos.library('service:charting', 'api.js'));

document.body.innerHTML = '<div id="chart" style="position: fixed; inset: 0"></div>';

const response = await atmos.fetch('https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.1&hourly=temperature_2m&timeformat=unixtime',
  { signal: atmos.lifecycle.signal });   // declare api.open-meteo.com in permissions.network
const { hourly } = await response.json();

const chart = charting.createTimeSeriesChart(document.getElementById('chart'), {
  type: 'line',
  indicator: null,                  // no trading overlay
  showPriceAxis: true,
  showTimeAxis: true,
  showPointCount: false,
  formatValue: value => `${value.toFixed(1)} °C`,
  formatTime: time => new Date(time).toLocaleString([], { weekday: 'short', hour: '2-digit' }),
  signal: atmos.lifecycle.signal,   // destroyed as the frame goes
  data: hourly.time.map((seconds, i) => ({ time: seconds * 1000, value: hourly.temperature_2m[i] })),
});
chart.fitContent();                 // the whole week, not only the newest hours
```

- **Give it a sized element.** The chart fills it (at least 80 px high) and
  follows its size. It replaces the element's children and paints its
  background `rgba(var(--surface-rgb), backgroundOpacity)`, opaque unless you
  `setChartSettings({ backgroundOpacity: 0 })`; `destroy()` restores both.
- **A new chart shows the newest points** at a readable density (about one
  point per 3 px, one candle per 6 px); double-click returns to that view.
  Call `fitContent()` to show them all.
- **Candle colours must be plain colours:** candles are painted on a canvas,
  which can't read `var(--…)`. Read Atmos's `--color-positive` and
  `--color-negative` with `getComputedStyle(document.documentElement)`, and
  again on `atmos.appearance.onChange`.
- **Shared settings are per frame.** `smoothing`, `lineOpacity`,
  `candleAnimation` and `showCurrentPriceLine` given to one chart last until
  the next `setChartSettings()`. Other frames read saved settings once, when
  they call `configureChartStorage()`, and don't see later changes.
- **With a `stateKey`, what was saved wins** over the options you pass.
- **Input.** Wheel zooms, drag pans, Ctrl-drag hides a range (Ctrl-double-click
  brings them back), Shift-drag measures (its change always shows a `$`).
- More (strips under the plot with `panes`, your own toolbar element,
  `surface`) is in `services/charting/README.md`.

#### Currency

Exchange rates, and conversion between currencies through GBP. It keeps no
state beyond the rates it holds in memory.

```json
"dependencies": { "currency": "^1.0.0" },
"permissions": { "network": ["cdn.moneyconvert.net"], "invokes": ["service:currency"] }
```

It fetches `https://cdn.moneyconvert.net/api/latest.json` from your frame,
hence the host. Import `rates.js` and `converter.js`:

| Call | What it does |
|---|---|
| `startRatesPolling()` / `stopRatesPolling()` (`rates.js`) | Fetch the rates now and every 5 minutes (calling it again restarts the timer); stop |
| `ratesReady()` | `true` once rates have arrived |
| `getRates()` | `{ USD: 1.27, EUR: 1.17, … }`: units of each currency per 1 GBP, for every currency the source lists |
| `onRatesUpdate(fn)` | `fn()` after every successful fetch or `useRates()`. Returns an unsubscribe function |
| `useRates(rates)` | Use rates another frame got from `getRates()`, instead of fetching |
| `convertToGbp(amount, currency)` (`converter.js`) | `amount` in `currency` (an ISO code such as `'EUR'`, or a symbol) into GBP |
| `convertFromGbp(amount, currency = 'GBP')` | GBP into `currency` |
| `symbolForIso(iso)` / `isoFromSymbol(symbol)` | `'EUR'` ↔ `'€'` for `£ $ € Fr C$ A$` (`$` is USD); anything else comes back unchanged |
| `OUTPUT_CURRENCIES` / `isOutputCurrency(iso)` | `[{ iso, label }]` for GBP, USD, EUR and CHF, for a currency picker |

```js
import atmos from 'atmos-sdk';

const rates = await import(await atmos.library('service:currency', 'rates.js'));
const { convertToGbp, convertFromGbp, symbolForIso } =
  await import(await atmos.library('service:currency', 'converter.js'));

const price = document.body.appendChild(document.createElement('p'));

function render() {
  if (!rates.ratesReady()) { price.textContent = 'Waiting for exchange rates…'; return; }
  const dollars = convertFromGbp(convertToGbp(19.99, 'EUR'), 'USD');
  price.textContent = `€19.99 is about ${symbolForIso('USD')}${dollars.toFixed(2)}`;
}

atmos.lifecycle.onCleanup(rates.onRatesUpdate(render));
atmos.lifecycle.onCleanup(rates.stopRatesPolling);
rates.startRatesPolling();
render();
```

- **Until rates arrive, and for a currency they don't list, conversions
  return the amount unchanged.** Check `ratesReady()` before showing a
  converted figure. `convertToGbp` returns `0` for `0` or a non-number.
- **Nothing is saved, and each frame polls on its own.** With several frames,
  poll only in `boot.js`: `expose()` a method returning `getRates()` and
  `emit()` an event from `onRatesUpdate`. Views pass what
  `atmos.call('plugin:<your id>', …)` or the event gives them to `useRates()`
  (section 4, "Keeping work alive").
- **A failed fetch only logs a console warning** and keeps the last good
  rates. There is no error callback, and an undeclared host fails the same way.

#### Fullscreen Viewer

Shows images and videos one at a time in an element you give it: the wheel
steps through them and Shift+wheel zooms towards the pointer. It knows
nothing about where the items come from.

```json
"dependencies": { "fullscreen-viewer": "^1.0.0" },
"permissions": { "invokes": ["service:fullscreen-viewer"] }
```

Media loads under your frame's rules: your own files, `blob:` and `data:`
URLs, and hosts in your `permissions.network`. Import `index.js`.

| Call | What it does |
|---|---|
| `createFullscreenViewer(element, options)` | A viewer that puts one `<img>` or `<video>` in `element` and listens for the wheel there. `options`: `wheelCooldownMs` (the least time between steps), `zoomMin`, `zoomMax`, `zoomSensitivity`, and optional `onOpen(item)`, `onNavigate(item)`, `onClose()` |
| `viewer.open(items, startId)` | Show `items` (`[{ id, url, kind: 'image' \| 'video', alt? }]`) from the one whose `id` is `startId`, at 1× zoom. Call again if the list changes |
| `viewer.close()` / `isOpen()` / `current()` / `destroy()` | Forget the items and call `onClose`; whether it's open; the item shown, or `null`; remove its wheel listener |
| `findMedia(root)`, `applyZoom(media, wheelEvent, zoom, { zoomMin, zoomMax, zoomSensitivity })` | Zoom only, for your own navigation: the `<img>`/`<video>` under `root`, and one zoom step that returns the new zoom (you keep it, and set it back to 1 for a new item) |

```css
.viewer { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .9); }
.viewer[hidden] { display: none; }
.viewer img, .viewer video { max-width: 100%; max-height: 100%; object-fit: contain; }   /* it sets no size */
```

```js
import atmos from 'atmos-sdk';

const { createFullscreenViewer } = await import(await atmos.library('service:fullscreen-viewer', 'index.js'));

const photos = ['harbour', 'hills', 'storm'].map(name =>
  ({ id: name, kind: 'image', alt: name, url: new URL(`./photos/${name}.jpg`, import.meta.url).href }));
const overlay = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'viewer', hidden: true }));

const viewer = createFullscreenViewer(overlay, {
  wheelCooldownMs: 350, zoomMin: 1, zoomMax: 6, zoomSensitivity: 0.0015,   // no defaults: pass all four
  onClose: () => { overlay.hidden = true; overlay.replaceChildren(); },    // it doesn't empty the element
});
atmos.lifecycle.onCleanup(viewer.destroy);

for (const photo of photos) {
  const thumb = document.body.appendChild(Object.assign(document.createElement('img'), { src: photo.url, alt: photo.alt }));
  thumb.addEventListener('click', () => { overlay.hidden = false; viewer.open(photos, photo.id); });
}
overlay.addEventListener('click', event => { if (event.target === overlay) viewer.close(); });
atmos.lifecycle.listen(document, 'keydown', event => {
  if (event.key === 'Escape' && viewer.isOpen()) { event.preventDefault(); viewer.close(); }   // else Atmos gets Escape too
});
```

- **All four numbers are required.** Without them zoom becomes `NaN` and the
  wheel has no cooldown. Matrix Chat uses the values above.
- **It draws no chrome.** The backdrop, a close button, Escape, keys and
  captions are yours. The wheel stops at the first and last item; Ctrl+wheel
  is ignored.
- **It covers only its element**, and a frame can't draw outside its
  surface, so in a sidebar widget "full screen" is the widget.
- **`close()` leaves the last image or video in the element** (a video keeps
  playing): hide or empty it in `onClose`. Videos start muted and playing,
  with controls.
- **`startId` must be one of the ids**, or nothing is shown.

## 6. Main-process code (`main.cjs`)

**Official extensions only.** Use it only for what a frame can't do: files,
native integration, streaming resources, or privileged network work.

```js
module.exports = async context => {
  context.handle('read:value', async (_event, key) => readValue(key));

  context.registerResourceProvider('example-art', async ({ pathname }) => {
    const bytes = await loadArt(pathname);
    return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
  });
};
```

**Starting.** Atmos waits for the returned promise before it starts the
next extension, so register handlers and return; start slow work
(connections, scans) without awaiting it. An `activate()` that throws, or
hasn't finished after **10 seconds**, fails the extension for the session:
what it registered is withdrawn, whatever requires it is skipped ("Needs X,
which failed to start"), the rest of Atmos starts, and Settings → Extensions
lists it under Needs attention. It's tried again at the next start.
Unpackaged, `--activation-timeout=<ms>` changes the limit. Atmos never runs
a community extension's `main.cjs`.

**Reaching it.** The extension's frames use the SDK:

```js
const value = await atmos.invoke('plugin:example-plugin', 'read:value', 'key');
const unsubscribe = atmos.listen('plugin:example-plugin', 'changed', payload => render(payload));
const imageUrl = 'atmos-resource://example-art/covers/1.png';   // <img src>, fetch()
```

Other extensions reach only the handlers and events it shares (`exports`,
section 7), and every call arrives stamped with the extension making it. Its
resource providers serve its own frames only.

**Which frame called.** Every call comes through the Atmos page, so a
handler's `event.sender` is the page, whichever frame asked, and it outlives
them all. `event.callerFrame` is the frame: `{ id, isDestroyed() }`, and
`once('destroyed', fn)` / `removeListener` for when it goes (closed, or its
extension stopped). Keep what a frame started (a subscription, a stream)
with it, and end it there. `send(event.sender, …)` still delivers events;
they reach every frame listening, so say whose they are.

**The context** gives, each only when `extension.json` declares it:

| Member | Declared with |
|---|---|
| `id`, `kind`, `root` (its folder), its normalised `permissions` | — |
| The Electron objects Atmos hands out: `app`, `BrowserWindow`, `dialog`, `shell` (never `ipcMain` or `protocol`) | `permissions.electron` |
| `handle(name, handler)` and `send(webContents, name, ...args)`, for IPC scoped to the extension | `"ipc": true` |
| `registerResourceProvider(name, handler)`, for `atmos-resource://<name>/…` | `permissions.resources` |
| `provide(name)`: does nothing now, kept so packages from before SDK 1.0 load | `permissions.provides` |

Anything undeclared throws `… is not permitted to …; declare it in
extension.json "permissions"`. IPC names are validated, handlers can't
overwrite another extension's, and provider names must be unique.

`main.cjs` runs with full Node.js access, so these checks catch mistakes;
they don't contain hostile code. Keep privileged work in narrow handlers,
validate what frames send, and don't expose raw file or shell access when a
smaller operation will do.

## 7. Permissions and security

### The permissions block

Every extension lists what it uses:

```json
{
  "permissions": {
    "network":   ["api.example.com", "*.example.org"],
    "browser":   ["geolocation"],
    "invokes":   ["service:location", "service:example-service"],
    "node":      ["fs", "path"],
    "electron":  ["dialog", "shell"],
    "ipc":       true,
    "resources": ["example-art"]
  }
}
```

| Key | Meaning |
|---|---|
| `network` | Hosts it contacts: its frames (`fetch()`, WebSockets, images, media) and `atmos.fetch()`. Each entry is a public host name (`"api.example.com"`), `"*.example.com"` for its subdomains (not `example.com` itself), or `"*"` for any public host. No schemes, ports, paths, IP addresses or local names (`.localhost`, `.local`, `.lan`, `.internal`, `.home.arpa`): a manifest with one is invalid |
| `browser` | `geolocation`, `clipboard-read`, `notifications`, `media` (camera and microphone), `display-capture`, and `wasm` (not a browser permission: lets its frames compile WebAssembly). Writing the clipboard, fullscreen and audio autoplay need nothing |
| `invokes` | Other extensions it talks to, as `plugin:<id>` or `service:<id>`: the system services (`service:audio`, `service:wallpaper`), Atmos's calls through official services (`service:location`, `service:now-playing`), libraries it imports, and whatever other extensions share with it. Declaring one isn't enough on its own: the other extension decides what it shares |
| `node` | Official only: modules `main.cjs` (and the `.cjs` files it loads) `require()`, including `electron` and npm packages |
| `electron` | Official only: Electron APIs used from the main process |
| `ipc` | Official only: `main.cjs` registers IPC handlers or sends events |
| `resources` | Official only: `atmos-resource://` providers it registers |
| `web` | Official only (Atmos 0.17): `true` to show web pages in its panel through `atmos.web` (section 4, "Official extensions only"), in a browsing session of its own. Atmos Browser is the one extension with it |
| `provides` | Accepted so older packages load; means nothing now (section 10) |

Omitted keys mean none; `"permissions": {}` is a valid declaration of no
special permissions. Unknown keys and malformed values make the block
invalid, and the extension doesn't load.

### Approval (community extensions)

A community extension doesn't load until the user approves it in Settings →
Plugins (or Services). The prompt lists its permissions in plain words
("Connect to api.open-meteo.com", "Know your location, as set in Atmos",
"Show system notifications"), naming every host, says what it can use of
other extensions, and what the sandbox does and doesn't cover.

Until then nothing of it shows, so Atmos says it's waiting: the footer's
Extensions button turns the negative colour ("Weather needs your
approval"), and Settings → Extensions lists it under **Waiting for your
approval**, where Review opens its card. Approving loads it at once, with
nothing to restart: its panel, widgets and settings page appear and its
background frame starts, along with any community extension that was
approved earlier but needed this one. (It waits for the next start when it
can't load now: switched off, or a dependency that isn't loading.)

Approval records a fingerprint of every file (the manifest included) and
the permissions shown. After any change the extension stops loading until
it's approved again. What it now asks for beyond what was approved is
compared as data, so an added host shows by name, marked **new**, even when
the summary line reads the same. Approvals are kept in
`extension-approvals.json` in Atmos's user data.

A developer folder (`--dev-extension`) loads without approval: starting
Atmos with it is the consent. Everything else about it is community.

A community extension can't have a `main.cjs`, main-process permissions
(`node`, `electron`, `ipc`, `provides`, `resources`) or `web`: Atmos blocks
it, and it can't be approved.

### Sharing with other extensions (`exports`)

What an extension offers others is private until its manifest shares it:
the IPC handlers its `main.cjs` registers, the events it sends
(`context.send()` in `main.cjs`, `atmos.events.emit()` in frames), and the
methods its background frame `expose()`s.

```json
{
  "exports": {
    "ipc":     { "subscribe": "official", "read-tags": "all" },
    "events":  { "event": "official" },
    "methods": {
      "greet":   "all",
      "palette": { "with": "all", "description": "The sky's colours now, without your location" }
    }
  }
}
```

- `"official"` shares it with system and official extensions; `"all"` with
  community extensions too.
- **Atmos 0.16:** a name may instead be `{ "with": "official" | "all",
  "description": "…" }`: what it gives, in plain words (at most 200
  characters). Only Settings uses it; Atmos 0.15 refuses the block, so an
  extension that uses it needs `"engines": { "atmos": ">=0.16.0" }`.
- What isn't listed stays the extension's own: its own frames and
  `main.cjs` reach it as before.
- Another extension reaches a shared name only if it also declares the
  owner in `permissions.invokes`.
- A manifest with **no** `"exports"` block shares everything with system
  and official extensions that declare it, and nothing with community ones
  (so that packages from before 0.12 kept working). Add a block, even
  `{}`, to keep things private. Every bundled extension with a `main.cjs` or
  a background frame has one (`npm run test:permissions` checks it).
- Libraries' modules and the system services' calls aren't affected: a
  library runs with the consumer's own permissions.

Atmos checks sharing twice: the frame's bridge refuses anything not shared
with the caller's tier, and every IPC call reaches the main process stamped
with the calling extension, where the handler runs only if it shares that
name with it. Share only handlers that are safe for any caller of that
tier: one that reads any path, fetches any URL or returns a secret should
stay private, or go to official extensions only when they need it.

**What you share can pass on what you were allowed.** Sharing is checked
against the target's `exports`, not against what the caller could reach
itself: an extension that may read the location and shares a method with
`"all"` hands whatever that method returns to extensions the user never
allowed to know the location. So share with every extension only what's
safe for any of them, and say what it gives. Settings shows the user:

- on the extension's own card and in its approval prompt, **Shares with
  other extensions**: each name, with whom, and its description ("Any
  extension can call palette(): The sky's colours now, without your
  location");
- on a caller's card, what it may use of each extension it declares, with
  the same descriptions;
- a warning, on the card and in the prompt, when an extension can reach
  something sensitive (the location, the camera or microphone, the
  clipboard, the screen) and shares anything with every extension: "It can
  know your location, and shares palette() with any extension, so what it
  shares could pass that on."


### What is enforced

- **Frames.** No access to the Atmos page, other extensions or Electron;
  network limited to declared hosts by each frame's Content-Security-Policy;
  every SDK call checked against the manifest; only files really inside
  the extension's folder served.
- **`atmos.fetch()`.** Made by the main process under the rules in section
  4, against the permissions Atmos holds for the extension, never what a
  frame claims.
- **Browser permissions.** Each origin gets only what its extensions
  declare: the Atmos page, what the system services and official libraries
  declare; each frame origin, what its extension declares (the shared
  official origin, what all of them declare). Everything else is denied.
- **Navigation.** The Atmos window's own page never leaves
  `atmos-app://local/`. Links and `window.open()` to `http(s)` and `mailto`,
  from it and from frames, open in the default browser, or an `http(s)`
  link in Atmos Browser instead while "Open links in Atmos Browser" is on
  (by default from Atmos 0.18): in front just after a click in Atmos,
  otherwise in a tab behind; other schemes are refused. Official frames'
  pop-ups go the same way (their sandbox allows them only so they reach
  this handler, which never opens a window). Community frames have no
  `allow-popups` at all: the SDK sends their link clicks and `window.open()`
  to Atmos (`links.open`), which opens one after a click or key in that
  frame and otherwise asks, Don't open being the default
  (`core/js/core/extension-links.cjs`). A frame navigates only within its origin and can't make
  a `<webview>`: the only ones in the window are Core's, for web pages (next
  item).
- **Web pages** (Atmos 0.17). Only Core's web layer, in the Atmos page,
  attaches a `<webview>`: in the browser's own sessions
  (`persist:atmos-browser`, and an in-memory one for private tabs), starting
  blank, with preferences Atmos fixes whatever the element asks (sandboxed,
  context-isolated, web security on, no Node, and no preload but Core's
  own: it gives `window.chrome` the members Chrome has, and asks Core, over
  two channels answered only for the page's own address, for the ad
  blocker's styles and scriptlets; the page's own scripts can't reach it). Those sessions
  have none of Atmos's schemes, storage or cookies. The main process applies
  the browser's policy (`core/js/core/web-policy.cjs`, unit-tested) to every
  page: `http(s)` and `about:blank` only, never Atmos's schemes, `file:`,
  `chrome:` or `devtools:`; other schemes (`mailto:`…) only after the user
  says yes; a new tab or window only just after a click in the page, one
  each, and a pop-up with an opener (a sign-in window) in a small window of
  its own, never fullscreen; camera, microphone, location, notifications and
  reading the clipboard only for sites the user allowed (a frame asks as
  the page it's in), everything else refused; no way past a certificate
  error, and no client certificate sent; safe download names, one download
  on its own per page and one per click, and only documents and media
  opened from Atmos. A site's icon is decoded in a sandboxed page of its own and
  drawn again by Core, so nothing a site sends is decoded in the
  extension's frames; a page in fullscreen is named over it ("Press Esc to
  exit"). Ads and trackers are blocked in the main process
  (`web-adblock.cjs`: uBlock Origin's lists, EasyList and EasyPrivacy in
  Ghostery's engine); the scriptlets it runs in pages ship with Atmos, and
  lists that aren't uBlock Origin's own can't use the ones that need trust.
  Only an official extension declaring `"web"` drives pages, through
  `atmos.web`, and nothing in it loosens the policy.
- **Sharing.** Other extensions' handlers, events and methods only as far as
  they share them, checked again in the main process for IPC.
- **Approval.** Community extensions load only once approved, and again
  after any change (above).
- **Signed packages.** An installed extension signed by an official key
  loads as official only while every file matches its signature. One
  changed, added or removed file, or a broken signature, stops it loading
  (it shows as modified, and is never demoted to community).
- **Main-process code.** Only system and official extensions have any.
  The context hands out only what's declared (section 6).
- **The Atmos page.** It holds the bridges and checks every SDK call, and
  runs only Atmos's own files: its Content-Security-Policy allows no inline
  script (only the import map, by its hash) and no `eval`, and it reaches
  only the hosts the system services declare. The window is sandboxed,
  developer tools open only from source or with `--devtools`, and the main
  process takes settings changes (approving, switching, installing) only
  from the page.
- **Bundled integrity.** A build that bundles extensions (none does now;
  see `scripts/after-pack.cjs`) writes `resources/extensions/integrity.json`
  with a hash of every bundled file, and Atmos doesn't load one whose files
  changed. From source there's no list, and bundled extensions show as
  unverified. The system services are part of Atmos's own files.

### What is audited, not enforced

`npm run test:permissions` scans every bundled extension's code with
`scripts/extension-audit.cjs` and fails when it uses a Node module, Electron
API, IPC, resource provider, browser permission, network host or other
extension that its manifest doesn't declare, or declares one it no longer
uses. It skips folders Atmos never runs (tests, tools, companion apps,
`vendor/` for browser APIs) and any in `"auditExclude"`. To see what an
extension uses:

```bash
node scripts/extension-audit.cjs plugins/audio-player
```

A `require()` in `main.cjs` can't be blocked in-process, so for main-process
code the declarations are checked by this audit rather than enforced. In
frames, `network`, `browser` and `invokes` are enforced.

### Signed packages

An official extension is installed as a signed `.atmos` package (a zip of
its folder). Its `signature.json` holds its kind, id, `version`,
`publisher` and the SHA-256 of every other file, signed with Ed25519
(`core/js/core/extension-signing.cjs`). Atmos trusts the public keys in
`core/trusted-keys.json`; each is official, belongs to one publisher, and can
be marked `"revoked"`. A signature from any other key never makes an
extension official; a community author's own signature is shown as
**Signed** (below, "Publishing from GitHub").

```bash
npm run keys:create -- <file outside the repo>   # a new key, encrypted with a passphrase; added to core/trusted-keys.json
npm run keys:show -- <file>                       # its id, and whether Atmos trusts it
npm run pack:extensions -- --key <file>          # the released extensions → dist/packages/<id>-<version>.atmos
npm run pack:extensions -- --key <file> finance --out <dir>
```

`pack:extensions` copies what an installer would bundle (the filters in
`package.json` `build.extraResources`), signs the copy, checks it against
`core/trusted-keys.json` and zips it; `--from <folder>` packs another tree,
such as the export for the public repository. It writes each package's
kind, id, version, `engines`, dependencies, size and hash into a signed
`index.json`. `--key` defaults to `ATMOS_SIGNING_KEY`, and the passphrase is
asked for (or read from `ATMOS_SIGNING_PASSPHRASE`). It stops if the key
isn't official, if an extension has uncommitted changes (`--allow-dirty`),
or if one changed without a higher `version` than the official source has
(`--previous <folder or url>` compares with another; `--same-version`
overrides). The key file stays outside the repository (the scripts refuse
one inside it). To replace a key, add the new one, mark the old one revoked
and ship an Atmos update; keep a backup of the key file.

A bundled extension is checked against `integrity.json` when the build has
one, and otherwise against its own `signature.json` if it has one.

### Installing, updating and removing (Settings → Extensions)

`core/js/core/extension-manager.cjs` installs official packages from
**sources**: a folder or `https://` address holding `index.json` and the
`.atmos` files it lists (what `pack:extensions` writes to `--out`). The index
is signed with an official key, so the host needn't be trusted. Sources are
the official one in `core/extension-sources.json` (the public repository's
latest GitHub release), the packages a personal build carries ("Comes with
Atmos"), and ones added on the Extensions page (`extension-sources.json` in
user data). Unpackaged, `--extension-source=<folder or url>` (or
`ATMOS_EXTENSION_SOURCE`) adds one for the session.

- **Checking** reads the indexes only: soon after start, every 12 hours, or
  with Check for updates. Nothing downloads until Install or Update.
  Packages this Atmos can't run (`engines`, `apiVersion`) aren't offered.
  An index older than one already seen from the same source (its signed
  `generated` time, in `extension-index-seen.json`) is refused, so whoever
  controls a source can't bring back an old, genuinely signed index that
  hides updates. Publishing therefore always means a newer index; never
  mark an older release "latest" again.
- **"Atmos X is available."** The index also carries the Atmos version of
  the tree that was packed and its Windows installer (`"core": { "version",
  "installer": { file, size, sha256, platform, arch } }`). An installed
  Atmos on Windows (0.19 and later) downloads that installer from the same
  source, checks its size and hash against the signed index, and installs
  it when you quit or from "Restart to update"
  (`core/js/core/atmos-update.cjs`; "Update Atmos automatically" at the top
  of this page). Any other copy says a version is available, with a
  Download button that opens Atmos's own setting (`"download"` in
  `core/extension-sources.json`), never an address from the index.
- **Install / Update** downloads the package and any missing or too-old
  required dependency (never more bytes than the index's size), checks size
  and hash against the index, unpacks it safely, checks every file against
  an official signature, and stages it (`extension-staging/`, recorded in
  `extension-pending.json`). Nothing running changes.
- **Remove** is for what's in the installed folder (a bundled extension is
  switched off instead; removing an update of one goes back to the bundled
  version). It asks every time whether to keep the extension's settings and
  data (the default) or delete them, and is refused while another extension
  requires it (unless a copy bundled with Atmos stays).
- **At the next start**, before anything is listed, pending changes apply:
  staged packages move into the installed folder, removed ones are deleted.
  The version an update replaced is kept in `extension-previous/` and loads
  instead if the new one can't; it's deleted once the new one has run a
  whole session. An official update that loads but doesn't start (its
  `main.cjs` fails, Atmos stops while it starts, or one of its frames'
  entry file fails to load in its first session) runs the version before
  from the next start, and Settings says so; Update tries it again,
  keeping the version before.
  Deleting data removes the extension's state file, a `userData/<id>`
  folder, and its own origin's storage: the IndexedDB and localStorage its
  frames used (from Atmos 0.17; before, they stayed) and, for Atmos
  Browser, its browsing session and site settings. Data an official
  extension without `"isolation"` keeps in the shared origin stays, since
  Atmos can't tell whose it is.
- The footer's **Extensions** button (left of Settings) opens the page, and
  turns the negative colour, with a tooltip saying why, when an update is
  available, a change waits for a restart, or an extension failed to load.

For development and the end-to-end checks, an unpackaged Atmos also trusts
the keys in `--trusted-keys=<file>` (or `ATMOS_TRUSTED_KEYS`); a packaged one
trusts only its own list.

### Publishing from GitHub (community extensions)

A community extension is published as a GitHub release of its own
repository, and installed, updated and removed from Settings → Extensions
like an official one, with community rules:

```bash
npm run pack                          # in your extension: dist/<id>-<version>.atmos and dist/index.json, unsigned
npm run pack -- --new-key ../my.pem   # the first time you sign: makes a key outside the folder, signs with it
npm run pack -- --key ../my.pem       # every version after
```

`pack.cjs` (in `.atmos-sdk/`, from `npm run new:extension`; MIT) zips the
folder without dot files, `node_modules`, `tests`, `package.json`,
`package-lock.json`, `jsconfig.json` and `dist`, and writes an `index.json`
naming the package's size and SHA-256. The id is `package.json`'s `"name"`
(or the folder's; `--id` to choose), `--kind service` packs a service. It
refuses `"publisher": "atmos"` and a `main.cjs`. Attach both files to a
release; the latest release is the one Atmos reads.

- **Adding it.** `github.com/owner/repo`, `github:owner/repo` or any
  github.com address of the repository (case doesn't matter), on the
  sources page. Its card says
  Community and how many packages it has; ids it can't use are listed
  there ("Not offered: …").
- **Before anything is staged**, the package is checked as the index says
  (size, SHA-256) and then refused if it could never be approved
  (`main.cjs`, main-process or `web` permissions), if its author's
  signature doesn't match its files, if it is signed with an official key
  or says `"publisher": "atmos"`, or if it carries a dot file, `Thumbs.db`
  or `desktop.ini` (files neither a signature nor an approval covers). An
  id an official source lists (or listed last time it was read), an
  official copy has, or Atmos ships with is never taken from a repository,
  whatever the kind, and neither is an id another installed extension has; the first install binds the
  id to its repository (`extension-community.json` in user data), and the
  same id from another repository is refused until it's removed.
- **After the restart** it waits for approval, like any community
  extension; its card says where it's from and **Signed** or **Unsigned**.
  **Every update asks again**: an update is a change to its files.
- **Signing** is optional and grants nothing. `signature.json` carries the
  public key (`"publicKey"`), so Atmos checks that the files are exactly
  what that key signed, shows the key's id, and says so when a version is
  signed with a different key than the one before it, or no longer signed
  ("the repository may have changed hands"); the key is remembered across
  unsigned versions. Sign every version with the
  same key, keep it out of the repository, and keep a copy: a lost key
  looks like a new author. `ATMOS_SIGNING_PASSPHRASE` encrypts a new key or
  reads an encrypted one.
- An official package with the same id replaces a community copy and
  frees the id. A repository's index needn't be signed.

Unpackaged, `--github-releases=<folder>` serves repositories' latest
releases from `<folder>/<owner>/<repo>/` (the end-to-end check uses it).

### Limits

- Frames contain an extension's access, not its resource use: a frame can
  still use a lot of CPU or memory, and what it shows inside its own panel
  is up to it (including a convincing form).
- `main.cjs` (official only) runs with full Node.js access; the context
  checks catch mistakes, not hostile code.
- Nothing stops someone who can write Atmos's own files (`core/`, including
  `trusted-keys.json`) in an installed copy. That needs a signed,
  asar-packed app with Electron's integrity fuses. Signed packages are only
  as trustworthy as the copy of Atmos checking them.

## 8. Tools: typings, tests, licensing

### Typings and the manifest schema

`.atmos-sdk/` in a new extension holds, from the Atmos it was made with:

- `atmos-sdk.d.ts`: types for the whole SDK, with the stable, experimental
  and official-only parts marked. `jsconfig.json` points `atmos-sdk` at it,
  so an editor checks and completes calls.
- `extension.schema.json`: the manifest's schema (`"$schema"` in
  `extension.json`).
- `testing/`: the fake Atmos for tests.

They're copies of `core/js/sdk/` in the Atmos repository, all MIT. Refresh
them from a newer Atmos with `npm run new:extension -- <your folder>
--update-sdk`. Atmos never serves a dot-folder to a frame.

### Tests with a fake Atmos

`npm test` in the extension runs `node --import
./.atmos-sdk/testing/register.mjs --test`. The import makes `import atmos
from 'atmos-sdk'` give a fake that keeps everything in memory, has the SDK's
calls and refuses what Atmos would (an undeclared host, target, system
service or notification), with what Atmos gives: the same audio state and
wallpaper summary, the same errors.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAtmos } from '../.atmos-sdk/testing/fake-atmos.mjs';

test('shows the stars', async () => {
  const atmos = installFakeAtmos({
    permissions: { network: ['api.github.com'] },
    fetch: { 'https://api.github.com/repos/o/r': { json: { stargazers_count: 42 } } },
  });
  const { loadStars } = await import('../src/stars.js');   // imports 'atmos-sdk'
  assert.equal(await loadStars(), 42);
  assert.equal(atmos.fake.requests.length, 1);
});
```

`installFakeAtmos(options)` makes the fake the one `atmos-sdk` gives, and
returns it (`createFakeAtmos` only makes one). Its options:

| Option | |
|---|---|
| `extension`, `surface` | What `atmos.extension` and `atmos.surface` say |
| `permissions` | As in `extension.json`: `network`, `invokes`, `browser` |
| `state` | The saved state to start from |
| `fetch` | Answers for `atmos.fetch()`: `{ 'https://…': answer }` (or `'POST https://…'`), or `request => answer`. An answer is a `Response`, `{ status, headers, json \| text \| body }`, or an `Error` to throw |
| `location`, `appearance` | What `atmos.location` and `atmos.appearance` give |
| `wallpaper` | The wallpaper `atmos.wallpaper.get()` starts from (`{ mode, opacity, thumbnail }`), or `null` |

`atmos.fake` lets a test see and steer what happens:

| | |
|---|---|
| `state`, `emitted`, `requests`, `menus`, `notifications`, `clipboard`, `panelShown`, `exposed`, `headerMenu`, `glass` | What the code did |
| `wallpaper` | The last image `atmos.wallpaper.set()` was given (`null` after `restore()`) |
| `audio.loads`, `audio.state` | What `atmos.audio.load()` was given (`[{ source, id, position, play, loop }]`), and the channel's state now |
| `audio.update(patch, type)`, `audio.end()` | Playback from outside: change the state and tell `onChange` listeners (`audio.update({ currentTime: 12 })`); the source reaching its end (`'ended'`, or starting over with `loop`) |
| `setState(next)`, `emit(name, payload)`, `setLocation(next)`, `setWallpaper(summary)`, `send(target, channel, ...args)` | Changes from outside, as another frame, the user or a `main.cjs` would make them |
| `chooseFromMenu(choice)` | What the next `contextMenu.open()` picks (an id, `{ id, value }`, or `null`); its `run` is called |
| `handle(target, channel, fn)`, `exposeFor(target, methods)` | Stand-ins for another extension's `invoke()` handlers and `call()` methods |
| `unload()` | The frame goes: `atmos.lifecycle` cleanups run and its signal aborts |

The fake is checked against Atmos itself: one script of SDK calls
(`scripts/sdk-contract/contract.js` in the Atmos repository) runs against
the fake in Atmos's unit tests and against a real Atmos in its end-to-end
checks, and both must give the same report. A difference between them is
a bug in Atmos, not in your extension.

### Licensing your extension

Atmos is licensed under the GPLv3 with the Atmos Extension Exception
(`LICENSE-EXCEPTION.md`). An extension that is your own code and works with
Atmos only through the extension interface (the SDK, `extension.json`, and
the plugins and services it reaches through the SDK) can be licensed however
you like, including closed and paid. The SDK itself (`core/js/sdk/`,
including the typings, schema and test kit) is MIT, so copying or bundling
it is fine. What stays under the GPLv3: Atmos and modified versions of it,
code copied from Atmos (other than the SDK and documentation examples), and
an extension that reaches into Atmos's internal modules instead of the SDK.

## 9. Checklist

Before sharing an extension:

1. One stable id (lowercase letters, numbers, hyphens), which is also its
   folder's name.
2. An `extension.json` with `apiVersion: 4`, `engines.atmos`, `version`,
   `permissions` and, for anything it offers others, `exports` (with a
   `description` for each name shared with every extension).
3. Entry files at the root (or listed in `contributes`), each importing
   `atmos-sdk`; nothing imports Atmos's own modules.
4. State in `atmos.state` (small, JSON, shared by its frames); larger data
   in its origin's IndexedDB.
5. Long-lived work (a socket, a player, a poller) in `boot.js`; panels and
   widgets as views that can be made again at any time.
6. What a view gives something that outlives it cleaned up with
   `atmos.lifecycle`.
7. Its own look, headers and controls inside its own surfaces; the shell is
   Atmos's. A settings page can use Atmos's own rows (`/__atmos/ui.css`).
8. Every permission it uses declared, and nothing it doesn't. For a bundled
   extension, `npm run test:permissions` checks it.
9. `npm test` passing, and tried in every layout (full, tile, window), after
   a restart, and with its optional dependencies switched off.
10. Official extensions: privileged work behind narrow `main.cjs` handlers
    that check their arguments, shared only when they must be.

## 10. Compatibility

**SDK 1.4 (Atmos 0.21).** Only additions; an SDK 1.3 extension runs
unchanged, but for one move: Location is an official service now
(services/location), no longer part of Atmos. `atmos.location` works as
before once it's installed, and `get()` is `null` until it is. An
extension that reads it lists it as a dependency (`"location": "^1.0.0"`)
so it comes along at install. One written before, with only
`"invokes": ["service:location"]`, still brings it: Atmos's update check
installs Location once for an installed extension that invokes it (unless
you removed Location), applied at the next restart. Its Settings section
and Detect are where they were (Appearance), and the location set before
moves to it the first time it starts. Without a reader, nothing installs
it; the location set before waits until it's installed.

- `atmos.nowPlaying` (`set`, `clear`, `onControl`): say what your extension
  plays in Atmos's Now Playing widget and take its controls (section 4,
  "Now Playing"). Needs `"engines": { "atmos": ">=0.21.0" }` and
  `"invokes": ["service:now-playing"]`.
- Now Playing is an official service now, not part of Audio Player: Audio
  Player 1.2 publishes to it and installs it as a recommended dependency.
  The widget keeps its old id, so saved sidebars keep it in place, and,
  having no panel of its own, shows beside every panel (Music's showed
  beside Music only).
- A recommended optional dependency comes with the update that first
  recommends it, as it does with a first install; never one the user
  removed or cancelled, whichever extension recommends it (installing it by
  hand undoes that). What Atmos Browser (built in) recommends comes with
  the first start's choice, or after the Atmos update that first
  recommends it (not after "Just Atmos Browser").
- `atmos.web.media` and the `media` event (official extensions): what plays
  in a page, and its controls. Atmos Browser 1.2.0 shows its tabs in Now
  Playing with them.

**SDK 1.3 (Atmos 0.20).** Only additions; an SDK 1.2 extension runs
unchanged.

- Atmos's command bar (Alt+\\), and `"commands"` in the manifest with
  `atmos.commands` (`handle`, `bar`, `field`, `open`, `refresh`) for an extension's
  own `rev/` commands (section 4, "Commands in Atmos's bar"). An extension
  that uses them needs `"engines": { "atmos": ">=0.20.0" }`.
- `ui.css`'s `.atmos-bar`: a panel's bottom bar as Atmos draws its own.
- Matrix Chat's `rev/` commands moved onto Atmos's bar; Audio Player has
  `rev/play`, `rev/next`, `rev/previous`, `rev/song` and `rev/album`.

**Atmos 0.18 (SDK 1.2, unchanged).** Atmos Browser is built in, and
Atmos opens on it.

- A panel's `"default": true` is a request now: the built-in browser comes
  first, and of two extensions asking, the first keeps it and the other is
  logged (before, the second threw and its panel was lost).
- Links Atmos and its extensions send out open in Atmos Browser by default
  ("Open links in Atmos Browser"), in the system browser when it's off or
  the browser is switched off. Nothing changes for an extension: a link or
  `window.open()` is handed to Atmos as before.

**SDK 1.2 (Atmos 0.17).** Only additions; an SDK 1.1 extension runs
unchanged.

- `atmos.web` and the `"web"` permission, for official extensions: web
  pages in a panel (Atmos Browser), with its ad and tracker blocker
  (`shield`, `blocked`, `adblock`, the `blockAds` option).
- Removing an extension with its data deletes its frames' IndexedDB and
  localStorage too (they used to stay behind).

**SDK 1.1 (Atmos 0.16).** Only additions; an SDK 1.0 extension runs
unchanged.

- `atmos.audio.load(…, { loop: true })`, and `id` and `loop` in the audio
  state (`source` stays, with the same label).
- `atmos.wallpaper.restore()` and `canRestore`: Atmos keeps the wallpaper
  an extension replaced.
- Exports with a `description` (`{ "with", "description" }`), shown in
  Settings.
- `/__atmos/ui.css`: Atmos's Settings rows and controls for frames.
- Widgets and settings pages are sized to their content even with a
  `height: 100%` reset (0 px before), and warn in their console when they
  measure 0 px.
- A panel key two panels ask for goes to one (official first, then start
  order); Settings → Panels lists the keys.
- A community extension approved while Atmos runs loads at once, and one
  waiting for approval shows in the footer and on Settings → Extensions.
- The test kit refuses undeclared audio and wallpaper calls, reports the
  audio state Atmos reports, and lets a test drive playback
  (`atmos.fake.audio`).

**SDK 1.0 (Atmos 0.15).**

- New: `atmos.fetch()`, `atmos.location`, `atmos.lifecycle`, `engines.atmos`,
  `apiVersion: 4`, `extension.version`, developer folders, the typings,
  schema and test kit, and the extension template.
- `SDK_VERSION` is now the string `'1.0.0'` (it was the number `3`).
- `permissions.network` entries must be public host names (section 7). Any
  other string used to be accepted.
- Drawers and boot keys are official-only now, as were `background()` and
  `atmos.legacy.*`. A community drawer panel becomes an ordinary panel.
- `supersedesServices` counts only from official plugins.
- Removed, since nothing used them:
  - file drops (`"fileDrops"`, `atmos.surface.onFileDrag` and
    `onFileDrop`);
  - sharing resource providers with other extensions (`exports.resources`);
    an extension's providers serve its own frames only;
  - main-process capabilities: `"uses"` is no longer a permission (a
    manifest with it is invalid) and `context.use()` is gone; `"provides"`
    and `context.provide()` are still accepted and do nothing, so older
    packages load;
  - eight capabilities no manifest required: `panel.explicit-default`,
    `panel.pass-through`, `panel.surface-presentation`,
    `appearance.semantic-colors`, `sidebar.resizable-sections`,
    `extensions.after`, `extensions.tiers`, `extensions.permissions`;
  - the `ATMOS_EXTENSIONS_ROOT` and `ATMOS_SEED_PACKAGES` variables (the
    `--extensions-root` and `--seed-packages` flags remain, unpackaged
    only).

**Older manifests.** `requires` lists capabilities with minimum versions
(an array of names means version 1). Atmos doesn't load an extension that
needs one it lacks, and Settings says why. The capabilities Atmos still
has, so older manifests keep loading: `extensions.manifest`,
`events.namespaced`, `lifecycle.context`, `renderer.capabilities`,
`surface.workspace`, `context-menu.contributions`, `state.namespaced`,
`settings.appearance-contributions` and `extensions.frames` (level 3). The
list is in `core/js/core/capabilities.js`, with a copy for the main process
in `core/js/core/extension-host.cjs`. Before SDK 1.0, `extensions.frames`
was the SDK's level: 2 brought `listen`, `readLocalStorage` and panel
shortcuts; 3 (Atmos 0.8.3) brought header menus, `readState`, IndexedDB
`keys`, `legacyId`, `shortcutToggles`, menu ticks, selects, controls and
icons, notifications, wallpaper, audio, drawers, boot keys, `"resizable"`,
`"showIn"`, `"glass"`, button rows, `contextMenu.close`, the clipboard,
`deleteIndexedDB` and `background()`. New extensions use `engines` instead.

**Atmos 0.12 removed the page runtime.** Until then an extension could run
inside the Atmos page, import Atmos's modules (`atmos-core/…`) and register
with its registries (`registerPanelPlugin`, `registerSection`,
`registerStateNamespace`…) from `panel.js`, `sidebar.js`, `settings.js`,
`persist.js` and `boot.js`. Now every extension runs in frames, whatever
`runtime` says, and one written for the page API fails in its frame (rewrite
it on the SDK). `atmos-plugin://` and `atmos-service://` are gone, and the
system services, the only code left in the page, are part of Atmos
(`core/system`). Keep `"runtime": "frame"` in a manifest while Atmos 0.11 or
older might install it: those versions ran official extensions without it
in the page.

**Sharing.** An extension with no `"exports"` block (every package from
before 0.12) shares everything with official extensions and nothing with
community ones (section 7).

**Storage.**
- `atmos.state` lived in the Atmos page's one saved blob until 0.12. The
  first time an extension's state is used under 0.12 or later it is copied
  into the extension's own file, and the blob's copy is forgotten at a later
  start.
- An official package from before 0.12 has no `"isolation"`, so it runs in
  the shared origin, with its data, until it's updated to a version that
  moves out (section 4, "Official extensions only").
- The `atmos.legacy.*` calls remain for extensions still carrying data over
  from the page, and will be removed in a later version.
