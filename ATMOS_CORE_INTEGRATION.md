# Atmos Core integration guide

This guide describes how plugins and shared services integrate with Atmos Core.
Atmos owns the workspace shell, discovery, lifecycle, layouts, persistence,
permissions and safe module/resource routing. Extensions own their behavior,
state, markup, styling, and external integrations.

Extensions run in one of two ways:

| Runtime | Who | API |
|---|---|---|
| **page** | System extensions (Wallpaper, Audio, Location) and first-party services' page code (libraries and `main.cjs` IPC); no bundled plugin any more | Core modules imported from `atmos-core/…` (sections 2–14) |
| **frame** | Every third-party extension, and first-party ones with `"runtime": "frame"` (every bundled plugin, such as the Audio Player) | The Atmos SDK, from sandboxed frames (section 19) |

The contract is additive: an extension may contribute to any combination of
surfaces. Security rules for both runtimes are in section 18.

## 1. Extension types

Atmos has two kinds of extension:

- A **plugin** is user-facing. It may contribute a panel, sidebar widget,
  settings panel, startup behavior, persistence, and main-process behavior.
- A **service** supplies shared behavior or data. It may contribute a sidebar
  widget, settings panel, persistence, main-process behavior, and renderer
  modules that plugins import.
- A **library** is a service marked `"library": true`: code its consumers
  import, with no lifecycle, UI or state of its own. See section 19,
  "Services and libraries".

Use a stable lowercase id containing letters, numbers, and hyphens, such as
`audio-player` or `weather-data`. The folder name is the extension id and is
also used for state, events, IPC, and DOM persistence.

### Where extensions come from, and tiers

Atmos loads extensions from two places:

| Source | Location | Tier |
|---|---|---|
| Bundled with Atmos | `resources/extensions/{plugins,services}` in an installed build; the repo's `plugins/` and `services/` when running from source | `system` or `first-party` |
| Installed by the user | `%APPDATA%/atmos/{plugins,services}/<id>/` | always `third-party` |

A bundled extension declares its tier in `extension.json`:

```json
{ "tier": "system" }
```

- **system** — part of Atmos itself (Wallpaper, Audio, Location). Always
  loaded; it cannot be disabled in Settings.
- **first-party** — shipped with Atmos (the Audio Player, …) and can be
  disabled. A bundled extension without a tier is first-party.
- **third-party** — anything in `%APPDATA%/atmos`. The `tier` field is
  ignored there, so nothing installed by a user can claim to be system.

**The background layer.** Two system services run behind every panel for the
whole session, in the Atmos page:

- **Wallpaper** (`services/wallpaper`, formerly the Background plugin) paints
  the wallpaper and its effects and owns desktop blending. Page code uses the
  `visual.wallpaper` capability; frames use `atmos.wallpaper` with
  `"invokes": ["service:wallpaper"]`.
- **Audio** (`services/audio`) gives each extension its own playback
  channel (an `<audio>` element keyed by the extension), so sound carries on
  through panel switches, layouts and frame reloads. The extension decides
  what plays; the channel loads, plays, pauses, seeks and reports back. Page
  code uses the `media.audio` capability; frames use `atmos.audio` with
  `"invokes": ["service:audio"]`.

Services may have a `boot.js`, like plugins; these two start from theirs.

If the same id exists in both places, the bundled copy is loaded and the
installed one is ignored (a warning is logged). Declare `"extensions.tiers": 1`
if an extension depends on this behaviour. Installs from before the
`services` rename used a singular `service/` folder, which Atmos moves on
first launch.

