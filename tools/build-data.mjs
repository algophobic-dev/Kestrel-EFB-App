#!/usr/bin/env node
// Rebuilds everything in /data from free public sources. No API keys.
// Run every 28 days (FAA cycle):  node tools/build-data.mjs
// Rebuild one part only:          node tools/build-data.mjs --only=airports   (airports | fixes | airways | plates | procs)
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const OA = 'https://davidmegginson.github.io/ourairports-data/';
const FAA = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/';
const COUNTRIES = new Set(['US', 'PR', 'VI', 'GU', 'AS', 'MP']);
const r5 = n => Math.round(n * 1e5) / 1e5;
const r4 = n => Math.round(n * 1e4) / 1e4;
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = n => !ONLY.length || ONLY.includes(n);

async function get(url, as = 'text', tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status + ' ' + url);
      return as === 'json' ? await res.json() : as === 'buf' ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

function csv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift();
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

async function save(name, obj) {
  const s = JSON.stringify(obj);
  await writeFile(path.join(OUT, name), s);
  console.log(name.padEnd(16), (s.length / 1024).toFixed(0) + ' KB');
}

async function pages(service, fields, count, extra = '') {
  const out = [];
  const offs = []; for (let o = 0; o < count; o += 2000) offs.push(o);
  for (let i = 0; i < offs.length; i += 6) {
    const got = await Promise.all(offs.slice(i, i + 6).map(o =>
      get(`${FAA}${service}/FeatureServer/0/query?where=1%3D1&outFields=${fields}&outSR=4326&orderByFields=OBJECTID&resultOffset=${o}&resultRecordCount=2000${extra}&f=json`, 'json')));
    for (const g of got) out.push(...(g.features || []));
    process.stdout.write(`\r${service} ${out.length}/${count}   `);
  }
  process.stdout.write('\n');
  return out;
}
const countOf = async s => (await get(`${FAA}${s}/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json`, 'json')).count;
const inUS = (lat, lon) => lat > 13 && lat < 72.5 && (lon < -64 || lon > 144);

await mkdir(OUT, { recursive: true });

// ---- Airports, runways, frequencies, navaids (OurAirports, public domain)
const wxSites = {};
try {
  const st = JSON.parse(gunzipSync(await get('https://aviationweather.gov/data/cache/stations.cache.json.gz', 'buf')).toString());
  for (const s of st) if (s.icaoId) wxSites[s.icaoId] = (s.siteType || []).includes('TAF') ? 2 : (s.siteType || []).includes('METAR') ? 1 : 0;
} catch (e) { console.warn('weather station list failed:', e.message); }

const TYPES = { small_airport: 0, medium_airport: 1, large_airport: 2, seaplane_base: 3, heliport: 4 };
// Every airport in the US and its territories. Elsewhere, airports only (no heliports or seaplane bases), to keep the file small.
const apRows = csv(await get(OA + 'airports.csv')).filter(a => a.type in TYPES && (COUNTRIES.has(a.iso_country) || TYPES[a.type] <= 2));
// Outside the US the place line shows the country name, since a code like CA could be read as California.
const countryName = Object.fromEntries(csv(await get(OA + 'countries.csv')).map(c => [c.code, c.name]));
const idOf = {};          // OurAirports ident -> our id
const used = new Set();
// US airports first, so a US identifier always wins when another country uses the same local code.
apRows.sort((a, b) => COUNTRIES.has(b.iso_country) - COUNTRIES.has(a.iso_country));
const airports = apRows.map(a => {
  const us = COUNTRIES.has(a.iso_country);
  // Pilots know an airport by its ICAO code, or in the US by its FAA identifier when it has no ICAO code.
  let id = us ? a.icao_code || a.local_code || a.gps_code || a.ident : a.icao_code || a.gps_code || a.ident;
  // A code already taken falls back to the OurAirports ident, then to the ident with the country, so every id is unique.
  if (used.has(id)) id = a.ident;
  if (used.has(id)) id = a.ident + '-' + a.iso_country;
  for (let n = 2; used.has(id); n++) id = a.ident + '-' + n;
  used.add(id); idOf[a.ident] = id;
  // Weather stations are keyed by ICAO-style ids (K + FAA identifier for most of the lower 48).
  const station = [a.icao_code, a.gps_code, us && a.local_code && 'K' + a.local_code].find(s => s && wxSites[s]);
  return [id, a.name, r5(+a.latitude_deg), r5(+a.longitude_deg), Math.round(+a.elevation_ft || 0), TYPES[a.type],
    a.municipality, us ? a.iso_region.split('-')[1] || '' : countryName[a.iso_country] || a.iso_country, us && a.local_code && a.local_code !== id ? a.local_code : '',
    station ? wxSites[station] : 0, station && station !== id ? station : ''];
});
await save('airports.json', airports);

