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
| `finance.cjs` | Finance in frames against a synthetic VPS (`fake-vps.cjs`): settings, hidden chart ranges and Charting's settings carried over from what the in-page Finance saved (the display currency from the Currency service's old namespace); the panel and six widgets fed by one engine frame (the VPS read once); a widget header menu, whose Currency dropdown changes the totals in every widget; private mode (Hide balances) masking amounts, positions, the server address and the chart's value labels in every widget, and back; the chart menu's ticks and dropdowns; a font imported in Appearance inside a widget; a watchlist symbol opening its chart from the panel's ticker picker; settings after a restart; the old `portfolio-vps.json` moved into the sealed connection file, Disconnect showing the pairing form, and pairing again with a code. |
| `matrix-chat.cjs` | Matrix Chat in frames against a fake homeserver (`fake-homeserver.cjs`): the one-time fresh start (the old device signed out, the page's old key store deleted, display preferences kept); the Rooms widget beside Chat only; signing in from the panel; opening a room from the widget; Atmos drawing the panel and composer glass; sending; an incoming message shown and pinging on the Audio service; the message menu's quick-reaction row reacting; Delete asking first; signed in again after a restart with no second fresh start. |
| `official-packages.cjs` | Signed packages with a test key (`--trusted-keys`): Sample (an official-style fixture, `fixtures/official`) packed and signed as a `.atmos` and unpacked into the installed folder loads as Official in first-party frames of its own origin; a signed plugin's `main.cjs` is activated and an unsigned one's is blocked; one changed file makes it tampered (not Community); unsigned or signed by an unknown key it's Community, waiting for approval; a signed newer version (the repo's, patch + 1) wins over the bundled one and, damaged, falls back to it with Settings saying so; Charting switched off stops Finance with the reason shown, and Charting lists Finance under "Used by". |
| `extension-manager.cjs` | Settings → Extensions with a local source (a signed index and packages of the Sample fixture): the footer button opens it; Install stages the package and the button asks for a restart in the negative colour; after the restart it runs as Official; a 0.9.1 update shows (nothing downloaded until Update) and replaces it, the kept 0.9.0 deleted once it loads; Remove asks, keeping data by default, and a reinstall finds its saved state; Remove with Delete clears it; a package changed on the source after signing is refused with the reason shown; an index naming a newer Atmos shows "Atmos X is available" with a Download button in Settings → Atmos, and beside the footer's version. |
| `atmos-update.cjs` | Atmos updating itself (`atmos-update.cjs`), with a local source whose signed index names Atmos 99.0.0 and its installer, and `--update-test-install` standing in for an installed copy (what would run is written to a file): the check downloads and checks the installer by itself, Settings → Atmos says it's ready and installs on quit, and the footer's version says it's ready; "Update Atmos automatically" off and on, saved; quitting runs the checked installer with `--updated /S` and records the attempt; the next start uses the download again and "Restart to update" quits with `--force-run`; Restart to apply installs a waiting update instead of relaunching; an installer that doesn't match the index is refused with the reason, Try again and the download page, nothing kept or run; with automatic updates off, Download, then ready, nothing on quit; the source unreachable at the next check, the update waiting stands, kept, and installs on quit. |
| `source-fetch.cjs` | Not through Atmos: Electron runs it as its main process. Downloads from sources (`source-fetch.cjs`) against local https and http servers: an https file and an https-to-https redirect; redirects to http, `file:` and a custom scheme refused, and endless ones; Atmos's own schemes never reached (a plain `net.fetch` would); a declared or real size past the limit; an error status; a 2 MB download written whole with progress, and refused past its signed size; a server that stalls mid-body, and one that never answers; an abort; a file that can't be written. |
| `finance-lifecycle.cjs` | Finance through the extension manager on a minimal Atmos (Core and the system services only) with a signed local source and the synthetic VPS: installing Finance brings Charting and Currency (required) and Market Data (optional, recommended); with Market Data removed Finance still runs, the chart switcher is hidden, a watchlist click opens nothing and Market Data is offered; installed from that offer, the charts are back; a Finance update changes only Finance; removing Finance keeps its connection and state, and reinstalling finds them; an official service whose `main.cjs` never finishes starting is failed after 10 s, the plugin that needs it skipped, the rest start and Settings says why; removing with Delete clears Finance's data folder. |
| `first-run.cjs` | An installer's extensions made as `after-pack.cjs` makes them (Atmos Browser built in, bundled; the rest signed packages, passed as `--seed-packages`): a first start shows the picker without Atmos Browser ("Atmos Browser is built in", and "Just Atmos Browser" to skip); Finance and Audio Player ticked install with only the services they need, as removable official extensions, and the rest stay Available from "Comes with Atmos"; Atmos opens on the browser; "Just Atmos Browser" installs nothing and the picker doesn't return; an upgrade from an Atmos that bundled everything installs it all at once (never over the built-in browser), keeping a switched-off extension off. Then as a release build (only the browser bundled; `--setup-source` stands in for the GitHub release): unreachable, the picker offers Try again / Just Atmos Browser and a restart still shows it; reachable, it installs what's ticked; an upgrade downloads everything in the background and opens Extensions waiting for a restart. |
| `origin-move.cjs` | Official extensions' storage moving out of the shared first-party origin: Finance and Audio Player as they were (sharing `atmos-ext://first-party`) leave data there (Blobs, an ArrayBuffer, localStorage keys, plus a database and a key nobody declares, and a value in `atmos.state`); with the move made to time out they run from the shared origin once more and Settings says why; then the data is copied into each one's own origin and read there, with the shared copies still in place; at the next start the shared copies of what moved are gone, and what nobody declared stays. |
| `security.cjs` | The Atmos page's lock-down (no injected inline script or string-compiled code, a sandboxed window), approval, re-approval after a change, the `main.cjs` ban, nothing served for an extension waiting for approval, nothing served through a link out of an approved extension's folder, notifications from a frame (and one refused for another extension), tamper detection on a copy of the bundled extensions with `integrity.json`, link and `window.open` handling, browser permissions. |
| `sdk.cjs` | SDK 1.0 from developer folders (`--dev-extension`): they load without approval as Community, and one whose `engines` needs a later Atmos doesn't; `atmos.fetch()` against a local HTTPS server that sends no CORS headers (`--fetch-test`), with a POST, a redirect, and the refusals (an undeclared host, a redirect to one, an address, plain http) and an abort; `atmos.location` before and after the location changes; `atmos.lifecycle` cleaning up as a frame goes; a saved file reloading the frame; a changed `extension.json` taking a new host without a restart; the extension template as `npm run new:extension` makes it, with its panel's glass and its widget's `atmos.fetch()`. |
| `contract.cjs` | The SDK contract (`scripts/sdk-contract/contract.js`) in the panels of two developer folders, one declaring the system services and notifications and one declaring nothing, compared with `scripts/sdk-contract/expected.json` and with the fake Atmos running the same script. |
| `community-sources.cjs` | A community extension from a GitHub repository (releases served from a folder with `--github-releases`), packed by the SDK's `pack.cjs` and signed: added as a source by its github.com address (card: the repository, Community, 1 package); Available with a Community badge; Install says you'll review it after the restart; after it, Waiting for your approval, and the card says Signed, its key and where it's from; Approve runs it; 1.1.0 signed with another key says it asks for approval again, and after Update and a restart the review says the key changed. |
| `approval.cjs` | Two community extensions copied in by hand (Skyloom reads the location and shares a snapshot with every extension; Sky Reader needs it): the footer and Settings → Extensions say they wait for approval, Review opens Skyloom's card with what it shares and the location warning; Sky Reader approved alone waits for a restart, and approving Skyloom loads both at once; Sky Reader gets Skyloom's snapshot but not the location; both load after a restart. |
| `browser.cjs` | Atmos Browser (`plugins/browser`) on Core's web layer, against local pages over http and https (`browser-pages.cjs`; the https certificate isn't trusted), with real X input (`xinput.py`): no browser session on disk before the first page; Atmos opening on the browser (built in), with the sidebar open on its Tabs widget (a first start); the address bar (suggestions drawn over the page, an address or a search, `javascript:`, `file:` and `atmos-app:` refused); the site's icon decoded apart and drawn again by Core (a 32×32 PNG), and a broken one refused; links, back and forward, history; Ctrl+T, Ctrl+Tab, Ctrl+W, Ctrl+Shift+T, Ctrl+L; keys typed in a page reaching the page and never Atmos's single-key shortcuts; zoom per site; find in page; pop-ups only after a real click, one each (one without a click blocked, with a notice whose Open takes no click the moment it appears; two from one click, the second blocked; a click in an embedded frame of another site letting that frame open one), `target=_blank` and `window.open` as tabs, a sign-in pop-up as a window with its opener, and a pop-up window refused fullscreen; downloads (a safe name, a document opened, a program never, a page's second download without a click stopped with a notice and fetched from its Download); a `mailto:` link asking first; `file:` and `atmos-app:` links refused; a location prompt (no answer from a click the moment it appears; Block and Allow, clicked as the user would, remembered and taken back from Settings), notifications and reading the clipboard, and a frame of another site asking (the prompt names the page's site; its notifications refused); the certificate interstitial with no way on, and no client certificate sent; mixed content blocked; Chrome's user agent; Chrome's `window.chrome` members before a page's own scripts (Core's page preload; in a sign-in pop-up too), no FedCM, and Chromium's client hints on a navigation, the brands the page reads; the ad and tracker blocker with small local lists (`--browser-filter-lists`): an ad server's script, a tracker's (a stand-in) and a pixel blocked, a scriptlet before the page's scripts (a page's scriptlets together, nothing left on its window, uBlock Origin's `proxy-apply-config` reaching the others: `Function.prototype.toString` untouched, as X needs; an "isolated" one rewriting an inline script from a world of its own on a page that enforces Trusted Types and breaks rewriting in its own world, as YouTube's rules need; an argument with a "%"), ad slots hidden by site, class and id (a late one too) and the article left alone, `utm_source` taken off, the count in the shield and by site, a trusted scriptlet from uBlock Origin's list but not from EasyList's, a page on an ad server still opening, the shield down and up, blocking off for all, a private tab, a page's first requests judged as its own (not by the page before, whose shield was down), and after a restart; a closed tab's page running its `beforeunload`, `pagehide` and `unload` first, and a page open as Atmos quits saving the same way; a page that sets no background white, not see-through; Atmos's menu, Settings and Task View over a page; another panel, a column and a panel window; the Tabs widget; private tabs' cookies and history; a site's icon fetched without its cookies, and never from a local address the page isn't on; the hostile page (Atmos's schemes, files and globals out of reach, and Atmos's own IPC refused to it); links from Atmos with "Open links in Atmos Browser" (in a tab behind without a click just before, in front after one); pages put away; HTML fullscreen with Atmos's notice over it naming the site, Escape, and Atmos taking a page out of fullscreen when it replaced `exitFullscreen`; tabs, bookmarks, history and the settings page after a restart; removing it with its data. |
| `system-services.cjs` | From a developer folder: an audio channel with `loop: true` (silence at the loop point measured at the element's output, next to the seek-and-play workaround), `id` reported back; a wallpaper the extension sets, shown in Settings → Appearance as its own and restored there; a settings page and a widget with an `html, body { height: 100% }` reset sized to their content (the widget growing and shrinking); a widget whose content is all out of the flow warning in its console; `/__atmos/ui.css` giving a settings row Atmos's own padding, sizes and switch. |

## Running

Linux or macOS (or WSL). On Windows they refuse to run, because Electron
would use your real `%APPDATA%\atmos` (see `isolate.cjs`).

After `npm install` (the scripts use its Electron):

```sh
npm install --no-save playwright-core
node scripts/e2e/frames.cjs      # JSON report on stdout, screenshots in .tmp/e2e/frames
node scripts/e2e/security.cjs    # screenshots in .tmp/e2e/security
node scripts/e2e/official-packages.cjs # screenshots in .tmp/e2e/official-packages
node scripts/e2e/extension-manager.cjs # screenshots in .tmp/e2e/extension-manager
node scripts/e2e/atmos-update.cjs # report.json and screenshots in .tmp/e2e/atmos-update
node_modules/.bin/electron scripts/e2e/source-fetch.cjs --no-sandbox # JSON on stdout (not through Atmos)
node scripts/e2e/libraries.cjs   # screenshot in .tmp/e2e/libraries
node scripts/e2e/finance.cjs     # screenshot in .tmp/e2e/finance
node scripts/e2e/first-run.cjs # screenshots in .tmp/e2e/first-run
node scripts/e2e/finance-lifecycle.cjs # screenshots in .tmp/e2e/finance-lifecycle (about 3 minutes)
node scripts/e2e/audio-player.cjs # screenshots in .tmp/e2e/audio-player
node scripts/e2e/matrix-chat.cjs  # screenshots in .tmp/e2e/matrix-chat
node scripts/e2e/origin-move.cjs  # progress in .tmp/e2e/origin-move/progress.json
node scripts/e2e/sdk.cjs          # screenshots in .tmp/e2e/sdk
node scripts/e2e/contract.cjs     # reports in .tmp/e2e/contract
node scripts/e2e/approval.cjs     # screenshots in .tmp/e2e/approval
node scripts/e2e/community-sources.cjs # screenshots in .tmp/e2e/community-sources
node scripts/e2e/system-services.cjs # screenshots in .tmp/e2e/system-services
node scripts/e2e/browser.cjs      # report.json and screenshots in .tmp/e2e/browser (about 2 minutes)
```

`browser.cjs` needs an X display (it sends real clicks and keys through
XTest, as the OS would, since that is how input reaches a web page), so it
needs python3-xlib (`pip install python-xlib`) and ImageMagick's `import`
(it reads pixels off the screen). It takes the proxy variables out of
Electron's environment, since its pages are local. `E2E_ELECTRON_ARGS` adds
switches, e.g. `--use-angle=swiftshader --enable-unsafe-swiftshader` for
GPU compositing (in software) where there is no GPU.

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
- `origin-move.cjs`:
  - `1-origins` are all `atmos-ext://first-party`; `2-origins` too, with
    every `2-moves` entry `failed` ("it took longer than 1 s"), one
    `2-problems` line each and `2-finance` still reading its data;
  - `3-origins` are `atmos-ext://first-party-plugin-<id>`; every `3-moves`
    entry is `copied` (Audio Player 3 records, Finance 1 record and 4 keys);
    `3-read` finds the `"text/plain 10 hello blob"` Blob and Finance's values,
    with `unrelated` `null`; `3-shared` still lists everything; `3-state` is
    `"kept"`;
  - `4-shared` is only `unrelated-db` and `unrelated:key`, every `4-moves`
    entry is `cleaned: true`, and `4-read` is the same as `3-read`;
  - every `errors` list is empty.
- `contract.cjs`: every list under `all` and `none` is empty (the runtime,
  the fake and `expected.json` agree), and `errors` is empty. When Atmos
  changes what a call gives on purpose, update `expected.json` from
  `.tmp/e2e/contract/*-runtime.json`, and `npm run test:sdk` shows where the
  fake must follow.
- `approval.cjs`:
  - `before` is both `pending/off`; `footerBefore` is `attention: true`,
    "Extensions: 2 extensions need your approval";
  - `managerWaiting` lists Skyloom and Sky Reader with Review, and
    `reviewOpened` is `{ highlighted: true, page: "Extensions" }`;
  - `skyloomPrompt` has "Know your location, as set in Atmos", "Shares with
    other extensions", "Any extension can call snapshot(): The sky's colours
    now, without your location" and the warning, which is `skyloomCaution`;
  - `readerAlone` says "Approved. Restart Atmos to apply." and
    `afterReaderAlone` is still both `pending/off`;
  - `afterSkyloom` is both `approved/active`, `panels` has `skyloom` and
    `sky-reader`, `bootFrame` is `true`;
  - `skyloomCard` and `readerCard` say "Approved. It’s running now.";
    `readerDetails` has "Skyloom: snapshot (The sky's colours now, without
    your location), sky events";
  - `icons.skyloom` is `true` (Sky Reader has no icon: `false`);
    `footerAfter.attention` is `false`;
  - `readerPanel` is `{ snapshot: { palette: […] }, location:
    "AtmosPermissionError" }`;
  - `afterRestart` is both `approved/active`, and every `errors*` is empty.
- `system-services.cjs`:
  - `loopLoad` is `{ id: "tone", source: "tone", loop: true }`; `loop` has
    `longestSilenceMs` of a block or two (about 6–12) and `loopState` has
    `playing: true`, `ended: false`, `endedEvents: 0`; `workaround` has
    `restarts` of 3 (its silence is as small: measured at the element's
    output, neither shows the ~100 ms that `captureStream()` reports at
    every loop point);
  - `wallpaperSet.canRestore` is `true`; `wallpaperRow` is "Set by Sky
    Probe" with the Restore button, titled "Put back the Atmos default";
    `afterRestore` is `{ kind: "default", status: "The Atmos default",
    restoreShown: false }` and `canRestoreAfter` is `false`;
  - `settingsHeight` is over 100; `uiCss` matches `atmosRow` (padding
    `5px 14px`, label `11.52px`) with `rowDisplay: "grid"`, a `34px`
    switch with `switchAppearance: "none"`;
  - `widgetTall` is 120 and `widgetShrunk` 40; `ghostWarning` is the SDK's
    "This widget measures 0 px tall" line; `errors` is empty.
- `browser.cjs`: the report is pass/fail: `summary` is "129 of 129 checks
  passed" and `failed` is empty (it exits 1 otherwise). `details` has what
  each failed check saw, and `gpu` how Chromium draws on this machine.
  `retriedCtrlT` is set when Xvfb lost the first Ctrl+T (a key sent before
  the window has settled is lost now and then).
- `security.cjs`:
  - `pageLockdown` is `{ inlineScript: "blocked", stringTimer: "blocked", sandboxed: true }`;
  - `run1` shows `pending` and `blocked`, `sneakyMainRan` is `false`, and
    `pendingFiles` is `404` (nothing of an extension waiting for approval
    is served);
  - `links` is `{ outFile: 404, outDir: 404, inside: 200 }`: links added to
    an approved extension's folder (they aren't in its fingerprint) serve
    nothing from outside it;
  - `afterApprove` is already `approved/active` (approving loads a
    community extension at once);
  - `run2` is `approved/active` with a boot frame; `notify` is `"shown true"`
    (`"shown false"` where the system has no notifications, as in a bare
    Linux container), `notifyClicks` is `[{ tag: "t1" }]` and
    `notifyFromPageForOther` is `"refused"`;
  - `run3` is `changed/off`;
  - `run4` shows `audio-player` as `tampered/off` and the rest `verified`;
  - `urlAfterLinkClick` is still `atmos-app://local/index.html`.
