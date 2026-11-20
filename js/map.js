// Moving map: base maps, FAA charts, aeronautical overlay, airspace, radar, SIGMETs, ownship, inspector.
import { $, h, icon, kv, files, on, emit, debounce, toast, esc, uid, modal } from './util.js';
import { db, inBox, nearby, search, resolve, marks } from './db.js';
import { along, dist, bearing, fmtLL, compass, norm, inGeom } from './geo.js';
import { metar, sigmets, elevations, traffic, gairmets, pireps, pirepLevel, pirepText } from './wx.js';
import { plan, setPlan, addPoint, current } from './route.js';
import { CONFIG } from './config.js';
import { plateImage } from './plateov.js';
import { tfrs, tfrsAt, tfrRow } from './tfr.js';
import { rx, connected as adsbOn } from './gdl90.js';

const FAA_TILES = 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/';
export const FAA_FEAT = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/';
const CK = CONFIG.cartoKey ? '?key=' + encodeURIComponent(CONFIG.cartoKey) : '';
const CARTO = 'https://basemaps.cartocdn.com/rastertiles/', CARTO_ATTR = '© OpenStreetMap © CARTO';
// `online: true` marks layers that may not be bulk-downloaded for offline use.
export const BASES = {
  dark: CK ? { name: 'Dark', url: CARTO + 'dark_all/{z}/{x}/{y}.png' + CK, min: 3, max: 18, attr: CARTO_ATTR, online: true }
    : { name: 'Dark', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', min: 3, max: 16, attr: '© Esri', online: true },
  ...(CK ? { light: { name: 'Light', url: CARTO + 'voyager/{z}/{x}/{y}.png' + CK, min: 3, max: 18, attr: CARTO_ATTR, online: true } } : {}),
  topo: { name: 'Topographic', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', min: 3, max: 16, attr: 'USGS' },
  // USGS imagery covers the US and can be saved offline. Elsewhere the map shows Esri World Imagery (online only).
  sat: { name: 'Satellite', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', min: 3, max: 16, attr: 'USGS',
    world: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', worldAttr: 'USGS · Imagery © Esri, Maxar, Earthstar Geographics' },
};
export const CHARTS = {
  none: { name: 'None' },
  sec: { name: 'VFR Sectional', url: FAA_TILES + 'VFR_Sectional/MapServer/tile/{z}/{y}/{x}', min: 8, max: 12 },
  tac: { name: 'VFR Terminal', url: FAA_TILES + 'VFR_Terminal/MapServer/tile/{z}/{y}/{x}', min: 10, max: 12 },
  low: { name: 'IFR Low', url: FAA_TILES + 'IFR_AreaLow/MapServer/tile/{z}/{y}/{x}', min: 7, max: 12 },
  high: { name: 'IFR High', url: FAA_TILES + 'IFR_High/MapServer/tile/{z}/{y}/{x}', min: 5, max: 9 },
  // Europe and southern Africa, about 20 countries. Shown only, not saved for offline use.
  ofm: { name: 'VFR Europe', url: 'https://nwy-tiles-api.prod.newaydata.com/tiles/{z}/{x}/{y}.png?path=latest/aero/latest', min: 7, max: 12, online: true, attr: '<a href="https://www.openflightmaps.org/" target="_blank" rel="noopener">open flightmaps</a>' },
};
const OVERLAYS = { aero: 'Airports and navaids', airspace: 'Airspace (US)', oaip: 'Airspace (world)', radar: 'Radar', cat: 'Flight category', sigmet: 'SIGMETs', pirep: 'PIREPs', tfr: 'TFRs', ice: 'Icing advisories', turb: 'Turbulence advisories', ifr: 'IFR advisories', hazard: 'Terrain hazard', obstacles: 'Obstacles', traffic: 'Traffic' };
// US radar from Iowa Environmental Mesonet. Elsewhere, RainViewer (zoom 7 at most, 10-minute frames).
const RADAR = o => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913${o ? '-m' + String(o).padStart(2, '0') + 'm' : ''}/{z}/{x}/{y}.png`;
const RV_ATTR = 'Weather data by <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>';
const OAIP_ATTR = 'Airspace: <a href="https://www.openaip.net/" target="_blank" rel="noopener">OpenAIP</a>';
const inUS = () => { const c = map.getCenter(); return c.lat > 22 && c.lat < 51 && c.lng > -130 && c.lng < -64; };
let rv = null;
async function rvFrames() {
  if (!rv || Date.now() - rv.at > 5 * 6e4) {
    const j = await (await fetch('https://api.rainviewer.com/public/weather-maps.json')).json();
    rv = { host: j.host, past: j.radar?.past || [], at: Date.now() };
  }
  if (!rv.past.length) throw new Error('No radar frames');
  return rv;
}
const RV = f => `${rv.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`;

const st = Object.assign({ base: 'dark', chart: 'none', ov: { aero: true, airspace: true, radar: false, cat: true, sigmet: false }, c: [39.1, -84.5], z: 8 }, kv.get('map', {}));
// TFRs are on unless turned off, also for maps saved before the layer existed.
st.ov.tfr ??= true;
const save = () => kv.set('map', st);
export let map;
let pirepL, pirepData = null, tfrL, tfrData = null, baseL, chartL, radarL, radarSrc, oaipL, aeroL, routeL, airspaceL, sigmetL, ownL, canvas, hazardL, obsL, trafficL, marksL, contentL, advisL, surfL;
const cats = new Map(), markers = new Map();

export const altText = (v, uom, code) => code === 'SFC' || (v === 0 && code !== 'MSL') ? 'Surface' : v == null || v < 0 ? (code || 'Unknown') : uom === 'FL' ? 'FL' + v : `${Number(v).toLocaleString()}' ${code || 'MSL'}`;
const mk = (p, cls, label) => L.marker([p.lat, p.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="mk ${cls}"><i></i><b>${esc(label ?? p.id)}</b></div>` }) });

export function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 3, maxZoom: 18, worldCopyJump: true, zoomSnap: .5 }).setView(st.c, st.z);
  map.attributionControl.setPrefix(false);
  canvas = L.canvas({ padding: .3 });
  map.createPane('wx').style.zIndex = 350;
  airspaceL = L.layerGroup().addTo(map); sigmetL = L.layerGroup().addTo(map);
  advisL = L.layerGroup().addTo(map); tfrL = L.layerGroup().addTo(map); pirepL = L.layerGroup().addTo(map); surfL = L.layerGroup().addTo(map);
  contentL = L.layerGroup().addTo(map); obsL = L.layerGroup().addTo(map);
  routeL = L.layerGroup().addTo(map); aeroL = L.layerGroup().addTo(map); marksL = L.layerGroup().addTo(map); trafficL = L.layerGroup().addTo(map);
  applyTiles(); applyOverlays();

  map.on('moveend', () => { const c = map.getCenter(); st.c = [c.lat, c.lng]; st.z = map.getZoom(); save(); drawAero(); loadAirspace(); loadObstacles(); loadSurface();
    if (st.ov.radar && radarSrc !== (inUS() ? 'iem' : 'rv')) makeRadar(); });
  map.on('click', e => inspect({ lat: e.latlng.lat, lon: e.latlng.lng }));
  map.on('dragstart', () => setFollow(false));
  new ResizeObserver(() => { if ($('#map').clientWidth) map.invalidateSize(); }).observe($('#map'));
  on('route', r => { drawRoute(r); drawAero(); refreshHazard(); });
  on('marks', drawMarks); on('content', drawContent);

  $('#tool-zin').onclick = () => map.zoomIn(1); $('#tool-zout').onclick = () => map.zoomOut(1);
  $('#tool-follow').onclick = () => setFollow(!follow);
  $('#tool-rec').onclick = toggleRec;
  $('#btn-center').onclick = fitRoute;
  $('#btn-layers').onclick = e => { e.stopPropagation(); const p = $('#layers-pop'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) drawLayersPop(); };
  document.addEventListener('click', e => { if (!e.target.closest('#layers-pop')) $('#layers-pop').classList.add('hidden'); if (!e.target.closest('.search')) $('#search-results').classList.add('hidden'); });
  initRadarBar(); initSearch(); drawAero(); loadAirspace(); drawMarks(); drawContent();
}

// ---------- tiles and overlays
function applyTiles() {
  baseL?.remove(); chartL?.remove();
  if (!BASES[st.base]) st.base = 'dark';
  const b = BASES[st.base];
  baseL = (b.world ? new SplitLayer(b) : L.tileLayer(b.url, { maxNativeZoom: b.max, maxZoom: 18, attribution: b.attr })).addTo(map);
  const c = CHARTS[st.chart];
  chartL = c?.url ? L.tileLayer(c.url, { minNativeZoom: c.min, maxNativeZoom: c.max, minZoom: c.min - 1, maxZoom: 18, attribution: c.attr || 'FAA charts' }).addTo(map) : null;
  $('#layer-label').textContent = c?.url ? c.name : b.name + ' map';
}
// A base map that uses the US source for tiles over the US and its states and territories, and the world source elsewhere.
const US_BOXES = [[24, -125, 50, -66], [51, -170, 72, -129], [18, -161, 23, -154], [17.5, -67.5, 18.7, -64.5], [13, 144, 21, 146.5]];
const overUS = (lat, lon) => US_BOXES.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);
const SplitLayer = L.TileLayer.extend({
  initialize(b) { this.b = b; L.TileLayer.prototype.initialize.call(this, b.world, { maxNativeZoom: b.max, maxZoom: 18, attribution: b.worldAttr }); },
  getTileUrl(c) {
    const z = this._getZoomForUrl(), n = 2 ** z, lon = (c.x + .5) / n * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (c.y + .5) / n))) * 180 / Math.PI;
    const url = z >= 6 && overUS(lat, lon) ? this.b.url : this.b.world;
    return L.Util.template(url, { z, x: c.x, y: c.y });
  },
});
// Used by the Mac app's menus.
export function setOverlay(key, on) { st.ov[key] = on ?? !st.ov[key]; save(); applyOverlays(); }
export function setChart(key) { if (CHARTS[key]) { st.chart = key; save(); applyTiles(); } }
export function setBase(key) { if (BASES[key]) { st.base = key; save(); applyTiles(); } }
let radarSeq = 0;
async function makeRadar() {
  const my = ++radarSeq;
  radarL?.remove(); radarL = null; radarSrc = null;
  if (!st.ov.radar) return;
  const src = inUS() ? 'iem' : 'rv';
  if (src === 'rv') {
    try { await rvFrames(); } catch { if (my === radarSeq) toast('Radar outside the US did not load. Check your connection.'); return; }
    if (my !== radarSeq) return;
  }
  radarSrc = src;
  radarL = L.tileLayer(src === 'iem' ? RADAR(0) : RV(rv.past.at(-1)), { opacity: .7, pane: 'wx', maxNativeZoom: src === 'iem' ? 9 : 7, attribution: src === 'iem' ? 'IEM radar' : RV_ATTR }).addTo(map);
  setRadarFrame(+$('#radar-slider').value);
}
let oaipSeq = 0;
async function setOaip() {
  const my = ++oaipSeq;
  oaipL?.remove(); oaipL = null;
  if (!st.ov.oaip) return;
  const off = msg => { st.ov.oaip = false; save(); toast(msg); };
  if (!CONFIG.proxyUrl) return off('World airspace needs the relay server. See the README to set it up.');
  const base = CONFIG.proxyUrl.replace(/\/$/, '') + '/oaip';
  const r = await fetch(base + '/2/2/1.png').catch(() => null);
  if (my !== oaipSeq) return;
  if (r?.status === 501) return off('World airspace needs an OpenAIP key on the relay. See the README.');
  if (!r?.ok) return off('World airspace did not load. Check your connection.');
  oaipL = L.tileLayer(base + '/{z}/{x}/{y}.png', { pane: 'wx', minZoom: 4, maxNativeZoom: 14, attribution: OAIP_ATTR }).addTo(map);
}
function applyOverlays() {
  $('#timebar').classList.toggle('hidden', !st.ov.radar);
  $('#map-clock').classList.toggle('hidden', !st.ov.radar);
  makeRadar(); setOaip();
  drawAero(); loadAirspace(); loadSigmets(); loadTfrs(); loadPireps();
  hazardL?.remove(); hazardL = null; hazardAt = null;
  if (st.ov.hazard) { hazardL = new Hazard({ pane: 'wx', maxNativeZoom: 11, minZoom: 6, attribution: 'Terrain: Mapzen' }).addTo(map); hazardAt = hazardRef(); }
  loadObstacles(); setTraffic(); loadAdvisories(); loadSurface();
}
function drawLayersPop() {
  const radio = (group, key, label) => h('label', { class: 'row' }, h('input', { type: 'radio', name: group, checked: st[group] === key, onchange: () => { st[group] = key; save(); applyTiles(); } }), label);
  const check = (key, label) => h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!st.ov[key], onchange: e => { st.ov[key] = e.target.checked; save(); applyOverlays(); } }), label);
  $('#layers-pop').replaceChildren(
    h('div', { class: 'sect' }, 'Chart'), ...Object.entries(CHARTS).map(([k, c]) => radio('chart', k, c.name)),
    h('div', { class: 'sect' }, 'Base map'), ...Object.entries(BASES).map(([k, b]) => radio('base', k, b.name)),
    h('div', { class: 'sect' }, 'Overlays'), ...Object.entries(OVERLAYS).map(([k, n]) => check(k, n)));
}

// ---------- airports, navaids, fixes
const RANK = [2, 3, 4, 1, 0];
function drawAero() {
  if (!map || !db.ready) return;
  aeroL.clearLayers(); markers.clear();
  if (!st.ov.aero) return;
  const z = map.getZoom(), b = map.getBounds().pad(.05), s = b.getSouth(), w = b.getWest(), n = b.getNorth(), e = b.getEast();
  let apts = inBox(db.airports, s, w, n, e, x => x.type === 2 || (z >= 6 && x.type === 1) || (z >= 8.5 && x.type === 0 && !x.minor) || z >= 10.5);
  if (apts.length > 260) apts = apts.sort((a, c) => RANK[c.type] - RANK[a.type]).slice(0, 260);
  const want = [], onRoute = new Set(current.points.map(p => p.id));
  for (const a of apts) {
    if (onRoute.has(a.id)) continue;
    const cat = st.ov.cat && a.wx ? cats.get(a.id) : null;
    const m = mk(a, `t${a.type}${a.wx && st.ov.cat ? ' wx' : ''} ${cat || ''}`).addTo(aeroL);
    markers.set(a.id, m);
    if (st.ov.cat && a.wx && z >= 6 && !cats.has(a.id)) want.push(a);
  }
  if (z >= 7.5) for (const v of inBox(db.navaids, s, w, n, e, x => z >= 9.5 || x.navType !== 'NDB').slice(0, 120)) onRoute.has(v.id) || mk(v, 'nav').addTo(aeroL);
  if (z >= 10) for (const f of inBox(db.fixes, s, w, n, e).slice(0, 220)) onRoute.has(f.id) || mk(f, 'fix').addTo(aeroL);
  queueCats(want.slice(0, 45));
}
let catQ = [], catBusy = 0;
function queueCats(list) { catQ = list; pumpCats(); }
function pumpCats() {
  while (catBusy < 5 && catQ.length) {
    const a = catQ.shift(), id = a.id; if (cats.has(id)) continue;
    catBusy++; cats.set(id, '');
    metar(a.wxId).then(m => {
      cats.set(id, m.cat || '');
      const el = markers.get(id)?.getElement()?.firstChild; if (el && m.cat) el.classList.add(m.cat);
    }).catch(() => { }).finally(() => { catBusy--; pumpCats(); });
  }
}
setInterval(() => { cats.clear(); drawAero(); }, 10 * 6e4);

// ---------- route
// Keep each point within 180° of longitude of the one before, so a line crossing the 180° meridian carries on into the
// next copy of the world instead of jumping back across the whole map.
function unwrap(list) {
  const out = [];
  for (const [lat, lon] of list) {
    let l = lon;
    if (out.length) { const prev = out[out.length - 1][1]; while (l - prev > 180) l -= 360; while (l - prev < -180) l += 360; }
    out.push([lat, l]);
  }
  return out;
}
let routeLine = [];
function drawRoute(r) {
  routeL.clearLayers(); routeLine = [];
  const pts = r.points; if (!pts.length) return;
  const raw = [], at = [0];
  for (let i = 1; i < pts.length; i++) { const n = Math.max(2, Math.ceil(dist(pts[i - 1], pts[i]) / 25)); for (let k = 0; k < n; k++) { const p = along(pts[i - 1], pts[i], k / n); raw.push([p.lat, p.lon]); } at.push(raw.length); }
  raw.push([pts[pts.length - 1].lat, pts[pts.length - 1].lon]);
  const line = routeLine = unwrap(raw);
  L.polyline(line, { color: '#000', weight: 8, opacity: .35, interactive: false }).addTo(routeL);
  L.polyline(line, { color: '#e23bf0', weight: 4.5, interactive: false }).addTo(routeL);
  // Waypoint labels go on the same copy of the world as the line.
  pts.forEach((p, i) => mk({ ...p, lon: line[Math.min(at[i], line.length - 1)][1] }, 'rt', p.kind === 'll' ? '' : p.id).addTo(routeL));
}
export function fitRoute() {
  const pts = current.points;
  map.invalidateSize();
  if (pts.length > 1 && routeLine.length) map.fitBounds(L.latLngBounds(routeLine).pad(.15));
  else if (pts.length) map.setView([pts[0].lat, pts[0].lon], 10);
  else if (own) map.setView([own.lat, own.lon], 10);
  else toast('Enter a route or turn on Follow to center the map.');
}
export const flyTo = (p, z = 10) => map.setView([p.lat, p.lon], Math.max(map.getZoom(), z));

// ---------- airspace
const AS_STYLE = f => {
  const p = f.properties, c = p.CLASS || '', t = p.TYPE_CODE || '';
  if (c === 'B') return { color: '#3d8bff', weight: 2.5, fillOpacity: .07 };
  if (c === 'C') return { color: '#d946ef', weight: 2.2, fillOpacity: .07 };
  if (c === 'D') return { color: '#3d8bff', weight: 1.6, dashArray: '6 5', fillOpacity: .05 };
  if (t === 'MOA') return { color: '#c264d8', weight: 1.4, dashArray: '2 5', fillOpacity: .04 };
  if (t === 'R' || t === 'P') return { color: '#5b7dff', weight: 1.6, fillOpacity: .13 };
  return { color: '#c9a04a', weight: 1.3, dashArray: '4 4', fillOpacity: .05 };
};
const envelope = b => `&geometry=${b.getWest().toFixed(3)},${b.getSouth().toFixed(3)},${b.getEast().toFixed(3)},${b.getNorth().toFixed(3)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`;
const AS_FIELDS = 'NAME,CLASS,TYPE_CODE,UPPER_VAL,UPPER_UOM,UPPER_CODE,LOWER_VAL,LOWER_UOM,LOWER_CODE';
let asSeq = 0;
const loadAirspace = debounce(async () => {
  if (!map) return;
  const my = ++asSeq;
  if (!st.ov.airspace || map.getZoom() < 7) { airspaceL.clearLayers(); return; }
  const b = map.getBounds().pad(.2), off = (b.getEast() - b.getWest()) / 1500;
  const q = (svc, where) => fetch(`${FAA_FEAT}${svc}/FeatureServer/0/query?where=${encodeURIComponent(where)}${envelope(b)}&outFields=${AS_FIELDS}&outSR=4326&maxAllowableOffset=${off.toFixed(5)}&f=geojson`).then(r => r.json()).catch(() => ({ features: [] }));
  const [cls, sua] = await Promise.all([q('Class_Airspace', "CLASS IN ('B','C','D')"), q('Special_Use_Airspace', '1=1')]);
  if (my !== asSeq) return;
  airspaceL.clearLayers();
  L.geoJSON({ type: 'FeatureCollection', features: [...(sua.features || []), ...(cls.features || [])] }, { style: AS_STYLE, renderer: canvas, interactive: false }).addTo(airspaceL);
}, 500);
export async function airspaceAt(p) {
  const g = `&geometry=${p.lon.toFixed(5)},${p.lat.toFixed(5)}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=false&outFields=${AS_FIELDS}&f=json`;
  const q = (svc, where) => fetch(`${FAA_FEAT}${svc}/FeatureServer/0/query?where=${encodeURIComponent(where)}${g}`).then(r => r.json()).then(j => (j.features || []).map(f => f.attributes)).catch(() => []);
  const [a, b] = await Promise.all([q('Class_Airspace', "CLASS IN ('B','C','D')"), q('Special_Use_Airspace', '1=1')]);
  return [...a, ...b];
}
async function loadSigmets() {
  sigmetL.clearLayers(); if (!st.ov.sigmet) return;
  try {
    const j = await sigmets();
    L.geoJSON(j, { renderer: canvas, interactive: false, filter: f => !!f.geometry, style: { color: '#f2b134', weight: 2, fillOpacity: .12 } }).addTo(sigmetL);
    if (!(j.features || []).some(f => f.geometry)) toast('No active SIGMETs.');
  } catch { toast('SIGMETs did not load. Check your connection.'); }
}

// ---------- radar loop
let playing = null;
function setRadarFrame(i) {
  let off = (10 - i) * 5;
  $('#radar-slider').value = i;
  let t = new Date(Math.floor(Date.now() / 3e5) * 3e5 - off * 6e4);
  if (radarSrc === 'rv') {
    // RainViewer has a frame every 10 minutes: show the one nearest the slider's time.
    const f = rv.past.reduce((a, b) => Math.abs(b.time * 1e3 - t) < Math.abs(a.time * 1e3 - t) ? b : a);
    t = new Date(f.time * 1e3); off = Math.round((rv.past.at(-1).time - f.time) / 60);
    if (radarL && radarL._url !== RV(f)) radarL.setUrl(RV(f));
  } else radarL?.setUrl(RADAR(off));
  const txt = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('#radar-label').innerHTML = `${off ? '-' + off + ' min' : 'Latest'}<br>${txt}`;
  $('#map-clock').textContent = 'Radar ' + txt;
}
function initRadarBar() {
  $('#radar-slider').oninput = e => setRadarFrame(+e.target.value);
  $('#radar-play').onclick = () => {
    if (playing) { clearInterval(playing); playing = null; }
    else playing = setInterval(() => setRadarFrame((+$('#radar-slider').value + 1) % 11), 700);
    $('#radar-play').replaceChildren(icon(playing ? 'pause' : 'play'));
  };
}

// ---------- ownship and track log
let own = null, follow = false, watch = null, ownTrack = null, rec = null, recTimer = null;
const PLANE = '<svg viewBox="0 0 24 24"><path d="M12 2l2 7 8 5v2l-8-2.500V19l2.500 2v1L12 21l-4.500 1v-1L10 19v-5.500L2 16v-2l8-5z"/></svg>';
function startGPS() {
  if (watch != null) return true;
  if (!navigator.geolocation) { toast('This device has no location service.'); return false; }
  watch = navigator.geolocation.watchPosition(pos => {
    // An ADS-B receiver's GPS, when one is connected, is used instead of the device's own location.
    if (adsbOn() && rx.own) return;
    const c = pos.coords;
    setOwn({ lat: c.latitude, lon: c.longitude, alt: c.altitude != null ? c.altitude * 3.28084 : null, gs: c.speed != null ? c.speed * 1.94384 : null, t: pos.timestamp,
      trk: c.heading != null && !isNaN(c.heading) && (c.speed || 0) > 1 ? c.heading : null });
  }, err => { toast(err.code === 1 ? 'Location access is off. Allow it in your browser settings.' : 'Waiting for a position fix.'); }, { enableHighAccuracy: true, maximumAge: 2000 });
  return true;
}
function setOwn(o) {
    const prev = own;
    own = o;
    own.trk = o.trk != null ? o.trk : prev && dist(prev, own) > .01 ? bearing(prev, own) : prev?.trk || 0;
    if (!ownL) ownL = L.marker([own.lat, own.lon], { interactive: false, zIndexOffset: 1000, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="own">${PLANE}</div>` }) }).addTo(map);
    ownL.setLatLng([own.lat, own.lon]);
    const el = ownL.getElement()?.firstChild; if (el) el.style.transform = `rotate(${own.trk}deg)`;
    if (follow) map.panTo([own.lat, own.lon], { animate: true });
    if (rec) { rec.pts.push([+own.lat.toFixed(5), +own.lon.toFixed(5), Math.round(own.alt || 0), Math.round(own.gs || 0), own.t]); ownTrack?.addLatLng([own.lat, own.lon]); }
    emit('gps', own);
}

// ---------- ADS-B receiver: its GPS position and the traffic it hears
let adsbL = null;
on('adsb', r => {
  if (!map) return;
  if (r.own) setOwn({ lat: r.own.lat, lon: r.own.lon, alt: r.geoAlt ?? r.own.alt, gs: r.own.gs, trk: r.own.track, t: r.own.t });
  adsbL ||= L.layerGroup().addTo(map);
  adsbL.clearLayers();
  for (const a of r.traffic.values()) {
    if (r.own && a.addr === r.own.addr) continue;
    const rel = r.own?.alt != null && a.alt != null ? Math.round((a.alt - r.own.alt) / 100) : null;
    const alt = rel != null ? (rel >= 0 ? '+' : '−') + String(Math.abs(rel)).padStart(2, '0') : a.alt != null ? String(Math.round(a.alt / 100)).padStart(3, '0') : '';
    const arrow = a.vs > 300 ? '↑' : a.vs < -300 ? '↓' : '';
    L.marker([a.lat, a.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [0, 0],
      html: `<div class="tfc rx"><span style="transform:rotate(${Math.round(a.track || 0)}deg)">${PLANE}</span><b>${esc(a.flight || '')}<br>${alt}${arrow}</b></div>` }) }).addTo(adsbL);
  }
});
function setFollow(v) {
  if (v && !startGPS()) return;
  follow = v; $('#tool-follow').classList.toggle('on', v);
  if (v && own) map.setView([own.lat, own.lon], Math.max(map.getZoom(), 10));
}
function toggleRec() {
  const btn = $('#tool-rec');
  if (!rec) {
    if (!startGPS()) return;
    rec = { id: uid(), start: Date.now(), pts: [] };
    ownTrack = L.polyline([], { color: '#43c463', weight: 3, interactive: false }).addTo(map);
    btn.classList.add('rec');
    recTimer = setInterval(() => { const s = Math.floor((Date.now() - rec.start) / 1000); $('#tool-timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 1000);
    toast('Recording track log.');
  } else {
    clearInterval(recTimer); btn.classList.remove('rec'); $('#tool-timer').textContent = '00:00';
    ownTrack?.remove(); ownTrack = null;
    if (rec.pts.length > 1) {
      let d = 0; for (let i = 1; i < rec.pts.length; i++) d += dist({ lat: rec.pts[i - 1][0], lon: rec.pts[i - 1][1] }, { lat: rec.pts[i][0], lon: rec.pts[i][1] });
      const tracks = kv.get('tracks', []);
      tracks.unshift({ id: rec.id, start: rec.start, end: Date.now(), nm: +d.toFixed(1), pts: rec.pts.length > 5000 ? rec.pts.filter((_, i) => i % Math.ceil(rec.pts.length / 5000) === 0) : rec.pts });
      kv.set('tracks', tracks.slice(0, 40)); emit('tracks');
      toast('Track log saved. Open More > Track logs to view it.');
    } else toast('Track log discarded. No position was received.');
    rec = null;
  }
}
export function showTrack(t) {
  const line = L.polyline(unwrap(t.pts.map(p => [p[0], p[1]])), { color: '#43c463', weight: 3 }).addTo(routeL);
  map.fitBounds(line.getBounds().pad(.2));
}

// ---------- inspector
export async function inspect(p, focus) {
  const box = $('#inspector');
  const z = map.getZoom(), rad = Math.max(1.5, 40075 * Math.cos(p.lat * Math.PI / 180) / Math.pow(2, z + 8) * 36 / 1.852);
  const kinds = z >= 10 ? ['apt', 'nav', 'fix'] : z >= 7.5 ? ['apt', 'nav'] : ['apt'];
  let near = nearby(p, rad, kinds, 12).filter(x => x.kind !== 'apt' || x.type < 3 || z >= 11);
  if (focus) near = [{ ...focus, d: 0 }, ...near.filter(x => x.id !== focus.id)];
  const close = () => { box.classList.add('hidden'); pin?.remove(); };
  pin?.remove(); pin = L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#2bb3a0', fillOpacity: 1, interactive: false }).addTo(map);
  const add = x => { addPoint(x.kind === 'll' ? `${x.lat.toFixed(4)}/${x.lon.toFixed(4)}` : x.id); $('#fpl').classList.remove('hidden'); $('#btn-fpl').classList.add('on'); toast(`${x.kind === 'll' ? 'Position' : x.id} added to route.`); };
  const locSub = h('div', { class: 's' }, own ? `${dist(own, p).toFixed(1)} nm, ${Math.round(bearing(own, p))}°T from your position` : 'Elevation loading');
  const asBox = h('div', {}, h('div', { class: 'row' }, h('div', { class: 's' }, 'Loading')));
  const rowFor = x => h('div', { class: 'row' },
    h('span', { class: 'dot ' + (cats.get(x.id) || '') }),
    h('div', { class: 'grow' }, h('div', { class: 't' }, x.id), h('div', { class: 's' }, `${x.name}${x.d ? ` · ${x.d.toFixed(1)} nm ${compass(bearing(p, x))}` : ''}`)),
    x.kind === 'apt' && h('button', { class: 'pill', onclick: () => emit('open-airport', x.id) }, 'Info'),
    h('button', { class: 'pill go', onclick: () => add(x) }, 'Add'));
  box.replaceChildren(
    h('div', { class: 'head' }, h('button', { class: 'btn sm', onclick: close }, 'Close'), h('div', { class: 'ttl' }, 'Add to Route'),
      h('button', { class: 'btn sm', title: 'Replace the route with a direct course here', onclick: () => { const x = near[0]?.d < rad / 3 || focus ? near[0] : { kind: 'll', ...p }; const from = own ? `${own.lat.toFixed(4)}/${own.lon.toFixed(4)}` : current.points[0]?.id; if (!from) return toast('Direct To needs a position or a departure point.'); setPlan({ text: `${from} ${x.kind === 'll' ? `${x.lat.toFixed(4)}/${x.lon.toFixed(4)}` : x.id}` }); close(); } }, 'Direct To')),
    h('div', { class: 'body' },
      h('div', { class: 'sect' }, 'Location'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, fmtLL(p.lat, p.lon)), locSub), h('button', { class: 'pill', title: 'Save this spot as a named position', onclick: () => markAt(p) }, 'Mark'), h('button', { class: 'pill go', onclick: () => add({ kind: 'll', ...p }) }, 'Add')),
      h('div', { class: 'sect' }, 'Airspace'), asBox,
      tfrRowsAt(p), pirepRows(p, rad), obsRows(p, rad), advisRows(p),
      h('div', { class: 'sect' }, 'Nearby'),
      near.length ? near.map(rowFor) : h('div', { class: 'row' }, h('div', { class: 's' }, 'Nothing nearby. Zoom in to see fixes.'))));
  box.classList.remove('hidden');
  elevations([p]).then(([ft]) => { locSub.textContent = `Elevation ${Math.round(ft).toLocaleString()}'` + (own ? ` · ${dist(own, p).toFixed(1)} nm from you` : ''); }).catch(() => { locSub.textContent = 'Elevation unavailable'; });
  airspaceAt(p).then(list => asBox.replaceChildren(...(list.length ? list.map(a => h('div', { class: 'row' }, h('div', { class: 'grow' },
    h('div', { class: 't' }, a.NAME || 'Airspace'),
    h('div', { class: 's' }, `${altText(a.LOWER_VAL, a.LOWER_UOM, a.LOWER_CODE)} – ${altText(a.UPPER_VAL, a.UPPER_UOM, a.UPPER_CODE)} · ${a.CLASS && a.CLASS.length === 1 ? 'Class ' + a.CLASS : a.TYPE_CODE || ''}`))))
    : [h('div', { class: 'row' }, h('div', { class: 's' }, 'No Class B, C, D or special use airspace here.'))])));
}
let pin = null;

// ---------- search box
function initSearch() {
  const inp = $('#map-search'), res = $('#search-results');
  const go = x => { res.classList.add('hidden'); inp.value = ''; inp.blur(); flyTo(x, x.kind === 'apt' ? 11 : 10); inspect(x, x); };
  inp.oninput = () => {
    const q = inp.value.trim();
    if (!q || /\s/.test(q)) { res.classList.add('hidden'); return; }
    const list = search(q, 12);
    res.replaceChildren(...(list.length ? list.map(x => h('button', { class: 'row', onclick: () => go(x) },
      h('div', { class: 'grow' }, h('div', { class: 't' }, x.id), h('div', { class: 's' }, x.kind === 'apt' ? `${x.name} · ${x.city}, ${x.state}` : x.name))))
      : [h('div', { class: 'row' }, h('div', { class: 's' }, 'No match. Enter an identifier, name or city.'))]));
    res.classList.remove('hidden');
  };
  inp.onkeydown = e => {
    if (e.key !== 'Enter') return;
    const q = inp.value.trim().toUpperCase(); if (!q) return;
    if (/\s/.test(q)) {
      $('#fpl').classList.remove('hidden'); $('#btn-fpl').classList.add('on');
      setPlan({ text: q }).then(r => { setTimeout(fitRoute, 60); if (r.errors.length) toast(r.errors[0] + '.'); }); inp.value = ''; inp.blur(); res.classList.add('hidden');
    } else { const x = resolve(q) || search(q, 1)[0]; x ? go(x) : toast(`${q} not found.`); }
  };
}
export const mapView = () => ({ bounds: map.getBounds(), zoom: map.getZoom(), base: st.base, chart: st.chart });

// ---------- terrain hazard: red within 100 ft of your altitude, yellow within 1,000 ft
// Uses GPS altitude when a fix is available, else the flight plan altitude.
const hazardRef = () => own && own.alt > 0 ? own.alt : plan.alt;
let hazardAt = null;
const Hazard = L.GridLayer.extend({
  createTile(c, done) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, 256, 256), p = d.data, ref = hazardRef() / 3.28084;
      for (let i = 0; i < p.length; i += 4) {
        const m = p[i] * 256 + p[i + 1] + p[i + 2] / 256 - 32768;
        if (m > ref - 30.5) { p[i] = 239; p[i + 1] = 68; p[i + 2] = 68; p[i + 3] = 125; }
        else if (m > ref - 304.8) { p[i] = 245; p[i + 1] = 200; p[i + 2] = 40; p[i + 3] = 100; }
        else p[i + 3] = 0;
      }
      g.putImageData(d, 0, 0); done(null, cv);
    };
    img.onerror = () => done(null, cv);
    img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${c.z}/${c.x}/${c.y}.png`;
    return cv;
  },
});
function refreshHazard() {
  const ref = hazardRef();
  if (hazardAt != null && Math.abs(ref - hazardAt) >= 100) { hazardAt = ref; hazardL?.redraw(); loadObstacles(); }
}
on('gps', refreshHazard);

// ---------- obstacles (FAA Digital Obstacle File)
let obsSeq = 0, obstacles = [];
const loadObstacles = debounce(async () => {
  if (!map) return;
  const my = ++obsSeq;
  if (!st.ov.obstacles || map.getZoom() < 9) { obsL.clearLayers(); obstacles = []; return; }
  const minAgl = map.getZoom() >= 11.5 ? 0 : 200;
  const j = await fetch(`${FAA_FEAT}Digital_Obstacle_File/FeatureServer/0/query?where=${encodeURIComponent('AGL>=' + minAgl)}${envelope(map.getBounds())}&outFields=Type_Code,AGL,AMSL&outSR=4326&resultRecordCount=1500&f=geojson`).then(r => r.json()).catch(() => ({ features: [] }));
  if (my !== obsSeq) return;
  obsL.clearLayers();
  obstacles = (j.features || []).filter(f => f.geometry).map(f => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], type: (f.properties.Type_Code || 'Obstacle').trim(), agl: f.properties.AGL, msl: f.properties.AMSL }));
  const ref = hazardRef();
  for (const o of obstacles) L.circleMarker([o.lat, o.lon], { renderer: canvas, interactive: false, radius: o.agl >= 1000 ? 5.5 : 3.5, weight: 1, color: '#10161a', fillOpacity: .95,
    fillColor: o.msl > ref - 100 ? '#ef4444' : o.msl > ref - 1000 ? '#f2b134' : '#aeb9c1' }).addTo(obsL);
}, 500);
function obsRows(p, rad) {
  const near = obstacles.map(o => ({ ...o, d: dist(p, o) })).filter(o => o.d <= rad).sort((a, b) => b.msl - a.msl).slice(0, 4);
  if (!near.length) return [];
  const cap = s => s.charAt(0) + s.slice(1).toLowerCase();
  return [h('div', { class: 'sect' }, 'Obstacles'), ...near.map(o => h('div', { class: 'row' }, h('div', { class: 'grow' },
    h('div', { class: 't' }, `${o.msl.toLocaleString()}' MSL`), h('div', { class: 's' }, `${cap(o.type)} · ${o.agl.toLocaleString()}' AGL · ${o.d.toFixed(1)} nm ${compass(bearing(p, o))}`))))];
}

// ---------- live traffic (needs the relay server in CONFIG.proxyUrl)
let trafficTimer = null;
async function loadTraffic() {
  // With a receiver connected, its own traffic is shown instead of internet traffic.
  if (!st.ov.traffic || document.hidden || !$('#v-maps').classList.contains('active') || adsbOn()) { if (adsbOn()) trafficL.clearLayers(); return; }
  const c = map.getCenter(), b = map.getBounds();
  const r = Math.min(250, Math.max(10, dist({ lat: b.getNorth(), lon: b.getWest() }, { lat: c.lat, lon: c.lng })));
  let list; try { list = await traffic(c.lat, c.lng, r); } catch { return; }
  if (!st.ov.traffic) return;
  trafficL.clearLayers();
  for (const a of list.slice(0, 300)) {
    const alt = a.alt === 'ground' ? 'GND' : a.alt != null ? String(Math.round(a.alt / 100)).padStart(3, '0') + (a.vs > 300 ? '↑' : a.vs < -300 ? '↓' : '') : '';
    L.marker([a.lat, a.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [0, 0],
      html: `<div class="tfc"><span style="transform:rotate(${Math.round(a.track || 0)}deg)">${PLANE}</span><b>${esc(a.flight || a.type || '')}<br>${alt}</b></div>` }) }).addTo(trafficL);
  }
}
function setTraffic() {
  clearInterval(trafficTimer); trafficTimer = null; trafficL.clearLayers();
  if (!st.ov.traffic) return;
  if (!CONFIG.proxyUrl) { st.ov.traffic = false; save(); toast('Traffic needs the relay server. See the README to set it up.'); return; }
  loadTraffic(); trafficTimer = setInterval(loadTraffic, 8000);
}

// ---------- marked positions and imported map content
function drawMarks() {
  marksL.clearLayers();
  for (const m of marks.list()) mk({ lat: m.lat, lon: m.lon, id: m.name }, 'mark').addTo(marksL);
}
function markAt(p) {
  const name = h('input', { type: 'text', maxLength: 8, placeholder: 'For example CABIN', style: 'width:100%;text-transform:uppercase' });
  modal('Mark this position', h('div', { class: 'form' }, h('label', { class: 'field wide' }, h('span', {}, 'Name. 2 to 8 letters or digits. Use it in routes.'), name), h('div', { class: 'note wide' }, fmtLL(p.lat, p.lon))), [{ label: 'Save', run: () => {
    const n = name.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(n)) { toast('Use 2 to 8 letters or digits, no spaces.'); return false; }
    if (resolve(n) && !marks.list().some(m => m.name === n)) { toast(`${n} is already an airport, navaid or fix. Choose another name.`); return false; }
    marks.add(n, p.lat, p.lon); toast(`${n} saved. Type it in a route to use it.`);
  } }]);
  setTimeout(() => name.focus(), 50);
}
async function drawContent() {
  contentL.clearLayers();
  for (const c of kv.get('content', [])) {
    if (c.hidden) continue;
    const gj = await files.get('content:' + c.id); if (!gj) continue;
    L.geoJSON(gj, { renderer: canvas, interactive: false, style: { color: '#ffb020', weight: 2.5, fillOpacity: .12 },
      pointToLayer: (f, ll) => L.circleMarker(ll, { renderer: canvas, radius: 5, color: '#10161a', weight: 1, fillColor: '#ffb020', fillOpacity: 1, interactive: false }) }).addTo(contentL);
  }
}

// ---------- PIREPs (through the relay)
export const PIREP_COLOR = { sev: '#ef4444', mod: '#ff9f1c', lgt: '#f2d13a', neg: '#3fc35f', '': '#a7b5bf' };
async function loadPireps() {
  pirepL.clearLayers(); pirepData = null;
  if (!st.ov.pirep) return;
  if (!CONFIG.proxyUrl) { st.ov.pirep = false; save(); return toast('PIREPs need the relay server. See the README to set it up.'); }
  try { pirepData = await pireps(); } catch (e) { return toast(e.message + '.'); }
  if (!st.ov.pirep) return;
  pirepL.clearLayers();
  for (const f of pirepData.features) {
    const [lon, lat] = f.geometry.coordinates, lv = pirepLevel(f.properties);
    L.circleMarker([lat, lon], { renderer: canvas, interactive: false, radius: lv === 'sev' ? 7 : 5, color: '#10161a', weight: 1.5, fillColor: PIREP_COLOR[lv], fillOpacity: 1 }).addTo(pirepL);
  }
}
setInterval(() => { if (st.ov.pirep) loadPireps(); }, 5 * 6e4);
function pirepRows(p, rad) {
  if (!pirepData) return [];
  const hit = pirepData.features.map(f => ({ q: f.properties, d: dist(p, { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }) })).filter(x => x.d <= Math.max(rad, 10)).sort((a, b) => a.d - b.d).slice(0, 6);
  return hit.length ? [h('div', { class: 'sect' }, 'PIREPs'), ...hit.map(({ q }) => h('div', { class: 'row' }, h('span', { class: 'dot', style: `background:${PIREP_COLOR[pirepLevel(q)]}` }),
    h('div', { class: 'grow' }, h('div', { class: 't' }, pirepText(q) || q.airepType), h('div', { class: 's', style: 'white-space:normal' }, `${q.rawOb} · ${Math.round((Date.now() - Date.parse(q.obsTime)) / 6e4)} min ago`))))] : [];
}

// ---------- TFRs (through the relay)
async function loadTfrs() {
  tfrL.clearLayers(); tfrData = null;
  if (!st.ov.tfr || !CONFIG.proxyUrl) return;
  try { tfrData = await tfrs(); } catch { return toast('TFRs did not load. Check your connection.'); }
  if (!st.ov.tfr) return;
  tfrL.clearLayers();
  L.geoJSON(tfrData, { renderer: canvas, interactive: false, style: { color: '#ff4d4d', weight: 2, fillColor: '#ff4d4d', fillOpacity: .16 } }).addTo(tfrL);
}
setInterval(() => { if (st.ov.tfr) loadTfrs(); }, 10 * 6e4);
function tfrRowsAt(p) {
  const hit = tfrData ? tfrsAt(tfrData, p) : [];
  return hit.length ? [h('div', { class: 'sect' }, 'TFRs'), ...hit.map(t => tfrRow(t))] : [];
}

// ---------- G-AIRMET advisories: icing, turbulence, IFR (through the relay)
const ADV = { ICE: ['ice', '#4cc9f0', 'Icing'], 'TURB-HI': ['turb', '#ff9f1c', 'Turbulence, high'], 'TURB-LO': ['turb', '#ff9f1c', 'Turbulence, low'], IFR: ['ifr', '#b388ff', 'IFR'], MT_OBSC: ['ifr', '#b388ff', 'Mountain obscuration'] };
let advis = [];
async function loadAdvisories() {
  advisL.clearLayers(); advis = [];
  if (!st.ov.ice && !st.ov.turb && !st.ov.ifr) return;
  const off = msg => { st.ov.ice = st.ov.turb = st.ov.ifr = false; save(); toast(msg); };
  if (!CONFIG.proxyUrl) return off('Advisories need the relay server. See the README to set it up.');
  let j; try { j = await gairmets(); } catch (e) { return off(e.message + '.'); }
  const polys = (j.features || []).filter(f => f.geometry && /Polygon/.test(f.geometry.type) && ADV[f.properties.hazard]);
  const first = Math.min(...polys.map(f => f.properties.forecast ?? 0));
  advis = polys.filter(f => (f.properties.forecast ?? 0) === first && st.ov[ADV[f.properties.hazard][0]]);
  advisL.clearLayers();
  L.geoJSON({ type: 'FeatureCollection', features: advis }, { renderer: canvas, interactive: false, style: f => ({ color: ADV[f.properties.hazard][1], weight: 2, fillOpacity: .13, dashArray: f.properties.hazard === 'TURB-HI' ? '8 5' : null }) }).addTo(advisL);
  if (!advis.length) toast('No active advisories of that kind.');
}
const lvl = v => !v ? '' : v === 'SFC' ? 'surface' : v === 'FZL' ? 'freezing level' : +v >= 180 ? 'FL' + v : `${(+v * 100).toLocaleString()}'`;
function advisRows(p) {
  const hit = advis.filter(f => inGeom(p.lon, p.lat, f.geometry));
  if (!hit.length) return [];
  return [h('div', { class: 'sect' }, 'Advisories'), ...hit.map(f => { const q = f.properties;
    return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, ADV[q.hazard][2] + (q.severity ? `, ${q.severity === 'MOD' ? 'moderate' : q.severity.toLowerCase()}` : '')),
      h('div', { class: 's' }, [q.base || q.top ? `${lvl(q.base)} to ${lvl(q.top)}` : '', q.dueTo && q.dueTo !== q.hazard ? q.dueTo : '', `valid ${new Date(q.validTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`].filter(Boolean).join(' · ')))); })];
}

