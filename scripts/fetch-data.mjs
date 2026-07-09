#!/usr/bin/env node
/**
 * fetch-data.mjs — pulls REAL data for the Atlanta Cycling Map and writes
 * the data/*.js files the map loads automatically.
 *
 * Sources:
 *   1. Bike infrastructure — City of Atlanta official GIS layer
 *      "Bicycle Routes" (OpenDataService/FeatureServer/30): true road
 *      geometries with facility type (protected/buffered/lane/path/sharrow).
 *   2. Neighborhoods — City of Atlanta official "Neighborhood" boundary
 *      layer (AdministrativeArea/GeopoliticalArea/MapServer/1).
 *   3. Crashes —
 *      a) BEST: a GDOT crash-data CSV export (all severities). GDOT's portal
 *         (https://gdot.numetric.net) needs a free account; filter to
 *         bicyclist/e-scooter-involved crashes in the City of Atlanta,
 *         export CSV, then pass --gdot-csv <file>.
 *      b) OPTIONAL: --fars fetches fatal crashes only from the public NHTSA
 *         FARS CrashAPI (no account needed) — fatalities only, so treat it
 *         as a supplement, not a substitute.
 *
 * Usage:
 *   node scripts/fetch-data.mjs                  # infrastructure + neighborhoods
 *   node scripts/fetch-data.mjs --gdot-csv crashes.csv
 *   node scripts/fetch-data.mjs --fars           # fatal crashes only
 *   node scripts/fetch-data.mjs --selftest       # offline unit tests
 *
 * Options:
 *   --out DIR        output directory (default: <repo>/data)
 *   --years A-B      crash aggregation window (default 2021-2025)
 *   --gdot-csv FILE  GDOT export to ingest
 *   --map "k=Col,.." override CSV column auto-detection; keys:
 *                    lat,lng,year,date,mode,severity,street
 *   --assume-bike    treat every CSV row as a bicycle crash (use when your
 *                    export was already filtered to bike crashes and has no
 *                    person-type column)
 *   --skip-infra --skip-neighborhoods
 *
 * Requires Node 18+ (built-in fetch). No npm dependencies.
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = {
  // Bike facilities aren't at a stable layer id across service revisions, so we
  // DISCOVER the layer by name inside these service catalogs (first match wins).
  bikeServiceCatalogs: [
    'https://gis.atlantaga.gov/dpcd/rest/services/OpenDataService/FeatureServer',
    'https://gis.atlantaga.gov/dpcd/rest/services/OpenDataService1/MapServer',
    'https://gis.atlantaga.gov/dpcd/rest/services/Transportation/MapServer'
  ],
  bikeNameRe: /bicycle|bike|cycl/i,
  bikeExcludeRe: /parking|rack|share|shop|station|repair|count|signal|\bped/i,
  // ARC Regional Bikeway Inventory — metro-wide facilities (suburbs included).
  // Rows located in the City of Atlanta are dropped in favor of the richer city layer.
  arcRegionalCatalogs: [
    'https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/TRANSPORTATION_bicycle_facilities/FeatureServer'
  ],
  neighborhoods:
    'https://gis.atlantaga.gov/dpcd/rest/services/AdministrativeArea/GeopoliticalArea/MapServer/1/query',
  fars: 'https://crashviewer.nhtsa.dot.gov/CrashAPI'
};

// MARTA rail stations (for nearest-station enrichment on each route).
const MARTA = [
  ['Midtown', 33.7807, -84.3865], ['North Avenue', 33.7716, -84.3872],
  ['Arts Center', 33.789, -84.3872], ['Civic Center', 33.7663, -84.3876],
  ['Peachtree Center', 33.7593, -84.3877], ['Five Points', 33.754, -84.3917],
  ['Georgia State', 33.7501, -84.3857], ['King Memorial', 33.7499, -84.3765],
  ['Inman Park/Reynoldstown', 33.7573, -84.3527], ['Edgewood/Candler Park', 33.7616, -84.3399],
  ['West End', 33.736, -84.4133], ['Ashby', 33.7565, -84.4177],
  ['Vine City', 33.7566, -84.4041], ['Bankhead', 33.772, -84.429],
  ['Lindbergh Center', 33.8232, -84.3693], ['Buckhead', 33.8478, -84.367],
  ['Lenox', 33.8454, -84.3571], ['Oakland City', 33.7166, -84.4254],
  ['Garnett', 33.7489, -84.3955], ['Dome/GWCC/Philips/CNN', 33.7562, -84.3982]
];

/* ================= pure transforms (unit-tested by --selftest) ========= */

// City-mapped facilities are paved; trails may include interim unpaved segments.
export function inferSurface(type) {
  return type === 'trail' ? 'Paved (some interim unpaved segments possible)' : 'Paved (asphalt)';
}

export function classifyFacility(raw) {
  if (!raw) return null;
  const t = String(raw).toLowerCase();
  if (/multi[\s-]?use|shared[\s-]?use|side\s?path|\bpath\b|\btrail\b|greenway|beltline|off[\s-]?(street|road)/.test(t)) return 'trail';
  if (/protect|cycle\s?track|separat|raised\s+bike\s+lane/.test(t)) return 'protected';
  if (/buffer/.test(t)) return 'buffered';
  if (/sharrow|shared[\s-]?(lane|roadway|street)|bike\s?(blvd|boulevard)|neighborhood\s?(greenway|street|bikeway)|signed|wide\s?curb|shoulder/.test(t)) return 'sharrow';
  if (/\blane\b/.test(t)) return 'standard';
  if (/route|connector/.test(t)) return 'sharrow';
  return null;
}

