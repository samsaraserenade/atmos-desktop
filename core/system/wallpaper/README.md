# Wallpaper

System service that paints what sits behind everything in Atmos: the
wallpaper image and its effects (parallax, blur, colour), the controls on
Settings → Appearance, a copied image pasted with `rev/wallpaper paste` and
temporary visual overrides. With no image (Remove), the theme's workspace
colour shows instead. The Atmos window is always opaque: the see-through
window, its See-through mode and opacity, and the click-through that went
with it were removed in Atmos 0.24 (Wallpaper 1.2.0).

Together with the Audio service it makes up Atmos's background layer: the
two things that run behind every panel for the whole session.

Part of Core (`core/system/wallpaper`): Core loads it itself
(`core/js/core/system-services.js`). It is always on, and is never
installed, packaged or switched off.

- In Core's own code, use the `visual.wallpaper` renderer capability from
  `atmos-core/core/renderer-capabilities.js` (`getState`,
  `getPersistentState`, `setState`, `setWallpaper`, `setWallpaperFor`,
  `restorePrevious`, `removeWallpaper`,
  `useDefaultWallpaper`, `imageKind`, `setTemporaryEffects`,
  `clearTemporaryEffects`, `subscribe`, `getThumbnail`). With no image of your own, it shows `core/assets/atmos-background.jpg`; Remove shows none
  (`wallpaperRemoved`). `setState` still takes `mode: 'transparent'` and
  an `opacity`, deprecated, and changes nothing for them; `getState` says
  `mode: 'wallpaper'` and `opacity: 100`.
- From a frame, use `atmos.wallpaper` in the SDK, with
  `"invokes": ["service:wallpaper"]`. An image an extension sets is recorded
  as its own (`setWallpaperFor`, with `setBy`, `setByName` and `previous` in
  its state): what it replaced is kept (an own image as the
  `wallpaper:previous` asset), Settings → Appearance says whose it is with
  a Restore previous button, and `restorePrevious(owner)` puts it back
  (`atmos.wallpaper.restore()`). Anything the user chooses (an image, Use
  default, Remove, a paste) forgets it. `get()`'s `mode` and `opacity` are
  deprecated since SDK 1.7 (always `'wallpaper'` and 100).

Its saved state is version 3: version 2 (Atmos 0.23 and older) is migrated
by dropping `mode` and `opacity`. Removed stays what `wallpaperRemoved`
says; only state saved before that flag existed takes See-through at 0%,
the old Remove, as removed (`withoutSeeThrough` in `persist.js`).

This was the Background plugin. Its saved settings (`background` state
namespace) and image (`background:wallpaper` asset) are carried over on
first launch.
