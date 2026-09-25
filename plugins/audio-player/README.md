# Audio Player

Plays your music library. First-party, runs in frames (`"runtime": "frame"`).

```text
audio-player/
├── boot.js              # Background frame: the engine, for the whole session
├── panel.js             # "Music" panel: player bar + library browser, in Atmos's drawer
├── sidebar.js           # "Now Playing" widget
├── sidebar-queue.js     # "Queue" widget (or the album picked in the grid)
├── sidebar-library.js   # "Library" widget: folders, rescans, scan progress
├── main.cjs             # Folder dialogs, directory walks, tag fallbacks, media server (your folders only)
├── assets/              # panel.css (panel + Queue/Library widgets), sidebar.css (Now Playing)
└── src/
    ├── engine.js        # Queue, shuffle/repeat, restore, waveforms; exposes methods
    ├── library.js       # Folder scanning and album grouping (engine side)
    ├── client.js        # What the views see of the engine, and their actions
    ├── player-view.js   # The panel's UI
    ├── cover-editor.js  # Edit Cover Art (view) → cover-writer.js (engine)
    ├── state.js         # Saved settings shared by all frames
    ├── store.js         # IndexedDB: library, waveform cache, opened files
    └── …                # metadata grouping, waveform loader, fs bridge, templates
```

**Only your music folders.** `main.cjs` runs with your account's rights,
so it's kept to the folders you picked (`src/library-roots.cjs`, saved as
`audio-player/library-folders.json` in Atmos's data folder). The folder
dialog adds one; after any library change the engine reports the folders it
still uses (`keep-folders`, which can only remove). Every listing, tag or
cover read, "show in folder" and streamed track outside them is refused. On
the first launch with this list, the folders an existing library already had
are handed over once (`adopt-folders`). It never writes to your music.

**Where the sound comes from.** The engine doesn't play anything itself: it
loads tracks into its channel of Atmos's Audio service (`atmos.audio`),
which lives in the Atmos page. So music carries on whatever panel is
showing, and the panel and widgets can come and go. The engine hears when a
track ends and loads the next one.

**The drawer.** On the full workspace the Music panel is a drawer
(`"drawer": { "bar": 54, "keys": true }`): Atmos slides it between hidden,
bar only and open (wheel anywhere on the workspace, swipes, Escape twice to
close), remembers where it rests and whether the bar is docked at the bottom
("Dock Player" in the waveform menu), and draws the glass behind it. The
panel lays out the bar and browser and follows `atmos.drawer`. Typing on the
workspace while it is open searches the library. In a tile or floating
window it is pinned open.

**Views and engine.** The panel and widgets call the engine's methods
(`atmos.call('plugin:audio-player', …)`) and follow its `engine`,
`waveform`, `library-changed` and `library-status` events, plus the Audio
service's changes for time and play/pause. Settings are shared through
`atmos.state` (the same `audio-player` namespace the in-page version used):
the engine saves playback keys, the views save display keys. The library
lives in IndexedDB, written by the engine and read by the views.

**Space** plays and pauses from anywhere in Atmos (the boot contribution
declares `"keys": ["Space"]`), except in a text field or in a panel that
uses Space itself.

**Carried over from the in-page version** (once): settings, via the shared
state namespace; the library, waveform cache and opened files, from the
Atmos page's database (`legacyStorage`); the drawer's position and "Dock
Player", handed to Atmos on the first panel mount.

Run the tests with `node --test tests/*.test.cjs`; end to end with
`scripts/e2e/audio-player.cjs`.
