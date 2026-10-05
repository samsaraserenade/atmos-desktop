/**
 * Types for the Atmos SDK 1.3 (`import atmos from 'atmos-sdk'`).
 *
 * The SDK is what a framed extension uses to talk to Atmos; Atmos serves it
 * to every frame. These typings let an editor check and complete calls; point
 * `atmos-sdk` at this file (a new extension's jsconfig.json already does).
 *
 * Stability: everything here is stable in SDK 1.x unless marked
 * `@experimental` (may change in a minor version) or `@firstParty` (official
 * extensions only: Atmos refuses it to community ones).
 *
 * MIT licence, like the SDK itself.
 */

/** The SDK's version, semver. A later 1.x only adds. */
export declare const SDK_VERSION: string;

/** Resolves once the frame is connected to Atmos. Entry files already run after it. */
export declare const ready: Promise<unknown>;

// ── Identity ────────────────────────────────────────────────────────────────

export type ExtensionKind = 'plugin' | 'service';
/** "first-party" is Official; "third-party" is Community. */
export type ExtensionTier = 'system' | 'first-party' | 'third-party';
/** Another extension, as `invokes`, `call` and `listen` name it. */
export type ExtensionRef = `plugin:${string}` | `service:${string}`;

export interface ExtensionInfo {
  readonly id: string;
  readonly kind: ExtensionKind;
  readonly tier: ExtensionTier;
  /** Its extension.json "version", or null. */
  readonly version: string | null;
}

/** Which extension this frame belongs to. */
export declare const extension: ExtensionInfo;

// ── Surfaces ────────────────────────────────────────────────────────────────

export type SurfaceType = 'panel' | 'sidebar' | 'settings' | 'boot';

export interface GlassRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** "panel": the panel's blur and opacity; "shell": the shell's. */
  material?: 'panel' | 'shell';
  /** Corner radius in px, at most 40. */
  radius?: number;
}

export interface Surface {
  readonly type: SurfaceType;
  /** The panel or widget id. */
  readonly id: string;
  /** Where a panel is shown. A layout change recreates the frame, so this never changes. */
  readonly presentation: 'full' | 'tile' | 'window' | null;
  /** The panel declared "glass": true. */
  readonly glass: boolean;
  /** @firstParty The panel's drawer, when it declared "drawer". */
  readonly drawer: DrawerState | null;
  /** Sidebar widgets: the items Atmos adds to the widget header's right-click menu. Call again when they change. */
  setMenu(items: MenuItem[]): Promise<void>;
  /** Panels with "glass": true: where Atmos draws the frosted glass under the frame, in frame pixels. [] clears it. */
  setGlass(regions: GlassRegion[]): Promise<void>;
  /**
   * The same, kept up to date: every element marked data-atmos-glass="panel|shell"
   * (optionally data-atmos-glass-inset="top right bottom left") becomes a
   * region. Returns a function that stops.
   */
  trackGlass(): () => void;
  /** @firstParty Boot frames: a key declared on the boot contribution ("keys") was pressed. */
  onKey(fn: (event: { code: string }) => void): Unsubscribe;
}

/** This frame's surface. */
export declare const surface: Surface;

/** Removes a listener or subscription. */
export type Unsubscribe = () => void;

// ── State and events ────────────────────────────────────────────────────────

/** A JSON value: what atmos.state keeps. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** The saved state: an object of JSON values (typed loosely; pass your own type to get<T>()). */
export type StateObject = { [key: string]: any };

export interface StateApi {
  /** The extension's saved state ({} at first). */
  get<T extends StateObject = StateObject>(): Promise<T>;
  /** Replace it (at most 1 MB of JSON). */
  set(value: StateObject): Promise<void>;
  /** Merge top-level keys in one step, so two frames' updates to different keys don't undo each other. */
  update(patch: StateObject): Promise<void>;
  /** Another frame of this extension changed it. */
  onChange<T extends StateObject = StateObject>(fn: (state: T) => void): Unsubscribe;
}

/** Persisted JSON state shared by the extension's frames, in a file of its own. */
export declare const state: StateApi;

export interface EventsApi {
  /** One of this extension's own events (no "<id>:" prefix). */
  emit(name: string, payload?: unknown): Promise<void>;
  /** Its own events by name, or "<id>:<name>" for another extension's that it shares ("exports.events"). */
  on(name: string, fn: (payload: any) => void): Unsubscribe;
}

export declare const events: EventsApi;

// ── Appearance ──────────────────────────────────────────────────────────────

