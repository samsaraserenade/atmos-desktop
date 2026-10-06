# Media Metadata service

Reads tags from audio files and writes cover art into them.

## Contract

A library service (`"library": true`) with main-process handlers.
`renderer.js` runs in the consumer's frame (declare
`"invokes": ["service:media-metadata"]`):

```js
const metadata = await import(await atmos.library('service:media-metadata', 'renderer.js'));
metadata.setInvoke((channel, ...args) => atmos.invoke('service:media-metadata', channel, ...args));
```

Audio Player does this in its engine frame (`src/media-metadata.js`). Until `setInvoke()` is
called, `readTags()` returns `{}` and `writeCoverArt()` fails. The library
follows the library rules in ATMOS_CORE_INTEGRATION.md § 5.

Renderer exports:

- `readTags(filePath)` — reads the first 256 KB of the file through the main
  process and parses it with the bundled `jsmediatags.min.js`. Returns
  jsmediatags' tag object (title, artist, album, track, raw frames, embedded
  picture) plus a normalised `albumArtist`, or `{}` on any failure so callers
  can fall back to the filename.
- `writeCoverArt(filePath, imageBase64, mimeType)` — JPEG or PNG. Resolves
  `{ ok, sidecar?, ext?, error? }`.
- `setInvoke(fn)` — route the two calls above through
  `fn(channel, ...args)`.

Service side (`main.cjs`): scoped IPC handlers `read-file-bytes` and `write-cover-art`, and
the `media-metadata` capability for other extensions. Paths must be absolute.
Both handlers are shared with official extensions only (`"exports"`), since
they take any path.

## Cover art

- MP3/MP2/MP1: embedded ID3v2 APIC frame (v2.3 and v2.4; a PIC frame in
  v2.2, which stays v2.2), `formats/id3.cjs`. A tag it can't rewrite
  faithfully (another version, or unsynchronised or compressed as a whole)
  is refused and the file left alone.
- FLAC: METADATA_BLOCK_PICTURE, `formats/flac.cjs`.
- Anything else: a `cover.jpg` / `cover.png` sidecar next to the file.

Audio data is never modified. Consumer: Audio Player.
