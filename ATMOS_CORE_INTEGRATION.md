# Atmos Core integration guide

How extensions (plugins and services) work with Atmos Core. Atmos owns the
workspace shell, discovery, lifecycle, layouts, persistence, permissions and
routing between extensions. Extensions own their behaviour, state, markup,
styling and external integrations.

Every extension runs in sandboxed frames and talks to Atmos only through the
**Atmos SDK** (section 4). An official (first-party) extension may also have
a `main.cjs` for work only Electron's main process can do (section 6). The
system services (Wallpaper, Audio and Location) are part of Core itself.
Security rules are in section 7.

| Section | |
|---|---|
| 1 | Extension types, tiers, where extensions come from |
| 2 | Files and surfaces: panels, sidebar widgets, settings, the boot frame |
| 3 | The manifest (`extension.json`): versions, dependencies, start order |
| 4 | The Atmos SDK |
| 5 | Services and libraries |
| 6 | Main-process code (`main.cjs`) |
| 7 | Permissions and security, signed packages, the extension manager |
| 8 | Checklist |
| 9 | Compatibility |

Until Atmos 0.12, extensions could also run inside the Atmos page itself
and import Core's modules (`atmos-core/…`). That page runtime is gone: see
section 9.

## 1. Extension types

Atmos has two kinds of extension:

- A **plugin** is user-facing. It may contribute a panel, sidebar widgets,
  a settings page and a background (boot) frame, and, if official, a
  `main.cjs`.
- A **service** supplies shared behaviour or data to other extensions: methods
  its boot frame exposes, main-process IPC it shares, or modules they import.
- A **library** is a service marked `"library": true`: code its consumers
  import, with no lifecycle, UI or state of its own. See section 5,
  "Services and libraries".

Use a stable lowercase id containing letters, numbers and hyphens, such as
`audio-player` or `weather-data`. The folder name is the extension id and is
also used for state, events and IPC.

### Where extensions come from, and tiers

Atmos finds extensions in three places:

| Source | Location |
|---|---|
| Part of Atmos | `core/system/<id>`: the system services only |
| Bundled with Atmos | the repo's `plugins/` and `services/` when running from source (`npm start`); an installer bundles none, and offers them as packages on the first start |
| Installed | `%APPDATA%/atmos/{plugins,services}/<id>/` on Windows (`~/Library/Application Support/atmos` on macOS, `~/.config/atmos` on Linux), by Settings → Extensions or by hand |

Where an extension sits does not decide who vouches for it; its signature
does. Settings shows the tier as **System**, **Official** or **Community**:

| Tier | Settings | Which extensions |
|---|---|---|
| `system` | System | In `core/system`: part of Atmos itself (Wallpaper, Audio, Location). Always loaded; can't be disabled. A manifest elsewhere can't claim it. |
| `first-party` | Official | Running from the repo (`npm start`), **or installed with a valid signature from an official key** in `core/trusted-keys.json` (section 7, "Signed packages"). Can be switched off. |
| `third-party` | Community | Installed and not signed by an official key. The `tier` field is ignored, so nothing installed can claim to be system or official. |

**The background layer.** Two system services run behind every panel for the
whole session, in the Atmos page. Extensions reach them through the SDK:

- **Wallpaper** (`core/system/wallpaper`, formerly the Background plugin) paints
  the wallpaper and its effects and owns desktop blending. Frames use
  `atmos.wallpaper` with `"invokes": ["service:wallpaper"]`.
- **Audio** (`core/system/audio`) gives each extension its own playback
  channel (an `<audio>` element keyed by the extension), so sound carries on
  through panel switches, layouts and frame reloads. The extension decides
  what plays; the channel loads, plays, pauses, seeks and reports back.
  Frames use `atmos.audio` with `"invokes": ["service:audio"]`.

If the same id exists in several places: a system service always wins; among
official copies (bundled, or installed and signed) the highest `version` wins,
the bundled one on a tie, and the next one down is kept as a fallback that
loads instead if the winner can't (a damaged update, say; Settings says so);
a community copy never replaces an official one. The ignored copies are
logged. Installs from before the `services` rename used a singular
`service/` folder, which Atmos moves on first launch.