export interface Appearance {
  theme: string | null;
  colorScheme: 'dark' | 'light' | string;
  /** --ink-rgb, --surface-rgb, --app-font-family, --color-positive, …: already applied to the frame. */
  vars: Record<string, string>;
  /** A font the user imported in Appearance (registered in the frame automatically). */
  font: { id: string; family: string } | null;
}

export interface AppearanceApi {
  get(): Promise<Appearance>;
  onChange(fn: (appearance: Partial<Appearance>) => void): Unsubscribe;
}

/** Theme. Frames are themed automatically; this is for drawing (canvas, charts). */
export declare const appearance: AppearanceApi;

// ── Menus ───────────────────────────────────────────────────────────────────

interface MenuItemBase {
  id?: string;
  label?: string;
  /** SVG markup; Atmos keeps only plain shapes. */
  icon?: string;
}
export interface MenuRow extends MenuItemBase {
  type?: undefined;
  run?: () => void;
  /** Shows a tick. */
  checked?: boolean;
  /** Ask for a press and hold before running. */
  hold?: boolean;
  tone?: 'danger';
}
export interface MenuToggle extends MenuItemBase { type: 'toggle'; checked: boolean; run?: (value: boolean) => void; closeOnChange?: boolean }
export interface MenuRange extends MenuItemBase { type: 'range'; min: number; max: number; step?: number; value: number; suffix?: string; zeroLabel?: string; run?: (value: number) => void; closeOnChange?: boolean }
export interface MenuNumber extends MenuItemBase { type: 'number'; min: number; max: number; step?: number; value: number; suffix?: string; run?: (value: number) => void; closeOnChange?: boolean }
export interface MenuText extends MenuItemBase { type: 'text'; value: string; placeholder?: string; maxLength?: number; run?: (value: string) => void }
export interface MenuSelect extends MenuItemBase { type: 'select'; value: string; options: { value: string; label: string }[]; run?: (value: string) => void; closeOnChange?: boolean }
export interface MenuColors extends MenuItemBase { type: 'colors'; values: string[]; run?: (value: string) => void; closeOnChange?: boolean }
export interface MenuButtons extends MenuItemBase { type: 'buttons'; buttons: { id?: string; label: string; icon?: string; title?: string; run?: () => void }[] }
export interface MenuDecoration extends MenuItemBase { type: 'separator' | 'heading' | 'meta' }
export type MenuItem = MenuRow | MenuToggle | MenuRange | MenuNumber | MenuText | MenuSelect | MenuColors | MenuButtons | MenuDecoration;

export interface ContextMenuApi {
  /**
   * An Atmos menu at frame coordinates (at most 50 rows). Resolves with the
   * chosen row's id, the last { id, value } a control changed, or null.
   */
  open(x: number, y: number, items: MenuItem[]): Promise<string | { id: string; value: unknown } | null>;
  /** Close the menu this frame has open. */
  close(): Promise<void>;
}

/** Background frames can't open menus. */
export declare const contextMenu: ContextMenuApi;

// ── Small things ────────────────────────────────────────────────────────────

export interface ClipboardApi {
  /** Write text through Atmos (a menu's "Copy" runs while the Atmos page has focus). */
  writeText(text: string): Promise<void>;
  writeImage(png: Blob, text?: string): Promise<void>;
}
export declare const clipboard: ClipboardApi;

export interface PanelApi {
  /** Switch Atmos to this extension's panel. */
  show(): Promise<void>;
}
export declare const panel: PanelApi;

// ── Other extensions ────────────────────────────────────────────────────────

/** An official extension's main-process IPC handler: its own, or one another shares ("exports.ipc"). Needs "invokes". */
export declare function invoke<T = unknown>(target: ExtensionRef, channel: string, ...args: unknown[]): Promise<T>;
/** Events a main.cjs sends with context.send(). Needs "invokes" for another extension's. */
export declare function listen(target: ExtensionRef, channel: string, fn: (...args: any[]) => void): Unsubscribe;
/** A method an extension exposes from its boot frame (waits up to 15 s for it to start). */
export declare function call<T = unknown>(target: ExtensionRef, method: string, ...args: unknown[]): Promise<T>;
/** From boot.js: offer methods to call(). Arguments and results must be structured-cloneable. */
export declare function expose(methods: Record<string, (...args: any[]) => unknown>): Promise<void>;
/** The URL of a library service's module, to import(). Needs "invokes": ["service:<id>"]. */
export declare function library(target: `service:${string}`, file: string): Promise<string>;