Extensions are loaded at runtime. Adding a third-party extension does not
require rebuilding Atmos, but Atmos must be restarted because discovery is
cached for the session. A third-party extension also needs the user's
approval before it loads, and it cannot have a `main.cjs`; see
[18. Permissions and security](#18-permissions-and-security).

## 2. Recommended layout

```text
example-plugin/
├── extension.json       # manifest: compatibility, tier, permissions (section 4)
├── main.cjs             # optional main-process entry
├── persist.js           # optional state registration
├── sidebar.js           # optional sidebar contribution
├── settings.js          # optional settings-panel contribution
├── panel.js             # optional panel contribution; plugins only
├── boot.js              # optional startup hook; plugins only in the page (any framed extension)
├── src/
│   ├── engine.js
│   └── view.js
└── assets/
    └── icon.svg
```

Every renderer entry point is an ES module. `main.cjs` is CommonJS because it
runs in Electron's main process. The table below is for page-runtime
extensions; framed ones are listed in section 19.

### Discovery conventions

| Entry point | Plugin | Service | Loaded when |
|---|:---:|:---:|---|
| `main.cjs` | Yes | Yes | Before the Atmos window is created |
| `persist.js` | Yes | Yes | Before core state is loaded |
| `sidebar.js` | Yes | Yes | After state is loaded |
| `*-sidebar.js` | Yes | No | Alongside `sidebar.js` |
| `settings.js` | Yes | Yes | Alongside `sidebar.js` |
| `panel.js` | Yes | No | Before the default panel is mounted |
| `boot.js` | Yes | No | Registered after `panel.js`, run after panel mounting |

Persistence entry points load sequentially, in start order (see `after`), to
preserve legacy hydration order.
Independent sidebar and settings entry points load in parallel. Only files at
the extension root are discovered; files in subfolders load only when
imported. Plugin `panel.js` and
`boot.js` load together in start order (plugin id, adjusted by `after`).

## 3. Importing Atmos Core

Renderer modules import core APIs through the stable `atmos-core/` prefix:

```js
import { registerSection } from 'atmos-core/core/sidebar-registry.js';
import { registerStateNamespace, save } from 'atmos-core/persist.js';
```

Use normal relative imports for files inside the same extension:

```js
import { render } from './src/view.js';
```

Styles and assets resolve relative to the importing module:

```js
const href = new URL('./styles.css', import.meta.url).href;
if (!document.querySelector(`link[href="${href}"]`)) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}
```

Atmos routes plugin and service files through confined custom protocols, so
JavaScript, CSS, JSON, images, fonts, and WASM can live outside the installed
application bundle.

## 4. Compatibility manifest

`extension.json` is optional for bundled extensions (one without it is
treated as a legacy, compatible extension with no permissions) and required
for third-party ones. Every extension should declare its `permissions`; see
section 18.

```json
{
  "apiVersion": 3,
  "requires": {
    "lifecycle.context": 1,
    "state.namespaced": 1
  },
  "permissions": {}
}
```

| Key | Meaning | Section |
|---|---|---|
| `apiVersion`, `requires` | Core API targeted and capabilities needed | this section |
| `tier` | `system` or `first-party` (bundled extensions only) | 1 |
| `after`, `supersedesServices` | Start order; legacy services this plugin replaces | this section |
| `permissions` | Everything the extension uses | 18 |
| `auditExclude` | Folders the permission audit skips | 18 |
| `displayName` | Name shown in Settings and, for framed extensions, the default label | 9, 19 |
| `runtime` | `"frame"` moves a first-party extension into frames | 19 |
| `contributes` | Labels, icons and entry files for framed surfaces | 19 |
| `library` | `true` on a service that is a library: imported by consumers, no lifecycle, UI or state of its own | 19 |
| `legacyStorage` | Databases a migrating first-party extension may copy from the page | 19 |

`apiVersion` is the newest core API the extension targets. `requires` may be
an object of capability names and minimum versions, or an array of names when
version 1 is sufficient. Atmos skips incompatible renderer contributions and
reports the reason instead of allowing a partial, unpredictable mount.

Core API v3 currently advertises:

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

The main process keeps its own copy of this list in
`js/core/extension-host.cjs`; update both when adding a capability.

Capabilities can also be checked at runtime:

```js
import { hasCapability, listCapabilities } from 'atmos-core/core/capabilities.js';

if (hasCapability('panel.pass-through')) {
  // Offer an enhanced presentation without making it mandatory.
}
```

Declare a capability as required only when the extension cannot operate
without it. Prefer runtime checks for optional enhancements.

### Start order

Extensions of the same kind start in alphabetical id order unless a manifest
says otherwise. List ids that must start first in `after`:

```json
{
  "after": ["media-library"]
}
```

`after` applies to main-process activation and to the order the renderer
loads entry points (and therefore to the default panel order). Only ids of the
same kind (plugin or service) that are installed, enabled and compatible are
considered; missing ids are ignored, so `after` never prevents startup. A cycle
is logged and broken alphabetically. Services always start before plugins, so
a plugin never needs `after` for a service. Declare `"extensions.after": 1`
if the order is required rather than preferred; older Cores ignore the field.

A plugin replacing a legacy standalone service may also declare:

```json
{
  "supersedesServices": ["old-service-id"]
}
```

Only valid service ids are accepted. This prevents the old main-process
service from activating when its replacement plugin is installed.

## 5. Lifecycle context

Atmos passes a lifecycle context to every mounted renderer contribution as
its last argument.

| Contribution | Signature |
|---|---|
| Panel mount/unmount | `(surfaceEl, context)` |
| Sidebar mount/unmount | `(bodyEl, context)` |
| Settings mount/unmount | `(bodyEl, context)` |
| Boot hook | `run(context)` |

Every context contains:

```js
{
  id,                       // extension id
  surface,                  // 'panel', 'sidebar', 'settings', or 'boot'
  signal,                   // aborted during disposal
  apiVersion,
  capabilities: { has, list },
  events,                   // extension-namespaced event facade
  onCleanup(fn),
  listen(target, type, handler, options),
  setTimeout(fn, delay, ...args),
  setInterval(fn, delay, ...args),
  requestAnimationFrame(fn)
}
```

Prefer context helpers for resources tied to a mounted surface:

```js
function mount(bodyEl, context) {
  context.listen(window, 'resize', repaint, { passive: true });
  context.setInterval(refresh, 30_000);

  const observer = new ResizeObserver(repaint);
  observer.observe(bodyEl);
  context.onCleanup(() => observer.disconnect());
}
```

Atmos disposes these resources automatically:

- when a panel is replaced;
- when a sidebar widget is disabled or unregistered;
- when the application unloads after a boot hook.

An optional `unmount()` still runs before disposal for teardown that needs the
live context. Cleanup functions should be safe to call once, and mounts should
be repeatable because a surface may be recreated many times in one session.

Long-lived engines—audio playback, connection pools, background indexing—do
not belong in a panel lifecycle. Initialize them once from module scope or a
boot hook, then make panel/sidebar views disposable consumers of that
engine. Framed extensions do the same with a background frame (section 19).

## 6. Sidebar widgets

Register a sidebar contribution from `sidebar.js`:

```js
import { registerSection } from 'atmos-core/core/sidebar-registry.js';

registerSection('example-plugin', {
  order: 20,
  icon: '<svg viewBox="0 0 24 24">...</svg>',
  label: 'Example',
  defaultEnabled: true,
  resizable: true,
  resizeStep: 28,
  headerExtra: '<button class="example-refresh">Refresh</button>',

  mount(bodyEl, context) {
    bodyEl.innerHTML = '<div class="example-status"></div>';
    context.listen(bodyEl, 'click', handleClick);
    render(bodyEl);
  },

  unmount(bodyEl, context) {
    // Optional custom teardown. Context resources are disposed afterward.
  },
});
```

Core owns the section shell, label row, expand/collapse behavior, enable state,
drag ordering, and panel-specific visibility. Every accordion's Core-provided
right-click menu lets the user show it globally (the default) or only while a
particular registered panel is active. The extension owns only the content
placed in `bodyEl` and any markup placed inside `headerExtra`.

Open accordions can be resized by dragging their invisible lower edge. Heights
move in 28px intervals by default, are persisted by section ID, and stop at a
28px minimum unless the extension declares a different `minHeight`. There is no
maximum: the sidebar scrolls when a section grows beyond the available space.
Untouched sections fit their content naturally, and double-clicking the lower
edge returns to that natural height. Extensions that genuinely need a fixed
starting size can override it with `defaultHeight`, and can set their own
interval with `resizeStep`. A fixed-content contribution can set
`resizable: false`; Core then omits its resize edge, ignores saved sizing, and
always uses its natural content height.

Extensions that depend on these sizing fields should declare
`"sidebar.resizable-sections": 1` in their compatibility manifest.

Registry utilities:

```js
import {
  setSectionEnabled,
  getRegisteredSections,
  unregisterSection,
} from 'atmos-core/core/sidebar-registry.js';
```

`setSectionEnabled()` persists the user's choice and mounts or unmounts the
widget. `unregisterSection()` removes its runtime registration; disabling a
widget keeps it available in Settings.

## 7. Appearance

### Settings contributions

Plugins and services can place controls beneath Core's Theme, App Font, and
semantic-color settings without creating a sidebar accordion. Register a
settings panel with `category: 'Appearance'`; Core mounts it with a scoped
lifecycle context whenever the Appearance page is shown.

```js
import { registerSettingsPanel } from 'atmos-core/core/settings-registry.js';

registerSettingsPanel('example-appearance', {
  label: 'Example',
  category: 'Appearance',
  order: 10,
  mount(bodyEl, context) {
    // Build controls and bind listeners through context.listen(...).
  },
});
```

Declare `"settings.appearance-contributions": 1` in the extension manifest.

### Shared semantic colors

Core owns the positive, negative, and neutral palette. Users configure it in
Settings → Appearance; changes are persisted and published to all subscribers.
Plugins can import `getSemanticColors`, `setSemanticColor(role, hex)`, and
`onSemanticColorChange` from `atmos-core/core/semantic-colors.js`. Roles are
`positive`, `negative`, and `neutral`; colors are six-digit hex values.
Subscriptions return an unsubscribe function to register with `context.onCleanup`.
CSS consumers can use `--color-positive`, `--color-negative`, and `--color-neutral`.

The capability `appearance.semantic-colors` is version 1. The same module also
exports price-oriented helpers: `getPriceColors()` (`{ up, down, neutral }`),
`setPriceColorUp`, `setPriceColorDown`, `setPriceColorNeutral`,
`classifyChange`, `colorForChange`, and `onPriceColorChange`. An explicit
second argument to `colorForChange` overrides the shared neutral color.

The standalone `price-color` service and its `getServiceFileUrl('price-color',
'index.js')` / `atmos-core/services/price-color.js` routes have been removed;
import `atmos-core/core/semantic-colors.js` directly.

Plugins must not restore their own saved palettes over Core at startup.

## 8. Panel plugins

### Ownership boundary

Core supplies a mountable surface, lifecycle, layouts, freeform window
movement/resizing, and persistence. It does not supply a plugin header, visual
identity, toolbar, or content layout. In particular, the Music Player's
waveform, track metadata, album art, playback controls, and media layout are
owned entirely by `audio-player`. They are not a panel convention or a
template for other plugins.

Start every new panel with one empty surface and design its contents from the
plugin's own domain. A plugin may use Core's window and panel APIs when its
requirements call for them; it must not reproduce another plugin's internal
interactions merely because they already exist.

Register a panel from `panel.js`:

```js
import { registerPanelPlugin } from 'atmos-core/core/panel-registry.js';

registerPanelPlugin('example-plugin', {
  icon: '<svg viewBox="0 0 24 24">...</svg>',
  label: 'Example',
  default: false,

  mount(surfaceEl, context) {
    surfaceEl.innerHTML = '<main class="example-panel"></main>';
    context.listen(surfaceEl, 'click', handlePanelClick);
  },

  unmount(surfaceEl, context) {
    // Core clears the surface after this returns.
  },
});
```

A plugin owns one panel section at a time. In the default `single` layout
the surface fills the window. Multi-panel layouts mount each assigned plugin
into its own tile or floating window, with its own surface and lifecycle
scope. The workspace background remains a separate surface behind the whole
layout. Core gives each plugin the section's real width and height (including
section-scoped `--panel-content-vis-h`, `--panel-section-width`, and
`--panel-section-height` variables), so responsive plugin CSS fits without a
transformed canvas or a Core-owned scroll viewport.