Extensions are loaded at runtime. Adding a third-party extension does not
require rebuilding Atmos, but Atmos must be restarted because discovery is
cached for the session. A third-party extension also needs the user's
approval before it loads, and it cannot have a `main.cjs`; see
[7. Permissions and security](#7-permissions-and-security).

## 2. Files and surfaces

```text
example-plugin/
├── extension.json       # the manifest (section 3)
├── panel.js             # a panel
├── sidebar.js           # a sidebar widget (more with "contributes")
├── settings.js          # a settings page (Settings → Appearance)
├── boot.js              # a background frame for the whole session
├── main.cjs             # official extensions only: main-process code (section 6)
├── src/
│   ├── engine.js
│   └── view.js
└── assets/
    └── icon.svg
```

Every file a frame loads is an ES module served from the extension's own
origin (`atmos-ext://…`); `main.cjs` is CommonJS because it runs in
Electron's main process. Relative imports, `new URL('./x.css',
import.meta.url)`, fonts and images work as on the web. WebAssembly needs
`"wasm"` in `permissions.browser`. Declared network hosts are open to
`fetch()`, WebSockets, images and media, but scripts, stylesheets and fonts
load only from the extension's own files. Folders named `data`, `tests`,
`backups` and `_to_delete`, and anything whose name starts with `.`, are
never served to a frame.

### Surfaces

Core creates a frame for each entry file and registers it with the usual registry, so panels work in
every layout, sidebar widgets can be reordered and hidden, and so on.

| File | Surface | Frame |
|---|---|---|
| `panel.js` | panel | fills the panel surface while the panel is shown |
| `sidebar.js` | sidebar widget | sized to its content |
| `settings.js` | settings | the extension's settings body |
| `boot.js` | background | hidden, runs for the whole session |

Labels, icons and options come from `"contributes"` in `extension.json`
(optional; without it, the files above are used with `displayName`). With
`"contributes"`, only the surfaces it lists are created, so list each one
(`"boot": {}` is enough for `boot.js`):

```json
{
  "apiVersion": 3,
  "displayName": "Weather",
  "permissions": { "network": ["api.open-meteo.com"], "invokes": ["service:plotting"] },
  "contributes": {
    "panel":    { "label": "Weather", "icon": "icon.svg", "default": false },
    "sidebar":  [{ "label": "Forecast", "order": 10, "defaultHeight": 120 },
                 { "id": "alerts", "entry": "alerts-sidebar.js", "label": "Alerts" }],
    "settings": { "label": "Weather" },
    "boot":     { "entry": "boot.js" }
  }
}
```

Panel and sidebar entries may also declare:

- `"shortcut": "#"` (panel only): one printable key that opens the panel from
  anywhere in Atmos, except while typing in a field. Core listens for it, so
  it works whether or not the extension has a frame open. With
  `"shortcutToggles": true` the same key closes it again (back to the
  previous panel).
- `"legacyId": "old-widget-id"` (first-party only): the id the panel or
  widget had before the extension moved into frames, so saved layouts,
  order and visibility still apply to it.
- `"fileDrops": true` (first-party only for now): files dragged from the
  desktop onto this surface arrive with their paths on disk (see
  `atmos.surface.onFileDrop` below).
- `"drawer": { "bar": 54, "keys": true }` (panel only): on the full workspace
  the panel lives in a drawer that slides up from the bottom, with everything
  around it passing clicks through to the wallpaper. Atmos moves it (wheel
  anywhere on the workspace, swipes, Escape twice to close), remembers where
  it rests, and draws the glass behind it; the frame lays out a `bar`-px bar
  and the rest (see `atmos.drawer`). With `"keys": true`, characters typed on
  the workspace while it is open go to the frame. In a tile or floating
  window the drawer is pinned open. Audio Player's Music panel is one.
- `"defaultEnabled": false` (sidebar only): the widget starts hidden until
  the user shows it.
- `"resizable": false` (sidebar only): the widget's height always follows
  its content; the user can't resize it.
- `"showIn": ["audio-player"]` (sidebar only): the panels the widget shows
  beside until the user picks otherwise in its header menu. Absent: beside
  the extension's own panel only (every panel if it has none); `[]`: every
  panel. The user's own choice, Global included, is kept over it.
- `"glass": true` (panel only): Atmos draws the panel's frosted glass under
  the frame, where the frame says (`atmos.surface.setGlass` /
  `trackGlass`), following the panel's blur and opacity (Settings →
  Appearance → Individual Panels). A frame's own `backdrop-filter` only
  blurs what is inside the frame, never the wallpaper behind it, so a
  panel that wants the glass look asks Atmos for it and leaves those areas
  transparent.

A boot contribution may declare `"keys": ["Space"]` (first-party only):
`KeyboardEvent.code` values its frame hears (`atmos.surface.onKey`) wherever
they are pressed in Atmos, except in a text field or in a frame that uses
the key itself.

Labels are plain text and icons are files in the extension, drawn as a mask
in the current text colour (so single-colour SVGs work best); nothing an
extension declares is ever inserted into Atmos as markup. Settings frames
appear on Settings → Appearance; sidebar and settings frames size
themselves to their content.

### What Core owns

Core owns the shell around every surface; the extension owns what is inside
its frame.

- **Panels.** Core supplies the surface, the layouts (`single`, columns,
  rows, stacks, `quad`, and four `freeform` windows the user moves and
  resizes), switching, the panel history (the mouse back button; hold for
  Task View) and saved placement. A panel's frame fills its section at the
  section's real size, and `atmos.surface.presentation` says which it is
  in: `'full'`, `'tile'` or `'window'`. A layout change recreates the
  frame, so read it once. Core draws no header, toolbar or visual identity
  for a panel. Design it from the extension's own domain, and don't copy
  another extension's interactions (the Audio Player's drawer is its own).
- **Sidebar widgets.** Core owns the section shell, the label row,
  expand/collapse, drag ordering, hiding and the per-panel visibility
  (every widget's header menu lets the user show it everywhere or beside
  one panel). Open widgets can be resized by dragging their lower edge, in
  28 px steps, with double-click back to the natural height. The frame's
  own height follows its content.
- **Settings.** Settings (the Control Centre) lists every extension on its
  Plugins, Services and System pages, where it is switched on or off (at the
  next start), approved, and its permissions and dependencies shown.
  Settings → Extensions installs, updates and removes packages (section 7).
  An extension's own preferences belong in its own surfaces, or in its
  settings page on Settings → Appearance.
- **Theme.** The frame gets Atmos's CSS variables (`--ink-rgb`,
  `--surface-rgb`, `--app-font-family`, the semantic colours
  `--color-positive`, `--color-negative`, `--color-neutral`…) and the font
  imported in Appearance, and they follow changes (`atmos.appearance`).

## 3. The manifest

Every extension has an `extension.json`. The smallest useful one:

```json
{
  "apiVersion": 3,
  "version": "1.0.0",
  "displayName": "Weather",
  "requires": { "extensions.frames": 3 },
  "permissions": { "network": ["api.open-meteo.com"] },
  "runtime": "frame"
}
```

| Key | Meaning | Section |
|---|---|---|
| `apiVersion`, `requires` | Core API targeted and capabilities needed | this section |
| `version` | The extension's own version, `MAJOR.MINOR.PATCH` (semver). Required to be packaged, and for others to depend on a range of it | this section |
| `publisher` | Who publishes it (`"atmos"` for official extensions); must match the key that signs it | 7 |
| `dependencies` | Services (or plugins) it needs, with version ranges; also its start order | this section |
| `description`, `contract` | A one-line description; for a service, its own API contract (renderer API file, API version, events), formerly `service.json`. Atmos doesn't read `contract`; it documents the service, and the service's own tests use it | — |
| `after`, `supersedesServices` | Start order only (prefer `dependencies`); legacy services this plugin replaces | this section |
| `permissions` | Everything the extension uses | 7 |
| `exports` | What it shares with other extensions: IPC handlers, events, exposed methods and resource providers, each for official extensions or for all | 7 |
| `auditExclude` | Folders the permission audit skips | 7 |
| `tier` | Ignored by Atmos (section 1); bundled manifests say `"first-party"` (`"system"` in `core/system`), which `npm run test:permissions` checks | 1 |
| `displayName` | Name shown in Settings and, for framed extensions, the default label | 2, 4 |
| `runtime` | `"frame"`. Every extension runs in frames now, whatever it says; keep it for Atmos 0.11 and older, which ran first-party extensions without it in the page | 9 |
| `isolation` | `"origin"` gives an official extension an origin of its own: storage and frames no other extension can reach. Every official extension that keeps data should have it (all the bundled plugins do; the bundled services are libraries, with no frames of their own); without it an official extension shares `atmos-ext://first-party` | 4 |
| `contributes` | Labels, icons and entry files for framed surfaces | 2, 4, 5 |
| `library` | `true` on a service that is a library: imported by consumers, no lifecycle, UI or state of its own | 2, 4, 5 |
| `legacyStorage` | What an official extension kept elsewhere before: in the Atmos page (`state`, `indexedDB`, `localStorage`, `deleteIndexedDB`, read with `atmos.legacy.*`), and in the shared first-party origin (`sharedOrigin`, moved into its own origin by Core; `sharedOriginIndexedDB`, deleted by Core) | 2, 4, 5 |

`apiVersion` is the newest Core API the extension targets (3). `requires`
lists the Core capabilities it needs, with minimum versions (an array of
names means version 1). Atmos doesn't load an extension this Core can't run,
and Settings says why. For a framed extension the one that matters is
`extensions.frames`: the SDK level it needs (section 4 lists what came with
2 and 3).

Core still advertises the capabilities of its old page API, so manifests
that name them keep loading:

- `extensions.manifest`
- `events.namespaced`
- `lifecycle.context`
- `panel.explicit-default`
- `panel.pass-through`
- `panel.surface-presentation`
- `renderer.capabilities`
- `state.namespaced`
- `surface.workspace`
- `context-menu.contributions`
- `appearance.semantic-colors`
- `settings.appearance-contributions`
- `sidebar.resizable-sections`
- `extensions.after`
- `extensions.tiers`
- `extensions.permissions`
- `extensions.frames`