export function pickField(sampleProps, regexes, excludeRe) {
  const keys = Object.keys(sampleProps || {}).filter(k => !(excludeRe && excludeRe.test(k)));
  for (const re of regexes) {
    const hit = keys.find(k => re.test(k));
    if (hit) return hit;
  }
  return null;
}

// GeoJSON geometry -> array of [lat,lng] lines, decimated to <= maxPts each
// (region-wide layers carry very dense vertices; ~150 pts is visually identical
// at city scale and keeps the data file small).
export function geomToLines(geometry, maxPts = 150) {
  if (!geometry) return [];
  const flip = pts => {
    const step = Math.max(1, Math.ceil(pts.length / maxPts));
    const out = pts.filter((_, i) => i % step === 0).map(([lng, lat]) => [round5(lat), round5(lng)]);
    const last = pts[pts.length - 1];
    const tail = out[out.length - 1];
    if (tail[0] !== round5(last[1]) || tail[1] !== round5(last[0])) out.push([round5(last[1]), round5(last[0])]);
    return out;
  };
  if (geometry.type === 'LineString') return [flip(geometry.coordinates)];
  if (geometry.type === 'MultiLineString') return geometry.coordinates.map(flip);
  return [];
}

// GeoJSON polygon -> outer ring as [lat,lng], decimated to <= maxPts
export function polyOuterRing(geometry, maxPts = 160) {
  if (!geometry) return null;
  let ring = null;
  if (geometry.type === 'Polygon') ring = geometry.coordinates[0];
  else if (geometry.type === 'MultiPolygon') {
    // largest outer ring
    ring = geometry.coordinates.map(p => p[0]).sort((a, b) => b.length - a.length)[0];
  }
  if (!ring || ring.length < 4) return null;
  const step = Math.max(1, Math.ceil(ring.length / maxPts));
  const out = ring.filter((_, i) => i % step === 0).map(([lng, lat]) => [round5(lat), round5(lng)]);
  if (out.length < 4) return null;
  return out;
}

export function round5(x) { return Math.round(x * 1e5) / 1e5; }

// Ray-casting point-in-polygon over a set of [lat,lng] rings (XOR handles holes).
export function pointInRings(pt, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if (((yi > pt[0]) !== (yj > pt[0])) && (pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi))
        inside = !inside;
    }
  }
  return inside;
}

export function haversineKm([lat1, lng1], [lat2, lng2]) {
  const R = 6371, d = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * d / 2) ** 2 +
    Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lng2 - lng1) * d / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function nearestMarta(coords, maxKm = 1.3, maxN = 2) {
  const mid = coords[Math.floor(coords.length / 2)];
  return MARTA
    .map(([name, lat, lng]) => ({ name, km: haversineKm(mid, [lat, lng]) }))
    .filter(s => s.km <= maxKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, maxN)
    .map(s => `${s.name} (${(s.km * 0.621).toFixed(1)} mi)`);
}

// Minimal CSV parser (quotes, embedded commas/newlines).
export function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

export function detectColumns(sampleRow, overrides = {}) {
  const col = {
    lat: pickField(sampleRow, [/^lat(itude)?$/i, /lat/i]),
    lng: pickField(sampleRow, [/^(lng|lon|long|longitude)$/i, /lon/i]),
    year: pickField(sampleRow, [/crash\s*year/i, /^year$/i]),
    date: pickField(sampleRow, [/crash\s*date/i, /date/i]),
    mode: pickField(sampleRow, [/non.?motorist/i, /person\s*type/i, /bicycl|pedal|bike/i]),
    severity: pickField(sampleRow, [/sever/i, /injur/i, /kabco/i]),
    street: pickField(sampleRow, [/on\s*road|road\s*name/i, /street/i, /route\s*name/i, /corridor/i])
  };
  return Object.assign(col, overrides);
}

export function rowMode(v, assumeBike) {
  if (v == null || v === '') return assumeBike ? 'bike' : null;
  const t = String(v).toLowerCase();
  if (/scooter/.test(t)) return 'scooter';
  if (/bicycl|pedal\s?cycl|\bbike\b|cyclist/.test(t)) return 'bike';
  return assumeBike ? 'bike' : null;
}

export function isInjury(v) {
  if (v == null || v === '') return null;
  const t = String(v).toLowerCase().trim();
  if (/no\s*(apparent)?\s*injur|not\s*injured|none|property|^o\b|^pdo/.test(t)) return false;
  if (/fatal|killed|serious|suspected|possible|visible|injur|^[kabc]\b/.test(t)) return true;
  return null;
}

const titleCase = s => String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

/**
 * Aggregates parsed crash rows into the map's safety shapes:
 * hotspot clusters, top-5 corridors, and yearly stats.
 */