A panel's lifecycle context also carries:

- `surfaceEl` — the element passed to `mount`;
- `hostEl` — the section element that contains it;
- `presentation` — `'full'` (the whole workspace), `'tile'` (a split layout
  section) or `'window'` (a freeform window). Use it when the same panel
  should behave differently in a small section, as the Audio Player does by
  pinning its drawer open outside `'full'`.

### Panel descriptor options

- `default`: makes this the explicit default panel. Only one plugin may claim
  it. If none does, the first registered panel is the fallback.
- `passThrough`: the full-window surface only takes pointer events where the
  plugin draws something, so clicks and scrolls elsewhere reach the workspace
  background. Give your own interactive elements `pointer-events: auto`. Used
  by panels that cover only part of the window, such as the Audio Player's
  drawer. Declare `"panel.pass-through": 1` if you rely on it.
- `panelAppearance`: opt into Core's per-panel blur/opacity settings, exposed
  as `--panel-blur` and `--panel-opacity` on the section.

The registry owns section geometry. Plugins own everything rendered inside
their surface and should not change Core container positioning directly.
Core has no panel bar, drawer or slide physics: a plugin that wants one (like
the Audio Player) builds it inside its own surface.

Registry controls include:

```js
import {
  activatePanelPlugin,
  activateDefaultPanelPlugin,
  activatePreviousPanelPlugin,
  getActivePanelPluginId,
  getPanelLayout,
  getPanelSections,
  listPanelPlugins,
  setPanelLayout,
  assignPanelPlugin,
} from 'atmos-core/core/panel-registry.js';
```

`setPanelLayout()` accepts `single`, `columns`, `rows`, `right-stack`,
`left-stack`, `quad`, or `freeform`. Use `assignPanelPlugin(sectionId, pluginId)` to fill a
visible section; pass `null` to empty any section except `main`. Core prevents
the same plugin instance from being mounted in two sections simultaneously.
Multi-panel dividers are pointer- and keyboard-resizable. Core saves the X/Y
split independently for each layout; double-clicking a divider restores that
layout's default proportion.

