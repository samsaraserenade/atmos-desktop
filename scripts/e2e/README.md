# End-to-end checks

These launch the real Atmos (Electron) against this repo in a throwaway home
folder and drive it with Playwright. They are slower than the unit tests and
are run by hand after changes to extension loading, trust, permissions or
frames.

| Script | Checks |
|---|---|
| `frames.cjs` | Installs `fixtures/` as third-party extensions and approves them, then: panel, sidebar and settings frames; isolation from the Atmos page; CSP refusing undeclared hosts and Atmos's own schemes; blocked navigation and pop-ups; SDK state, events, service calls and a library service (Media Metadata's client); Core context menus; split layouts; theme sync; state surviving a restart; memory per process. |
| `audio-player.cjs` | The background layer and Audio Player in frames: Wallpaper carrying over Background's settings and image; Audio Player carrying over its settings, folders, library and waveforms from the page; the Music panel in Atmos's drawer; double-clicking an album playing it from the Audio service; the Queue, Now Playing and Library widgets; playback carrying on under another panel and into the next track; Space; album and waveform menus with icons, ranges and toggles; docking the bar; Escape twice from inside the frame; wheel on the workspace; a library rescan; everything after a restart. |
| `security.cjs` | Approval, re-approval after a change, the `main.cjs` ban, tamper detection on a copy of the bundled extensions with `integrity.json`, link and `window.open` handling, browser permissions. |

## Running

Linux or macOS (or WSL). On Windows they refuse to run, because Electron
would use your real `%APPDATA%\atmos` (see `isolate.cjs`).

```sh
npm install --no-save playwright-core
node scripts/e2e/frames.cjs      # JSON report on stdout, screenshots in .tmp/e2e/frames
node scripts/e2e/security.cjs    # screenshots in .tmp/e2e/security
node scripts/e2e/audio-player.cjs # screenshots in .tmp/e2e/audio-player
```

They use the Electron from `devDependencies`; set `ELECTRON_PATH` to use
another. Without a display, prefix with `xvfb-run -a`.

The output is a JSON report, not pass/fail. What to expect:

- `frames.cjs`:
  - `panel.parent`, `fetchUndeclared`, `fetchResource`, `fetchAppShell`, `fetchPluginScheme` and `fetchFirstPartyFrame` are `"blocked"`;
  - `windowAtmos` and `windowAtmosCore` are `"undefined"`;
  - `invokeUndeclared` and `notifyUndeclared` are an `AtmosPermissionError`;
  - `collapsedWidget` is `{ open: false, grewBy: 150, restored: true }`;
  - `greet` is a greeting and `library` is `"ok"`;
  - `menuResult.choice` is `"say"`;
  - `panelUrlAfterNavigate` is still the frame's own URL and `topNavigate` is `"SecurityError"`;
  - `settingsFrame` is `"Greeting"`;
  - `tile.presentation` is `"tile"`;
  - `visitsAfterRestart` is one more than `tile.visits` (each panel mount counts as a visit).
- `audio-player.cjs`:
  - `list.surfaces` has the drawer panel, the three widgets and `boot:audio-player:keys=Space`; `list.wallpaper` and `list.audio` are `"system"` and `list.background` is `false`;
  - `wallpaper` shows `mode: "wallpaper"`, `vignette: 40`, `brightness: 80`, a `blob:` image, `movedAsset: true`, `oldAsset: false`;
  - `panel.drawer` is `{ open: true, expanded: true, locked: false }` (the old position handed over), `panel.cards` is `["Test Album"]`, `coverSize` `"120px"`, `volume` `"40%"`;
  - `playing.playing` is `true` with source `"Test Album/one.wav"`, `pageAudioElements` is `["plugin:audio-player"]`, `queue` starts `"*One"`, `nowPlaying` is One by Tester, `waveform.length` is 500;
  - `whileOtherPanel.playing` and `.advanced` are `true`, `advancedTo` is a later track, `afterSpace` is `false` and `afterSecondSpace` `true`;
  - `albumMenu` has 6 icons, 3 ranges, 1 toggle and no scripts; `coverSizeAfterRange` is `"140px"`; `seekMenu` lists the Waveform Appearance controls; `docked.bar` and `dockedInFrame` are `"bottom"`;
  - `escape` is `{ openBefore: true, focus: "IFRAME", armed: true, closed: true }` and `wheelReopened` is `true`;
  - `rescanStatuses` ends with `"✓ 3 tracks imported"`;
  - `afterRestart` keeps the track (not playing), `volume: 0.4`, `bar: "bottom"`, `wallpaperMode: "wallpaper"`, `coverSize: "140px"`;
  - `errors` and `errorsAfterRestart` are empty.
- `security.cjs`:
  - `run1` shows `pending` and `blocked` and `sneakyMainRan` is `false`;
  - `run2` is `approved/active` with a boot frame; `notify` is `"shown true"`
    (`"shown false"` where the system has no notifications, as in a bare
    Linux container), `notifyClicks` is `[{ tag: "t1" }]` and
    `notifyFromPageForOther` is `"refused"`;
  - `run3` is `changed/off`;
  - `run4` shows `audio-player` as `tampered/off` and the rest `verified`;
  - `urlAfterLinkClick` is still `atmos-app://local/index.html`.

## Fixtures

- `fixtures/plugins/hello-frame`: a third-party plugin with a panel, sidebar
  widget and settings page. The panel probes the sandbox (see `panel.js`).
- `fixtures/services/hello-service`: a third-party service whose `boot.js`
  exposes `greet()`.

Together they are also the smallest working examples of the Atmos SDK.
