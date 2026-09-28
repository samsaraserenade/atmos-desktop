# End-to-end checks

These launch the real Atmos (Electron) against this repo in a throwaway home
folder and drive it with Playwright. They are slower than the unit tests and
are run by hand after changes to extension loading, trust, permissions or
frames.

| Script | Checks |
|---|---|
| `frames.cjs` | Installs `fixtures/` as third-party extensions and approves them, then: panel, sidebar and settings frames; isolation from the Atmos page; CSP refusing undeclared hosts and Atmos's own schemes; blocked navigation and pop-ups; SDK state, events, service calls and a library service (Media Metadata's client); handlers and events another extension doesn't share with community extensions refused, by Core's bridge and again by the main process; Core context menus; split layouts; theme sync; state surviving a restart; memory per process. |
| `libraries.cjs` | Currency and Media Metadata imported into a sandboxed community frame as library services (Media Metadata's file handlers refused to it, since they are shared with official extensions only), Audio Player reading a tag from its background frame, and the libraries still listed under Settings → Services. |
| `audio-player.cjs` | The background layer and Audio Player in frames: Wallpaper carrying over Background's settings and image; Audio Player carrying over its settings, folders, library and waveforms from the page; the Music panel in Atmos's drawer; double-clicking an album playing it from the Audio service; the Queue, Now Playing and Library widgets; playback carrying on under another panel and into the next track; Space; album and waveform menus with icons, ranges and toggles; docking the bar; Escape twice from inside the frame; wheel on the workspace; a library rescan; everything after a restart. |
| `finance.cjs` | Finance in frames against a synthetic VPS (`fake-vps.cjs`): settings, hidden chart ranges and Charting's settings carried over from what the in-page Finance saved (the display currency from the Currency service's old namespace); the panel and six widgets fed by one engine frame (the VPS read once); a widget header menu, whose Currency dropdown changes the totals in every widget; private mode (Hide balances) masking amounts, positions, the server address and the chart's value labels in every widget, and back; the chart menu's ticks and dropdowns; a font imported in Appearance inside a widget; a watchlist symbol opening its chart from the panel's ticker picker; the `]` toggle; settings after a restart; the old `portfolio-vps.json` moved into the sealed connection file, Disconnect showing the pairing form, and pairing again with a code. |
| `matrix-chat.cjs` | Matrix Chat in frames against a fake homeserver (`fake-homeserver.cjs`): the one-time fresh start (the old device signed out, the page's old key store deleted, display preferences kept); the Rooms widget beside Chat only; signing in from the panel; opening a room from the widget; Atmos drawing the panel and composer glass; sending; an incoming message shown and pinging on the Audio service; the message menu's quick-reaction row reacting; Delete asking first; signed in again after a restart with no second fresh start. |
| `finance-lifecycle.cjs` | Finance through the extension manager on a minimal Atmos (Core and the system services only) with a signed local source and the synthetic VPS: installing Finance brings Charting and Currency (required) and Market Data (optional, recommended); with Market Data removed Finance still runs, the chart switcher is hidden, a watchlist click opens nothing and Market Data is offered; installed from that offer, the charts are back; a Finance update changes only Finance; removing Finance keeps its connection and state, and reinstalling finds them; an official service whose `main.cjs` never finishes starting is failed after 10 s, the plugin that needs it skipped, the rest start and Settings says why; removing with Delete clears Finance's data folder. |
| `first-run.cjs` | An installer's extensions made as `after-pack.cjs` makes them (system services built in, the rest signed packages, passed as `--seed-packages`): a first start shows the picker; Finance and Audio Player ticked install with only the services they need, as removable official extensions, and the rest stay Available from "Comes with Atmos"; "Start with none" installs nothing and the picker doesn't return; an upgrade from an Atmos that bundled everything installs it all at once, keeping a switched-off extension off. Then as a release build (no packages; `--setup-source` stands in for the GitHub release): unreachable, the picker offers Try again / Start with none and a restart still shows it; reachable, it installs what's ticked; an upgrade downloads everything in the background and opens Extensions waiting for a restart. |
| `security.cjs` | The Atmos page's lock-down (no injected inline script or string-compiled code, a sandboxed window), approval, re-approval after a change, the `main.cjs` ban, nothing served for an extension waiting for approval, notifications from a frame (and one refused for another extension), tamper detection on a copy of the bundled extensions with `integrity.json`, link and `window.open` handling, browser permissions. |

## Running

Linux or macOS (or WSL). On Windows they refuse to run, because Electron
would use your real `%APPDATA%\atmos` (see `isolate.cjs`).

After `npm install` (the scripts use its Electron):

```sh
npm install --no-save playwright-core
node scripts/e2e/frames.cjs      # JSON report on stdout, screenshots in .tmp/e2e/frames
node scripts/e2e/security.cjs    # screenshots in .tmp/e2e/security
node scripts/e2e/libraries.cjs   # screenshot in .tmp/e2e/libraries
node scripts/e2e/finance.cjs     # screenshot in .tmp/e2e/finance
node scripts/e2e/first-run.cjs # screenshots in .tmp/e2e/first-run
node scripts/e2e/finance-lifecycle.cjs # screenshots in .tmp/e2e/finance-lifecycle (about 3 minutes)
node scripts/e2e/audio-player.cjs # screenshots in .tmp/e2e/audio-player
node scripts/e2e/matrix-chat.cjs  # screenshots in .tmp/e2e/matrix-chat
```

They use the Electron from `devDependencies`; set `ELECTRON_PATH` to use
another. They find the Atmos window with `atmosWindow()` (`isolate.cjs`),
not Playwright's `firstWindow()`: Atmos opens hidden pages of its own at
startup (moving and cleaning up storage), which Playwright lists as windows
too; picking one of those was what made a run fail now and then with "page
closed" during boot. Without a display, prefix with `xvfb-run -a`.

The output is a JSON report, not pass/fail. What to expect:

- `frames.cjs`:
  - (the probe results are under `panel.`) `panel.parent`, `fetchUndeclared`, `fetchResource`, `fetchAppShell`, `fetchPluginScheme` (a scheme that no longer exists) and `fetchFirstPartyFrame` are `"blocked"`;
  - `windowAtmos` and `windowAtmosCore` are `"undefined"`;
  - `invokeUndeclared` and `notifyUndeclared` are an `AtmosPermissionError`;
  - `invokeUnshared` and `invokeMatrixFetch` are an `AtmosPermissionError`
    saying Media Metadata and Matrix Chat don't share those handlers with
    community extensions, and `listenUnshared` says the same of events;
    `mainRefusesUnshared` is the same refusal from the main process, and
    `mainRefusesImpostor` says `plugin:nobody` is not running;
    `sharingSummary` is `["Matrix Chat shares nothing with community extensions", "Hello Service: greet", "Media Metadata shares nothing with community extensions"]`;
  - `collapsedWidget` is `{ open: false, grewBy: 150, restored: true }`;
  - `panel.greet` is a greeting and `panel.library` is `"ok"`;
  - `menuResult.choice` is `"say"`;
  - `panelUrlAfterNavigate` is still the frame's own URL and `topNavigate` is `"SecurityError"`;
  - `settingsFrame` is `"Greeting"`;
  - `tile.presentation` is `"tile"`;
  - `visitsAfterRestart` is one more than `tile.visits` (each panel mount counts as a visit).
- `libraries.cjs`:
  - `audioPlayerTags` is `"Library Probe Song"`; `probe.title` and
    `probe.titleWithoutInvoke` are `null`, and `probe.readRefused` says
    Media Metadata doesn't share `read-file-bytes` with community
    extensions; `probe.symbol` is `"€"`, and `probe.coverWithoutInvoke`
    says there is no route to the main process;
  - every entry in `servicesPage` is `true`;
  - `errors` is empty (Electron's development CSP warning and Finance's
    missing VPS are filtered out).
- `matrix-chat.cjs`:
  - `freshStart.oldTokenSignedOut` is `true`, `freshStart.state` has no sessions, `framesFreshStart: true` and the seeded `showUsernames`/`chatScale`, and `freshStart.pageDatabases` no longer lists `matrix-js-sdk::matrix-sdk-crypto`;
  - `widgetScope` is `{ shownWithChat: true, hiddenElsewhere: true }`;
  - `signedIn`, `widgetListsRoom`, `roomOpened`, `sent`, `sentShown`, `incomingShown`, `reacted` and `notRedacted` are `true`;
  - `glass` is a `panel` piece above a 54 px `shell` piece, `ping.source` is `"ping"`, `quickRow` starts with 👍 and `deleteAsks` is `"Delete this message? Delete Message Cancel"`;
  - every `afterRestart` entry is `true`, and `errors` is empty (matrix-js-sdk's push-rule notes about the fake server are filtered out). Set `NO_PROXY=127.0.0.1` if your shell has an HTTP proxy.
- `finance.cjs`:
  - `surfaces` has the `portfolio-tracker` panel, seven sidebars and `boot:finance`;
  - `balance` is `"€1,988.00"` (the last point of the synthetic history) and `balanceAfterCurrencyToggle` starts with `Fr`, `currencyChangedInOtherFrame` is `true`;
  - `panel.mode` is `"portfolio"`;
  - `copied.charting` is `{"seeded":true}`, `copied.hidden.hidden` is `[{from:1,to:2}]` and `copied.hidden.wallpaper` is `null`;
  - `vpsCalls["/v1/portfolio"]` is 1;
  - `balanceMenu` ends with `Show mini chart` and `Import font…`;
  - `chartMenu` has `ticked` above 0, `selects` `["MA Opacity", "Candle Color Basis"]`, `opacityAfterChoosing` `"40"` and `sessionsToggled` `true`;
  - `appFontInWidget` is `true`;
  - `pickerRows` lists the held and watched symbols (`SOL` among them) and `panelAfterWatchlistClick.markets` is `true` with `SOL` in its text;
  - `afterToggleOff` is the previous panel and `afterToggleOn` is `"portfolio-tracker"`;
  - `afterRestart.connections` still shows `Server: 100.100.1.1:8080`;
  - `connection.sealed` and `sealedAgain` are `true`, `afterDisconnect` shows the pairing-code form, `filesAfterDisconnect` is `[false, false]`, and `afterPairing` shows the server again;
  - `errors` and `errorsAfterRestart` are empty.
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
  - `errors` and `errorsAfterRestart` are empty, apart from Finance's "VPS unavailable" warning (there is no portfolio server in this run).
- `security.cjs`:
  - `pageLockdown` is `{ inlineScript: "blocked", stringTimer: "blocked", sandboxed: true }`;
  - `run1` shows `pending` and `blocked`, `sneakyMainRan` is `false`, and
    `pendingFiles` is `404` (nothing of an extension waiting for approval
    is served);
  - `run2` is `approved/active` with a boot frame; `notify` is `"shown true"`
    (`"shown false"` where the system has no notifications, as in a bare
    Linux container), `notifyClicks` is `[{ tag: "t1" }]` and
    `notifyFromPageForOther` is `"refused"`;
  - `run3` is `changed/off`;
  - `run4` shows `audio-player` as `tampered/off` and the rest `verified`;
  - `urlAfterLinkClick` is still `atmos-app://local/index.html`.
- `finance-lifecycle.cjs`:
  - `1-before` is all `null` and `1-services` is `["audio", "location", "wallpaper"]`;
  - `1-available` lists Charting, Currency, Finance and Market Data;
    `1-pending` installs Charting, Currency, Market Data and Finance, in that order (each with its version), and `1-optionalOffer` is `null`;
  - `2-after` has all four `first-party/verified/active installed`; `2-charts` is `{ switcher: true, marketDataClass: false, rowTitle: "Click to open chart · hold to remove", afterClick: "markets" }`;
    `2-connections` shows `Server: 100.100.1.1:8080`, `2-sealed` is `true`, `2-state` `"kept"`;
  - `3-withoutMarketData` has Finance active and `market-data` `null`; `3-chartsWithout` is `{ switcher: false, marketDataClass: true, rowTitle: "Hold to remove", afterClick: "portfolio" }`;
    `3-installedOffer` names Market Data, `3-pending` is `["install market-data <its repo version>"]` and `3-charts` is like `2-charts` again;
  - `4-updates` is `["finance <repo version> → <patch + 1>"]` (1.0.2 → 1.0.3 today), `4-pending` only Finance, `4-after` the newer Finance and the rest unchanged, `4-previousKept` `false`, `4-connections` connected, `4-state` `"kept"`;
  - `5-alsoOffered` is Charting, Currency and Market Data, all ticked (the script unticks them); `5-defaultChoice` is `"keep"`, `5-afterRemove` has Finance `null` and the three services still installed, `5-connectionFileKept` `true`,
    `5-pendingReinstall` only Finance, and after reinstalling `5-connections` is connected and `5-state` `"kept"`;
  - `6-bootMs` a little over 10 000, `6-list` has `early-stall` off with "Didn't start: it took longer than 10 s", `needs-stall` off with
    "Needs Early Stall, which failed to start" and everything else active; `6-needsStallBootFrame` and `6-ipcWithdrawn` are `false`;
    `6-log` shows Market Data activated after the failure; `6-footer.attention` is `true`; `6-connections` is connected;
  - `7-pending` removes finance, charting, currency and market-data; `7-afterRemove` is all `null` and `7-connectionFileGone` is `true`;
  - every `*-errors` is empty.
- `first-run.cjs`:
  - `packed` is the released extensions and `builtIn` is empty (the system services are part of Core, not bundled);
  - `1-picker` lists Audio Player, Finance and Matrix Chat with descriptions, `1-installBeforeTicking` is `true`,
    `1-pending` is `audio-player, charting, currency, finance, market-data, media-metadata` and `1-setup` `"chosen"`;
  - `2-list` has those six `first-party/active installed`, `2-picker` is `null`, and `2-extensionsPage` lists Fullscreen Viewer and
    Matrix Chat under Available, the six under Installed with Remove, and the source "Comes with Atmos · … built in";
  - `3-settingsOpen` is `false`, `3-setup` `"skipped"`, `3-list` `{}` and `3-picker` `null`;
  - `4-list` has all eight installed and active except `matrix-chat` (`off`), `4-picker` is `null`, `4-setup` `"upgrade"`;
  - `5-offline` says the list couldn't be reached, `5-offlineSetup` is `null` (not done), `5-picker` lists the three plugins after it,
    and `5-list` is Finance with Charting, Currency and Market Data;
  - `6-listAtStart` is `{}`, `6-page` starts with "WAITING FOR A RESTART", `6-setup` is `"upgrade"`,
    `6-afterRestart` has all eight installed and active, and `6-picker` is `null`;
  - every `*-errors` is empty.

## Fixtures

- `fixtures/plugins/hello-frame`: a third-party plugin with a panel, sidebar
  widget and settings page. The panel probes the sandbox (see `panel.js`).
- `fixtures/services/hello-service`: a third-party service whose `boot.js`
  exposes `greet()`.

Together they are also the smallest working examples of the Atmos SDK.