The `freeform` layout exposes four floating window slots. Core supplies a
dedicated drag title bar and bottom-right resize handle, raises a window when
it is clicked, and persists normalized position, size, and stacking order.
Plugin content remains interactive and is never repurposed as a drag area.
Unassigned slots exist only in Settings; Core does not render empty tiled
sections, floating windows, or orphaned splitter handles for them.

The mouse back button cycles through recently used panels; holding it opens
Task View.

## 9. Extension controls and configuration

The Settings menu is the Atmos Control Centre. Its existing Plugins and
Services pages are populated from discovery metadata and let the user enable
or disable an installed extension. A disabled extension is filtered before
`main.cjs` or any renderer entry point runs. Changes take effect after an Atmos
restart. Each row also shows the extension's tier, its permissions and, for
third-party extensions, the approval prompt (section 18).

Plugin-specific preferences do not belong in the Control Centre. Put those
controls in a surface owned by the plugin, normally its panel or sidebar
widget, and keep their state in the plugin's namespaced persistence module.

## 10. State and persistence

Prefer one collision-free, versioned namespace per extension. Register it from
`persist.js`, which Atmos imports before calling the core `load()`:

```js
import { registerStateNamespace, save } from 'atmos-core/persist.js';

export const prefs = registerStateNamespace('example-plugin', {
  version: 2,
  defaults: {
    density: 'comfortable',
    refreshMinutes: 30
  },

  migrate(data, fromVersion, toVersion) {
    if (fromVersion < 2) data.refreshMinutes ??= 30;
    return data;
  },
});

export function updateDensity(value) {
  prefs.density = value;
  save();
}
```

`save()` writes all state synchronously. For changes that arrive in bursts —
slider and colour-picker `input` events, drag gestures — call `scheduleSave()`
instead: it coalesces the burst into one write about 250 ms after the last
change. A later `save()` absorbs any pending scheduled write, and Core flushes
pending writes before the page unloads (reload, window close, restart). Call
`flushPendingSave()` when something outside the page must see the data now.

The returned object keeps the same identity for the renderer session. Optional
advanced hooks are:

- `serialize(namespace)`: return the data to save;
- `hydrate(namespace, savedData)`: apply saved data manually;
- `migrate(savedData, fromVersion, toVersion)`: transform old data first.

Unknown namespaces are retained when saving, so temporarily disabling or
removing an extension does not erase its data. `registerPersist()` remains for
legacy flat-state integrations, but new extensions should use namespaces.

Other persistence helpers:

```js
import {
  onStateLoaded,
  scheduleSave,
  flushPendingSave,
  saveAsset,
  loadAsset,
  deleteAsset,
} from 'atmos-core/persist.js';
```

`saveAsset()`, `loadAsset()`, and `deleteAsset()` use IndexedDB for blobs or larger values.
Prefix asset keys with the extension id because asset keys are not
automatically namespaced.

## 11. Namespaced events

Every lifecycle context exposes `context.events`. Event names are automatically
prefixed with the extension id, allowing the same plugin's panel, sidebar, and
boot contributions to communicate without colliding with another plugin:

```js
// panel.js
context.events.emit('selection-changed', selection);

// sidebar.js
context.events.on('selection-changed', renderSelection);
```

Listeners registered through a context end when that context is disposed.
The facade supports `on`, `once`, `off`, and `emit`.

For a long-lived engine outside a mounted surface, create an explicit scope:

```js
import { createEventScope } from 'atmos-core/core/events.js';

export const events = createEventScope('example-plugin');
```

Prefer a shared service module when multiple unrelated extensions need a formal
cross-extension data contract; do not couple them through accidental global
event names.

### Optional renderer capabilities

When one user-facing plugin optionally enhances another, publish a runtime
capability instead of importing the provider's files or DOM:

```js
// provider
import { provideCapability } from 'atmos-core/core/renderer-capabilities.js';
const revoke = provideCapability('visual.wallpaper', api, { owner: 'wallpaper' });
context.onCleanup(revoke);

// consumer
import { getCapability } from 'atmos-core/core/renderer-capabilities.js';
getCapability('visual.wallpaper')?.setTemporaryEffects('my-plugin', effects);
```

When effects are computed relative to the user's saved values, providers may
also expose `getPersistentState()` so a consumer does not feed its own current
temporary override back into the next animation frame.

`onCapabilityChange()` observes installation and removal. Capability names use
lowercase letters, numbers, dots, and hyphens. A missing optional capability is
`null`; consumers must continue operating normally.

### Workspace surfaces

Plugins that render outside a panel, sidebar, or settings body register a
Core-owned full-window surface:

```js
import { registerSurface } from 'atmos-core/core/surface-registry.js';

context.onCleanup(registerSurface('example-visual', {
  layer: 'workspace-background',
  mount(hostEl, surfaceContext) {},
}));
```

Core owns the mount node, stacking, and disposal. The plugin owns everything
rendered inside it. Available layers are `workspace-background` and
`workspace-overlay`; neither implies a particular product feature.

Workspace context-menu actions follow the same rule through
`registerContextMenuItem()` from `core/context-menu-registry.js`.

## 12. Boot hooks

Register startup work from `boot.js`:

```js
import { registerBootHook } from 'atmos-core/core/boot-registry.js';

registerBootHook('example-plugin', {
  order: 20,
  async run(context) {
    await refreshInitialData();
    context.setInterval(refresh, 30_000);
  },
});
```

Boot hooks run sequentially by `order`; registration order breaks ties. One
failure is logged and isolated from later hooks. Use boot for application-wide
work, not DOM that belongs to a panel or sidebar mount.

## 13. Shared services

A service can export ordinary renderer modules in addition to its conventional
entry points. Consumers should ask the service loader for a verified URL:

```js
import { getServiceFileUrl } from 'atmos-core/core/service-loader.js';

const url = await getServiceFileUrl('weather-data', 'api.js');
if (url) {
  const { getForecast } = await import(url);
  const forecast = await getForecast();
}
```