The list is `core/js/core/capabilities.js`; the main process keeps its own
copy in `core/js/core/extension-host.cjs`. Update both when adding a
capability. The last one, `extensions.frames`, is the SDK's own level
(section 4); the others are kept only so older manifests load.

### Versions and dependencies

Every extension has a `version`, and lists what it needs in `dependencies`:

```json
{
  "version": "1.0.0",
  "publisher": "atmos",
  "dependencies": {
    "charting": "^1.2.0",
    "currency": "^1.0.0",
    "market-data": { "version": "^0.4.0", "optional": true }
  }
}
```

A bare id is a service; write `"plugin:<id>"` for a plugin. Ranges are
`1.2.3` (exactly), `^1.2.3` (compatible: `<2.0.0`, or `<0.5.0` for `^0.4.x`),
`~1.2.3` (patch updates), `>=1.2.3` and `*`. Every `service:<id>` in
`permissions.invokes` must also be a dependency (`npm run test:permissions`
checks it, along with the ranges against the repo's copies and that a
released extension's required dependencies are released too).

At startup, after trust is decided, an extension whose **required**
dependency is missing, switched off, can't load, or has a version outside
the range doesn't load either, and Settings says why ("Needs Charting, which
is switched off"). The dependency's own row lists what uses it. An
**optional** dependency never stops loading: the extension checks for it
itself and hides what needs it. Dependencies of the same kind also order
startup.

A library service that isn't loading this session (not installed, switched
off, missing a dependency, or failed to start) can't be imported:
`atmos.library('service:<id>', file)` rejects, which is how a frame checks
for an optional one. Finance does this once per frame before it mounts
(`plugins/finance/src/host/market-data.js`) and, without Market Data, hides
its market charts rather than showing them offline.

The extension manager installs required dependencies with the extension
and **offers** optional ones: Settings → Extensions shows "Optional: <name>"
with its own Install beside the extension, as long as a source has a
version in range and it isn't installed. An optional dependency marked
`"recommended": true` is installed together with the extension on its
first install (when a source has it), but stays optional: it can be removed
or switched off, or fail to start, without stopping the extension, and an
update doesn't bring it back. Finance does this with Market Data for now:

```json
"market-data": { "version": "^0.4.0", "optional": true, "recommended": true }
```

### Start order

Extensions of the same kind start in alphabetical id order, after their
dependencies of that kind. The older `after` list still orders startup
(and nothing else):

```json
{
  "after": ["media-metadata"]
}
```

`after` applies to main-process activation and to the order frames are
created (and therefore to the default panel order). Only ids of the
same kind (plugin or service) that are installed, enabled and compatible are
considered; missing ids are ignored, so `after` never prevents startup. A cycle
is logged and broken alphabetically. Services always start before plugins, so
a plugin never needs `after` for a service. Declare
`"requires": { "extensions.after": 1 }` if the order is required rather
than preferred; older Cores ignore the field. Bundled extensions use
`dependencies` instead (`npm run test:permissions` refuses `after` in
them).

A plugin replacing a legacy standalone service may also declare:

```json
{
  "supersedesServices": ["old-service-id"]
}
```

Only valid service ids are accepted. This prevents the old main-process
service from activating when its replacement plugin is installed.

## 4. The Atmos SDK

### Using the SDK

Entry files import `atmos-sdk` and render into their own `document`:

```js
import atmos from 'atmos-sdk';

document.body.innerHTML = '<main class="weather"></main>';

const saved = await atmos.state.get();
await atmos.state.update({ city: saved.city ?? 'London' });
atmos.state.onChange(next => render(next));            // other frames' changes

atmos.events.on('refresh', () => load());               // this extension's events
atmos.events.emit('refresh');

const { drawChart } = await import(await atmos.library('service:plotting', 'index.js'));

document.addEventListener('contextmenu', event => {
  event.preventDefault();
  atmos.contextMenu.open(event.clientX, event.clientY, [
    { id: 'refresh', label: 'Refresh', run: () => load() },
  ]);
});
```