export function aggregateSafety(rows, col, years, { assumeBike = false, source = 'GDOT export' } = {}) {
  const [y0, y1] = years;
  const pts = [];
  for (const r of rows) {
    const lat = parseFloat(r[col.lat]), lng = parseFloat(r[col.lng]);
    if (!isFinite(lat) || !isFinite(lng) || lat < 33.4 || lat > 34.1 || lng < -84.8 || lng > -84.0) continue;
    let year = col.year ? parseInt(r[col.year], 10) : NaN;
    if (!isFinite(year) && col.date) {
      const m = String(r[col.date]).match(/(19|20)\d{2}/);
      if (m) year = parseInt(m[0], 10);
    }
    if (!isFinite(year) || year < y0 || year > y1) continue;
    const mode = rowMode(col.mode ? r[col.mode] : null, assumeBike);
    if (!mode) continue;
    pts.push({
      lat, lng, year, mode,
      injury: col.severity ? isInjury(r[col.severity]) : null,
      street: col.street && r[col.street] ? titleCase(r[col.street]) : null
    });
  }

  // yearly stats (bike series; scooter as a total)
  const yearsArr = []; for (let y = y0; y <= y1; y++) yearsArr.push(y);
  const bikeCrashes = yearsArr.map(y => pts.filter(p => p.mode === 'bike' && p.year === y).length);
  const scooterTotal = pts.filter(p => p.mode === 'scooter').length;
  const withSev = pts.filter(p => p.injury !== null);
  const injuryPct = withSev.length
    ? Math.round(100 * withSev.filter(p => p.injury).length / withSev.length) : null;

  // hotspot clusters (~100 m grid), capped to the 400 densest
  const cells = new Map();
  for (const p of pts) {
    const key = `${Math.round(p.lat / 0.0009)}:${Math.round(p.lng / 0.0009)}:${p.mode}`;
    if (!cells.has(key)) cells.set(key, { lat: 0, lng: 0, n: 0, mode: p.mode, streets: new Map() });
    const c = cells.get(key);
    c.lat += p.lat; c.lng += p.lng; c.n++;
    if (p.street) c.streets.set(p.street, (c.streets.get(p.street) || 0) + 1);
  }
  const kept = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 400);
  // Data-driven risk grades: thresholds from the actual cluster-size
  // distribution (roughly top ~7% high, next ~23% medium), with floors so a
  // 1-crash spot is never "high". Absolute cutoffs fail when most clusters
  // are small — everything ends up one color.
  const ns = kept.map(c => c.n).sort((a, b) => a - b);
  const q = p => ns[Math.min(ns.length - 1, Math.floor(p * ns.length))];
  const hiCut = Math.max(3, q(0.93)), medCut = Math.max(2, Math.min(q(0.70), hiCut - 1));
  console.log(`  risk grade cutoffs: high >= ${hiCut}, medium >= ${medCut} crashes per cluster`);
  const crashes = kept.map(c => {
    const street = [...c.streets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      lat: round5(c.lat / c.n), lng: round5(c.lng / c.n), n: c.n, mode: c.mode,
      sev: c.n >= hiCut ? 'high' : c.n >= medCut ? 'med' : 'low',
      label: street || 'Crash cluster'
    };
  });

  // corridors: top 5 streets by crash count, polyline through their points
  const byStreet = new Map();
  for (const p of pts) if (p.street) {
    if (!byStreet.has(p.street)) byStreet.set(p.street, []);
    byStreet.get(p.street).push(p);
  }
  const corridors = [...byStreet.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5)
    .map(([name, list]) => {
      const latSpread = Math.max(...list.map(p => p.lat)) - Math.min(...list.map(p => p.lat));
      const lngSpread = Math.max(...list.map(p => p.lng)) - Math.min(...list.map(p => p.lng));
      const axis = latSpread >= lngSpread ? 'lat' : 'lng';
      const sorted = [...list].sort((a, b) => a[axis] - b[axis]);
      const step = Math.max(1, Math.ceil(sorted.length / 15));
      const coords = sorted.filter((_, i) => i % step === 0).map(p => [round5(p.lat), round5(p.lng)]);
      if (coords.length < 2) coords.push([round5(sorted.at(-1).lat), round5(sorted.at(-1).lng)]);
      const sev = list.filter(p => p.injury !== null);
      return {
        name, crashes: list.length,
        injuryPct: sev.length ? Math.round(100 * sev.filter(p => p.injury).length / sev.length) : null,
        coords
      };
    });

  return {
    crashes, corridors,
    stats: {
      years: yearsArr, bikeCrashes, injuryPct,
      scooterTotal: scooterTotal || null,
      scooterLabel: `E-scooter crashes (${y0}–${y1})`,
      top5: corridors.map(c => ({ name: c.name, crashes: c.crashes })),
      source
    }
  };
}

/* ============================ fetch helpers ============================ */

async function getJSON(url) {
  // Some government APIs (e.g. NHTSA) reject requests without a browser-like
  // User-Agent; identify ourselves politely.
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; atlanta-cycling-map-pipeline/1.0; +https://github.com/prashamp/atlanta-cycling-map)'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function layerGeometryType(svc, id) {
  try { return (await getJSON(`${svc}/${id}?f=json`)).geometryType || null; } catch { return null; }
}
async function layerCount(svc, id) {
  try {
    const c = await getJSON(`${svc}/${id}/query?where=1%3D1&returnCountOnly=true&f=json`);
    return c.count ?? (c.properties && c.properties.count) ?? 0;
  } catch { return 0; }
}