This keeps service discovery and compatibility checks in the core. A plugin
file can be addressed similarly with `getPluginFileUrl()` from
`plugin-loader.js` when another core-managed consumer genuinely needs it.
Both return `null` for framed extensions, whose files are never served to the
page. A service that framed extensions should also be able to use declares
`"library": true`; frames reach it with `atmos.library()`. Libraries have
rules of their own (section 19, "Services and libraries").

Services load before plugins in the main process, which allows a service to
publish a main-process capability that a plugin consumes.

## 14. Main-process extensions and IPC

Use `main.cjs` only when renderer APIs are insufficient—for filesystem work,
native integration, resource streaming, or privileged network behavior.

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

Renderer calls are automatically scoped by extension kind and id:

```js
const value = await window.atmos.extensionInvoke(
  'plugin', 'example-plugin', 'read:value', 'key'
);

const unsubscribe = window.atmos.extensionOn(
  'plugin', 'example-plugin', 'changed', payload => render(payload)
);

const imageUrl = window.atmos.resourceUrl('example-art', 'covers/1.png');
```

The main-process context provides, each only when `extension.json`
declares it (section 18):

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

Only system and first-party extensions may have a `main.cjs`. It runs with
full Node.js access, so the gating above catches mistakes rather than
containing hostile code. Keep privileged operations in narrowly scoped
handlers, validate renderer arguments, and avoid exposing raw filesystem or
shell access when a smaller operation will do.

## 15. Complete minimal panel plugin

A bundled, page-runtime panel. A third-party (framed) panel is a
`panel.js` that imports `atmos-sdk` and renders into its own `document`;
the smallest working example is `scripts/e2e/fixtures/plugins/hello-frame`.

`extension.json`:

```json
{
  "apiVersion": 3,
  "requires": {
    "lifecycle.context": 1,
    "state.namespaced": 1
  },
  "permissions": {}
}
```

`panel.js`:

```js
import { registerPanelPlugin } from 'atmos-core/core/panel-registry.js';

registerPanelPlugin('example-plugin', {
  label: 'Example',
  mount(surfaceEl, context) {
    surfaceEl.innerHTML = '<main class="example-grid"></main>';
    renderGrid(surfaceEl.querySelector('.example-grid'));
  },
});
```

That is enough for discovery, compatibility checking, persisted preferences,
automatic cleanup, multi-panel assignment, and a domain-neutral mount surface.

## 16. Integration checklist

Before shipping an extension:

1. Use one stable lowercase, hyphenated id everywhere.
2. Keep conventional entry points at the extension root.
3. Add `extension.json` with `apiVersion`, `permissions` and, for bundled
   extensions, `tier`.
4. Put persistent state in `registerStateNamespace()` and call `save()` after
   user-visible changes.
5. Use lifecycle helpers for listeners, timers, animation frames, and custom
   cleanup.
6. Keep long-lived engines separate from disposable views.
7. Let registries own shell geometry, ordering, switching, and enable state.
8. Prefix extension-owned CSS selectors, DOM ids, and IndexedDB asset keys.
9. Keep branding, headers, controls, and content layout inside the plugin.
10. Do not copy the Audio Player's drawer or internal interaction model.
11. Isolate privileged operations behind extension-scoped IPC handlers.
12. Restart Atmos and test repeated mount/unmount cycles, not only first load.
13. Declare every permission the extension uses in `extension.json`, and
    nothing it doesn't.
14. Run `npm run test:core`, `npm run test:services` and
    `npm run test:permissions` before distributing a modified Atmos.

## 17. Backward compatibility

Core API v3 keeps the original extension model:

- `extension.json` is optional for bundled extensions (third-party ones need
  one to be approved);
- manual `unmount()` hooks continue to work;
- legacy flat persistence remains available;
- a first-registered panel remains the fallback when no explicit default is
  declared.

API v3 removed the panel bar, drawer physics and panel shell
(`panel-shell.js`, `panel-physics.js`), the `barPlacement`, `hideBar` and
`lockOpen` descriptor options, the four-argument
`mount(barEl, contentEl, extrasEl, context)` signature, and the
`panel.bar-placement`, `panel.immediate-state`, `panel.normalized-position`
and `panel.geometry-observer` capabilities. Every panel now receives
`mount(surfaceEl, context)`; Core logs a warning for a mount function that
still declares three or more parameters.

## 18. Permissions and security

### Trust model

| Tier | Runs in | Model |
|---|---|---|
| **system** | the Atmos page | Privileged and declared. Always on. |
| **first-party** | the Atmos page today; frames once migrated (`"runtime": "frame"`) | Trusted, declared and audited. |
| **third-party** | sandboxed frames only (section 19) | Approved, fingerprinted, sandboxed, with `network`, `browser` and `invokes` enforced. No `main.cjs`. |

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
    "uses":      ["media-library"],
    "resources": ["example-art"]
  }
}
```

| Key | Meaning |
|---|---|
| `network` | Hosts the extension contacts, from any process. `*.host` covers subdomains; `["*"]` means any host (user-configured servers, arbitrary URLs). |
| `browser` | Browser permissions: `geolocation`, `clipboard-read`, `notifications`, `media` (camera/microphone), `display-capture`, and `wasm` (not a Chromium permission: the extension's frames may compile WebAssembly, e.g. an encryption library). Writing to the clipboard, fullscreen and audio autoplay need nothing. Chromium doesn't allow the `Notification` API in frames, so a framed extension shows notifications with `atmos.notifications.show()` instead (Core shows them for it). |
| `invokes` | Other extensions it talks to, as `plugin:<id>` or `service:<id>`: their IPC (`window.atmos.extensionInvoke`, or `invoke()` in the SDK), methods a service exposes (`call()`), their events, and library services' modules (`library()`). |
| `node` | Modules `main.cjs` (and the `.cjs` files it loads) `require()`, including `electron` and npm packages. |
| `electron` | Electron APIs used from the main process, whether received from the context or required directly. |
| `ipc` | `main.cjs` registers IPC handlers or sends events. |
| `provides` / `uses` | Main-process capabilities it shares or consumes. |
| `resources` | `atmos-resource://` providers it registers. |

