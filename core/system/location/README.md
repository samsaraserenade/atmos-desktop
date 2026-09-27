# Location service

The user's location, for Atmos itself. DOM-free core logic plus a section in
Settings → Appearance for choosing a location. Extensions can't read it yet:
the SDK has no location call.

Part of Core (`core/system/location`): Core loads it itself
(`core/js/core/system-services.js`). It is always on, and is never
installed, packaged or switched off.

## Contract

`index.js` (imported by Core's own code; `settings.js` uses it):

| Export | Purpose |
|---|---|
| `getLocation()` | `{ mode: 'auto' \| 'manual', lat, lon, label }` (`lat` is `null` when unset) |
| `hasLocation()` | Whether a location is set |
| `detectLocation()` | Browser geolocation plus reverse geocoding; resolves with the location. For an explicit request only: the Atmos page's location permission is refused except briefly after this is called (`core/js/core/location-gate.cjs`) |
| `searchLocations(query)` | Up to 5 place matches |
| `setLocation(place)` | Use a result from `searchLocations` |
| `resetLocation()` | Clear back to unset |
| `onLocationChange(fn, options)` / `onLocationError(fn, options)` | Subscribe; pass `{ signal }` for lifecycle cleanup |

The location is stored in the `location` state namespace (migrated from the
old flat state). Geocoding uses the Open-Meteo geocoding API; reverse
geocoding uses OpenStreetMap Nominatim.

UI: `settings.js` adds a Location section to Settings → Appearance with
detect, clear and search.

Location is off by default: nothing reads it until you press Detect or pick
a place, and the browser permission itself is refused at any other time.
No bundled plugin reads the location yet.
