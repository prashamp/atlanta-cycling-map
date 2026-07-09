# 🚲 Atlanta Cycling Map

**Live map: https://prashallcommit.github.io/atlanta-cycling-map/**

An interactive, mobile-friendly map of cycling in metro Atlanta — every bike
lane and trail across the region, neighborhood boundaries, bike shops and
destinations, and a real crash-safety layer. Built as a public resource:
viewers just open the link; all data loads automatically.

## Features

### 🛣️ Bike infrastructure — the whole metro
- **City of Atlanta:** the official [DPCD GIS Bicycle Routes layer](https://gis.atlantaga.gov/dpcd/rest/services/OpenDataService1/MapServer/30)
  (~290 facilities on true road geometry).
- **Suburbs / region:** the [ARC Regional Bikeway Inventory](https://opendata.atlantaregional.com/datasets/regional-bikeway-inventory-2022)
  (~10k+ built facilities across the metro; recommended-but-unbuilt segments are filtered out).
- Color-coded by type: **multi-use trails** (purple), **protected lanes**
  (green), **buffered lanes** (blue), **standard lanes** (orange), **sharrows /
  shared roadway** (slate, dashed — includes wide curb lanes and rideable shoulders).
- Click any route for surface, nearest MARTA stations, and a construction/closures field.

### 🚨 Safety layer (real data)
- **764 bicycle crashes (2021–2025)** from a GDOT/Atlanta Police crash-data
  export (`data/source/`), aggregated into risk-graded hotspot clusters and
  top-5 high-crash corridors.
- Sidebar stat panel: crashes per year (trend chart), injury rate, worst corridors.

### 📍 Getting around
- **Map / Satellite** basemap switcher (CARTO light + Esri World Imagery).
- **GPS locate button** — see yourself on the map while riding.
- Search bar: neighborhoods, places, and street addresses (Nominatim).
- **Casual ride / Commuter** presets that flip layer combinations.
- Official **neighborhood boundaries** (248 polygons; labels appear as you zoom).

### 🔧 Places
- **Bike shops metro-wide from OpenStreetMap** — with phone numbers and
  websites where OSM has them.
- Parks, BeltLine access points, trailside cafes & breweries, landmarks, and
  MARTA stations — every point has an **"Open in Google Maps"** link.

## How it stays up to date (zero effort)

A GitHub Actions workflow (`.github/workflows/deploy.yml`) runs on every push
and **monthly on a schedule**. It:
1. Fetches the City of Atlanta GIS layers, the ARC regional inventory, and
   OpenStreetMap bike shops (auto-discovering layer ids and field names,
   logging every facility-type value it classifies).
2. Commits the refreshed `data/*.js` files back to the repo.
3. Assembles and deploys the site to GitHub Pages.

If a source is temporarily down, the deploy proceeds with the rest (`--soft`)
and the map notes what's missing rather than breaking.

## Data honesty

| Layer | Status |
|---|---|
| Bike infrastructure (city + metro) | ✅ Official GIS, auto-refreshed |
| Neighborhoods | ✅ Official city boundaries, auto-refreshed |
| Crash data | ✅ Real GDOT/APD export (2021–2025), committed in `data/` |
| Bike shops | ✅ OpenStreetMap, auto-refreshed |
| Lighting / hilliness | ❌ No official source publishes these — omitted rather than guessed |

Notes: FARS (NHTSA) fatal-crash fetching exists (`--fars`) but NHTSA blocks
GitHub's runner IPs, so run it locally if wanted. Relay Bike Share shut down
in 2020; dockless e-bikes/scooters are the current shared option.

## Refreshing crash data in future years (optional)

The map already carries a **real 2021–2025 GDOT/APD export** — nothing to do
today. When newer years become available and you want them included:
GDOT's portal (free account at https://gdot.numetric.net/) → filter to
bicyclist crashes in Atlanta → export CSV → then:

```bash
node scripts/fetch-data.mjs --gdot-csv your-export.csv --years 2021-2025 \
  --map "street=Roadway (From Crash Report)" --assume-bike \
  --skip-infra --skip-neighborhoods --skip-shops
git add data/ && git commit -m "Update crash data" && git push
```

Column names auto-detect; `--map` overrides them, `--assume-bike` covers
exports pre-filtered to bikes. `node scripts/fetch-data.mjs --selftest` runs
the offline test suite (40+ checks). `--help` lists everything.

## Stack

One HTML file (Leaflet 1.9.4 vendored, canvas rendering for the ~10k-segment
network, hand-rolled SVG chart), a zero-dependency Node ≥18 data pipeline, and
a GitHub Actions deploy. No framework, no build step.