// Scan ArcGIS service catalogs for the best bike-facility layer: among layers
// whose name matches nameRe (minus excludeRe), prefer POLYLINE geometry, then
// the most features. Logs every layer + candidate so the right one is auditable.
async function discoverLayer(catalogs, nameRe, excludeRe) {
  const candidates = [];
  for (const svc of catalogs) {
    const tag = svc.split('/services/')[1] || svc;
    let dir;
    try { dir = await getJSON(`${svc}?f=json`); }
    catch (e) { console.log(`  catalog ${tag} → ${e.message}`); continue; }
    const layers = (dir.layers || []).filter(l => l && typeof l.id === 'number');
    if (!layers.length) { console.log(`  ${tag}: no layers listed`); continue; }
    console.log(`  ${tag}: ${layers.map(l => `${l.id}:${l.name}`).join(' | ')}`);
    for (const l of layers) {
      if (!l.name || !nameRe.test(l.name) || (excludeRe && excludeRe.test(l.name))) continue;
      const gt = await layerGeometryType(svc, l.id);
      const count = await layerCount(svc, l.id);
      candidates.push({ svc, id: l.id, name: l.name, gt, count });
      console.log(`    candidate ${l.id}:${l.name} geom=${gt} count=${count}`);
    }
  }
  if (!candidates.length) return null;
  const poly = candidates.filter(c => /Polyline/i.test(c.gt || ''));
  const pick = (poly.length ? poly : candidates).sort((a, b) => b.count - a.count)[0];
  console.log(`  → chose ${pick.id}:${pick.name} (${pick.gt}, ${pick.count} features)`);
  return `${pick.svc}/${pick.id}/query`;
}

async function fetchArcGISAll(baseUrl) {
  const features = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const url = `${baseUrl}?where=1%3D1&outFields=*&outSR=4326&f=geojson` +
      `&resultOffset=${offset}&resultRecordCount=${pageSize}`;
    const page = await getJSON(url);
    if (page.error) throw new Error(`ArcGIS error: ${JSON.stringify(page.error)}`);
    const feats = page.features || [];
    features.push(...feats);
    process.stdout.write(`  …${features.length} features\r`);
    if (feats.length < pageSize) break;
  }
  console.log(`  ${features.length} features total`);
  return features;
}

function writeDataFile(outDir, name, banner, assignments) {
  const body =
    `// GENERATED by scripts/fetch-data.mjs — do not edit by hand.\n// ${banner}\n` +
    `window.ATL_DATA = window.ATL_DATA || {};\n` +
    assignments.map(([k, v]) => `window.ATL_DATA.${k} = ${JSON.stringify(v)};\n`).join('') +
    `window.ATL_DATA.meta = Object.assign(window.ATL_DATA.meta || {}, ` +
    `${JSON.stringify({ fetchedAt: new Date().toISOString() })});\n`;
  mkdirSync(outDir, { recursive: true });
  const p = join(outDir, name);
  writeFileSync(p, body);
  console.log(`  wrote ${p} (${(body.length / 1024).toFixed(0)} KB)`);
}

/* ============================== pipelines ============================== */

