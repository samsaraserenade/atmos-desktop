# {{name}}

An [Atmos](https://github.com/samsaraserenade/atmos-desktop) extension, made
from Atmos's template: a panel with a counter, and a sidebar widget that
shows the count and asks GitHub how many stars Atmos has. Change anything.

## Run it

Quit Atmos, then start it with this folder as a developer extension:

```sh
# Atmos installed on Windows
"%LOCALAPPDATA%\Programs\Atmos\Atmos.exe" --dev-extension="{{path}}"

# Atmos from source
npm start -- --dev-extension="{{path}}"
```

The panel is in the panel switcher and the widget in the sidebar. It loads
straight from here, without asking for approval, and its frames reload
whenever you save a file. Adding or removing a surface in `extension.json`
needs a restart. Add `--devtools` to open the developer tools (F12).

Settings → Plugins shows it with a **Developer** badge. If an installed
extension already has this folder's name as its id, Atmos loads that one
instead and says so there: remove it, or rename this folder.

## Test it

```sh
npm test
```

The tests run in Node against a fake Atmos (`.atmos-sdk/testing/`).

## What's here

| File | |
|---|---|
| `extension.json` | The manifest: its name, the Atmos it needs (`engines`), its surfaces (`contributes`) and what it may use (`permissions`) |
| `panel.js` | The panel |
| `sidebar.js` | The sidebar widget |
| `src/` | Code both use, kept apart from the page so it can be tested in Node |
| `styles.css`, `icon.svg` | Styles (Atmos's theme arrives as CSS variables) and the icon, drawn in the text colour |
| `tests/` | Tests: `npm test` |
| `.atmos-sdk/` | From Atmos: the SDK's typings (`jsconfig.json` points editors at them), the manifest's schema and the test kit. Never served to a frame |

Each surface runs in its own sandboxed frame and talks to Atmos only through
`import atmos from 'atmos-sdk'`. A frame lasts as long as its surface is
shown, and `atmos.lifecycle` cleans up after it. Work that must outlive a
panel (a socket, a poller) goes in a `boot.js`, which runs all session.

## Permissions

`permissions.network` lists the hosts it may reach, from its frames and
through `atmos.fetch()`, which also works for APIs that send no CORS
headers. Add `"invokes": ["service:location"]` to read the user's location
with `atmos.location`, `"notifications"` under `browser` to show
notifications, and so on. Atmos refuses anything undeclared, and people see
the list before they approve the extension.

## Share it

Copy the folder (without `node_modules`, `tests` and `.atmos-sdk`, if you
like) into `%APPDATA%\atmos\plugins\`. Atmos lists it under Settings →
Plugins as Community, shows its permissions and loads it once approved. Any
change to its files asks for approval again.

## More

`ATMOS_CORE_INTEGRATION.md` in the Atmos repository is the full guide:
section 1 to get going, 3 for the manifest, 4 for the SDK, 7 for
permissions and 8 for the typings and the test kit.