// ── The system services ─────────────────────────────────────────────────────

export interface WallpaperSummary {
  mode: string;
  opacity: number;
  /** A small JPEG data URL of the current image, or null. */
  thumbnail: string | null;
  /** SDK 1.1: this extension set the image showing, and restore() would put back the one before. */
  canRestore: boolean;
}
export interface WallpaperApi {
  /** Make an image Atmos's wallpaper. Atmos keeps the one it replaces, and Settings says whose it is. */
  set(file: Blob): Promise<void>;
  /** SDK 1.1: put back the wallpaper this extension's image replaced. False when the image showing isn't this extension's. */
  restore(): Promise<boolean>;
  get(): Promise<WallpaperSummary | null>;
  onChange(fn: (wallpaper: WallpaperSummary | null) => void): Unsubscribe;
}
/** Needs "invokes": ["service:wallpaper"]. */
export declare const wallpaper: WallpaperApi;

export interface AudioState {
  /** What changed. */
  type: 'source' | 'loaded' | 'play' | 'pause' | 'time' | 'ended' | 'volume' | 'error' | 'state';
  /** SDK 1.1: the `id` given to load(), or null. */
  id: string | null;
  /** The same label as `id` (its name before SDK 1.1). */
  source: string | null;
  /** SDK 1.1: whether it starts over at the end (load's `loop`). */
  loop: boolean;
  playing: boolean;
  /** Seconds. */
  currentTime: number;
  /** Seconds; 0 until known. */
  duration: number;
  volume: number;
  /** Never true while `loop` is on. */
  ended: boolean;
  error: string | null;
}
export interface AudioLoadOptions {
  /** Your own label for it (a track key), reported back as `id`. */
  id?: string;
  /** Where to start, in seconds. */
  position?: number;
  /** Start playing once loaded. */
  play?: boolean;
  /** SDK 1.1: start over at the end, without a gap and without an 'ended' change. */
  loop?: boolean;
}
export interface AudioApi {
  /** A Blob/File, or an atmos-resource:// URL from a provider the extension registers. Resolves with the state. */
  load(source: Blob | string, options?: AudioLoadOptions): Promise<AudioState>;
  /** Resolves whether playback started (false when it was interrupted or refused). */
  play(): Promise<boolean>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  stop(): Promise<void>;
  state(): Promise<AudioState>;
  onChange(fn: (state: AudioState) => void): Unsubscribe;
}
/** This extension's own playback channel, alive all session. Needs "invokes": ["service:audio"]. */
export declare const audio: AudioApi;

export interface Location {
  lat: number;
  lon: number;
  /** A place name, when Atmos has one. */
  label: string | null;
  /** "auto": detected; "manual": picked by the user. */
  mode: 'auto' | 'manual';
}
export interface LocationApi {
  /** The location set in Atmos, or null when none is. */
  get(): Promise<Location | null>;
  onChange(fn: (location: Location | null) => void): Unsubscribe;
}
/**
 * The user's location as set in Atmos (Settings → Appearance → Location),
 * read-only. Needs "invokes": ["service:location"].
 */
export declare const location: LocationApi;

/**
 * fetch(), made by Atmos for the frame: for APIs that send no CORS headers.
 * Same arguments and result as fetch(). Only https://, only hosts in
 * "permissions.network", never a private or local address; no cookies;
 * 30 s, 5 MB up and 10 MB down per request, six at a time.
 * Rejects with a TypeError for network failures, an AtmosPermissionError
 * for an undeclared host, and an AbortError when its signal aborts.
 */
export declare function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;

export interface LifecycleApi {
  /** Aborts as the frame goes: pass it to fetch(), addEventListener, your own work. */
  readonly signal: AbortSignal;
  /** Run fn as the frame goes (last added runs first). Returns a function that cancels it. */
  onCleanup(fn: () => void): () => void;
  /** addEventListener, removed as the frame goes. Returns a function that removes it now. */
  listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions | boolean): () => void;
  listen(target: EventTarget, type: string, fn: (event: Event) => void, options?: AddEventListenerOptions | boolean): () => void;
  setTimeout(fn: (...args: any[]) => void, delay?: number, ...args: any[]): ReturnType<typeof setTimeout>;
  setInterval(fn: (...args: any[]) => void, delay?: number, ...args: any[]): ReturnType<typeof setInterval>;
}
/** The frame's lifetime: Atmos removes a frame when its panel is switched away, its widget hidden, its layout changed. */
export declare const lifecycle: LifecycleApi;

