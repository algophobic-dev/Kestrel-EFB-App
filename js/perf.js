// Takeoff and landing distance estimates.
// Baseline figures come from the pilot (POH, sea level, standard day, max weight, paved, no wind).
// Corrections are common rules of thumb, not POH data: treat results as estimates.
import { h } from './util.js';
import { runways } from './db.js';
import { metar } from './wx.js';
import { norm } from './geo.js';

const SOFT = /TURF|GRASS|GRS|DIRT|GRAVEL|GRVL|SOD/i;

// kind: 'to' or 'ld'. Returns ground roll and total distance over a 50 ft obstacle, in feet.
export function estimate(kind, perf, { da, headwind, ratio, soft }) {
  const roll0 = kind === 'to' ? perf.toRoll : perf.ldRoll, tot0 = kind === 'to' ? perf.to50 : perf.ld50;
  const fDA = kind === 'to' ? Math.max(.85, 1 + .10 * da / 1000) : Math.max(.9, 1 + .035 * da / 1000);   // +10% (takeoff) or +3.5% (landing) per 1,000 ft density altitude
  const fW = kind === 'to' ? ratio * ratio : ratio;                                                     // takeoff varies with weight squared
  const fWind = headwind >= 0 ? Math.max(.5, 1 - .1 * headwind / 9) : 1 + .1 * -headwind / 2;           // -10% per 9 kt headwind, +10% per 2 kt tailwind
  const f = fDA * fW * fWind;
  const roll = roll0 * f * (soft ? (kind === 'to' ? 1.15 : 1.45) : 1);                                  // grass: +15% takeoff roll, +45% landing roll
  return { roll, total: roll + Math.max(0, tot0 - roll0) * f };
}

// A panel for one airport. weight() returns the current weight in lb for this phase, or null.
export async function perfPanel(apt, kind, ac, weight) {
  const out = h('div', {}), el = h('div', { style: 'margin-bottom:12px' });
  const title = `${kind === 'to' ? 'Takeoff' : 'Landing'} at ${apt.id}`;
  const p = ac.perf;
  if (!p || !(p.toRoll > 0) || !(p.ldRoll > 0)) {
    el.append(h('div', { style: 'font-weight:700' }, title), h('div', { class: 'note' }, 'This aircraft has no baseline distances. Add them in More > Aircraft.'));
    el.refresh = () => { }; return el;
  }
  const rws = await runways(apt.id);
  let m = null; if (apt.wx) try { m = await metar(apt.wxId); } catch { }
  const ends = rws.flatMap(r => [{ id: r[0], hdg: r[10], len: r[2], surf: r[4] }, { id: r[1], hdg: r[10] != null ? norm(r[10] + 180) : null, len: r[2], surf: r[4] }]).filter(e => e.id && e.len);
  if (!ends.length) { el.append(h('div', { style: 'font-weight:700' }, title), h('div', { class: 'note' }, 'No runway data for this airport.')); el.refresh = () => { }; return el; }
  const wind = e => m && m.spd != null && m.dir != null && e.hdg != null ? { hw: m.spd * Math.cos((m.dir - e.hdg) * Math.PI / 180), xw: Math.abs(m.spd * Math.sin((m.dir - e.hdg) * Math.PI / 180)) } : { hw: 0, xw: 0 };
  ends.sort((a, b) => wind(b).hw - wind(a).hw || b.len - a.len);
  const kvRow = (k, v, cls) => h('div', { class: 'kv' }, h('span', {}, k), h('span', { class: cls || '' }, v));
  const draw = () => {
    const e = ends[+sel.value], w = wind(e), altim = m?.alt ?? 29.92, pa = apt.elev + (29.92 - altim) * 1000, isa = 15 - 1.98 * pa / 1000;
    const da = pa + 120 * ((m?.temp ?? isa) - isa), W = weight(), ratio = W && ac.wb?.maxW ? Math.min(1.15, W / ac.wb.maxW) : 1, soft = SOFT.test(e.surf || '');
    const r = estimate(kind, p, { da, headwind: w.hw, ratio, soft });
    const cls = r.total > e.len ? 'bad' : r.total > e.len * .7 ? 'warn' : 'ok';
    out.replaceChildren(
      kvRow('Conditions', m ? `Density altitude ${Math.round(da / 10) * 10}' · ${Math.abs(Math.round(w.hw))} kt ${w.hw >= 0 ? 'head' : 'tail'}, ${Math.round(w.xw)} kt cross` : 'No weather report. Standard day and calm wind used.', m ? '' : 'warn'),
      kvRow('Weight', W ? `${Math.round(W).toLocaleString()} lb${soft ? ' · soft surface' : ''}` : 'Max weight assumed'),
      kvRow('Ground roll', `${Math.round(r.roll / 10) * 10} ft`), kvRow('Over a 50 ft obstacle', `${Math.round(r.total / 10) * 10} ft`),
      kvRow('Runway length', `${e.len.toLocaleString()} ft`),
      kvRow('Result', r.total > e.len ? 'Longer than the runway. Do not use.' : r.total > e.len * .7 ? `Uses ${Math.round(r.total / e.len * 100)}% of the runway. Check the POH.` : `Uses ${Math.round(r.total / e.len * 100)}% of the runway`, cls));
  };
  const sel = h('select', { onchange: draw, style: 'width:100%;margin:4px 0 6px' }, ends.map((e, i) => h('option', { value: i }, `Runway ${e.id} · ${e.len.toLocaleString()} ft`)));
  el.append(h('div', { style: 'font-weight:700' }, title), sel, out);
  el.refresh = draw; draw();
  return el;
}
