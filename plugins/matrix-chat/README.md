# Matrix Chat plugin

Matrix chat for Atmos. First-party, runs in frames (`"runtime": "frame"`).

```text
matrix-chat/
├── extension.json        # Frames contract: Chat panel, Matrix Chat and Matrix Account widgets, boot frame
├── boot.js               # Background frame: the Matrix engine, for the whole session
├── panel.js              # "Chat" panel: sign-in, the open room (the last one reopens)
├── sidebar.js            # "Matrix Chat" widget: invites, DMs and each space as groups
├── sidebar-account.js    # "Matrix Account" widget: accounts, profile, security, log out
├── main.cjs              # Homeserver requests (no CORS), saving downloads, sign-in callbacks
├── oauth-callback.cjs    # One-time 127.0.0.1 listener for browser sign-in (main process)
├── package.json          # Runtime and build dependencies
├── assets/               # Stylesheets and image assets
├── build/                # Bundle entry points and checks
├── data/                 # Local exports; do not share or commit
├── src/                  # Matrix client, caches, queues (engine)
│   ├── state.js          # Saved state (the `matrix-chat` namespace), engine only
│   └── ui/               # The views; ui/engine.js is their way into the engine
├── tests/                # Request, lifecycle, and memory checks
├── vendor/               # Generated SDK bundles and crypto WASM
└── node_modules/         # Installed dependencies
```

**Engine and views.** The Matrix connection (sync, encryption, unread
counts, the notification ping) runs in the background frame, `boot.js`,
which publishes the engine on its window. The panel and the Rooms widget
are first-party frames on the same origin, so `src/ui/engine.js` finds it
with `atmos.background()` and the views call it directly and read its live
SDK objects: nothing is copied between frames. Every listener a view adds
through `engine.js` is removed when its frame goes. Objects from the engine
belong to the background frame's realm (use `Array.isArray`, not
`instanceof`). Which room the panel shows is kept by the engine
(`engine.view`), so choosing a room in the widget opens it in the panel.

**Atmos pieces it uses.** The ping plays on Matrix Chat's channel of the
Audio service. Atmos draws the panel's glass (`"glass": true`; the room
view and composer are marked `data-atmos-glass`). Message and room menus
are Atmos menus (the quick reactions are a button row); deleting a message
or leaving a room asks again in a second menu. Images set the wallpaper
through the Wallpaper service; the fullscreen viewer is the
`fullscreen-viewer` library. Links open in the system browser; downloads
are saved by `main.cjs` (frames can't download). The Rooms widget shows
beside the Chat panel by default (`"showIn"`).

**Signing in and creating accounts.** Homeservers that run the Matrix
Authentication Service (matrix.org and others) use OAuth sign-in: the
sign-in screen asks the homeserver what it supports (`getSignInOptions`)
and shows *Continue with …* and *Create an account*. Both open the
homeserver's own page in the system browser (`shell.openExternal`, never an
Atmos window); captchas, terms, email checks and "Continue with GitHub" all
happen there. When the person finishes, the page redirects to a one-time
listener on `127.0.0.1` (`oauth-callback.cjs`), which answers only the
matching `state`, brings Atmos forward and closes. `src/oauth.js` holds the
PKCE verifier and exchanges the code for tokens. Atmos registers itself with
each auth server once (`oauthClients` in saved state), with
`client_uri` = the GitHub repo, which the server shows on its consent page.

OAuth access tokens last minutes. The SDK refreshes them through
`tokenRefreshFunction`, and the new refresh token is saved immediately,
since the server replaces it on every use. Signing out revokes the refresh
token. OAuth accounts get *Manage account* in the account menu (the
server's `account_management_uri`). Password homeservers keep the classic
form, and OAuth homeservers that still allow passwords offer it behind a
link. The (i) button explains what a Matrix account is.

**Secure messaging set-up.** A brand-new account has no encryption
identity. The account menu's Security section then offers *Set up*
(`setUpSecureMessaging` in `crypto-service.js`): it creates cross-signing
keys (the first upload needs no re-authentication, MSC3967), secret storage
and a key backup (an existing backup is kept), and shows a recovery key to
copy or save as a file. The key stays in memory only until *I've saved my
recovery key → Done*. Accounts that already have keys elsewhere never get
this; they verify with another device or use their recovery key.

**Secrets at rest.** Nothing secret is stored readable:

- **Own origin.** Matrix Chat's frames run in `atmos-ext://first-party-plugin-matrix-chat`
  (`"isolation": "origin"`), like every bundled official extension, so no
  other extension can open its storage or script its frames.
- **Vault key.** `vault.cjs` (main process) keeps one random 256-bit key,
  encrypted with the OS's secure storage (Electron `safeStorage`: DPAPI on
  Windows). `src/vault.js` derives two keys from it with HKDF: one seals the
  saved sessions (access/refresh tokens) with AES-256-GCM before they reach
  Atmos's saved state (`state.js`: `sealedSessions`); the other is the
  `storageKey` of every encryption database.
- **One encryption database per account and device**
  (`atmos-matrix::<user>::<device>`), deleted when that device ends (log out,
  remove, a rejected token, or signing in again as a new device). A deletion
  cut short by quitting is finished on the next launch
  (`pendingStoreDeletions`).
