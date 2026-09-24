# Audio

System service that owns audio playback for the whole session. With the
Wallpaper service it makes up Atmos's background layer: the two things that
keep running behind every panel.

Each extension gets its own **channel**: an `<audio>` element in the Atmos
page, keyed by the extension (`plugin:audio-player`). Because it lives in the
page, not in a panel, playback carries on through panel switches, layout
changes and frame reloads. The extension still decides *what* plays (its
queue, library, shuffle and repeat); the channel only:

- loads a source (an `atmos-resource://` URL from a provider the extension
  may use, or a `Blob`/`File`), optionally at a position and playing;
- plays, pauses, seeks, sets the volume, stops;
- reports `{ type, source, playing, currentTime, duration, volume, ended, error }`
  on every change (`type` is `source`, `loaded`, `play`, `pause`, `time`,
  `ended`, `volume` or `error`).

From a frame: `atmos.audio` in the SDK, with `"invokes": ["service:audio"]`.
Every frame of the extension hears its channel's changes, so a panel and
its widgets can follow playback without asking the extension's boot frame.

In the Atmos page: the `media.audio` renderer capability,
`getCapability('media.audio').channel('<kind>:<id>')`.
