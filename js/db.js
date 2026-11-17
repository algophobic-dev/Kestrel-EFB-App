// Navigation database: airports, navaids, fixes, airways, runways, frequencies, plates.
import { dist } from './geo.js';
import { kv, emit, uid } from './util.js';

// Marked positions: the pilot's own named waypoints. Usable in routes by name.
export const marks = {
  list: () => kv.get('marks', []),
  add(name, lat, lon) { kv.set('marks', [...marks.list().filter(m => m.name !== name), { id: uid(), name, lat: +lat.toFixed(5), lon: +lon.toFixed(5) }]); emit('marks'); },
  remove(id) { kv.set('marks', marks.list().filter(m => m.id !== id)); emit('marks'); },
};

const TYPE_NAMES = ['Airport', 'Airport', 'Airport', 'Seaplane base', 'Heliport'];
export const db = { airports: [], navaids: [], fixes: [], ready: false };
const byId = new Map(), byLocal = new Map(), navBy = new Map(), fixBy = new Map();
const lazy = {};

const getJSON = async f => (await fetch('data/' + f)).json();
const mkApt = r => ({ kind: 'apt', id: r[0], name: r[1], lat: r[2], lon: r[3], elev: r[4], type: r[5], city: r[6], state: r[7], local: r[8], wx: r[9], wxId: r[10] || r[0], minor: r[5] === 0 && r[0].length !== 3 && !/^[A-Z]{4}$/.test(r[0]), typeName: TYPE_NAMES[r[5]] });
const mkNav = r => ({ kind: 'nav', id: r[0], name: r[1] + ' ' + r[2], lat: r[3], lon: r[4], freq: r[5], mv: r[6], navType: r[2] });
const mkFix = r => ({ kind: 'fix', id: r[0], name: 'Waypoint', lat: r[1], lon: r[2] });
const push = (m, k, v) => { const a = m.get(k); a ? a.push(v) : m.set(k, [v]); };

export async function load() {
  const [a, n, f] = await Promise.all([getJSON('airports.json'), getJSON('navaids.json'), getJSON('fixes.json').catch(() => [])]);
  db.airports = a.map(mkApt); db.navaids = n.map(mkNav); db.fixes = f.map(mkFix);
  for (const x of db.airports) { const had = byId.get(x.id); if (!had || had.type >= 3) byId.set(x.id, x); if (x.local && !byLocal.has(x.local)) byLocal.set(x.local, x); }
  for (const x of db.navaids) push(navBy, x.id, x);
  for (const x of db.fixes) push(fixBy, x.id, x);
  db.ready = true;
}
export const part = name => lazy[name] ||= getJSON(name + '.json').catch(() => ({}));
export const airport = id => byId.get(id) || byLocal.get(id) || byId.get('K' + id);
export const procs = async id => (await part('procs'))[id] || {};
export const runways = async id => (await part('runways'))[id] || [];
export const freqs = async id => (await part('freqs'))[id] || [];
export async function plates(id) {
  const p = await part('plates'), a = p.a || {};
  const list = a[id] || a[id.replace(/^K/, '')] || [];
  return { cycle: p.cycle, from: p.from, to: p.to, list };
}

const nearest = (list, near) => !list ? null : !near || list.length === 1 ? list[0] : list.reduce((b, x) => dist(x, near) < dist(b, near) ? x : b);

// Resolve one route token to a point. `near` breaks ties between same-named fixes.
export function resolve(tok, near) {
  tok = tok.toUpperCase();
  const ll = tok.match(/^(-?\d+(?:\.\d+)?)[,/](-?\d+(?:\.\d+)?)$/);
  if (ll) return { kind: 'll', id: `${(+ll[1]).toFixed(2)}/${(+ll[2]).toFixed(2)}`, name: 'Position', lat: +ll[1], lon: +ll[2] };
  const m = marks.list().find(x => x.name === tok);
  if (m) return { kind: 'mark', id: m.name, name: 'Marked position', lat: m.lat, lon: m.lon };
  const apt = byId.get(tok), other = nearest(navBy.get(tok), near) || nearest(fixBy.get(tok), near);
  // An airport wins a shared code, unless a navaid or fix of that name is much closer to the route (MTU: Myton VOR, not an airport in Mozambique).
  if (apt && other && near && dist(other, near) + 500 < dist(apt, near)) return other;
  return apt || other || byLocal.get(tok) || byId.get('K' + tok) || null;
}

