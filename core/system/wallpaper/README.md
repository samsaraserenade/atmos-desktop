# Wallpaper

System service that paints what sits behind everything in Atmos: the
wallpaper image and its effects, desktop blending and click-through, the
controls on Settings → Appearance, clipboard paste (Ctrl+Shift+V) and
temporary visual overrides. See-through mode supports an adjustable 0–100%
wallpaper opacity while leaving Atmos UI and extension surfaces interactive.
Native transparency, rounded clipping and custom resize edges are opt-in and
applied on the next restart; the default uses Electron's lower-overhead
opaque window and native resizing.

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
  `clearTemporaryEffects`, `subscribe`, `getThumbnail`). With no image of your own, it shows `core/assets/atmos-background.jpg`; Remove shows none.
- From a frame, use `atmos.wallpaper` in the SDK, with
  `"invokes": ["service:wallpaper"]`. An image an extension sets is recorded
  as its own (`setWallpaperFor`, with `setBy`, `setByName` and `previous` in
  its state): what it replaced is kept (an own image as the
  `wallpaper:previous` asset), Settings → Appearance says whose it is with
  a Restore previous button, and `restorePrevious(owner)` puts it back
  (`atmos.wallpaper.restore()`). Anything the user chooses (an image, Use
  default, Remove, a paste) forgets it.

This was the Background plugin. Its saved settings (`background` state
namespace) and image (`background:wallpaper` asset) are carried over on
first launch.