/** SDK 1.3: what a command is given when it's run or asked what to list. */
export interface CommandInput {
  /** What was typed after the command's name (rev/go general → "general"). */
  args: string;
  /** The suggestion chosen (its `value`), or null. Only when running. */
  value?: string | null;
  /** The options' values, as the user left them. */
  options: Record<string, string | boolean>;
}
/** What running a command can come back with. Nothing: the bar closes. */
export interface CommandResult {
  /** A line saying what happened: shown where the bar was, or in it with `keep`. */
  done?: string;
  /** Keep the bar open (with `done` as its status). */
  keep?: boolean;
  /** Put this in the bar instead (and preset these options), for a next step. */
  fill?: string;
  options?: Record<string, string | boolean>;
}
/**
 * A row the command bar lists for a command declaring "suggests": true. Plain
 * text; Atmos draws it. `value` comes back to run() when the row is chosen;
 * `complete` is what Tab puts after the command's name (rev/go General),
 * and without it Tab moves on to the next row.
 */
export type CommandRow =
  | { title: string; sub?: string; action?: string; value?: string | number; complete?: string; danger?: boolean }
  | { heading: string }
  | { note: string };
/** An option shown above the rows (Atmos draws it, as chips). */
export interface CommandOption {
  id: string;
  type: 'select' | 'toggle' | 'text';
  label?: string;
  value: string | boolean;
  /** select: its choices; style 'chips' shows them as a row of chips, else a dropdown. */
  options?: Array<{ value: string; label: string }>;
  style?: 'chips' | 'dropdown';
  /** text: shown before and after the field ("#" … ":example.org"). */
  prefix?: string;
  suffix?: string;
  placeholder?: string;
}
/**
 * SDK 1.3: rev/ commands in Atmos's command bar (Ctrl+\). Declare each in
 * extension.json "contributes.commands": [{ name, args?, about?, takesArgs?, suggests? }].
 */
export interface CommandsApi {
  /** Run `name` when it's chosen; with `suggest`, list choices as it's typed. Returns a function that stops handling it. */
  handle(
    name: string,
    run: (input: CommandInput) => CommandResult | void | Promise<CommandResult | void>,
    options?: { suggest?: (input: CommandInput) => CommandRow[] | { rows: CommandRow[]; options?: CommandOption[] } | Promise<CommandRow[] | { rows: CommandRow[]; options?: CommandOption[] }> },
  ): () => void;
  /** Panels: the bar at the bottom of the panel, which the command bar opens over (ui.css .atmos-bar). One per frame: another replaces it. Returns stop(). */
  bar(element: Element): () => void;
  /**
   * A text field of yours that also takes commands (a message bar): rev/ typed
   * into it opens the command bar with what's typed; keys typed before the bar
   * has the keyboard follow it, and Enter in that moment does nothing here.
   * Put rev/… in it yourself and dispatch an input event to hand that over.
   * `options` presets your command's option values. Returns stop().
   */
  field(input: HTMLInputElement | HTMLTextAreaElement, options?: { options?: Record<string, string | boolean> }): () => void;
  /**
   * Open the command bar with text (rev/go general). Only while this frame has
   * focus and the user just did something. While a command name you typed is
   * in the bar, no other extension's row is chosen for the user.
   */
  open(text?: string, options?: Record<string, string | boolean>): Promise<void>;
  /** Ask Atmos to list this extension's suggestions again. */
  refresh(): void;
}
/** SDK 1.3 */
export declare const commands: CommandsApi;

/** @experimental Not yet seen working on Windows. Needs "notifications" in "permissions.browser". */
export interface NotificationsApi {
  /** Resolves true once shown, false where the system has none. */
  show(options: { title: string; body?: string; tag?: string; silent?: boolean }): Promise<boolean>;
  /** The user clicked one of this extension's notifications (Atmos comes to the front first). */
  onClick(fn: (event: { tag: string }) => void): Unsubscribe;
}
/** @experimental */
export declare const notifications: NotificationsApi;

// ── First-party ─────────────────────────────────────────────────────────────

/** @firstParty */
export interface DrawerState {
  open: boolean;
  expanded: boolean;
  placement: number;
  barPlacement: 'top' | 'bottom';
  locked: boolean;
  bar: number;
  visible?: number;
}
/** @firstParty A panel that lives in a drawer ("drawer" on the panel contribution). */
export interface DrawerApi {
  readonly state: DrawerState | null;
  onChange(fn: (state: DrawerState) => void): Unsubscribe;
  onKey(fn: (event: { key: string }) => void): Unsubscribe;
  open(): Promise<unknown>;
  close(): Promise<unknown>;
  expand(): Promise<unknown>;
  collapse(): Promise<unknown>;
  setBarPlacement(placement: 'top' | 'bottom'): Promise<unknown>;
  setPlacement(placement: 0 | 1 | 2): Promise<unknown>;
}
/** @firstParty */
export declare const drawer: DrawerApi;