// ---------- airport surface: runway outlines everywhere, taxiways, aprons and hot spots where the FAA maps them
let surfSeq = 0;
const loadSurface = debounce(async () => {
  if (!map) return;
  const my = ++surfSeq, z = map.getZoom();
  if (!st.ov.aero || z < 12.5) { surfL.clearLayers(); return; }
  const env = envelope(map.getBounds().pad(.1));
  const q = (svc, fields) => fetch(`${FAA_FEAT}${svc}/FeatureServer/0/query?where=1%3D1${env}&outFields=${fields}&outSR=4326&resultRecordCount=2000&f=geojson`).then(r => r.json()).then(j => j.features || []).catch(() => []);
  const detail = z >= 13.5;
  const [rw, tw, ap, hs] = await Promise.all([q('RunwayArea', 'DESIGNATOR_TXT'), detail ? q('AM_Taxiway', 'DESIGNATOR') : [], detail ? q('AM_Apron', 'DESIGNATOR') : [], detail ? q('AM_Hotspot', 'HOT_ID') : []]);
  if (my !== surfSeq) return;
  surfL.clearLayers();
  const add = (features, style) => L.geoJSON({ type: 'FeatureCollection', features }, { renderer: canvas, interactive: false, style }).addTo(surfL);
  add(ap, { color: '#5b6872', weight: .5, fillColor: '#46525c', fillOpacity: .85 });
  add(tw, { color: '#8a97a1', weight: .5, fillColor: '#6b7a85', fillOpacity: .9 });
  add(rw, { color: '#ffffff', weight: 1.5, fillColor: '#1b2126', fillOpacity: .92 });
  add(hs, { color: '#ef4444', weight: 2.5, fillOpacity: .08 });
  if (z < 14.5) return;
  const centre = g => { const ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0]; let x = 0, y = 0; for (const c of ring) { x += c[0]; y += c[1]; } return { lat: y / ring.length, lon: x / ring.length }; };
  const seen = new Set(); let n = 0;
  const label = (f, text, cls) => { if (!text || !f.geometry || n > 160) return; const c = centre(f.geometry), k = text + Math.round(c.lat * 500) + Math.round(c.lon * 500); if (seen.has(k)) return; seen.add(k); n++;
    L.marker([c.lat, c.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="surf ${cls}">${esc(text)}</div>` }) }).addTo(surfL); };
  rw.forEach(f => label(f, f.properties.DESIGNATOR_TXT, 'rwy'));
  tw.forEach(f => { const d = f.properties.DESIGNATOR; if (d && d !== 'UNK' && !d.includes('_')) label(f, d, 'twy'); });   // skip unnamed pavement and intersection pieces
  hs.forEach(f => label(f, f.properties.HOT_ID, 'hot'));
}, 500);

// ---------- approach plate on the map
let plateL = null, plateUrl = null;
export function hidePlate() { plateL?.remove(); plateL = null; if (plateUrl) URL.revokeObjectURL(plateUrl); plateUrl = null; $('#plate-bar').classList.add('hidden'); }
export async function showPlate(title, cycle, pdf, src) {
  const { blob, bounds } = await plateImage(cycle, pdf, src);
  hidePlate();
  plateUrl = URL.createObjectURL(blob);
  plateL = L.imageOverlay(plateUrl, bounds, { opacity: .85, interactive: false, pane: 'wx' }).addTo(map);
  map.fitBounds(bounds);
  $('#plate-bar').replaceChildren(h('div', { class: 'ttl' }, title),
    h('input', { type: 'range', min: 20, max: 100, value: 85, title: 'Plate opacity', oninput: e => plateL?.setOpacity(e.target.value / 100) }),
    h('button', { class: 'btn sm', onclick: hidePlate }, 'Remove'));
  $('#plate-bar').classList.remove('hidden');
}
