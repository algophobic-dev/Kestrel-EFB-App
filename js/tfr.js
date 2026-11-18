// TFRs: shapes for the map, a list near an airport, and each TFR's full text. All through the relay (tfr.faa.gov).
import { h, modal } from './util.js';
import { CONFIG } from './config.js';
import { dist, inGeom } from './geo.js';

const relay = () => CONFIG.proxyUrl.replace(/\/$/, '');
let got = null;
// Active TFRs as GeoJSON, kept for 10 minutes.
export function tfrs() {
  if (!CONFIG.proxyUrl) return Promise.reject(new Error('TFRs need the relay server'));
  if (got && Date.now() - got.t < 6e5) return got.p;
  const p = fetch(relay() + '/tfr').then(r => { if (!r.ok) throw new Error('TFRs did not load'); return r.json(); });
  got = { t: Date.now(), p }; p.catch(() => { got = null; });
  return p;
}

const TYPE = { SECURITY: 'Security', VIP: 'VIP', HAZARDS: 'Hazards', SPECIAL: 'Special', 'UAS PUBLIC GATHERING': 'Drone, public gathering', 'AIR SHOWS/SPORTS': 'Air show or sports', 'SPACE OPERATIONS': 'Space operations' };
export const tfrType = t => TYPE[t] || (t ? t[0] + t.slice(1).toLowerCase() : 'TFR');

// Distance in nm from a point to a TFR: 0 inside, else to the nearest corner of its outline.
function distTo(p, g) {
  if (inGeom(p.lon, p.lat, g)) return 0;
  const rings = g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
  let best = Infinity;
  for (const r of rings) for (const [lon, lat] of r) { const d = dist(p, { lat, lon }); if (d < best) best = d; }
  return best;
}
// TFRs within `nm` of a point, nearest first.
export async function tfrsNear(p, nm) {
  const j = await tfrs();
  return j.features.map(f => ({ ...f.properties, d: distTo(p, f.geometry) })).filter(t => t.d <= nm).sort((a, b) => a.d - b.d);
}
export const tfrsAt = (j, p) => j.features.filter(f => inGeom(p.lon, p.lat, f.geometry)).map(f => f.properties);

// One row per TFR, with a Details button that opens its full text.
export function tfrRow(t, extra = '') {
  return h('div', { class: 'row' },
    h('div', { class: 'grow' }, h('div', { class: 't' }, `TFR ${t.id} · ${tfrType(t.type)}`), h('div', { class: 's', style: 'white-space:normal' }, t.title + extra)),
    h('button', { class: 'pill', onclick: () => tfrDetails(t) }, 'Details'));
}
export async function tfrDetails(t) {
  const body = h('pre', { class: 'raw', style: 'white-space:pre-wrap;max-height:60vh;overflow:auto' }, 'Loading.');
  modal(`TFR ${t.id}`, h('div', {}, body,
    h('p', { class: 'note', style: 'margin-top:8px' }, h('a', { href: `https://tfr.faa.gov/tfr3/?page=detail_${t.id.replace('/', '_')}`, target: '_blank', rel: 'noopener' }, 'Open on tfr.faa.gov'))));
  try {
    const r = await fetch(`${relay()}/tfr/text?id=${encodeURIComponent(t.id)}`), j = await r.json();
    body.textContent = r.ok ? j.text : 'Details did not load. Open it on tfr.faa.gov.';
  } catch { body.textContent = 'Details did not load. Check your connection.'; }
}
