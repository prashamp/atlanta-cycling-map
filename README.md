# 🚲 Atlanta Cycling Map

An interactive, mobile-responsive map of Atlanta, GA focused on cycling — bike
infrastructure, neighborhood boundaries, destinations, rider-helpful route info,
and a toggleable crash-safety layer.

**To use it:** open `index.html` in any browser (needs internet access for the
basemap tiles and address geocoding — everything else is embedded in the file).

## Features

| Feature | Where |
|---|---|
| Bike infrastructure, color-coded by type (protected / buffered / standard / trails / sharrows) | Map lines + sidebar toggles |
| Neighborhood boundaries with subtle labels | Dotted gray overlays |
| Parks, BeltLine access points, bike shops/rentals, cafes & breweries, landmarks, MARTA stations | Emoji pin markers, each toggleable |
| Safety layer: crash hotspots (bike and e-scooter, separately toggleable) + high-crash corridors | Risk-graded circle markers and translucent red corridor bands |
| Stat panel: annual crashes, injury %, top-5 corridors, 5-year trend chart | Sidebar |
| Rider info popups: surface, hilliness, lighting, MARTA connections, construction/closures | Click any route |
| Casual ↔ Commuter mode presets | Sidebar switch |
| Search (local place names first, then address geocoding via Nominatim) | Top search bar |
| Legend | Bottom-left (collapsible on mobile) |

## Design decisions (defaults chosen — easy to change)

These four questions were asked but couldn't be answered before build, so the
recommended defaults were used:

1. **Crash data window: 2021–2025 (5 years)** — enough volume for corridor
   patterns and a year-over-year trend.
2. **E-scooter crashes: included**, as a separate toggle (never merged into
   bike stats), since scooters share the same infrastructure in Atlanta.
3. **Palette: the spec colors as-is** — green/blue/orange/purple/gray lanes on a
   light-gray CARTO basemap; the risk scale uses a reserved yellow/salmon/red
   status palette.
4. **Audience: both, casual-first** — the default "Casual ride" preset surfaces
   trails and destinations; the "Commuter" preset switches on MARTA stations,
   the safety layer, and hides sharrows/food in favor of directness.

## Loading real data (official sources)

The map ships with embedded **sample data** so it works out of the box. To
replace it with the real thing, run the bundled pipeline on any machine with
Node 18+ and open internet:

```bash
# 1. Official bike infrastructure + neighborhood boundaries (no account needed)
node scripts/fetch-data.mjs

# 2. Real crash data — download a CSV export first (see below), then:
node scripts/fetch-data.mjs --gdot-csv ~/Downloads/atlanta-bike-crashes.csv

# 3. Commit the generated files and push — the live site updates automatically
git add data/ && git commit -m "Load official data" && git push
```

The script writes `data/infrastructure.js`, `data/neighborhoods.js`, and
`data/safety.js`. `index.html` auto-detects them and switches off the samples
(the sidebar disclaimer flips from ⚠️ *sample data* to ✅ *official data*).
Delete the files to fall back to samples. Run `node scripts/fetch-data.mjs
--selftest` to check the transform logic offline, `--help` for all options.

### Where the data comes from

| Layer | Source | Access |
|---|---|---|
| Bike infrastructure | City of Atlanta DPCD GIS — [Bicycle Routes layer](https://gis.atlantaga.gov/dpcd/rest/services/OpenDataService/FeatureServer/30) (true road geometries with facility type: protected / buffered / lane / path / sharrow) | automatic |
| Neighborhoods | City of Atlanta DPCD GIS — [official Neighborhood boundaries](https://gis.atlantaga.gov/dpcd/rest/services/AdministrativeArea/GeopoliticalArea/MapServer/1) (~240 polygons; labels appear from zoom 13) | automatic |
| Crashes (best) | [GDOT Crash Data Portal](https://gdot.numetric.net/) — free account required. Filter: *bicyclist or e-scooter involved*, *City of Atlanta*, your year range → export CSV → `--gdot-csv`. Column names are auto-detected; override with `--map "lat=...,lng=...,year=...,mode=...,severity=...,street=..."`. If your export is pre-filtered to bikes and has no person-type column, add `--assume-bike`. | manual export |
| Crashes (supplement) | [NHTSA FARS CrashAPI](https://crashviewer.nhtsa.dot.gov/CrashAPI) via `--fars` — **fatalities only**, public API, no account. Useful preview; not a substitute for the GDOT export. | automatic |

Atlanta Police Department crash records are not published as a machine-readable
open dataset; GDOT's portal is the canonical source for all-severity crash data
(APD reports feed into it).

## ⚠️ About the built-in sample data

- Sample **route geometries are simplified approximations** of real facilities —
  good for orientation, not navigation. The pipeline replaces them with the
  city's full official network.
- Sample **safety figures are illustrative**, shaped to match published
  reporting patterns (Moreland Ave and DeKalb Ave really do top Atlanta's
  high-injury network) — **not official statistics**.
- **Relay Bike Share ceased operations in 2020.** The map keeps one marker at a
  former downtown hub as a note; dockless e-bikes/scooters (Lime, Bird) are the
  current shared options.

Each route also carries `surface`, `hills`, `lighting`, and a `closures`
placeholder meant for manual updates as construction comes and goes; the city
layer doesn't publish those attributes, so popups show honest "unknown"
defaults until filled in.

## Stack

One HTML file plus a vendored copy of [Leaflet 1.9.4](https://leafletjs.com/)
(`vendor/leaflet/`), CARTO Positron basemap tiles, OSM Nominatim for address
search, hand-rolled SVG for the trend chart. No build step, no framework.