export function search(q, limit = 30) {
  q = q.trim().toUpperCase(); if (!q) return [];
  const out = [], seen = new Set();
  const add = x => { if (!seen.has(x) && out.length < limit) { seen.add(x); out.push(x); } };
  const ex = resolve(q); if (ex) add(ex);
  (navBy.get(q) || []).forEach(add); (fixBy.get(q) || []).forEach(add);
  for (const x of db.airports) if (x.type < 3 && !x.minor && (x.id.startsWith(q) || x.local.startsWith(q))) add(x);
  if (q.length >= 3) {
    const rank = [[], []];
    for (const x of db.airports) {
      const n = x.name.toUpperCase(), c = x.city.toUpperCase();
      if (n.startsWith(q) || c.startsWith(q)) rank[0].push(x); else if (n.includes(q)) rank[1].push(x);
    }
    // Larger public airports first; private strips, seaplane bases and heliports last.
    const score = x => x.type === 2 ? 5 : x.type === 1 ? 4 : x.type === 0 ? (x.minor ? 2 : 3) : x.type === 3 ? 1 : 0;
    rank.map(l => l.sort((a, b) => score(b) - score(a))).flat().forEach(add);
    for (const x of db.navaids) if (x.name.toUpperCase().startsWith(q)) add(x);
  }
  return out;
}

// Everything within radius nm of a point, nearest first.
export function nearby(p, radius, kinds = ['apt', 'nav', 'fix'], limit = 25) {
  const dlat = radius / 60, out = [];
  const scan = list => { for (const x of list) if (Math.abs(x.lat - p.lat) <= dlat) { const d = dist(p, x); if (d <= radius) out.push({ ...x, d }); } };
  if (kinds.includes('apt')) scan(db.airports);
  if (kinds.includes('nav')) scan(db.navaids);
  if (kinds.includes('fix')) scan(db.fixes);
  return out.sort((a, b) => a.d - b.d).slice(0, limit);
}
export function inBox(list, s, w, n, e, test) {
  const out = [];
  for (const x of list) if (x.lat >= s && x.lat <= n && x.lon >= w && x.lon <= e && (!test || test(x))) out.push(x);
  return out;
}

// Magnetic variation (east positive), taken from the nearest navaid.
let mvCache = null;
export function magvar(p) {
  if (mvCache && dist(mvCache.p, p) < 25) return mvCache.v;
  let best = null, bd = Infinity;
  for (const n of db.navaids) { if (!n.mv) continue; const d = Math.abs(n.lat - p.lat) + Math.abs(n.lon - p.lon) * .7; if (d < bd) { bd = d; best = n; } }
  mvCache = { p: { lat: p.lat, lon: p.lon }, v: best ? best.mv : 0 };
  return mvCache.v;
}

// Expand an airway between two points into its intermediate points.
export async function airwayPath(name, from, to) {
  const segs = (await part('airways'))[name]; if (!segs) return null;
  const key = (la, lo) => la.toFixed(3) + ',' + lo.toFixed(3);
  const nodes = new Map();
  const node = (la, lo) => { const k = key(la, lo); let n = nodes.get(k); if (!n) nodes.set(k, n = { lat: la, lon: lo, adj: [] }); return n; };
  for (const [a, b, c, d] of segs) { const n1 = node(a, b), n2 = node(c, d); n1.adj.push(n2); n2.adj.push(n1); }
  const closest = p => { let b = null, bd = 4; for (const n of nodes.values()) { const d = dist(n, p); if (d < bd) { bd = d; b = n; } } return b; };
  const s = closest(from), t = closest(to); if (!s || !t) return null;
  const prev = new Map([[s, null]]), q = [s];
  while (q.length) { const n = q.shift(); if (n === t) break; for (const m of n.adj) if (!prev.has(m)) { prev.set(m, n); q.push(m); } }
  if (!prev.has(t)) return null;
  const path = []; for (let n = prev.get(t); n && n !== s; n = prev.get(n)) path.unshift(n);
  return path.map(n => {
    const hit = nearby(n, 1.2, ['nav', 'fix'], 1)[0];
    return hit ? { ...hit, via: name } : { kind: 'll', id: `${n.lat.toFixed(2)}/${n.lon.toFixed(2)}`, name: name, lat: n.lat, lon: n.lon, via: name };
  });
}
export const isAirway = async name => /^[A-Z]{1,2}\d{1,3}$/.test(name) && !!(await part('airways'))[name];