Omitted keys mean none; an empty block (`"permissions": {}`) is a valid
declaration of no special permissions. Unknown keys and malformed values make
the block invalid.

### What is enforced

- **Main-process context** — Electron objects, IPC, capabilities and resource
  providers are handed out only as declared (section 14).
- **Browser permissions** — each origin is granted only what its
  extensions declare: the Atmos page (`atmos-app://local`) what page-runtime
  extensions declare, each frame origin what its own extension declares.
  Everything else is denied.
- **Navigation** — the window never leaves `atmos-app://local/`. Links and
  `window.open()` to `http(s)`/`mailto` open in the default browser; other
  schemes are refused; a frame's `target="_blank"` links and
  `window.open()` go the same way (its sandbox allows pop-ups only so they
  reach this handler, which never opens a window). `<webview>` is disabled.
  A frame can only navigate within its own `atmos-ext://` origin.
- **Framed extensions** — see section 19: no access to the Atmos page,
  other extensions or Electron; network limited to declared hosts by the
  frame's Content-Security-Policy; every SDK request checked against the
  manifest.
- **Third-party approval** — a third-party extension does not load until the
  user approves it in Settings → Plugins / Services, which shows its
  permissions in plain language and what the sandbox does and doesn't cover. Approval
  records a SHA-256 fingerprint of all its files (manifest included); any
  change afterwards (code or permissions) stops it loading until it is
  approved again, with newly requested permissions highlighted. Approvals are
  kept in `extension-approvals.json` in Atmos's user-data folder.
- **No third-party main-process code** — a third-party extension with a
  `main.cjs`, or with main-process permissions (`node`, `electron`, `ipc`,
  `provides`, `uses`, `resources`), is blocked and cannot be approved. A
  third-party service may expose methods from its boot frame or be a
  library, but has no IPC or main-process capabilities.
- **Bundled integrity** — `npm run build` writes
  `resources/extensions/integrity.json` with a SHA-256 hash of every bundled
  file (`scripts/after-pack.cjs`). At startup Atmos rehashes each bundled
  extension and does not load one whose files were changed, added or removed
  (system extensions included); Settings shows it as modified. Dependency
  folders (`node_modules`) are cached by size and modification time in
  `extension-hash-cache.json` so later launches stay fast. When running from
  source there is no list, and bundled extensions show as unverified.

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

Direct `require()` in `main.cjs` and network access from page-runtime code
cannot be blocked in-process, so for first-party code in the page these
declarations are checked statically rather than enforced. Moving a
first-party extension into frames makes its renderer-side `network`,
`browser` and `invokes` enforced too.

### Limits, and what comes next

- Frames contain an extension's access, not its resource use: a frame can
  still use a lot of CPU or memory, and whatever it shows inside its own
  panel is up to it.
- First-party extensions still run in the page until each one migrates to
  frames, so their renderer permissions are audited rather than enforced.
- `main.cjs` (first-party only) runs with full Node.js access; the context
  gating catches mistakes, not hostile code.
- `integrity.json` makes changes to an installed Atmos visible; it does not
  stop someone who can also rewrite `integrity.json` (or `core/`). That needs
  a signed installer and app.

## 19. Atmos SDK and framed extensions

Third-party extensions — and first-party ones that set `"runtime": "frame"`
— never run in the Atmos page. Each surface runs in its own sandboxed
`<iframe>` and reaches Atmos only through the Atmos SDK. System extensions
(Wallpaper, Audio, Location) stay in the page as part of Core.

### Surfaces

A framed extension uses the same entry files as any other; Core creates a
frame for each and registers it with the usual registry, so panels work in
every layout, sidebar widgets can be reordered and hidden, and so on.

| File | Surface | Frame |
|---|---|---|
| `panel.js` | panel | fills the panel surface while the panel is shown |
| `sidebar.js` | sidebar widget | sized to its content |
| `settings.js` | settings | the extension's settings body |
| `boot.js` | background | hidden, runs for the whole session |

