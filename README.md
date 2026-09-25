<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/title.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/blacktitle.png">
    <img alt="Atmos" src="docs/images/blacktitle.png" width="100%">
  </picture>
</p>

<p align="center">
  <img alt="Atmos: the settings window over a blurred workspace" src="docs/images/atmos.jpg" width="100%">
</p>

Atmos is a modular desktop environment for Windows: a full-screen workspace
with your wallpaper behind everything, a sidebar of widgets, and panels you
arrange however you like. Everything you use inside it is an extension, and
the core is built to make extensions safe, consistent and pleasant to live
with.

It ships with a music player and an end-to-end encrypted chat client, so
it's useful from the first launch.

## The core

Atmos Core is the environment itself. It owns the shell, and extensions fill it.

- **Panels and layouts.** Show one panel full screen, split two side by side
  or stacked, run four in a grid, or float them as windows you can move,
  resize and layer. Dividers are draggable and every layout remembers its
  proportions. The mouse back button steps through recent panels; hold it
  for Task View.
- **A sidebar of widgets.** Widgets from any extension share one sidebar.
  Reorder them, resize them, collapse them, and choose whether each one
  shows everywhere or only beside a particular panel.
- **Appearance.** Themes, imported fonts, shared positive/negative/neutral
  colours, and per-panel blur and opacity. Atmos draws the frosted glass
  itself, so every extension gets the same material over your wallpaper.
- **Wallpaper.** Any image, with opacity, vignette and brightness controls,
  painted behind the whole workspace.
- **Background audio.** Each extension gets its own playback channel that
  keeps going through panel switches, layout changes and reloads, so
  sounds from different extensions never cut each other off.
- **Menus, notifications and shortcuts.** Right-click menus with toggles,
  sliders and pickers, system notifications, and keyboard shortcuts are all
  provided by Atmos, so extensions look and behave like part of one app.
- **Persistence.** Settings, layouts and each extension's state survive
  restarts, and your data is kept when you uninstall.

## Extensions, safely

Atmos is designed so that you can install things you didn't write.

- **Sandboxed.** Every plugin runs in its own isolated frame and reaches
  Atmos only through the Atmos SDK. It can't see Atmos, other extensions
  or your files. Built-in extensions that keep secrets, such as the chat
  client's encryption keys, get a storage origin of their own too.
- **Declared permissions.** Each extension lists what it needs (network
  hosts, browser permissions, other extensions it talks to) and Atmos
  enforces that list. Settings shows it in plain language.
- **Approval.** An extension you add yourself doesn't run until you approve
  it, and if its files change afterwards, Atmos asks again.
- **Integrity.** An installed Atmos checks its bundled extensions at startup
  and refuses to load any whose files have been changed.
- **Built-in services.** Extensions share capabilities from Atmos (audio,
  wallpaper, location, media tags) rather than each reimplementing them.

## Ships with

### Audio Player

Add your music folders and browse your library as albums, with a player
that lives in a drawer at the bottom of the screen, a waveform seek bar, a
queue that remembers where you were, and Now Playing, Queue and Library
widgets for the sidebar. Space plays and pauses from anywhere in Atmos.

### Matrix Chat

A chat client for [Matrix](https://matrix.org), the open, federated
messaging network, so you can talk to anyone on any Matrix app.

- **Sign in or create an account** on your homeserver's own page, in your
  browser (matrix.org and any server using the Matrix Authentication
  Service), or with a password on other servers. The (i) on the sign-in
  screen explains what a Matrix account is.
- **End-to-end encrypted.** Private rooms and direct messages are
  encrypted. New accounts set up secure messaging with a recovery key;
  a new sign-in confirms it's you with that key or another device, and
  message history comes back from the encrypted key backup.
- **Knows who sent what.** A message from a device its owner never
  verified, a deleted device, or sent unencrypted in an encrypted room says
  so, and you're told when someone's encryption identity changes.
- **Your keys stay yours.** Sign-in tokens and encryption keys are stored
  encrypted with Windows' own secure storage, and deleted when you sign out.
- **Rooms, spaces and DMs** in a sidebar widget, with replies, edits,
  reactions, read receipts, images and files, and several accounts at once.
- **`rev/` commands** in the message bar: `rev/go`, `rev/join`, `rev/dm`,
  `rev/create-room`, `rev/create-space`, `rev/invite`, `rev/leave` and
  `rev/notifications`.

## Install

Download `Atmos Setup <version>.exe` from the
[Releases](../../releases) page and run it. Atmos keeps your settings in
`%APPDATA%\atmos`; uninstalling leaves them.

## Run from source

```sh
npm install
npm start
```

`npm run build` makes the Windows installer (`dist/`), and
`npm run build:portable` makes a portable build.

## Build an extension

Put a folder in `%APPDATA%\atmos\plugins\<id>\` (or `services\<id>\`) with
an `extension.json` declaring its permissions, write its panel, widgets or
background work against the Atmos SDK, and restart Atmos. It appears in
Settings waiting for your approval. The smallest working example is
`scripts/e2e/fixtures/plugins/hello-frame`; the full API is in
[ATMOS_CORE_INTEGRATION.md](ATMOS_CORE_INTEGRATION.md) (§ 18 security,
§ 19 the Atmos SDK).

## Repository layout

```text
Atmos/
├── core/        # The runtime: window, panels, sidebar, settings, the extension host and SDK
├── plugins/     # User-facing extensions (audio-player, matrix-chat)
├── services/    # Capabilities extensions call into (audio, fullscreen-viewer, location, media-metadata, wallpaper)
├── scripts/     # Tests, permission audit, build hook, end-to-end checks
├── release.json # What an installer bundles
└── ATMOS_CORE_INTEGRATION.md   # The extension API
```

## Tests

| Command | What it does |
|---|---|
| `npm run test:core` | Core tests |
| `npm run test:services` | Service contract tests |
| `npm run test:permissions` | Checks each bundled extension's code against its declared permissions |
| `cd plugins/audio-player && node --test tests/*.test.cjs` | Audio Player tests |
| `cd plugins/matrix-chat && npm test` | Matrix Chat tests (`npm run check:browser` adds the message-sanitizer attack checks in a browser) |
| `node scripts/e2e/<name>.cjs` | End-to-end checks in a throwaway profile (Linux/macOS/WSL; see `scripts/e2e/README.md`) |

## Licence

Atmos is licensed under the [Apache License, Version 2.0](LICENSE).
Copyright 2026 hashy; see [NOTICE](NOTICE).

## Rev

Rev is the companion of Atmos — a tiny creature born from a modular world.

The Rev token: https://pump.fun/coin/5dw5MXrnW4wbqerxhUr4jAg92BeRjnux7Nf5RKHhpump

## Community

Follow Atmos development:

- X: https://x.com/atmosdesktop
