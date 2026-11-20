// Flight plan state: route text -> points -> legs with wind, time and fuel.
import { kv, emit, uid } from './util.js';
import { resolve, airwayPath, isAirway, magvar, procs, airport } from './db.js';
import { dist, bearing, along, norm } from './geo.js';
import { winds } from './wx.js';

const SAMPLE = {
  id: 'sample', name: 'C172S (sample)', tail: 'N12345', tas: 122, burn: 8.5, fuelCap: 53,
  climbKt: 74, climbFpm: 700, climbGph: 10, descKt: 110, descFpm: 500, descGph: 6,
  perf: { toRoll: 960, to50: 1630, ldRoll: 575, ld50: 1335 },
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
  // Dots separate route elements (KLUK.HYK), except inside a lat/lon point such as 40.08/116.60.
  const toks = text.toUpperCase().split(/\s+/).flatMap(t => /^-?\d+(\.\d+)?[,/]-?\d+(\.\d+)?$/.test(t) ? [t] : t.split('.')).filter(Boolean);
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
    // SID right after the departure airport, STAR right before the destination. Both end in a digit.
    const pushFixes = (seq, via) => { for (const id of seq) { const last = points[points.length - 1], f = resolve(id, last); if (f && f.id !== last.id) points.push({ ...f, via }); } };
    // Approach: typed right after the destination airport, optionally followed by a transition name.
    const appr = prev && prev.kind === 'apt' && points.length > 1 && ((await procs(prev.id)).F || {})[t];
    if (appr) {
      const tr = appr.t[toks[i + 1]], dest = points.pop();
      pushFixes([...(tr || []), ...appr.c], t); points.push(dest);
      chips.push({ label: t, kind: 'awy', i });
      if (tr) { i++; chips.push({ label: toks[i], kind: 'awy', i }); }
      continue;
    }
    if (prev && /^[A-Z]{3,5}\d$/.test(t)) {
      const sid = points.length === 1 && prev.kind === 'apt' && ((await procs(prev.id)).D || {})[t];
      if (sid) {
        const tr = sid.t[toks[i + 1]];
        pushFixes([...(sid.c.length || tr ? [] : Object.values(sid.r)[0] || []), ...sid.c, ...(tr || [])], t);
        chips.push({ label: t, kind: 'awy', i });
        if (tr) { i++; chips.push({ label: toks[i], kind: 'awy', i }); }   // the transition name is part of the SID
        continue;
      }
      const dest = toks[i + 1] && airport(toks[i + 1]);
      const star = dest && ((await procs(dest.id)).E || {})[t];
      if (star) {
        const tr = star.t[prev.id];
        pushFixes([...(tr || (star.c.length ? [] : Object.values(star.t)[0] || [])), ...star.c], t);
        chips.push({ label: t, kind: 'awy', i }); continue;
      }
    }
    const p = resolve(t, prev);
    if (p) { if (!prev || p.id !== prev.id) points.push(p); chips.push({ label: p.kind === 'll' ? p.id : t, kind: p.kind, i }); }
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
  const comp = wind && min ? ac.tas - d / (min / 60) : null;
  // Climb and descent: extra time and fuel against cruising the same distance. Wind is applied at cruise only.
  let toc = null, tod = null;
  const e0 = points[0]?.elev || 0, e1 = points[points.length - 1]?.elev || 0;
  if (legs.length) {
    const adj = (dAlt, kt, fpm, gph) => {
      if (!(fpm > 0) || !(kt > 0) || !(dAlt > 0)) return null;
      const full = kt * (dAlt / fpm) / 60, dist = Math.min(full, d / 2), t = dAlt / fpm * (dist / full), tCruise = dist / ac.tas * 60;
      return { dist, dt: t - tCruise, df: t / 60 * (gph || ac.burn) - tCruise / 60 * ac.burn };
    };
    const c = adj(alt - e0, ac.climbKt, ac.climbFpm, ac.climbGph), s = adj(alt - e1, ac.descKt, ac.descFpm, ac.descGph);
    if (c) { toc = c.dist; legs.forEach((l, i) => { if (!i) { l.min += c.dt; l.fuel += c.df; } l.cmin += c.dt; l.cfuel += c.df; }); min += c.dt; fuel += c.df; }
    if (s) { tod = d - s.dist; const l = legs[legs.length - 1]; l.min += s.dt; l.fuel += s.df; l.cmin += s.dt; l.cfuel += s.df; min += s.dt; fuel += s.df; }
  }
  return { legs, total: points.length > 1 ? { d, min, fuel, comp, toc, tod, e0, e1,
    // Fuel required = trip + taxi + reserve at cruise burn.
    taxi: ac.taxi ?? 1.5, reserve: (ac.reserve ?? 45) / 60 * ac.burn, req: fuel + (ac.taxi ?? 1.5) + (ac.reserve ?? 45) / 60 * ac.burn } : null };
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