// Fetch one bike-facility layer and convert its features to route objects.
// dropInsideRings: [lat,lng] rings (e.g. Atlanta city limits) — segments whose
// midpoint falls inside are dropped (covered by the richer city layer).
async function routesFromLayer(queryUrl, { note, dropCityAtlanta = false, dropInsideRings = null, requireType = false, forceType = null } = {}) {
  const feats = await fetchArcGISAll(queryUrl);
  if (!feats.length) throw new Error('layer returned no features');
  const props0 = feats.find(f => f.properties)?.properties || {};
  // never pick OBJECTID / FACILITYID / *_ID, nor REC_* (recommended/planned) fields
  const NO_ID = /(^|_)(object)?id$|^fid$|^rec_/i;
  const typeField = pickField(props0,
    [/fac.*type|type.*fac/i, /^bicycle_?facility$/i, /bike.*type|type.*bike/i, /lane.*type|type.*lane/i, /spec/i, /^type$/i, /class$/i, /category/i, /^facility$/i],
    NO_ID);
  const nameField = pickField(props0,
    [/st_?name|street.*name|name.*street/i, /road.*name|name.*road/i, /^street$/i, /^road$/i, /route.*name/i, /fac.*name|name.*fac/i, /^name$/i, /corridor/i, /label/i],
    NO_ID);
  const cityField = dropCityAtlanta ? pickField(props0, [/^city/i, /city.*(name|loc)/i, /jurisdiction/i], NO_ID) : null;
  // Existing vs programmed/planned marker (ARC's LINE_TYPE and similar)
  const statusCandidate = pickField(props0, [/line_?type/i, /existing/i, /^status$/i], NO_ID);
  const statusField = statusCandidate !== typeField ? statusCandidate : null;
  console.log(`  fields available: ${Object.keys(props0).join(', ')}`);
  console.log(`  detected fields → type: ${typeField ?? '(none)'} · name: ${nameField ?? '(none)'}` +
    ` · status: ${statusField ?? '(none)'}` +
    (dropCityAtlanta ? ` · city: ${cityField ?? '(none)'}` : ''));

  const seenTypes = new Map(), seenStatus = new Map();
  const routes = [];
  let droppedCity = 0, droppedPlanned = 0, droppedInside = 0;
  for (const f of feats) {
    const p = f.properties || {};
    if (cityField && /^atlanta$/i.test(String(p[cityField] || '').trim())) { droppedCity++; continue; }
    if (statusField) {
      const sv = String(p[statusField] ?? '');
      seenStatus.set(sv, (seenStatus.get(sv) || 0) + 1);
      if (/programmed|planned|proposed|future|conceptual|recommend|vision|funded/i.test(sv)) { droppedPlanned++; continue; }
    }
    const rawType = typeField ? p[typeField] : null;
    // requireType: rows with no facility value are recommended-network entries
    // with nothing built on the ground — don't render them as real lanes.
    if (requireType && (rawType == null || String(rawType).trim() === '')) { droppedPlanned++; continue; }
    const lines = geomToLines(f.geometry);
    if (dropInsideRings && lines.length) {
      const mid = lines[0][Math.floor(lines[0].length / 2)];
      if (pointInRings(mid, dropInsideRings)) { droppedInside++; continue; }
    }
    seenTypes.set(rawType, (seenTypes.get(rawType) || 0) + 1);
    const type = forceType || classifyFacility(rawType) || 'standard';
    for (const coords of lines) {
      if (coords.length < 2) continue;
      routes.push({
        name: (nameField && p[nameField]) ? titleCase(p[nameField]) : (rawType ? String(rawType) : 'Bike facility'),
        type, coords,
        surface: inferSurface(type),
        marta: nearestMarta(coords),
        closures: '—',
        ...(note ? { note } : {})
      });
    }
  }
  if (droppedCity) console.log(`  dropped ${droppedCity} City-of-Atlanta rows (covered by the city layer)`);
  if (droppedInside) console.log(`  dropped ${droppedInside} segments inside the city limits polygon (covered by the city layer)`);
  if (droppedPlanned) console.log(`  dropped ${droppedPlanned} planned/recommended (no built facility) segments`);
  if (seenStatus.size) console.log('  status values seen:', [...seenStatus].map(([v, n]) => `${v}×${n}`).join(' | '));
  console.log('  facility-type values seen:');
  for (const [v, n] of [...seenTypes].sort((a, b) => b[1] - a[1]))
    console.log(`    ${String(v)} × ${n} → ${classifyFacility(v) || 'standard (unmapped!)'}`);
  return routes;
}

// Official City of Atlanta boundary as [lat,lng] rings (for the spatial dedupe).
async function fetchCityLimitRings() {
  const feats = await fetchArcGISAll('https://gis.atlantaga.gov/dpcd/rest/services/OpenDataService1/MapServer/1/query');
  const rings = [];
  for (const f of feats) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys)
      for (const ring of poly)
        rings.push(ring.map(([lng, lat]) => [lat, lng]));
  }
  if (!rings.length) throw new Error('city limits layer returned no polygon rings');
  return rings;
}

async function pipelineInfrastructure(outDir, infraUrlOverride) {
  console.log('▶ Bike infrastructure — City of Atlanta GIS (auto-discovering bike layer)');
  const cityUrl = infraUrlOverride ||
    await discoverLayer(SOURCES.bikeServiceCatalogs, SOURCES.bikeNameRe, SOURCES.bikeExcludeRe);
  if (!cityUrl) throw new Error(
    'could not find a bicycle layer in the known service catalogs — ' +
    'pass --infra-url "<FeatureServer/<id>/query>" once you locate it (see logs above for available layers)');
  console.log(`  querying ${cityUrl}`);
  const routes = await routesFromLayer(cityUrl);
  if (!routes.length) throw new Error(
    `city layer produced 0 line features (likely a point layer or wrong field) — ` +
    `pass --infra-url to target the correct polyline layer`);

  // The city's dedicated multi-use trails layer carries newer BeltLine and
  // greenway segments that the Bicycle Routes layer lags on.
  console.log('▶ Bike infrastructure — City multi-use trails layer (BeltLine & greenways)');
  try {
    const trails = await routesFromLayer(
      'https://gis.atlantaga.gov/dpcd/rest/services/OpenDataService1/MapServer/32/query',
      { forceType: 'trail' });
    console.log(`  ${trails.length} multi-use trail segments merged`);
    routes.push(...trails);
  } catch (e) {
    console.warn(`  ⚠ multi-use trails layer skipped: ${e.message}`);
  }

  // Metro-wide facilities from the ARC Regional Bikeway Inventory (suburbs).
  console.log('▶ Bike infrastructure — ARC Regional Bikeway Inventory (metro/suburbs)');
  try {
    const arcUrl = await discoverLayer(SOURCES.arcRegionalCatalogs, /./, null);
    if (!arcUrl) throw new Error('no layer found in ARC service');
    let cityRings = null;
    try { cityRings = await fetchCityLimitRings(); console.log(`  city-limits polygon loaded (${cityRings.length} rings) for spatial dedupe`); }
    catch (e) { console.warn(`  ⚠ city-limits fetch failed (${e.message}) — regional rows inside the city may double-draw`); }
    console.log(`  querying ${arcUrl}`);
    const regional = await routesFromLayer(arcUrl, {
      note: 'Regional inventory (ARC) — outside the City of Atlanta',
      dropCityAtlanta: true,
      dropInsideRings: cityRings,
      requireType: true
    });
    console.log(`  ${regional.length} regional segments added to ${routes.length} city segments`);
    routes.push(...regional);
  } catch (e) {
    console.warn(`  ⚠ regional layer skipped: ${e.message} (city coverage still complete)`);
  }

  writeDataFile(outDir, 'infrastructure.js',
    'Sources: City of Atlanta DPCD GIS (Bicycle Routes) + ARC Regional Bikeway Inventory (metro)',
    [['routes', routes]]);
}