const runways = {};
for (const r of csv(await get(OA + 'runways.csv'))) {
  const id = idOf[r.airport_ident]; if (!id || r.closed === '1') continue;
  (runways[id] ||= []).push([r.le_ident, r.he_ident, +r.length_ft || 0, +r.width_ft || 0, r.surface, +r.lighted,
    r.le_latitude_deg ? r5(+r.le_latitude_deg) : null, r.le_longitude_deg ? r5(+r.le_longitude_deg) : null,
    r.he_latitude_deg ? r5(+r.he_latitude_deg) : null, r.he_longitude_deg ? r5(+r.he_longitude_deg) : null,
    +r.le_heading_degT || null, +r.le_elevation_ft || null, +r.he_elevation_ft || null]);
}
await save('runways.json', runways);

const freqs = {};
for (const f of csv(await get(OA + 'airport-frequencies.csv'))) {
  const id = idOf[f.airport_ident]; if (!id) continue;
  (freqs[id] ||= []).push([f.type, f.description, +f.frequency_mhz]);
}
await save('freqs.json', freqs);

const navaids = csv(await get(OA + 'navaids.csv'))
  .map(n => [n.ident, n.name, n.type, r5(+n.latitude_deg), r5(+n.longitude_deg), +n.frequency_khz, +n.magnetic_variation_deg || 0]);
await save('navaids.json', navaids);

// ---- Fixes and airways (FAA)
if (want('fixes')) try {
  const fx = await pages('DesignatedPoint', 'IDENT_TXT', await countOf('DesignatedPoint'));
  const seen = new Set(), fixes = [];
  for (const f of fx) {
    const id = f.attributes.IDENT_TXT, g = f.geometry;
    if (!g || !/^[A-Z]{5}$/.test(id || '') || !inUS(g.y, g.x)) continue;
    const k = id + Math.round(g.y) + Math.round(g.x); if (seen.has(k)) continue; seen.add(k);
    fixes.push([id, r5(g.y), r5(g.x)]);
  }
  await save('fixes.json', fixes);
} catch (e) { console.warn('fixes failed:', e.message); }

if (want('airways')) try {
  const seg = await pages('ATSRoute', 'IDENT_TXT', await countOf('ATSRoute'));
  const airways = {};
  for (const s of seg) {
    const id = s.attributes.IDENT_TXT, p = s.geometry?.paths?.[0];
    if (!id || !p || p.length < 2) continue;
    const a = p[0], b = p[p.length - 1];
    if (!inUS(a[1], a[0]) && !inUS(b[1], b[0])) continue;
    (airways[id] ||= []).push([r4(a[1]), r4(a[0]), r4(b[1]), r4(b[0])]);
  }
  await save('airways.json', airways);
} catch (e) { console.warn('airways failed:', e.message); }

// ---- Terminal procedures index (FAA d-TPP)
if (want('plates')) try {
  const base = Date.UTC(2025, 0, 23), day = 864e5;
  const n = Math.floor((Date.now() - base) / (28 * day));
  let xml, cycle;
  for (const k of [n, n - 1]) {
    const d = new Date(base + k * 28 * day);
    const y = d.getUTCFullYear();
    const inYear = Math.floor((d - Date.UTC(y, 0, 1)) / (28 * day)) + 1;
    cycle = String(y).slice(2) + String(inYear).padStart(2, '0');
    try { xml = await get(`https://aeronav.faa.gov/d-tpp/${cycle}/xml_data/d-tpp_Metafile.xml`, 'text', 1); break; } catch { }
  }
  if (!xml) throw new Error('no metafile');
  const hdr = xml.match(/<digital_tpp cycle="(\d+)" from_edate="([^"]+)" to_edate="([^"]+)"/);
  const a = {};
  for (const m of xml.matchAll(/<airport_name ID="[^"]*"[^>]*apt_ident="([^"]*)" icao_ident="([^"]*)"[^>]*>([\s\S]*?)<\/airport_name>/g)) {
    const list = [];
    for (const r of m[3].matchAll(/<chart_code>([^<]*)<\/chart_code>\s*<chart_name>([^<]*)<\/chart_name>[\s\S]*?<pdf_name>([^<]*)<\/pdf_name>/g))
      if (r[3] && !/DELETED/i.test(r[3])) list.push([r[1], r[2].replace(/&amp;/g, '&'), r[3]]);
    if (list.length) { a[m[2] || m[1]] = list; if (m[2] && m[1]) a[m[1]] ||= list; }
  }
  // de-duplicate the FAA-ident alias to keep the file small
  for (const k of Object.keys(a)) if (k.length === 3 && a['K' + k] === a[k]) delete a[k];
  await save('plates.json', { cycle: hdr[1], from: hdr[2], to: hdr[3], a });
} catch (e) { console.warn('plates failed:', e.message); }