| API | What it does | Needs |
|---|---|---|
| `atmos.extension` | `{ id, kind, tier }` | — |
| `atmos.ready` | A promise that resolves once the frame is connected to Atmos (entry files already run after it) | — |
| `atmos.SDK_VERSION` | The SDK level of this Atmos (`3`) | — |
| `atmos.surface` | `{ type, id, presentation, fileDrops, glass, drawer }`. A layout change recreates the frame, so `presentation` is fixed for its lifetime. Sidebar widgets and settings pages are sized to their content by the SDK, including while their section is collapsed or the sidebar closed | — |
| `atmos.surface.setMenu(items)` | Sidebar widgets: the items Atmos adds to the widget header's right-click menu, same shapes as `contextMenu.open` (a ticked row shows as "✓ Label", like the header's own items). Call again when they change | — |
| `atmos.surface.onFileDrag(fn)` / `onFileDrop(fn)` | Files dragged from the desktop: `{ state: 'over' \| 'leave' }` while a drag is over the frame, then `{ paths, files, types, data, x, y }` on drop (`paths[i]` is `files[i]`'s path, `''` when it has none; `data` holds `text/uri-list`, `text/plain`, `text/html`). Core takes the drop on the frame's behalf, since only the Atmos page can see paths | `"fileDrops": true` on the surface, first-party |
| `atmos.state.get/set/update/onChange` | Persisted JSON state shared by the extension's frames (≤ 1 MB), saved in a file of its own (`extension-state/<kind>-<id>.json` in user data) shortly after each change. `update` merges its top-level keys into the saved object in one step, so two frames' updates to different keys don't undo each other | — |
| `atmos.events.emit(name, payload)` / `on(name, fn)` | Own events; `on('<id>:name')` for another extension's, if it shares them (`exports.events`) | `invokes` for others |
| `atmos.appearance.get/onChange` | Theme; CSS variables (`--ink-rgb`, `--surface-rgb`, `--app-font-family`, `--color-positive`…) are applied to the frame automatically, and a font the user imported in Appearance is registered in the frame | — |
| `atmos.surface.setGlass(regions)` | Panels with `"glass": true`: `[{ x, y, width, height, material: 'panel' \| 'shell', radius }]` in frame pixels (`panel`: the panel's blur and opacity; `shell`: the shell's, as behind a composer). `[]` clears it. At most 24; `radius` is capped at 40 px | `"glass"` on the panel |
| `atmos.surface.trackGlass()` | The same, kept up to date: every element marked `data-atmos-glass="panel\|shell"` (optionally `data-atmos-glass-inset="top right bottom left"` in px; its border radius is used) becomes a region, re-measured when layout changes. Returns a function that stops | `"glass"` on the panel |
| `atmos.contextMenu.open(x, y, items)` | An Atmos menu at frame coordinates. Items: `{ id, label, run, checked?, hold?, tone? }` (`checked` shows a tick; `hold: true` asks for a press and hold, with a bar filling the row, before it runs; `tone: 'danger'` draws it in the semantic negative colour); `{ type: 'buttons', buttons: [{ id, label, icon?, title?, run }] }`, a row of small buttons (a quick-reaction row: a click runs that button and closes the menu); controls that stay open while changed, each with `run(value)`: `{ type: 'toggle', checked }`, `{ type: 'range', min, max, step, value, suffix?, zeroLabel? }`, `{ type: 'number', min, max, step, value, suffix? }`, `{ type: 'text', value, placeholder?, maxLength? }` (runs on Enter with the trimmed text, then closes), `{ type: 'select', value, options: [{ value, label }] }`, `{ type: 'colors', values: ['#rrggbb'] }` (`closeOnChange` to close on the first change); `{ type: 'separator' \| 'heading' \| 'meta', label }`. Any row may have an `icon`: SVG markup, of which Atmos keeps only plain shapes. Plain data only: Atmos draws the rows. Resolves with the chosen row's id, the last `{ id, value }` changed, or `null`. At most 50 rows (12 buttons, 6 colours, 50 options), and labels are cut at 120 characters. Background frames can't open menus | — |
| `atmos.contextMenu.close()` | Close the menu this frame has open (one another frame opened stays) | — |
| `atmos.clipboard.writeText(text)` / `writeImage(pngBlob, text?)` | Write the clipboard through Atmos. A frame can write it itself only while it has focus; a menu choice runs while the Atmos page has focus, so a menu's "Copy" uses this | — |
| `atmos.wallpaper.set(file)` / `get()` / `onChange(fn)` | Set an image `File`/`Blob` as the wallpaper; `{ mode, opacity, thumbnail }` (a small JPEG data URL of the current image, for sampling its colours) now and whenever the image or mode changes | `invokes: ["service:wallpaper"]` |
| `atmos.audio.load(source, { id, position, play })` | This extension's playback channel in Atmos: load a `Blob`/`File`, or an `atmos-resource://` URL from a provider it registers or invokes; `id` is your label for it, reported back | `invokes: ["service:audio"]` |
| `atmos.audio.play/pause/seek(seconds)/setVolume(0–1)/stop/state` / `onChange(fn)` | Control the channel; `{ type, source, playing, currentTime, duration, volume, ended, error }` on every change, in every frame of the extension | `invokes: ["service:audio"]` |
| `atmos.drawer.state` / `onChange(fn)` / `onKey(fn)` | Drawer panels: `{ open, expanded, placement, barPlacement, locked, bar }`; `--atmos-drawer-visible-h` on `:root` is the visible height below the bar while it moves. Wheel and swipes in the frame move the drawer except over elements marked `data-atmos-drawer-scroll` | `"drawer"` on the panel |
| `atmos.drawer.open/close/expand/collapse()` / `setBarPlacement('top' \| 'bottom')` / `setPlacement(0–2)` | Move it: bar only, hidden, fully open, back to the bar; dock the bar at the bottom (the rest revealed upward); place it (0 open, 1 bar, 2 hidden; for carrying over an old position). Nothing happens while it is pinned open | `"drawer"` on the panel |
| `atmos.surface.onKey(fn)` | Boot frames: a declared key was pressed, `fn({ code })` | `"keys"` on the boot contribution |
| `atmos.invoke('service:x', channel, ...args)` | A first-party extension's main-process IPC handler: its own, or one another extension shares (`exports.ipc`) | `invokes` and `exports.ipc`, except for the extension's own |
| `atmos.listen('plugin:<id>', channel, fn)` | Events a `main.cjs` sends with `context.send(webContents, channel, ...args)`; `fn(...args)`. Returns an unsubscribe function | `invokes` and `exports.events`, except for the extension's own |
| `atmos.call('service:x', method, ...args)` | A method an extension exposes from its boot frame (waits up to 15 s for that frame to start) | `invokes` and `exports.methods`, except for the extension's own |
| `atmos.expose({ method() {} })` | From `boot.js`: offer methods to `call()` | — |
| `atmos.notifications.show({ title, body?, tag?, silent? })` | A system notification, shown by Atmos for the frame. Resolves `true` once shown, `false` where the system has none | `"notifications"` in `permissions.browser` |
| `atmos.notifications.onClick(fn)` | The user clicked one of this extension's notifications: `fn({ tag })` in every frame of the extension, after Atmos comes to the front | — |
| `atmos.panel.show()` | Switch Atmos to this extension's panel | — |
| `atmos.legacy.readIndexedDB(name)` | First-party only: read a database the extension kept in the Atmos page before moving to frames (names listed in `"legacyStorage": { "indexedDB": [...] }`). An entry `{ "name": "db", "keys": ["prefix*", "exact"] }` returns only the records with matching keys, for a database the extension shared with others | — |
| `atmos.legacy.readState(namespace)` | First-party only: the saved data of a state namespace the extension used in the Atmos page (listed in `"legacyStorage": { "state": [...] }`), or `null` | — |
| `atmos.legacy.readLocalStorage(keys)` | First-party only: the Atmos page's values for localStorage keys listed in `"legacyStorage": { "localStorage": [...] }`, as `{ key: value \| null }`. A listed `"prefix*"` returns every key starting with the prefix | — |
| `atmos.legacy.deleteIndexedDB()` | First-party only: delete the page databases listed in `"legacyStorage": { "deleteIndexedDB": [...] }` (names, or `"prefix*"` of at least four characters), for an extension that starts afresh in frames. Resolves the names deleted | — |
| `atmos.library('service:x', file)` | URL to `import()` a library service's module into this frame | `invokes` |
| `atmos.background({ timeout })` | Official extensions only: the `window` of this extension's own boot frame, once it has started (waits up to 15 s, or `timeout` ms), for views that use live objects the engine holds instead of copying them through `call()`. An extension's frames all share its origin, so this is a same-origin window in the same process. Community extensions are refused. Objects from it belong to that realm (`instanceof Array` is false for its arrays; use `Array.isArray`), and listeners a view gives it must be removed when the view's frame goes (`pagehide`) | — |

Every call is asynchronous and checked by Core; a refused call rejects with
an `AtmosPermissionError` naming the missing declaration. `events.on`,
`listen` and the `onChange` subscriptions don't reject: a refusal is logged
in the frame's console.

Core doesn't check the `extensions.frames` level when a call is made:
`requires` only stops an older Atmos, which lacks a feature, from loading
the extension at all. Declare the level of the newest feature you use.
`listen`, `readLocalStorage`, file drops and panel shortcuts need
`"requires": { "extensions.frames": 2 }`; header menus, `readState`,
IndexedDB `keys`, `legacyId`, `shortcutToggles`, menu ticks, selects,
controls and icons, `notifications`, `wallpaper`, `audio`, drawers, boot
keys and `"resizable"` need `3` (Atmos 0.8.3), as do `"showIn"`, `"glass"`,
button rows, `contextMenu.close`, `clipboard`, `deleteIndexedDB` and
`background()`.

**Media from other extensions.** A frame may load `atmos-resource://<provider>`
URLs (in `<img>`, `<video>` and `fetch()`) for providers it registers itself
(`"resources"`) or that an extension it declares in `"invokes"` shares with
it (`"exports": { "resources": { "example-art": "official" } }` in the
extension that registers it, with `"invokes": ["plugin:example-plugin"]` in
the one using it). Its Content-Security-Policy allows exactly those.

### Background frame and views

Panel and settings frames exist only while shown, and each surface is a
separate page. Anything that must outlive a panel or be shared between
surfaces — an audio engine, a socket, a cache — belongs in `boot.js`, which
runs for the whole session: it `expose()`s methods and `emit()`s change
events, and the panel and widgets `call('plugin:<own id>', …)` and listen.
The Audio Player is the reference: its engine
(`src/engine.js`) keeps the queue and library in the boot frame and plays
through the Audio service, and its views follow both (`src/client.js`).

When the views need the engine's live objects rather than snapshots — a
chat timeline of thousands of events that the views read and react to, say
— a first-party extension can let its views use the engine directly:
`boot.js` publishes it on its `window`, and each view gets it with
`atmos.background()`. Each view must remove every listener it added to the
engine's objects when its frame goes (`pagehide`).

### What a frame can and cannot do

Each third-party extension has its own origin (`atmos-ext://plugin-<id>` or
`atmos-ext://service-<id>`), and so does each official one with
`"isolation": "origin"` (`atmos-ext://first-party-<kind>-<id>`; all the
bundled plugins have it). An origin is a storage partition and a process, so
a frame may use `localStorage` and IndexedDB for larger data, and its
frames can share them, but no other extension can read, overwrite or
script them. Official extensions without `"isolation"` share
`atmos-ext://first-party`, and with it each other's storage and frames.

**Leaving the shared origin.** An official extension that kept data in the
shared origin lists it when it moves out, and Core carries it across:

```json
"isolation": "origin",
"legacyStorage": {
  "sharedOrigin": {
    "indexedDB": ["finance-assets"],
    "localStorage": ["finance:state:*", "atmos:charting-*"]
  }
}
```

- **The copy.** At the first start with this manifest, before any of the
  extension's frames open, Core copies those databases (schema and every
  record, Blobs included) and keys (exact names, or `"prefix*"` of at least
  four characters) into the extension's own origin. It then counts what
  arrived.
