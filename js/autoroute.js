// Suggest a route along airways: shortest path through the airway network between two airports.
import { part, nearby } from './db.js';
import { dist, along } from './geo.js';

let nodesP;
const graph = () => nodesP ||= (async () => {
  const aw = await part('airways'), nodes = new Map();
  const node = (la, lo) => { const k = la.toFixed(3) + ',' + lo.toFixed(3); let n = nodes.get(k); if (!n) nodes.set(k, n = { lat: la, lon: lo, adj: [] }); return n; };
  for (const [name, segs] of Object.entries(aw)) {
    const cls = /^[VT]\d/.test(name) ? 'low' : /^[JQ]\d/.test(name) ? 'high' : null; if (!cls) continue;
    // RNAV routes (Q and T) are preferred: Jet and Victor routes count 15% longer, so they are used only where they save real distance.
    const k = /^[JV]/.test(name) ? 1.15 : 1;
    for (const [a, b, c, d] of segs) { const n1 = node(a, b), n2 = node(c, d), w = dist(n1, n2) * k; n1.adj.push({ to: n2, w, name, cls }); n2.adj.push({ to: n1, w, name, cls }); }
  }
  return [...nodes.values()];
})();

// Binary min-heap of [cost, node].
function heap() {
  const a = [];
  return {
    get size() { return a.length; },
    push(x) { a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } },
    pop() { const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; },
  };
}

// cls: 'low' (Victor and T routes) or 'high' (Jet and Q routes). Returns { text, d } or null.
export async function autoroute(dep, arr, cls) {
  const nodes = await graph(), JOIN = cls === 'high' ? 120 : 50, CHANGE = 4;   // nm to join the network; penalty for changing airways
  const usable = n => n.adj.some(e => e.cls === cls);
  const best = new Map(), prev = new Map(), h = heap();
  for (const n of nodes) { const d = dist(dep, n); if (d <= JOIN && usable(n)) { best.set(n, d); h.push([d, n]); } }
  const exits = new Map(); for (const n of nodes) { const d = dist(arr, n); if (d <= JOIN && usable(n)) exits.set(n, d); }
  if (!h.size || !exits.size) return null;
  let end = null, endCost = Infinity;
  while (h.size) {
    const [c, n] = h.pop();
    if (c > endCost) break;
    if (c > best.get(n)) continue;
    const out = exits.get(n); if (out != null && c + out < endCost) { endCost = c + out; end = n; }
    const via = prev.get(n)?.name;
    for (const e of n.adj) {
      if (e.cls !== cls) continue;
      const nc = c + e.w + (via && via !== e.name ? CHANGE : 0);
      if (nc < (best.get(e.to) ?? Infinity)) { best.set(e.to, nc); prev.set(e.to, { from: n, name: e.name }); h.push([nc, e.to]); }
    }
  }
  if (!end) return null;
  return trace(dep, arr, end, prev);
}
function trace(dep, arr, end, prev) {
  const path = []; for (let n = end; n; n = prev.get(n)?.from) path.unshift({ n, via: prev.get(n)?.name });
  const name = n => nearby(n, 1.5, ['nav', 'fix'], 1)[0]?.id || `${n.lat.toFixed(4)}/${n.lon.toFixed(4)}`;
  const toks = [dep.id, name(path[0].n)];
  let d = dist(dep, path[0].n);
  for (let i = 1; i < path.length; i++) {
    d += dist(path[i - 1].n, path[i].n);
    if (i === path.length - 1 || path[i + 1].via !== path[i].via) toks.push(path[i].via, name(path[i].n));
  }
  d += dist(path[path.length - 1].n, arr);
  toks.push(arr.id);
  return { text: toks.join(' '), d };
}

// RNAV direct: the great circle, through a named fix about every 150 nm, as GPS aircraft file today.
// Fixes on high airways are preferred, so the points are ones ATC knows; elsewhere any fix or navaid near the line is used.
export async function rnavRoute(dep, arr) {
  const total = dist(dep, arr), n = Math.floor(total / 150);
  if (n < 1) return { text: `${dep.id} ${arr.id}`, d: total };
  const nodes = await graph(), high = nodes.filter(x => x.adj.some(e => e.cls === 'high'));
  const toks = [dep.id], pts = [dep];
  for (let i = 1; i <= n; i++) {
    const p = along(dep, arr, i / (n + 1));
    let best = null, bd = 40;
    for (const x of high) if (Math.abs(x.lat - p.lat) < 1) { const d = dist(p, x); if (d < bd) { bd = d; best = x; } }
    const named = best && nearby(best, 1.5, ['nav', 'fix'], 1)[0] || nearby(p, 30, ['nav', 'fix'], 1)[0];
    if (named && named.id !== toks[toks.length - 1]) { toks.push(named.id); pts.push(named); }
  }
  toks.push(arr.id); pts.push(arr);
  let d = 0; for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
  return { text: toks.join(' '), d };
}