- **Secure start.** Storage version 2 started afresh: sessions saved as plain
  text before it are signed out of the homeserver and dropped, and the old
  databases are deleted (the page's by `legacyStorage.deleteIndexedDB`, the
  shared origin's by Core via `legacyStorage.sharedOriginIndexedDB`). You
  sign in again; your recovery key or another device unlocks message history.
  Display preferences are kept. If the vault key can't be read (another
  computer's or user's secure storage), a new one is made and you sign in again.

**Who sent this.** `trust-service.js` turns the SDK's per-message verdict
(`getEncryptionInfoForEvent`) into a line under a message whose sender
can't be confirmed (an unverified or deleted device, a forged sender, a
backup-restored key) and flags messages sent unencrypted in an encrypted
room. When someone in the room changes their encryption identity, a notice
sits above the message bar until you press OK (which pins the new identity,
or withdraws a verification that no longer holds).

**Untrusted content and the network.** Message HTML goes through
`html-sanitizer.js`: an allowlist of tags and attributes, links limited to
safe schemes, images to `mxc:` only (no remote tracking pixels), `<code
class>` to `language-*`, and bodies over 64 KB shown as plain text.
`npm run check:browser` runs a corpus of XSS payloads against it (`--out
<file>` writes the page for another Chromium). The frames declare no
network beyond names that appear as text; every Matrix request goes through
`main.cjs`, which sends no cookies and drops spoofing headers (Cookie,
Origin, Host, Sec-*, proxy and framing). It holds each answer whole in
Atmos's main process, so it bounds them: 100 MB an answer or upload, 256
MB of answers being read at once, 16 requests at a time (the rest wait
their turn), and 5 minutes without a byte (plus, before the answer, time
for an upload to be sent at 64 KB/s). Homeservers must be `https://`
(plain http only on this computer).

Run the checks from this directory, after `npm ci` (the tests import
`node_modules/matrix-js-sdk`):

```powershell
npm test
npm run check
npm run check:browser
```

End to end, against a fake homeserver: `scripts/e2e/matrix-chat.cjs`.

The generated attachment bundle is consumed from `vendor/`; its source entry is `build/attachment-entry.js`.

## Runtime boundaries

- `src/client.js` is the engine's public API, used by `boot.js` and (through
  `src/ui/engine.js`) the views.
- `src/session-runtime.js` serializes session initialization. Each runtime owns
  its SDK listeners, cancellation controller, caches and room service. Replaced
  sessions cannot start syncing or initiate further upload/send steps. A failed
  additional login leaves the existing connection running.
- `messaging-service.js`, `media-service.js`, `crypto-service.js`,
  `room-service.js` and `space-service.js` receive a specific runtime. They do not look up a replacement
  client midway through an operation. Keep that rule when adding async work.
- `preferences.js` reads persisted state through `preference-store.js`. Both
  background notifications and UI depend on this layer, which has no UI imports.
- `space-service.js` lists a space's rooms whether or not you've joined them
  (the space hierarchy API), creates rooms and spaces (a room made in a space
  is linked to it, and by default anyone in the space can join it), joins by
  address or matrix.to link, and handles room and space invites.
- There is no separate home or settings page. The Chat panel opens straight
  into the last room you had open (`engine.view` keeps one per account in
  `lastRooms`); with none, `ui/empty-view.js` shows an empty timeline and the
  message bar.
- `rev/` commands in Atmos's command bar (SDK 1.3): `rev/go`, `rev/join`,
  `rev/dm`, `rev/create-room`, `rev/create-space`, `rev/invite`,
  `rev/leave`, `rev/notifications` (the ping sound, on or off), declared in
  `extension.json` (`contributes.commands`) and answered in the background
  frame by `ui/command-handlers.js`, so they work from any panel (Alt+\\)
  with the Chat panel closed. In the Chat panel the bar opens over the
  message bar (`atmos.commands.bar`), and typing `rev/` there hands what's
  typed to it (`atmos.commands.field`, keys typed fast following it); `@`
  mentions and plain text are untouched, and a command is never sent as a
  message. The two create
  commands offer their options as chips (which space, who can join,
  encryption, an address); creating a space goes straight on to its first
  room. Needs Atmos 0.20.0 (`engines`).
- Two sidebar widgets. Matrix Chat: invites, then one list of collapsible
  groups (Direct Messages, each space with the rooms you haven't joined,
  Other rooms); which are open is saved. Matrix Account: your profile, saved
  accounts, notifications (the ping sound), device security and log out, the
  sections of `ui/settings-menu.js` always open. Names show as display names;
  there is no usernames setting. Status and destructive actions use Atmos's semantic colors
  (`--color-positive`, `--color-negative`).
- `room-projection.js` derives spaces, DMs and requests from SDK rooms.
  `ui/room-list.js` stays mounted, coalesces updates and reconciles keyed rows.
- `ui/timeline-controller.js` owns pagination and ignores results after disposal.
  `ui/composer-controller.js` owns attachment previews and send-batch lifetime.
  `ui/room-view.js` keeps DOM rendering and interaction wiring.

The architecture and client integration tests import real modules with fake SDK
clients. Browser checks exercise the real room-list controller and panel with a
fake engine in a temporary, headless Edge profile; no Matrix account is accessed.
Set `MATRIX_TEST_BROWSER` to another Chromium executable if needed. The module
check links the renderer entry points without rewriting vendor bundles.

Plain attachment preparation no longer reads an extra full-file buffer. Uploads
use the session cancellation controller. The IPC transport still buffers complete
request and response bodies; a streaming transport remains a separate change
requiring host integration and large-file measurements.