- **If the copy fails.** The extension runs from the shared origin that
  session, where its data still is, and Settings → Extensions says so.
  Atmos tries again at the next start.
- **The old copies.** Core deletes the shared ones at a later start, once
  the extension has run from its own origin. It touches nothing it wasn't
  told about.
- **Record.** `extension-origin-moves.json` in user data.
- **Delete only.** `"sharedOriginIndexedDB": ["name", "prefix*"]` asks for
  databases to be deleted from the shared origin once, without copying (an
  extension that starts afresh, as Matrix Chat did). Recorded in
  `shared-origin-cleanup-v2.json`; a changed list runs again.

A frame cannot:

- read or script the Atmos page, other extensions' frames, `window.atmos`,
  `window.atmosCore` or Electron;
- connect to hosts outside `permissions.network`, or load Atmos's own
  resources (`atmos-app:`, and `atmos-resource:` providers it hasn't
  declared or isn't shared) — its Content-Security-Policy refuses them;
- navigate itself away from its origin, navigate Atmos, open windows or
  dialogs (`alert`/`confirm`/`prompt`; use in-page UI instead), or embed
  other frames;
- listen for keys pressed outside it. A panel's global key is declared
  (`"shortcut"`), not listened for;
- use browser permissions it did not declare (and the user did not approve);
- draw outside its surface or catch input outside it. Only Core draws
  across the workspace: a drawer panel's pass-through and glass are Core's,
  asked for in the manifest.

Keys pressed inside a focused frame that aren't typing are passed on to
Atmos, so its shortcuts work whichever panel or widget has focus: modifier
combinations (Ctrl+` for Settings), F-keys, Escape, Space outside fields
and buttons, and Atmos's single-key shortcuts outside fields and buttons
(Tab for the sidebar, Shift+Tab to move it, and panel shortcuts such as
Finance's `]`). A key the frame handled itself (`preventDefault()`) stays
its own. System notifications go through
`atmos.notifications.show()`, since Chromium refuses the `Notification` API
in frames.

### Patterns

**Several frames, one extension.** An extension with a panel and several
widgets that used to share one page's memory can run as separate frames:
the panel and sidebar widgets run the same code in
different roles; preferences live in `atmos.state` (every frame gets
`onChange`), larger data in the extension's origin's localStorage (other
frames see `storage` events), and changes to the library are announced with an
event. A widget that needs the panel to do something (an import) records the
request in state and calls `atmos.panel.show()`, so a panel that is only just
starting still sees it.

**One engine, many views.** To keep fetching in one place when a panel and
several widgets all display the same data, make the boot frame the engine:
it fetches and polls, publishes what it has as an event (debounced) and
`expose()`s a `snapshot()` for frames that open later. The panel and the
widgets are views: they run the extension's ordinary modules, apply what
the engine publishes, and never fetch. Settings are saved together in
`atmos.state` as `{ namespaces: { id: { version, data } } }`, so every frame
sees every change; a field too big for state (an imported font) goes to the
origin's localStorage. Views `call()` the engine's `ready()` first.

## 5. Services and libraries

A **service** owns lifecycle and exposes capabilities. A **library** is code
that consumers import. It cannot own lifecycle, UI or privileged state.

| | Service | Library (`"library": true`) |
|---|---|---|
| Runs | Once per session, as itself: `main.cjs` in the main process, and/or `boot.js` in its own background frame | Once per consumer frame, inside it |
| Identity, permissions, storage | Its own | The consumer's |
| Lifecycle | Yes: it starts, stops and keeps running | None: nothing runs until a consumer imports it and calls it |
| UI | May contribute panels, widgets and settings | None of its own; it may render into elements the consumer passes it |
| State | May keep and persist state, shared by all its consumers | None it persists; state belongs to the consumer and is passed in |
| Privileged access (files, IPC, Electron) | Yes, through `main.cjs` and its declared permissions | Never directly; only through a route the consumer hands it |
| Consumers reach it with | `invoke()` (its IPC), `call()` (methods its boot frame `expose()`s), events, what it shares (`exports`) | `import()` of `atmos.library()` |

**Choosing.** Use a library for pure computation and rendering: conversion,
formatting, parsing, charts. Use a service when something must exist once
for everyone (a rate poller, a socket, a cache), outlive a view, hold shared
state, or touch privileged APIs. A library's copy in each consumer is
separate: two consumers of a library each have their own module state, so
anything that must be shared is a service.

**Library rules**

1. **Imports only its own files**, by relative path: no `atmos-core`, no
   `atmos-sdk`, no other extension, no bare packages.
2. **No entry points.** No `boot.js`, `panel.js`, `sidebar.js`,
   `settings.js` or `persist.js`, no `"contributes"` and no `"runtime"`.
   Core never runs a library's files: a library gets no frames, whatever
   it ships.
3. **No Atmos globals.** No `window.atmos` or `window.atmosCore`. What a
   library needs from Atmos, the consumer passes in (a function, a store, an
   element).
4. **No state of its own.** It does not write `localStorage`,
   `sessionStorage`, IndexedDB or cookies: those would land in the
   consumer's storage under the library's name. It takes the values it
   needs as arguments, or a store object from the consumer. In-memory
   caches that die with the document are fine.
5. **Runs with the consumer's permissions.** A network host the library
   contacts must be declared by the consumer (and by the library, for the
   audit); a framed consumer also declares `"invokes": ["service:<id>"]` to
   import it.

**A service with a library.** An extension may be both: a service side in
`main.cjs` that owns the privileged work, and library modules that are its
client. The library still follows the rules above; the consumer gives it the
route to the service. It has no renderer surfaces: a service that needs UI,
state or a background frame is an ordinary service, and can ship its client
as a separate library.

```js
// Media Metadata: reads files in main.cjs; renderer.js is the client library.
const metadata = await import(await atmos.library('service:media-metadata', 'renderer.js'));
metadata.setInvoke((channel, ...args) => atmos.invoke('service:media-metadata', channel, ...args));
const tags = await metadata.readTags(path);
```

**Examples in Atmos**

| Extension | Kind | Notes |
|---|---|---|
| Media Metadata | Service with a library | `main.cjs` reads and writes files, shared with official extensions only (it takes any path); `renderer.js` parses tags and takes `setInvoke()`. |
| Audio Player's engine | Service (plugin-owned) | Lives in `boot.js`, `expose()`s methods, emits changes. |
| A converter or chart renderer | Library | Pure computation or rendering into the consumer's element; any preferences go to storage the consumer passes in. |

**Checked by** `npm run test:permissions`: every bundled library is audited
against these rules (`auditLibrary()` in `scripts/extension-audit.cjs`), and
any exception would be listed by file in
`scripts/extension-permissions.test.cjs` rather than granted by a manifest
(there are none).

**Exposed methods.** For a service's boot frame: it calls `atmos.expose()`;
consumers `call()` it, for the methods it shares (`"exports": { "methods":
{ "greet": "all" } }`, section 7). Arguments and results cross frames, so
they must be structured-cloneable (no functions or DOM nodes).

## 6. Main-process code (`main.cjs`)

Official extensions only. Use `main.cjs` only when a frame can't do the
work: filesystem access, native integration, resource streaming, or
privileged network behaviour.

```js
module.exports = async context => {
  context.handle('read:value', async (_event, key) => {
    return readValue(key);
  });

  context.registerResourceProvider('example-art', async ({ pathname }) => {
    const bytes = await loadArt(pathname);
    return new Response(bytes, {
      headers: { 'Content-Type': 'image/png' },
    });
  });
};
```

Atmos waits for the returned promise before it starts the next extension
and opens its window, so `activate()` should register its handlers and
return; start slow work (connections, scans) without awaiting it. An
`activate()` that throws, or hasn't finished after **10 seconds**, fails
the extension for this session: what it registered is withdrawn (later
registrations are refused), whatever requires it is skipped ("Needs X,
which failed to start"), the rest of Atmos starts as usual, and Settings →
Extensions lists it under Needs attention. It is tried again at the next
start. Running unpackaged, `--activation-timeout=<ms>` changes the limit (for
end-to-end runs).

The extension's frames reach it through the SDK, scoped to the extension:

```js
const value = await atmos.invoke('plugin:example-plugin', 'read:value', 'key');
const unsubscribe = atmos.listen('plugin:example-plugin', 'changed', payload => render(payload));
const imageUrl = 'atmos-resource://example-art/covers/1.png'; // <img src>, fetch()
```

Other extensions reach only the handlers, events and providers it shares
(`exports`, section 7), and every call arrives with the extension making it.

The main-process context provides, each only when `extension.json`
declares it (section 7):

- `id`, `kind`, the extension `root` path and its normalised `permissions`;
- the Electron objects listed in `permissions.electron` that Core hands out
  (`app`, `BrowserWindow`, `dialog`, `shell`) — never `ipcMain` or `protocol`;
- `handle(name, handler)` and `send(webContents, name, ...args)` for isolated
  IPC, with `"ipc": true`;
- `provide(name, value)` and `use(name)` for main-process capabilities, for
  names listed in `provides` / `uses`;
- `registerResourceProvider(name, handler)` for streamed resources, for names
  listed in `resources`.

Anything undeclared throws `… is not permitted to …; declare it in
extension.json "permissions"`. IPC ids and names are validated and handlers
cannot overwrite another extension's scoped channel. Resource providers must
use globally unique names.

Only official extensions may have a `main.cjs`. It runs with
full Node.js access, so the gating above catches mistakes rather than
containing hostile code. Keep privileged operations in narrowly scoped
handlers, validate renderer arguments, and avoid exposing raw filesystem or
shell access when a smaller operation will do.

## 7. Permissions and security

### Trust model

| Tier | Runs in | Model |
|---|---|---|
| **system** | the Atmos page, as part of Core | Privileged and declared. Always on. |
| **first-party** (Official) | frames; first-party libraries inside the frames that import them; a `main.cjs` in the main process | Installed as a signed package (an installer offers them on the first start; `npm start` runs them from the repo). Trusted, declared and audited. |
| **third-party** (Community) | sandboxed frames only | Approved, fingerprinted, sandboxed, with `network`, `browser` and `invokes` enforced, and only what other extensions share with community ones. No `main.cjs`. |

Every extension, whatever its tier, lists what it uses in `extension.json`:

```json
{
  "permissions": {
    "network":   ["api.example.com", "*.example.org"],
    "browser":   ["geolocation"],
    "invokes":   ["service:example-service"],
    "node":      ["fs", "path"],
    "electron":  ["dialog", "shell"],
    "ipc":       true,
    "provides":  ["example-data"],
    "uses":      ["media-metadata"],
    "resources": ["example-art"]
  }
}
```

| Key | Meaning |
|---|---|
| `network` | Hosts the extension contacts, from any process. `*.host` covers subdomains; `["*"]` means any host (user-configured servers, arbitrary URLs). |
| `browser` | Browser permissions: `geolocation`, `clipboard-read`, `notifications`, `media` (camera/microphone), `display-capture`, and `wasm` (not a Chromium permission: the extension's frames may compile WebAssembly, e.g. an encryption library). Writing to the clipboard, fullscreen and audio autoplay need nothing. Chromium doesn't allow the `Notification` API in frames, so a framed extension shows notifications with `atmos.notifications.show()` instead (Core shows them for it). |
| `invokes` | Other extensions it talks to, as `plugin:<id>` or `service:<id>`: whatever of theirs they share with it (`"exports"`, below): IPC handlers (`invoke()` in the SDK), methods a boot frame exposes (`call()`), events and resource providers; and library services' modules (`library()`). Declaring a target is not enough on its own: the target decides what it shares. |
| `node` | Modules `main.cjs` (and the `.cjs` files it loads) `require()`, including `electron` and npm packages. |
| `electron` | Electron APIs used from the main process, whether received from the context or required directly. |
| `ipc` | `main.cjs` registers IPC handlers or sends events. |
| `provides` / `uses` | Main-process capabilities it shares or consumes. |
| `resources` | `atmos-resource://` providers it registers. |

Omitted keys mean none; an empty block (`"permissions": {}`) is a valid
declaration of no special permissions. Unknown keys and malformed values make
the block invalid.

### Sharing with other extensions (`exports`)

Whatever an extension offers other extensions is private until its
manifest shares it. That covers four things: the IPC handlers its
`main.cjs` registers, the events it sends (`context.send()` in `main.cjs`,
`atmos.events.emit()` in its frames), the methods its boot frame
`expose()`s, and its `atmos-resource://` providers.

```json
{
  "exports": {
    "ipc":       { "subscribe": "official", "read-tags": "all" },
    "events":    { "event": "official" },
    "methods":   { "greet": "all" },
    "resources": { "example-art": "official" }
  }
}
```

- `"official"` shares it with system and official extensions, and
  `"all"` with community extensions too.
- What isn't listed is the extension's own: its frames and its `main.cjs`
  reach it as before, and so does the Atmos page.
- A manifest with no `"exports"` block at all shares everything with
  system and official extensions that declare it in `invokes`, and nothing
  with community ones (so that packages from before 0.12 kept working).
  Add a block, even an empty `{}`, to keep things private.
- Another extension reaches a shared name only if it also declares the
  owner in `permissions.invokes`.
- Libraries' modules (`library()`) and the Wallpaper and Audio calls are
  not affected. A library is code the consumer runs with its own
  permissions, and the Wallpaper and Audio calls are the SDK's own.

Core checks this twice.

1. The frame's bridge refuses anything not shared with the calling
   extension's tier (an `AtmosPermissionError` naming the missing
   `exports` entry).