async function pipelineShops(outDir) {
  console.log('▶ Bike shops — OpenStreetMap via Overpass API (metro-wide)');
  const query = '[out:json][timeout:90];nwr["shop"="bicycle"](33.40,-84.85,34.20,-84.00);out center tags;';
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; atlanta-cycling-map-pipeline/1.0; +https://github.com/prashallcommit/atlanta-cycling-map)'
    },
    body: 'data=' + encodeURIComponent(query)
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const json = await res.json();
  const shops = [];
  for (const el of json.elements || []) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (!t.name || !isFinite(lat) || !isFinite(lng)) continue;
    const addr = [
      t['addr:housenumber'] && t['addr:street'] ? `${t['addr:housenumber']} ${t['addr:street']}` : t['addr:street'] || null,
      t['addr:city'] || null
    ].filter(Boolean).join(', ');
    shops.push({
      name: t.name, lat: round5(lat), lng: round5(lng),
      desc: addr || 'Bicycle shop',
      ...(t.phone || t['contact:phone'] ? { phone: t.phone || t['contact:phone'] } : {}),
      ...((t.website || t['contact:website']) && /^https?:\/\//i.test(t.website || t['contact:website'])
        ? { website: t.website || t['contact:website'] } : {})
    });
  }
  if (!shops.length) throw new Error('Overpass returned no bicycle shops');
  console.log(`  ${shops.length} shops (${shops.filter(s => s.phone).length} with phone numbers)`);
  writeDataFile(outDir, 'pois.js',
    'Source: OpenStreetMap via Overpass API — shop=bicycle across the Atlanta metro',
    [['shops', shops]]);
}

async function pipelineNeighborhoods(outDir) {
  console.log('▶ Neighborhoods — City of Atlanta GIS (official boundary layer)');
  const feats = await fetchArcGISAll(SOURCES.neighborhoods);
  if (!feats.length) throw new Error('layer returned no features');
  const props0 = feats.find(f => f.properties)?.properties || {};
  const nameField = pickField(props0, [/^name$/i, /neighborhood/i, /^nbhd/i, /label/i]);
  console.log(`  detected name field: ${nameField ?? '(none)'}`);
  const neighborhoods = [];
  for (const f of feats) {
    const ring = polyOuterRing(f.geometry);
    if (!ring) continue;
    neighborhoods.push({ name: nameField ? titleCase(f.properties?.[nameField] ?? '') : '', coords: ring });
  }
  writeDataFile(outDir, 'neighborhoods.js',
    'Source: City of Atlanta DPCD GIS — AdministrativeArea/GeopoliticalArea/MapServer/1 (Neighborhood)',
    [['neighborhoods', neighborhoods]]);
}

async function pipelineGdotCsv(outDir, csvPath, years, colOverrides, assumeBike) {
  console.log(`▶ Crash data — GDOT export: ${csvPath}`);
  const rows = parseCSV(readFileSync(csvPath, 'utf8'));
  if (!rows.length) throw new Error('CSV parsed to zero rows');
  const col = detectColumns(rows[0], colOverrides);
  console.log('  column mapping:', col);
  if (!col.lat || !col.lng) throw new Error('could not detect lat/lng columns — use --map "lat=...,lng=..."');
  if (!col.year && !col.date) throw new Error('could not detect a year/date column — use --map "year=..." or "date=..."');
  const agg = aggregateSafety(rows, col, years, { assumeBike, source: 'GDOT crash export' });
  const totalBike = agg.stats.bikeCrashes.reduce((a, b) => a + b, 0);
  console.log(`  ${totalBike} bike + ${agg.stats.scooterTotal ?? 0} scooter crashes in window; ` +
    `${agg.crashes.length} hotspot clusters; injuryPct=${agg.stats.injuryPct}`);
  if (!totalBike) {
    console.warn('  ⚠ zero bike crashes matched — check --map mode column or pass --assume-bike');
  }
  writeDataFile(outDir, 'safety.js',
    'Source: GDOT crash data export (user-supplied CSV), aggregated by scripts/fetch-data.mjs',
    [['crashes', agg.crashes], ['corridors', agg.corridors], ['stats', agg.stats]]);
}

