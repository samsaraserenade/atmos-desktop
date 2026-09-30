# Audio

System service that owns audio playback for the whole session. With the
Wallpaper service it makes up Atmos's background layer: the two things that
keep running behind every panel.

Part of Core (`core/system/audio`): Core loads it itself
(`core/js/core/system-services.js`). It is always on, and is never
installed, packaged or switched off.

Each extension gets its own **channel**: an `<audio>` element in the Atmos
page, keyed by the extension (`plugin:audio-player`). Because it lives in the
page, not in a panel, playback carries on through panel switches, layout
changes and frame reloads. The extension still decides *what* plays (its
queue, library, shuffle and repeat); the channel only:

- loads a source (an `atmos-resource://` URL from a provider the extension
  may use, or a `Blob`/`File`), optionally at a position, playing, and
  looping (1.1: the element starts over by itself, with no `ended` and no
  frame involved, so a soundscape keeps looping with its panel closed);
- plays, pauses, seeks, sets the volume, stops;
- reports `{ type, id, source, loop, playing, currentTime, duration, volume,
  ended, error }` on every change (`type` is `source`, `loaded`, `play`,
  `pause`, `time`, `ended`, `volume` or `error`; `state()` gives `state`).
  `id` is the label given to `load()`; `source` is the same label, its name
  before 1.1.

From a frame: `atmos.audio` in the SDK, with `"invokes": ["service:audio"]`.
Every frame of the extension hears its channel's changes, so a panel and
its widgets can follow playback without asking the extension's boot frame.

In Core's own code: the `media.audio` renderer capability,
`getCapability('media.audio').channel('<kind>:<id>')`.