/** @firstParty One-off reads of what an official extension kept in the Atmos page before it moved into frames. */
export interface LegacyApi {
  readIndexedDB(name: string): Promise<{ version: number; stores: Record<string, [unknown, unknown][]> } | null>;
  readState(namespace: string): Promise<unknown>;
  readLocalStorage(keys: string | string[]): Promise<Record<string, string | null>>;
  deleteIndexedDB(): Promise<string[]>;
}
/** @firstParty */
export declare const legacy: LegacyApi;

/** @firstParty The window of this extension's own boot frame, once it has started. */
export declare function background(options?: { timeout?: number }): Promise<Window>;

/** @firstParty SDK 1.2: what Atmos knows of a tab's page. */
export interface WebTabState {
  tabId?: string;
  private?: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  audible?: boolean;
  muted?: boolean;
  zoom?: number;
  secure?: boolean;
  /** Ads and trackers blocked on the page so far. */
  blocked?: number;
  /** The site's shield: 'on' (blocking), 'off' (the site's ads allowed), 'disabled' (blocking off), 'none' (not a web page). */
  shield?: 'on' | 'off' | 'disabled' | 'none';
}
/** @firstParty SDK 1.2: the ad and tracker blocker. */
export interface WebAdblockStatus {
  enabled: boolean;
  state: 'off' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** When the engine was last built from the lists (ms), or null. */
  updatedAt: number | null;
  rules: number;
  /** Everything it has blocked, in all. */
  total: number;
  lists: { id: string; title: string; changedAt: number | null; checkedAt: number | null }[];
}
/** @firstParty SDK 1.2: a rectangle in the frame's own pixels. */
export interface WebRect { x: number; y: number; width: number; height: number }
/** @firstParty SDK 1.2: a download, as Atmos reports it. */
export interface WebDownload {
  id: string;
  url: string;
  name: string;
  path: string | null;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  paused: boolean;
  received: number;
  total: number;
  started: number;
  private: boolean;
  /** True only for documents, media and archives: Atmos shows anything else in its folder. */
  openable: boolean;
}
/**
 * @firstParty SDK 1.2: what pages do. `type` is one of 'opened', 'closed',
 * 'state', 'navigated', 'progress', 'favicon', 'open-tab', 'open-link'
 * (`background`: no click in Atmos just before, so not to the front),
 * 'context-menu', 'command', 'find', 'load-failed', 'refused', 'fullscreen',
 * 'crashed', 'memory' (`bytes`: the page's process is past 2 GB, and
 * again at each 2 GB more), 'permission-request' (`origin`: the page's site, whichever
 * frame asked), 'permission-settled', 'external-request' (`site`: the
 * asking page's), 'popup-blocked' and 'download-blocked' (a page tried
 * without a click, or, with `insecure`, a secure page's download over plain
 * http; `url` to open or fetch it, when there is one), 'https-fallback'
 * (`url`, `site`: tried over https first, the page loads over http;
 * `redirected` when the site itself sent it back; Atmos 0.19.2),
 * 'download', 'download-removed', 'private-ended', 'adblock' (the blocker's
 * status changed; `untrusted` names uBlock Origin's lists in use from a
 * copy without their trust).
 */
export interface WebEvent {
  type: string;
  tabId?: string | null;
  [key: string]: unknown;
}
/**
 * @firstParty SDK 1.2: web pages, for an official extension declaring
 * "web": true in its permissions (Atmos Browser). Core shows each open tab's
 * page in the extension's panel, in the browser's own session and under
 * Core's policy; a tab id is the extension's own name for a tab.
 */
