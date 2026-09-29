/**
 * Types for the Atmos SDK 1.0 (`import atmos from 'atmos-sdk'`).
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
}
export interface WallpaperApi {
  set(file: Blob): Promise<void>;
  get(): Promise<WallpaperSummary | null>;
  onChange(fn: (wallpaper: WallpaperSummary | null) => void): Unsubscribe;
}
/** Needs "invokes": ["service:wallpaper"]. */
export declare const wallpaper: WallpaperApi;

export interface AudioState {
  type: 'source' | 'loaded' | 'play' | 'pause' | 'time' | 'ended' | 'volume' | 'error' | string;
  source: string | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  ended: boolean;
  error: string | null;
  id?: string | null;
}
export interface AudioApi {
  /** A Blob/File, or an atmos-resource:// URL from a provider the extension registers. */
  load(source: Blob | string, options?: { id?: string; position?: number; play?: boolean }): Promise<unknown>;
  play(): Promise<unknown>;
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
  /** @experimental */
  readonly notifications: NotificationsApi;
  /** @firstParty */
  readonly drawer: DrawerApi;
  /** @firstParty */
  readonly legacy: LegacyApi;
  /** @firstParty */
  readonly background: typeof background;
}

declare const atmos: Atmos;
export default atmos;
