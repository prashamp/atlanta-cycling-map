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

## ⚠️ About the data

- **Route geometries are simplified approximations** of real Atlanta facilities
  (BeltLine trails, PATH400, 10th St cycle track, etc.) — good enough for
  orientation, not navigation.
- **All safety figures are illustrative sample data** shaped to match published
  reporting patterns (e.g., Moreland Ave and DeKalb Ave consistently top
  Atlanta's high-injury network). They are **not official statistics**.
- **Relay Bike Share ceased operations in 2020.** The map keeps one marker at a
  former downtown hub as a note; dockless e-bikes/scooters (Lime, Bird) are the
  current shared options.

### Swapping in real data

All data lives in plain JS arrays at the top of the `<script>` block in
`index.html`:

| Array | What to replace it with |
|---|---|
| `ROUTES` | City of Atlanta bicycle-facility GIS layer (Atlanta DOT / [Atlanta Regional Commission Open Data](https://opendata.atlantaregional.com/) — export as GeoJSON, map each feature's coordinates into `coords` as `[lat, lng]` pairs) |
| `NEIGHBORHOODS` | City of Atlanta official *Neighborhoods* boundary layer (same portals) |
| `CRASHES`, `CORRIDORS`, `STATS` | GDOT crash data via the [GDOT Crash Data Portal](https://gdot.numetric.net/) or Atlanta Police Department open records — filter to bicycle / e-scooter involved, 2021–2025, and aggregate by intersection and corridor |
| `POIS.marta` | MARTA GTFS stops feed |

Each route object also carries `surface`, `hills`, `lighting`, `marta`, and a
`closures` placeholder field intended for manual updates as construction comes
and goes.

## Stack

One HTML file plus a vendored copy of [Leaflet 1.9.4](https://leafletjs.com/)
(`vendor/leaflet/`), CARTO Positron basemap tiles, OSM Nominatim for address
search, hand-rolled SVG for the trend chart. No build step, no framework.
