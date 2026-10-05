# Location service

Your location, set once in Settings → Appearance → Location (detected, or a
place you search for), for the extensions you let read it. An official
service in frames (`"runtime": "frame"`, Atmos 0.21; before, it was part of
Core), installed with an extension that uses it. Removing that extension
leaves it; remove it on its own (refused while an installed extension
requires it).

```text
location/
├── boot.js          # Background frame: keeps the location (atmos.state) and publishes it
├── settings.js      # Its section of Settings → Appearance: Detect, Clear, Search
├── assets/settings.css
└── src/location.js  # What a location is; the geocoders' answers (tests/location.test.mjs)
```

## How extensions read it

`atmos.location.get()` and `onChange(fn)` (SDK 1.0), with
`"invokes": ["service:location"]`: `{ lat, lon, label, mode }`, or `null`
when none is set or this service isn't installed. Declare it as a
dependency so it comes with your extension:

```json
"dependencies": { "location": "^1.0.0" }
```

Readers don't talk to this service. It publishes what it keeps
(`atmos.location.publish`, its own), and Core
(`core/js/core/location-hub.js`) hands that to each reader whose
permission it checks, and to those following it. Only the official
`service:location` may publish.

## Detect

Detect uses the browser's location in this service's frame, which declares
`"geolocation"`. Atmos refuses that permission to it except for a moment
after you press Detect: the button asks Atmos first
(`atmos.location.allowDetect`), and Atmos checks the click landed on this
frame (the main process sees where clicks land), then opens the gate
(`core/js/core/location-gate.cjs`). The place's name comes from
OpenStreetMap Nominatim; Search uses Open-Meteo's geocoding API. Both
through `atmos.fetch` (no cookies, only those two hosts).

## From Atmos 0.20

The first time it starts, it takes over the location Atmos kept itself
(`atmos.location.takeEarlier`, from `core/js/core/location-legacy.js`),
saves it, and only then has Atmos clear its copy
(`atmos.location.forgetEarlier`, once the service's state is on disk). A
choice made on its Settings page meanwhile stands. If its own state can't
be read, it writes nothing.

An upgrading profile gets it when something reads the location: Atmos's
update check installs it once for an installed extension that invokes
`service:location` (unless you removed it).