async function pipelineFars(outDir, years) {
  console.log('▶ Crash data — NHTSA FARS CrashAPI (FATALITIES ONLY, experimental)');
  const [y0, y1] = years;
  // FARS data is typically published ~18 months behind; clamp the window.
  const maxYear = new Date().getFullYear() - 2;
  const yTo = Math.min(y1, maxYear);
  const points = [];
  for (let y = y0; y <= yTo; y++) {
    const pb = await getJSON(`${SOURCES.fars}/FARSData/GetFARSData?dataset=PBType&caseYear=${y}&format=json`);
    const acc = await getJSON(`${SOURCES.fars}/FARSData/GetFARSData?dataset=Accident&caseYear=${y}&format=json`);
    const pbRows = pb.Results?.[0] ?? pb.Results ?? [];
    const accRows = acc.Results?.[0] ?? acc.Results ?? [];
    const gaBikeCases = new Set(
      pbRows.filter(r => String(r.STATE) === '13' && /bicyclist/i.test(r.PBPTYPENAME || r.PBPTYPEName || ''))
        .map(r => `${r.ST_CASE}`));
    for (const a of accRows) {
      if (String(a.STATE) !== '13' || !gaBikeCases.has(`${a.ST_CASE}`)) continue;
      const lat = parseFloat(a.LATITUDE ?? a.latitude), lng = parseFloat(a.LONGITUD ?? a.LONGITUDE ?? a.longitud);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      points.push({ lat: round5(lat), lng: round5(lng), year: y, street: a.TWAY_ID ? titleCase(a.TWAY_ID) : null });
    }
    console.log(`  ${y}: ${points.filter(p => p.year === y).length} fatal bicyclist crashes in GA`);
  }
  const yearsArr = []; for (let y = y0; y <= yTo; y++) yearsArr.push(y);
  const crashes = points.map(p => ({
    lat: p.lat, lng: p.lng, n: 1, mode: 'bike', sev: 'high',
    label: (p.street || 'Fatal bicyclist crash') + ' (FARS fatal)'
  }));
  writeDataFile(outDir, 'safety.js',
    'Source: NHTSA FARS CrashAPI — FATAL bicyclist crashes only (Georgia). For all severities use --gdot-csv.',
    [['crashes', crashes], ['corridors', []],
     ['stats', {
       years: yearsArr,
       bikeCrashes: yearsArr.map(y => points.filter(p => p.year === y).length),
       injuryPct: 100, scooterTotal: null,
       scooterLabel: null, top5: [], source: 'NHTSA FARS (fatalities only)'
     }]]);
}

/* =============================== selftest ============================== */

function selftest() {
  let fails = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
    if (!ok) fails++;
  };

  eq('classify protected', classifyFacility('Protected Bike Lane'), 'protected');
  eq('classify cycle track', classifyFacility('Two-Way Cycle Track'), 'protected');
  eq('classify buffered', classifyFacility('Buffered Bike Lane'), 'buffered');
  eq('classify lane', classifyFacility('Bike Lane'), 'standard');
  eq('classify sharrow', classifyFacility('Shared Lane Markings'), 'sharrow');
  eq('classify boulevard', classifyFacility('Bike Boulevard'), 'sharrow');
  eq('classify path', classifyFacility('Multi-Use Path'), 'trail');
  eq('classify shared-use', classifyFacility('Shared Use Path'), 'trail');
  eq('classify sidepath', classifyFacility('Side Path'), 'trail');
  eq('classify raised', classifyFacility('Raised Bike Lane'), 'protected');
  eq('classify contraflow buffered', classifyFacility('Buffered Contraflow Bike Lane'), 'buffered');
  eq('classify multiuse-hard', classifyFacility('Hard Surface Multi-Use Path'), 'trail');
  eq('classify bike-blvd', classifyFacility('Bike Boulevard'), 'sharrow');

  const sq = [[[33.70, -84.45], [33.90, -84.45], [33.90, -84.30], [33.70, -84.30], [33.70, -84.45]]];
  eq('pip inside', pointInRings([33.80, -84.40], sq), true);
  eq('pip outside', pointInRings([33.60, -84.40], sq), false);
  eq('pickField skips REC_', pickField({ REC_BICYCLE_FACILITY: 'x', BICYCLE_FACILITY: 'y' }, [/bicycle_?facility/i], /(^|_)(object)?id$|^fid$|^rec_/i), 'BICYCLE_FACILITY');
  eq('classify wide curb', classifyFacility('Wide Curb Lane'), 'sharrow');
  eq('classify shoulder', classifyFacility('Shoulder'), 'sharrow');
  eq('classify nbhd bikeway', classifyFacility('Neighborhood Bikeway'), 'sharrow');
  eq('classify protected one-way', classifyFacility('Bike Lane - Protected One-Way'), 'protected');
  eq('classify trail unpaved', classifyFacility('Trail - Unpaved'), 'trail');
  eq('classify unknown', classifyFacility('Widget'), null);
  eq('surface trail', inferSurface('trail'), 'Paved (some interim unpaved segments possible)');
  eq('surface lane', inferSurface('standard'), 'Paved (asphalt)');

  eq('csv quotes', parseCSV('a,b\n"x, y",2\n'), [{ a: 'x, y', b: '2' }]);
  eq('csv crlf', parseCSV('a,b\r\n1,2\r\n'), [{ a: '1', b: '2' }]);

  eq('geom line', geomToLines({ type: 'LineString', coordinates: [[-84.4, 33.7], [-84.5, 33.8]] }),
    [[[33.7, -84.4], [33.8, -84.5]]]);
  eq('geom multiline count',
    geomToLines({ type: 'MultiLineString', coordinates: [[[-84.4, 33.7], [-84.5, 33.8]], [[-84.1, 33.9], [-84.2, 33.95]]] }).length, 2);
  eq('poly ring', polyOuterRing({ type: 'Polygon', coordinates: [[[-84.4, 33.7], [-84.5, 33.8], [-84.45, 33.75], [-84.4, 33.7]]] }),
    [[33.7, -84.4], [33.8, -84.5], [33.75, -84.45], [33.7, -84.4]]);

  eq('mode bike', rowMode('Bicyclist', false), 'bike');
  eq('mode scooter', rowMode('E-Scooter Rider', false), 'scooter');
  eq('mode assume', rowMode('', true), 'bike');
  eq('injury K', isInjury('K - Fatal Injury'), true);
  eq('injury O', isInjury('O - No Apparent Injury'), false);

  const rows = [
    { Latitude: '33.7660', Longitude: '-84.3495', 'Crash Year': '2023', 'Non-Motorist Type': 'Bicyclist', 'Injury Severity': 'B - Suspected Minor Injury', 'Road Name': 'MORELAND AVE' },
    { Latitude: '33.7661', Longitude: '-84.3496', 'Crash Year': '2024', 'Non-Motorist Type': 'Bicyclist', 'Injury Severity': 'O - No Apparent Injury', 'Road Name': 'MORELAND AVE' },
    { Latitude: '33.7541', Longitude: '-84.3633', 'Crash Year': '2023', 'Non-Motorist Type': 'E-Scooter', 'Injury Severity': 'C - Possible Injury', 'Road Name': 'DEKALB AVE' },
    { Latitude: '40.0', Longitude: '-84.3', 'Crash Year': '2023', 'Non-Motorist Type': 'Bicyclist', 'Injury Severity': 'K', 'Road Name': 'OUT OF BOUNDS' }
  ];
  const col = detectColumns(rows[0]);
  eq('detect lat col', col.lat, 'Latitude');
  eq('detect mode col', col.mode, 'Non-Motorist Type');
  const agg = aggregateSafety(rows, col, [2021, 2025]);
  eq('agg bike series', agg.stats.bikeCrashes, [0, 0, 1, 1, 0]);
  eq('agg scooter total', agg.stats.scooterTotal, 1);
  eq('agg injuryPct', agg.stats.injuryPct, 67);
  eq('agg top corridor', agg.stats.top5[0], { name: 'Moreland Ave', crashes: 2 });
  eq('agg cluster merge', agg.crashes.find(c => c.label === 'Moreland Ave')?.n, 2);
  eq('agg bounds filter', agg.crashes.length, 2);

  console.log(fails ? `\n${fails} FAILURES` : '\nALL SELFTESTS PASS');
  process.exit(fails ? 1 : 0);
}

