# Fullscreen Viewer service

A small renderer-side engine for fullscreen media: wheel to step through
items, Shift+wheel to zoom towards the cursor. It knows nothing about what
the items are or where they're stored — callers pass plain items and react
to callbacks.

## Contract

A library service (`"library": true`; ATMOS_CORE_INTEGRATION.md § 19): pure
modules that run in the consumer's document. From the Atmos page use
`getServiceFileUrl('fullscreen-viewer', 'index.js')`; from a frame, declare
`"invokes": ["service:fullscreen-viewer"]` and use
`atmos.library('service:fullscreen-viewer', 'index.js')`.

`index.js`:

- `createFullscreenViewer(containerEl, options)` — a self-contained viewer
  that owns its wheel navigation and zoom. Options: `wheelCooldownMs`,
  `zoomMin`, `zoomMax`, `zoomSensitivity`, and the callbacks `onOpen`,
  `onNavigate`, `onClose`. Items are `{ id, url, kind: 'image' | 'video', alt? }`.
- `findMedia(root)` and `applyZoom(media, wheelEvent, currentZoom, { zoomMin, zoomMax, zoomSensitivity })`
  — stateless helpers for callers that already own navigation and only need
  the zoom maths (`applyZoom` returns the new zoom level).

Media elements are built with the DOM (never markup), so an item's `url`
and `alt` can't inject HTML.