2. Every IPC call reaches the main process stamped with the extension
   making it, and the handler runs only if it shares that name with that
   extension. A call that got past the page would still be refused.

Share only handlers that are safe for any caller of that tier. A handler
that reads any path, fetches any URL or returns a secret should stay
private, or be shared with official extensions only when they genuinely
need it.

Settings shows what a community extension can use of each extension it
declares, above its Approve button ("Media Metadata shares nothing with
community extensions"). `npm run test:permissions` checks that every
shared IPC handler is registered, and that every shared resource provider
is declared.

### What is enforced

- **Main-process context** — Electron objects, IPC, capabilities and resource
  providers are handed out only as declared (section 6).
- **Browser permissions** — each origin is granted only what its
  extensions declare: the Atmos page (`atmos-app://local`) what the system
  services and first-party libraries declare, each frame origin what its
  extensions declare (the shared first-party origin, what all of them
  declare).
  Everything else is denied.
- **Navigation** — the window never leaves `atmos-app://local/`. Links and
  `window.open()` to `http(s)`/`mailto` open in the default browser; other
  schemes are refused; a frame's `target="_blank"` links and
  `window.open()` go the same way (its sandbox allows pop-ups only so they
  reach this handler, which never opens a window). `<webview>` is disabled.
  A frame can only navigate within its own `atmos-ext://` origin.
- **Frames** — see section 4: no access to the Atmos page,
  other extensions or Electron; network limited to declared hosts by the
  frame's Content-Security-Policy; every SDK request checked against the
  manifest.
- **Sharing between extensions** — another extension's IPC handlers,
  events, exposed methods and resource providers only as far as it shares
  them (`exports`, above). IPC is checked again in the main process
  against the calling extension.
- **Third-party approval** — a third-party extension does not load until the
  user approves it in Settings → Plugins / Services, which shows its
  permissions in plain language and what the sandbox does and doesn't cover. Approval
  records a SHA-256 fingerprint of all its files (manifest included); any
  change afterwards (code or permissions) stops it loading until it is
  approved again, with newly requested permissions highlighted. Approvals are
  kept in `extension-approvals.json` in Atmos's user-data folder.
- **Signed packages** — see below. An installed extension signed by an
  official key loads as first-party once every file matches its signature;
  one changed, added or removed file, or a broken signature, stops it
  loading (it shows as modified, and is never demoted to community).
- **No third-party main-process code** — a third-party extension with a
  `main.cjs`, or with main-process permissions (`node`, `electron`, `ipc`,
  `provides`, `uses`, `resources`), is blocked and cannot be approved. A
  third-party service may expose methods from its boot frame or be a
  library, but has no IPC or main-process capabilities.
- **Bundled integrity** — a build that bundles extensions (none does now;
  see `scripts/after-pack.cjs`) writes `resources/extensions/integrity.json`
  with a SHA-256 hash of every bundled file, and Atmos doesn't load one whose
  files changed. When running from source there is no list, and bundled
  extensions show as unverified. The system services are part of Core's own
  files.

### Signed packages

An official extension can be installed separately from Atmos as a signed
`.atmos` package (a zip of the extension folder). Its `signature.json` holds
the extension's kind, id, `version` and `publisher` and the SHA-256 of every
other file, signed with Ed25519 (`core/js/core/extension-signing.cjs`).
Atmos trusts the public keys in `core/trusted-keys.json`; a key is official,
belongs to one publisher, and can be marked `"revoked"`. Signatures from keys
not in the list are ignored (the extension is community). Community
publishers signing their own packages comes later.

```bash
npm run keys:create -- <file outside the repo>   # new key, encrypted with a passphrase; adds it to core/trusted-keys.json
npm run keys:show -- <file>                       # its id, and whether Atmos trusts it
npm run pack:extensions -- --key <file>          # the released extensions → dist/packages/<id>-<version>.atmos
npm run pack:extensions -- --key <file> finance --out <dir>
```

`pack:extensions` copies what an installer would bundle (the filters in
`package.json` "build.extraResources"), signs the copy, checks it against
`core/trusted-keys.json` and zips it; `--from <folder>` packs another tree,
such as an export for the public repo. `--key` defaults to
`ATMOS_SIGNING_KEY`. The run stops if the key isn't official, if an
extension has uncommitted changes (`--allow-dirty` overrides), or if one
changed without a higher `version` than the official source has
(`--previous <folder or url>` compares with another; `--same-version`
overrides). The system services are part of
Atmos and never packaged. The key file stays outside the repo (the scripts refuse
one inside it) and the passphrase is asked for, or read from
`ATMOS_SIGNING_PASSPHRASE`. To replace a key, add the new one, mark the old
one revoked and ship an Atmos update; keep a backup of the key file.

A bundled extension is checked against `integrity.json` when the build has
one, and otherwise against its own `signature.json` if it has one.

### Installing, updating and removing (Settings → Extensions)

`core/js/core/extension-manager.cjs` installs official packages from
**sources**: a folder or an `https://` address holding `index.json` and the
`.atmos` files it lists — exactly what `pack:extensions` writes to its
`--out` folder. The index names each package's kind, id, version, Core
compatibility, dependencies, size and SHA-256, and is signed with an
official key, so the host needn't be trusted. Sources are listed in
`core/extension-sources.json` (built in: the official source, the public
repo's latest GitHub release), the packages a personal build carries
("Comes with Atmos"), and `extension-sources.json` in user data (added on
the Extensions page). Unpackaged, `--extension-source=<folder or
url>` (or `ATMOS_EXTENSION_SOURCE`) adds one for the session.

- **Checking** reads the indexes only, shortly after start and every 12
  hours, or with Check for updates. Nothing downloads until Install or
  Update is pressed. Packages this Core can't run are not offered. An index
  older than one already seen from the same source (its signed
  `generated` time, remembered in `extension-index-seen.json`) is refused
  with the reason on the source's row. Someone who controls where a source
  points can't bring back an old, genuinely signed index that hides
  updates. Publishing therefore always means a newer index: re-run
  `pack:extensions`, and don't mark an older release "latest" again.
- **Install / Update** downloads the package and any missing or too-old
  required dependency (never more bytes than the index gives as its size),
  checks size and hash against the index, unpacks it
  safely and checks every file against an official signature, then stages
  it in user data (`extension-staging/`, recorded in
  `extension-pending.json`). Nothing running changes.
- **Remove** is for what's in the installed folder (one bundled with Atmos
  is switched off instead; removing an update of one goes back to the
  bundled version). It asks every time whether to keep the extension's
  settings and data (the default) or delete them, and is refused while
  another extension requires it (unless a copy bundled with Atmos stays).
- **At the next start**, before anything is listed, pending changes are
  applied: staged packages move into the installed folder, removed ones are
  deleted. The version an update replaced is kept in
  `extension-previous/` and loads instead if the new one can't; it is
  deleted once the new one has loaded. Deleting data removes the
  extension's state file, a `userData/<id>` folder, and the storage of its
  own origin. Data an official extension without `"isolation"` keeps in the
  shared origin stays, since Core can't tell whose it is.
- The footer's **Extensions** button (left of Settings) opens this page and
  turns the negative colour, with a tooltip saying why, when an update is
  available, a change waits for a restart, or an extension failed to load.

For development and the end-to-end checks, an unpackaged Atmos also trusts
the keys in `--trusted-keys=<file>` (or `ATMOS_TRUSTED_KEYS`); a packaged
one trusts only its own list.

### What is audited, not enforced

`npm run test:permissions` (`scripts/extension-permissions.test.cjs`) scans
every bundled extension's source with `scripts/extension-audit.cjs` and fails
when code uses a Node module, Electron API, IPC, capability, resource
provider, browser permission, network host or other extension's IPC that its
manifest doesn't declare — or declares one it no longer uses. It skips
folders Atmos never runs (tests, tools, companion apps, `vendor/` for browser
APIs) and any listed in the manifest's `"auditExclude"`. Run it directly to
see what an extension uses:

```bash
node scripts/extension-audit.cjs plugins/audio-player
```

Direct `require()` in `main.cjs` can't be blocked in-process, so for
main-process code these declarations are checked statically rather than
enforced. In frames, `network`, `browser` and `invokes` are enforced.

### Limits, and what comes next

- Frames contain an extension's access, not its resource use: a frame can
  still use a lot of CPU or memory, and whatever it shows inside its own
  panel is up to it.
- `main.cjs` (first-party only) runs with full Node.js access; the context
  gating catches mistakes, not hostile code.
- Nothing stops someone who can write to Atmos's own files (`core/`,
  including `trusted-keys.json`) in an installed copy. That needs a signed,
  asar-packed app with Electron's integrity fuses. Signed packages are only
  as trustworthy as the copy of Atmos checking them.