- `extension-manager.cjs`:
  - `1-available` lists Sample under Available; `1-pending` under
    Waiting for a restart; `1-footer` has `attention: true` and "Restart to
    apply changes";
  - `2-after` is `first-party/verified/active installed 0.9.0`, `2-state` `"kept"`;
  - `3-update` lists `0.9.0 → 0.9.1`, `3-downloadedBeforeUpdate` is empty,
    `3-after` is `… 0.9.1`, `3-previousKept` is `false`;
  - `4-defaultChoice` is `"keep"`, `4-afterRemove` is `null`, `4-stateKept` is `"kept"`;
  - `5-stateAfterDelete` is `null`;
  - `6-error` says the package is too large (it grew after signing, and downloads stop at the index's size), `6-pending` is `0`;
  - `7-atmosRow` is "Atmos 99.0.0 is available You have <the repo's version>. …", `7-download` is `true`, and `7-footer` (the footer's version) is "Version <the repo's version> · 99.0.0 available" with the title "Atmos 99.0.0 is available";
  - `1-errors` and `errors` are empty.
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
    Matrix Chat under Available and the six under Plugins and Services with Remove (Atmos Browser, built in, without);
  - `3-settingsOpen` is `false`, `3-setup` `"skipped"`, `3-list` `{}` and `3-picker` `null`;
  - `4-list` has all eight installed and active except `matrix-chat` (`off`), `4-picker` is `null`, `4-setup` `"upgrade"`;
  - `5-offline` says the list couldn't be reached, `5-offlineSetup` is `null` (not done), `5-picker` lists the three plugins after it,
    and `5-list` is Finance with Charting, Currency and Market Data;
  - `6-listAtStart` is `{}`, `6-page` starts with "WAITING FOR A RESTART", `6-setup` is `"upgrade"`,
    `6-afterRestart` has all eight installed and active, and `6-picker` is `null`;
  - every `*-errors` is empty.
- `official-packages.cjs`:
  - `1-list`: `sample` and `signed-main` are `first-party/verified/active`
    from `installed`, `unsigned-main` is `third-party/blocked/off`;
    `1-bootFrameOrigin` is `first-party-plugin-sample`; `1-mainActivated` is `["signed-main"]`;
  - `2-list` is `first-party/tampered/off` (changed `boot.js`), with no boot frame;
  - `3-unsigned` and `3-unknownKey` are `third-party/pending/off`;
  - `4-newer` is `1.0.1` (the fixture's version with the patch number raised), from `installed`;
    `4-fallback` is `1.0.0` from `bundled`, active, with `fellBackFrom`
    naming `engine.js`; `4-bootFrameOrigin` is `first-party-plugin-sample`;
  - `5-list`: `finance` is `off` with "Needs Charting, which is switched off",
    `charting` and `market-data` list Finance under `usedBy`;
  - `1-errors` and `5-errors` are empty.

## Fixtures

- `fixtures/plugins/hello-frame`: a third-party plugin with a panel, sidebar
  widget and settings page. The panel probes the sandbox (see `panel.js`).
- `fixtures/services/hello-service`: a third-party service whose `boot.js`
  exposes `greet()`.
- `fixtures/official/plugins/sample`: an official-style plugin (a panel, a
  background frame that imports a second file, and saved state) that
  `official-packages.cjs` and `extension-manager.cjs` sign and install.
- `fixtures-sdk/sdk-probe`: the developer folder `sdk.cjs` loads; its panel
  probes `atmos.fetch()`, `atmos.location` and `atmos.lifecycle`.

For a working example to start from, use the extension template
(`npm run new:extension`), which `sdk.cjs` also runs.
