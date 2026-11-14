// Flight plan state: route text -> points -> legs with wind, time and fuel.
import { kv, emit, uid } from './util.js';
import { resolve, airwayPath, isAirway, magvar } from './db.js';
import { dist, bearing, along, norm } from './geo.js';
import { winds } from './wx.js';

const SAMPLE = {
  id: 'sample', name: 'C172S (sample)', tail: 'N12345', tas: 122, burn: 8.5, fuelCap: 53,
  wb: { emptyW: 1680, emptyArm: 39.5, maxW: 2550, cgFwd: 35, cgAft: 47.3, fuelArm: 48,
    stations: [{ name: 'Front seats', arm: 37 }, { name: 'Rear seats', arm: 73 }, { name: 'Baggage', arm: 95 }] },
};
export const aircraft = {
  list: () => { const l = kv.get('aircraft'); return l && l.length ? l : [SAMPLE]; },
  get: id => aircraft.list().find(a => a.id === id) || aircraft.list()[0],
  save(ac) { const l = aircraft.list().filter(a => a.id !== ac.id); ac.id ||= uid(); l.push(ac); kv.set('aircraft', l); emit('aircraft'); },
  remove(id) { kv.set('aircraft', aircraft.list().filter(a => a.id !== id)); emit('aircraft'); },
};

export const plan = Object.assign({ text: '', alt: 5500, acId: 'sample', etd: '' }, kv.get('plan', {}));
export let current = { points: [], chips: [], legs: [], total: null, errors: [] };
let seq = 0;

export function setPlan(patch) {
  Object.assign(plan, patch);
  plan.text = plan.text.toUpperCase().replace(/\s+/g, ' ').trim();
  kv.set('plan', plan);
  return recompute();
}
export const addPoint = id => setPlan({ text: (plan.text + ' ' + id).trim() });
export const removeToken = i => { const t = plan.text.split(' '); t.splice(i, 1); return setPlan({ text: t.join(' ') }); };
export const reverse = () => setPlan({ text: plan.text.split(' ').reverse().join(' ') });

export async function parse(text) {
  const toks = text.toUpperCase().split(/[\s.]+/).filter(Boolean);
  const points = [], chips = [], errors = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], prev = points[points.length - 1];
    if (/^\d{2,3}KTS?$/.test(t) || t === 'DCT') { chips.push({ label: t, kind: 'awy', i }); continue; }
    if (prev && toks[i + 1] && await isAirway(t)) {
      const next = resolve(toks[i + 1], prev);
      const mid = next && await airwayPath(t, prev, next);
      if (mid) { points.push(...mid); chips.push({ label: t, kind: 'awy', i }); continue; }
      if (!resolve(t, prev)) { errors.push(`${t} does not connect ${prev.id} and ${toks[i + 1]}`); chips.push({ label: t, kind: 'err', i }); continue; }
    }
    const p = resolve(t, prev);
    if (p) { points.push(p); chips.push({ label: p.kind === 'll' ? p.id : t, kind: p.kind, i }); }
    else { errors.push(`${t} not found`); chips.push({ label: t, kind: 'err', i }); }
  }
  return { points, chips, errors };
}

export function legsFor(points, ac, alt, wind) {
  const legs = [];
  let d = 0, min = 0, fuel = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dd = dist(a, b), tc = bearing(a, b), mid = along(a, b, .5), mv = magvar(mid);
    const w = wind?.[i - 1] || { dir: 0, spd: 0 };
    const ang = (w.dir - tc) * Math.PI / 180, xw = w.spd * Math.sin(ang), hw = w.spd * Math.cos(ang);
    const wca = Math.asin(Math.max(-1, Math.min(1, xw / ac.tas)));
    const gs = Math.max(20, ac.tas * Math.cos(wca) - hw);
    const t = dd / gs * 60, f = ac.burn * t / 60;
    d += dd; min += t; fuel += f;
    legs.push({ from: a, to: b, d: dd, tc, mc: norm(tc - mv), mh: norm(tc + wca * 180 / Math.PI - mv), wind: wind ? w : null, gs, min: t, fuel: f, cd: d, cmin: min, cfuel: fuel });
  }
  return { legs, total: points.length > 1 ? { d, min, fuel, comp: wind ? ac.tas - d / (min / 60) : null } : null };
}

export async function recompute() {
  const my = ++seq, ac = aircraft.get(plan.acId);
  const { points, chips, errors } = await parse(plan.text);
  if (my !== seq) return current;
  current = { points, chips, errors, ...legsFor(points, ac, plan.alt, null), ac, windPending: points.length > 1 };
  emit('route', current);
  if (points.length > 1) {
    try {
      const mids = points.slice(1).map((b, i) => along(points[i], b, .5));
      const w = await winds(mids, plan.alt);
      if (my !== seq) return current;
      current = { ...current, ...legsFor(points, ac, plan.alt, w), windPending: false };
    } catch { current = { ...current, windPending: false, windFailed: true }; }
    if (my === seq) emit('route', current);
  }
  return current;
}

// Saved flights
export const flights = {
  list: () => kv.get('flights', []),
  save(f) { const l = flights.list().filter(x => x.id !== f.id); f.id ||= uid(); l.unshift(f); kv.set('flights', l); emit('flights'); return f; },
  remove(id) { kv.set('flights', flights.list().filter(x => x.id !== id)); emit('flights'); },
};