### Licensing your extension

Atmos is licensed under the GPLv3 with the Atmos Extension Exception
(`LICENSE-EXCEPTION.md`). An extension that is your own code and works with
Atmos only through the extension interface — the SDK, `extension.json`,
and the plugins and services it reaches through the SDK — can be licensed
however you like, including closed and paid. The SDK itself
(`core/js/sdk/`) is MIT, so bundling or copying it is fine. What stays
under the GPLv3: Atmos and modified versions of it, code copied from Atmos
(other than the SDK and documentation examples), and an extension that
reaches into Atmos's internal modules instead of the SDK.

## 8. Checklist

Before shipping an extension:

1. One stable lowercase, hyphenated id everywhere.
2. An `extension.json` with `apiVersion`, `version`, `requires` (the
   `extensions.frames` level it needs), `permissions` and, for anything it
   offers other extensions, `exports`.
3. Entry files at the extension root (or listed in `contributes`), each
   importing `atmos-sdk`; nothing imports Atmos's own modules.
4. State in `atmos.state` (small, JSON, shared by the extension's frames);
   larger data in the frame origin's IndexedDB.
5. Long-lived work (a socket, a player, a poller) in `boot.js`; panels and
   widgets as views that can be recreated at any time.
6. Every listener and timer a view adds to something that outlives it
   removed on `pagehide`.
7. Branding, headers, controls and layout inside the extension's own
   surfaces; the shell is Core's.
8. Privileged work (official extensions) behind narrow `main.cjs` handlers
   that validate their arguments, shared with other extensions only when
   they must be.
9. Every permission it uses declared, and nothing it doesn't:
   `npm run test:permissions` checks a bundled extension.
10. Tested in every layout (full, tile, window), after a restart, and with
    its dependencies switched off.

## 9. Compatibility

**Atmos 0.12 removed the page runtime.** Until then an extension could run
inside the Atmos page, import Core's modules (`atmos-core/…`) and register
with its registries (`registerPanelPlugin`, `registerSection`,
`registerStateNamespace`…), from `panel.js`, `sidebar.js`, `settings.js`,
`persist.js` and `boot.js`. Official extensions without `"runtime":
"frame"` ran that way, and every plugin moved to frames before 0.12. Now:

- every extension runs in frames, whatever `runtime` says. An extension
  written for the page API fails in its frame: rewrite it on the SDK;
- `atmos-plugin://` and `atmos-service://`, which served page-runtime
  files, are gone;
- the system services, the only code left in the page, are part of Core
  (`core/system`), and `atmos-core/…` is Core's internal alias;
- Core keeps advertising the old capabilities (section 3), so manifests
  that name them still load.

Keep `"runtime": "frame"` in a manifest while Atmos 0.11 or older might
install the extension: those versions ran first-party extensions without it
in the page.

**Data from the page.** Extensions that moved from the page into frames
copied their old data once with `atmos.legacy.*` (their `"legacyStorage"`
lists what). Those calls remain for now and will be removed in a later
version; new extensions have no use for them.

**Sharing.** An extension with no `"exports"` block (every package from
before 0.12, and some bundled ones still) shares everything with official
extensions, and nothing with community ones (section 7).

**Storage.**
- `atmos.state` lived in the Atmos page's one saved blob until 0.12. The
  first time an extension's state is used under 0.12 it is copied into the
  extension's own file, and the blob's copy is forgotten at a later start.
- An official package from before 0.12 has no `"isolation"`, so it keeps
  running in the shared origin, with its data, until it is updated to a
  version that moves out (section 4, "Leaving the shared origin").