export interface WebApi {
  open(tabId: string, options?: { url?: string; private?: boolean }): Promise<WebTabState>;
  close(tabId: string): Promise<boolean>;
  show(tabId: string | null): Promise<boolean>;
  list(): Promise<WebTabState[]>;
  navigate(tabId: string, url: string): Promise<'loading' | 'external'>;
  back(tabId: string): Promise<void>;
  forward(tabId: string): Promise<void>;
  reload(tabId: string, options?: { hard?: boolean }): Promise<void>;
  stop(tabId: string): Promise<void>;
  zoom(tabId: string, direction: 'in' | 'out' | 'reset'): Promise<number>;
  find(tabId: string, text: string, options?: { forward?: boolean; findNext?: boolean }): Promise<number | null>;
  stopFind(tabId: string): Promise<void>;
  print(tabId: string): Promise<boolean>;
  mute(tabId: string, muted: boolean): Promise<boolean>;
  edit(tabId: string, action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'delete' | 'selectAll'): Promise<void>;
  download(tabId: string, url: string): Promise<void>;
  /** The image at x, y in the page (a context-menu event's point), onto the clipboard. */
  copyImage(tabId: string, x: number, y: number): Promise<void>;
  focus(tabId: string): Promise<void>;
  state(tabId: string): Promise<WebTabState>;
  /** The site's shield for the tab's page: true blocks its ads and trackers, false allows them (kept per site). */
  shield(tabId: string, on: boolean): Promise<'on' | 'off' | 'disabled' | 'none'>;
  /** What was blocked on the tab's page: the count, and by site. */
  blocked(tabId: string): Promise<{ count: number; hosts: { host: string; count: number }[] }>;
  /** The panel: where the page goes (null: nowhere). `over`: what the frame draws over the page. */
  setSurface(rect: (WebRect & { over?: WebRect[] }) | null): Promise<void>;
  onEvent(fn: (event: WebEvent) => void): Unsubscribe;
  readonly downloads: {
    list(): Promise<WebDownload[]>;
    open(id: string): Promise<boolean>;
    show(id: string): Promise<boolean>;
    cancel(id: string): Promise<boolean>;
    pause(id: string): Promise<boolean>;
    resume(id: string): Promise<boolean>;
    remove(id: string): Promise<boolean>;
  };
  readonly permissions: {
    respond(requestId: string, answer: { allow: boolean; remember?: boolean }): Promise<boolean>;
    /** Each site's remembered answers; `name` is a prompted permission, 'ads' (its shield down) or 'popups' (pop-ups without a click). */
    list(): Promise<{ origin: string; name: string; value: 'allow' | 'block' }[]>;
    /** Remember or forget one; 'ads' and 'popups' are only ever 'allow' ('block' forgets them). */
    set(origin: string, name: string, value: 'allow' | 'block' | null): Promise<{ origin: string; name: string; value: 'allow' | 'block' }[]>;
  };
  readonly external: { respond(requestId: string, allow: boolean): Promise<boolean> };
  readonly adblock: {
    status(): Promise<WebAdblockStatus>;
    /** Check every list now (and build again if one changed). */
    update(): Promise<WebAdblockStatus>;
  };
  options(): Promise<{ openLinks: boolean; askWhereToSave: boolean; blockAds: boolean }>;
  setOptions(patch: { openLinks?: boolean; askWhereToSave?: boolean; blockAds?: boolean }): Promise<{ openLinks: boolean; askWhereToSave: boolean; blockAds: boolean }>;
  clearData(what: { cookies?: boolean; cache?: boolean; siteSettings?: boolean }): Promise<boolean>;
}
/** @firstParty SDK 1.2 */
export declare const web: WebApi;

// ── The default export ──────────────────────────────────────────────────────

export interface Atmos {
  readonly SDK_VERSION: typeof SDK_VERSION;
  readonly ready: typeof ready;
  readonly extension: ExtensionInfo;
  readonly surface: Surface;
  readonly state: StateApi;
  readonly events: EventsApi;
  readonly appearance: AppearanceApi;
  readonly contextMenu: ContextMenuApi;
  readonly clipboard: ClipboardApi;
  readonly panel: PanelApi;
  readonly invoke: typeof invoke;
  readonly listen: typeof listen;
  readonly call: typeof call;
  readonly expose: typeof expose;
  readonly library: typeof library;
  readonly wallpaper: WallpaperApi;
  readonly audio: AudioApi;
  readonly fetch: typeof fetch;
  readonly location: LocationApi;
  readonly lifecycle: LifecycleApi;
  /** SDK 1.3 */
  readonly commands: CommandsApi;
  /** @experimental */
  readonly notifications: NotificationsApi;
  /** @firstParty */
  readonly drawer: DrawerApi;
  /** @firstParty */
  readonly legacy: LegacyApi;
  /** @firstParty */
  readonly background: typeof background;
  /** @firstParty SDK 1.2 */
  readonly web: WebApi;
}

declare const atmos: Atmos;
export default atmos;