Labels, icons and options come from `"contributes"` in `extension.json`
(optional; without it, the files above are used with `displayName`):

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
appear on Settings → Appearance, like page-runtime settings contributions
(section 7); sidebar and settings frames size themselves to their content.

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
| `atmos.surface` | `{ type, presentation, fileDrops }`. A layout change recreates the frame, so `presentation` is fixed for its lifetime. Sidebar widgets and settings pages are sized to their content by the SDK, including while their section is collapsed or the sidebar closed | — |
| `atmos.surface.setMenu(items)` | Sidebar widgets: the items Atmos adds to the widget header's right-click menu, same shapes as `contextMenu.open` (a ticked row shows as "✓ Label", like the header's own items). Call again when they change | — |
| `atmos.surface.onFileDrag(fn)` / `onFileDrop(fn)` | Files dragged from the desktop: `{ state: 'over' \| 'leave' }` while a drag is over the frame, then `{ paths, files, types, data, x, y }` on drop (`paths[i]` is `files[i]`'s path, `''` when it has none; `data` holds `text/uri-list`, `text/plain`, `text/html`). Core takes the drop on the frame's behalf, since only the Atmos page can see paths | `"fileDrops": true` on the surface, first-party |
| `atmos.state.get/set/update/onChange` | Persisted JSON state shared by the extension's frames (≤ 1 MB) | — |
| `atmos.events.emit(name, payload)` / `on(name, fn)` | Own events; `on('<id>:name')` for another extension's | `invokes` for others |
| `atmos.appearance.get/onChange` | Theme; CSS variables (`--ink-rgb`, `--surface-rgb`, `--app-font-family`, `--color-positive`…) are applied to the frame automatically, and a font the user imported in Appearance is registered in the frame | — |
| `atmos.surface.setGlass(regions)` | Panels with `"glass": true`: `[{ x, y, width, height, material: 'panel' \| 'shell', radius }]` in frame pixels (`panel`: the panel's blur and opacity; `shell`: the shell's, as behind a composer). `[]` clears it. At most 24 | `"glass"` on the panel |
| `atmos.surface.trackGlass()` | The same, kept up to date: every element marked `data-atmos-glass="panel\|shell"` (optionally `data-atmos-glass-inset="top right bottom left"` in px; its border radius is used) becomes a region, re-measured when layout changes. Returns a function that stops | `"glass"` on the panel |
| `atmos.contextMenu.open(x, y, items)` | An Atmos menu at frame coordinates. Items: `{ id, label, run, checked?, hold?, tone? }` (`checked` shows a tick; `hold: true` asks for a press and hold, with a bar filling the row, before it runs; `tone: 'danger'` draws it in the semantic negative colour); `{ type: 'buttons', buttons: [{ id, label, icon?, title?, run }] }`, a row of small buttons (a quick-reaction row: a click runs that button and closes the menu); controls that stay open while changed, each with `run(value)`: `{ type: 'toggle', checked }`, `{ type: 'range', min, max, step, value, suffix?, zeroLabel? }`, `{ type: 'number', min, max, step, value, suffix? }`, `{ type: 'text', value, placeholder?, maxLength? }` (runs on Enter with the trimmed text, then closes), `{ type: 'select', value, options: [{ value, label }] }`, `{ type: 'colors', values: ['#rrggbb'] }` (`closeOnChange` to close on the first change); `{ type: 'separator' \| 'heading' \| 'meta', label }`. Any row may have an `icon`: SVG markup, of which Atmos keeps only plain shapes. Plain data only: Atmos draws the rows. Resolves with the chosen row's id, the last `{ id, value }` changed, or `null` | — |
| `atmos.contextMenu.close()` | Close the menu this frame has open (one another frame opened stays) | — |
| `atmos.clipboard.writeText(text)` / `writeImage(pngBlob, text?)` | Write the clipboard through Atmos. A frame can write it itself only while it has focus; a menu choice runs while the Atmos page has focus, so a menu's "Copy" uses this | — |
| `atmos.wallpaper.set(file)` / `get()` / `onChange(fn)` | Set an image `File`/`Blob` as the wallpaper; `{ mode, opacity, thumbnail }` (a small JPEG data URL of the current image, for sampling its colours) now and whenever the image or mode changes | `invokes: ["service:wallpaper"]` |
| `atmos.audio.load(source, { id, position, play })` | This extension's playback channel in Atmos: load a `Blob`/`File`, or an `atmos-resource://` URL from a provider it registers or invokes; `id` is your label for it, reported back | `invokes: ["service:audio"]` |
| `atmos.audio.play/pause/seek(seconds)/setVolume(0–1)/stop/state` / `onChange(fn)` | Control the channel; `{ type, source, playing, currentTime, duration, volume, ended, error }` on every change, in every frame of the extension | `invokes: ["service:audio"]` |
| `atmos.drawer.state` / `onChange(fn)` / `onKey(fn)` | Drawer panels: `{ open, expanded, placement, barPlacement, locked, bar }`; `--atmos-drawer-visible-h` on `:root` is the visible height below the bar while it moves. Wheel and swipes in the frame move the drawer except over elements marked `data-atmos-drawer-scroll` | `"drawer"` on the panel |
| `atmos.drawer.open/close/expand/collapse()` / `setBarPlacement('top' \| 'bottom')` / `setPlacement(0–2)` | Move it: bar only, hidden, fully open, back to the bar; dock the bar at the bottom (the rest revealed upward); place it (0 open, 1 bar, 2 hidden; for carrying over an old position). Nothing happens while it is pinned open | `"drawer"` on the panel |
| `atmos.surface.onKey(fn)` | Boot frames: a declared key was pressed, `fn({ code })` | `"keys"` on the boot contribution |
| `atmos.invoke('service:x', channel, ...args)` | A first-party extension's main-process IPC handler | `invokes` |
| `atmos.listen('plugin:<id>', channel, fn)` | Events a `main.cjs` sends with `context.send(target, channel, ...args)`; `fn(...args)`. Returns an unsubscribe function | `invokes`, except for the extension's own |
| `atmos.call('service:x', method, ...args)` | A method an extension exposes from its boot frame (waits up to 15 s for that frame to start) | `invokes`, except for the extension's own |
| `atmos.expose({ method() {} })` | From `boot.js`: offer methods to `call()` | — |
| `atmos.notifications.show({ title, body?, tag?, silent? })` | A system notification, shown by Atmos for the frame. Resolves `true` once shown, `false` where the system has none | `"notifications"` in `permissions.browser` |
| `atmos.notifications.onClick(fn)` | The user clicked one of this extension's notifications: `fn({ tag })` in every frame of the extension, after Atmos comes to the front | — |
| `atmos.panel.show()` | Switch Atmos to this extension's panel | — |
| `atmos.legacy.readIndexedDB(name)` | First-party only: read a database the extension kept in the Atmos page before moving to frames (names listed in `"legacyStorage": { "indexedDB": [...] }`). An entry `{ "name": "db", "keys": ["prefix*", "exact"] }` returns only the records with matching keys, for a database the extension shared with others | — |
| `atmos.legacy.readState(namespace)` | First-party only: the saved data of a state namespace the extension used in the Atmos page (listed in `"legacyStorage": { "state": [...] }`), or `null` | — |
| `atmos.legacy.readLocalStorage(keys)` | First-party only: the Atmos page's values for localStorage keys listed in `"legacyStorage": { "localStorage": [...] }`, as `{ key: value \| null }`. A listed `"prefix*"` returns every key starting with the prefix | — |
| `atmos.legacy.deleteIndexedDB()` | First-party only: delete the page databases listed in `"legacyStorage": { "deleteIndexedDB": [...] }` (names, or `"prefix*"` of at least four characters), for an extension that starts afresh in frames. Resolves the names deleted | — |
| `atmos.library('service:x', file)` | URL to `import()` a library service's module into this frame | `invokes` |
| `atmos.background()` | First-party only: the `window` of this extension's own boot frame, once it has started (waits up to 15 s), for views that use live objects the engine holds instead of copying them through `call()`. First-party frames share one origin, so this is a same-origin window in the same process; third-party frames each have their own origin and can't. Objects from it belong to that realm (`instanceof Array` is false for its arrays; use `Array.isArray`), and listeners a view gives it must be removed when the view's frame goes (`pagehide`) | — |

Every call is asynchronous and checked by Core; a refused call rejects with
an `AtmosPermissionError` naming the missing declaration. `listen`,
`setWallpaper`, `readLocalStorage`, file drops and panel shortcuts need
`"requires": { "extensions.frames": 2 }`; header menus, `readState`,
IndexedDB `keys`, `legacyId`, `shortcutToggles`, menu ticks, selects,
controls and icons, `notifications`, `wallpaper`, `audio`, drawers, boot
keys and `"resizable"` need `3` (Atmos 0.8.3), as do `"showIn"`, `"glass"`,
button rows, `contextMenu.close`, `clipboard`, `deleteIndexedDB` and
`background()`.

**Media from other extensions.** A frame may load `atmos-resource://<provider>`
URLs (in `<img>`, `<video>` and `fetch()`) for providers it registers itself
(`"resources"`) or that belong to an extension it declares in `"invokes"`, for
example `"invokes": ["service:media-library"]` for a media library
service's files. Its Content-Security-Policy allows exactly those.

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

### Services and libraries

A **service** owns lifecycle and exposes capabilities. A **library** is code
that consumers import. It cannot own lifecycle, UI or privileged state.

| | Service | Library (`"library": true`) |
|---|---|---|
| Runs | Once per session, as itself: `main.cjs` in the main process, and/or `boot.js` in its own background frame | Once per consumer document, inside the consumer (the Atmos page, or the consumer's frame) |
| Identity, permissions, storage | Its own | The consumer's |
| Lifecycle | Yes: it starts, stops and keeps running | None: nothing runs until a consumer imports it and calls it |
| UI | May contribute panels, widgets and settings | None of its own; it may render into elements the consumer passes it |
| State | May keep and persist state, shared by all its consumers | None it persists; state belongs to the consumer and is passed in |
| Privileged access (files, IPC, Electron) | Yes, through `main.cjs` and its declared permissions | Never directly; only through a route the consumer hands it |
| Consumers reach it with | `invoke()` (its IPC), `call()` (methods its boot frame `expose()`s), events | `import()` of `getServiceFileUrl()` (page) or `atmos.library()` (frame) |

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
   Core never runs a library's files: the page loader skips them and a
   library gets no frames, whatever it ships.
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

In the Atmos page the consumer passes Core's bridge instead:
`(channel, ...args) => window.atmos.extensionInvoke('service', 'media-metadata', channel, ...args)`.

**Examples in Atmos**

| Extension | Kind | Notes |
|---|---|---|
| Media Metadata | Service with a library | `main.cjs` reads and writes files; `renderer.js` parses tags and takes `setInvoke()`. |
| Audio Player's engine | Service (plugin-owned) | Lives in `boot.js`, `expose()`s methods, emits changes. |
| A converter or chart renderer | Library | Pure computation or rendering into the consumer's element; any preferences go to storage the consumer passes in. |

**Checked by** `npm run test:permissions`: every bundled library is audited
against these rules (`auditLibrary()` in `scripts/extension-audit.cjs`), and
any exception would be listed by file in
`scripts/extension-permissions.test.cjs` rather than granted by a manifest
(there are none).

**Exposed methods.** For a service's boot frame: it calls `atmos.expose()`;
consumers `call()` it. Arguments and results cross frames, so they must be
structured-cloneable (no functions or DOM nodes). Page-runtime code cannot
`call()` a framed service yet, which is why a service whose consumers still
run in the page is offered as a library first.

### What a frame can and cannot do

Each third-party extension has its own origin (`atmos-ext://plugin-<id>` or
`atmos-ext://service-<id>`); framed first-party extensions share
`atmos-ext://first-party`. An origin is a storage partition and a process,
so a frame may use `localStorage` and IndexedDB for larger data, and its
frames can share them.

A frame cannot:

- read or script the Atmos page, other extensions' frames, `window.atmos`,
  `window.atmosCore` or Electron;
- connect to hosts outside `permissions.network`, or load Atmos's own
  resources (`atmos-app:`, `atmos-plugin:`, `atmos-service:`, and
  `atmos-resource:` providers it hasn't declared) — its
  Content-Security-Policy refuses them;
- navigate itself away from its origin, navigate Atmos, open windows or
  dialogs (`alert`/`confirm`/`prompt`; use in-page UI instead), or embed
  other frames;
- listen for keys pressed outside it. A panel's global key is declared
  (`"shortcut"`), not listened for;
- use browser permissions it did not declare (and the user did not approve);
- draw outside its surface or catch input outside it. Pass-through panels and
  workspace overlays are page-only features.

Keys pressed inside a focused frame that aren't typing (shortcuts, Escape)
are passed on to Atmos. System notifications go through
`atmos.notifications.show()`, since Chromium refuses the `Notification` API
in frames.

### Migrating a first-party extension

1. Replace `atmos-core/...` imports with the SDK (state, events, menus, theme
   variables, services).
2. Move persisted state to `atmos.state` (same namespace id, so saved
   settings carry over).
3. Move long-lived work into `boot.js` and let the views talk to it
   (above).
4. Copy browser storage across once with `atmos.legacy.readIndexedDB()` and
   `readLocalStorage()`, listing the databases and keys in
   `"legacyStorage"`. Copy each key only if the frames don't have it yet:
   another of the extension's frames may already have copied and changed it.
5. Set `"runtime": "frame"` and `"contributes"` in `extension.json`.
6. Check it in every layout; `npm run test:permissions` still applies.

Every bundled plugin runs in frames.

**Several frames, one extension.** An extension with a panel and several
widgets that used to share one page's memory can run as separate frames:
the panel and sidebar widgets run the same code in
different roles; preferences live in `atmos.state` (every frame gets
`onChange`), larger data in the shared origin's localStorage (other frames
see `storage` events), and changes to the library are announced with an
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
shared origin's localStorage. The engine does the one-time copy from the
page; views `call()` its `ready()` first. Small modules that stand in for
the Core modules the extension used in the page let the rest of it keep
its shape.