/* ================================ main ================================= */

function parseArgs(argv) {
  const a = { out: join(ROOT, 'data'), years: [2021, 2025], map: {} };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out') a.out = resolve(argv[++i]);
    else if (v === '--gdot-csv') a.gdotCsv = resolve(argv[++i]);
    else if (v === '--years') { const m = argv[++i].match(/^(\d{4})-(\d{4})$/); if (!m) throw new Error('--years A-B'); a.years = [+m[1], +m[2]]; }
    else if (v === '--map') for (const kv of argv[++i].split(',')) { const [k, c] = kv.split('='); a.map[k.trim()] = c.trim(); }
    else if (v === '--assume-bike') a.assumeBike = true;
    else if (v === '--fars') a.fars = true;
    else if (v === '--infra-url') a.infraUrl = argv[++i];
    else if (v === '--soft') a.soft = true;
    else if (v === '--skip-infra') a.skipInfra = true;
    else if (v === '--skip-neighborhoods') a.skipNb = true;
    else if (v === '--skip-shops') a.skipShops = true;
    else if (v === '--selftest') a.selftest = true;
    else if (v === '--help' || v === '-h') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '*/'); process.exit(0); }
    else throw new Error(`unknown arg: ${v}`);
  }
  return a;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) selftest();
  else {
    (async () => {
      let failures = 0;
      const step = async (skip, fn, what) => {
        if (skip) return;
        try { await fn(); }
        catch (e) { failures++; console.error(`✖ ${what} failed: ${e.message}`); }
      };
      await step(args.skipInfra, () => pipelineInfrastructure(args.out, args.infraUrl), 'infrastructure');
      await step(args.skipNb, () => pipelineNeighborhoods(args.out), 'neighborhoods');
      await step(args.skipShops, () => pipelineShops(args.out), 'bike shops');
      if (args.gdotCsv) await step(false, () => pipelineGdotCsv(args.out, args.gdotCsv, args.years, args.map, args.assumeBike), 'GDOT CSV');
      else if (args.fars) await step(false, () => pipelineFars(args.out, args.years), 'FARS');
      else console.log('ℹ No crash source given — pass --gdot-csv <file> (best) or --fars (fatalities only).');
      if (failures && args.soft) console.log(`\nDone with ${failures} failure(s) — continuing anyway (--soft). The map falls back to samples for any layer that failed.`);
      else console.log(failures ? `\nDone with ${failures} failure(s).` : '\nDone. Open index.html — the map now uses the generated data. Commit data/ and push to update the live site.');
      process.exit(failures && !args.soft ? 1 : 0);
    })();
  }
}