// ---- SIDs and STARs (FAA CIFP, ARINC 424). Needs the `unzip` command.
if (want('procs')) try {
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const base = Date.UTC(2025, 0, 23), day = 864e5, n = Math.floor((Date.now() - base) / (28 * day));
  let zip;
  for (const k of [n, n - 1]) {
    const d = new Date(base + k * 28 * day), ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
    try { zip = await get(`https://aeronav.faa.gov/Upload_313-d/cifp/CIFP_${ymd}.zip`, 'buf', 1); break; } catch { }
  }
  if (!zip) throw new Error('no CIFP file');
  const tmp = path.join(tmpdir(), 'kestrel-cifp.zip'); await writeFile(tmp, zip);
  const text = execFileSync('unzip', ['-p', tmp, 'FAACIFP18'], { maxBuffer: 1 << 28 }).toString('latin1');
  // Route type -> part: r = runway transition, c = common route, t = enroute transition.
  const PART = { D: { 1: 'r', 4: 'r', F: 'r', T: 'r', 2: 'c', 5: 'c', M: 'c', 3: 't', 6: 't', S: 't', V: 't' },
    E: { 1: 't', 4: 't', F: 't', 2: 'c', 5: 'c', 8: 'c', M: 'c', 3: 'r', 6: 'r', 9: 'r', S: 'r' } };
  const procs = {}, lines = text.split('\n');
  // The FAA map service misses many RNAV waypoints. Add every CIFP waypoint that fixes.json lacks.
  const fixes = JSON.parse(await readFile(path.join(OUT, 'fixes.json'), 'utf8').catch(() => '[]'));
  const have = new Set(fixes.map(f => f[0] + Math.round(f[1] * 10) + Math.round(f[2] * 10)));
  const dms = (s, n) => (s[0] === 'S' || s[0] === 'W' ? -1 : 1) * (+s.slice(1, 1 + n) + +s.slice(1 + n, 3 + n) / 60 + +s.slice(3 + n) / 360000);
  let added = 0;
  for (const l of lines) {
    if (l[0] !== 'S' || !((l[4] === 'E' && l[5] === 'A') || (l[4] === 'P' && l[12] === 'C'))) continue;
    const id = l.slice(13, 18).trim(), la = l.slice(32, 41), lo = l.slice(41, 51);
    if (!/^[A-Z]{5}$/.test(id) || !/^[NS]\d{8}$/.test(la) || !/^[EW]\d{9}$/.test(lo)) continue;
    const lat = r5(dms(la, 2)), lon = r5(dms(lo, 3)), k = id + Math.round(lat * 10) + Math.round(lon * 10);
    if (have.has(k) || !inUS(lat, lon)) continue;
    have.add(k); fixes.push([id, lat, lon]); added++;
  }
  console.log('waypoints added from CIFP:', added);
  await save('fixes.json', fixes);
  for (const l of lines) {
    if (l[0] !== 'S' || l[4] !== 'P' || !'DEF'.includes(l[12])) continue;
    const apt = l.slice(6, 10).trim(), kind = l[12], name = l.slice(13, 19).trim();
    // Approaches (F): route type A is a transition; anything else is the final approach course.
    const part = kind === 'F' ? (l[19] === 'A' ? 't' : 'c') : PART[kind][l[19]];
    const trans = l.slice(20, 25).trim(), fix = l.slice(29, 34).trim();
    if (!part || !fix || fix === apt) continue;
    const p = ((procs[apt] ||= {})[kind] ||= {})[name] ||= { r: {}, c: [], t: {} };
    // An approach ends at the runway; what follows is the missed approach, which is not drawn.
    if (/^RW\d/.test(fix)) { if (kind === 'F' && part === 'c') p.end = true; continue; }
    if (p.end && part === 'c') continue;
    const list = part === 'c' ? p.c : (p[part][trans] ||= []);
    if (list[list.length - 1] !== fix) list.push(fix);
  }
  for (const a of Object.values(procs)) for (const k of 'DEF') for (const p of Object.values(a[k] || {})) { delete p.end; if (k === 'F') delete p.r; }
  await save('procs.json', procs);
} catch (e) { console.warn('procedures failed:', e.message); }

await save('meta.json', { built: new Date().toISOString() });
