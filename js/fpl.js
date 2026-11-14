// Flight plan panel: route chips, totals, NavLog table, terrain and airspace profile.
import { $, $$, h, on, toast } from './util.js';
import { plan, setPlan, removeToken, reverse, current, aircraft, flights } from './route.js';
import { along, dist, fmtDur, pad3, inGeom } from './geo.js';
import { elevations } from './wx.js';
import { FAA_FEAT, altText, fitRoute } from './map.js';

const f1 = n => n.toFixed(n < 100 ? 1 : 0);

export function navlogTable(r) {
  if (!r.legs.length) return h('div', { class: 'empty' }, 'Add at least two points to see the NavLog.');
  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, ['Leg', 'Course', 'Heading', 'Dist', 'Wind', 'GS', 'ETE', 'Fuel', 'Total dist', 'Total time'].map(t => h('th', {}, t)))),
    h('tbody', {},
      r.legs.map(l => h('tr', {},
        h('td', {}, `${l.from.id} → ${l.to.id}`), h('td', {}, pad3(l.mc) + '°M'), h('td', {}, pad3(l.mh) + '°M'), h('td', {}, f1(l.d) + ' nm'),
        h('td', {}, l.wind ? `${pad3(l.wind.dir)}/${Math.round(l.wind.spd)}` : '--'), h('td', {}, Math.round(l.gs) + ' kt'),
        h('td', {}, fmtDur(l.min)), h('td', {}, l.fuel.toFixed(1) + ' g'), h('td', {}, f1(l.cd) + ' nm'), h('td', {}, fmtDur(l.cmin)))),
      h('tr', { class: 'total' }, h('td', {}, 'Total'), h('td'), h('td'), h('td', {}, f1(r.total.d) + ' nm'), h('td'), h('td'),
        h('td', {}, fmtDur(r.total.min)), h('td', {}, r.total.fuel.toFixed(1) + ' g'), h('td'), h('td'))));
}

export function etaText(r) {
  if (!r.total) return '--';
  const d = new Date();
  if (plan.etd) { const [hh, mm] = plan.etd.split(':'); d.setHours(+hh, +mm, 0, 0); }
  return new Date(d.getTime() + r.total.min * 6e4).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

let mode = 'edit';
function render(r) {
  const input = h('input', { placeholder: r.chips.length ? 'Add waypoint' : 'Enter route, e.g. KLUK HYK KLEX', autocapitalize: 'characters', spellcheck: false, autocomplete: 'off',
    onkeydown: e => {
      if ((e.key === 'Enter' || e.key === ' ') && input.value.trim()) { e.preventDefault(); const keep = e.key === ' '; setPlan({ text: plan.text + ' ' + input.value }).then(x => { if (x.errors.length) toast(x.errors[0] + '.'); if (keep) $('#fpl-chips input')?.focus(); }); }
      else if (e.key === 'Backspace' && !input.value && r.chips.length) removeToken(r.chips[r.chips.length - 1].i);
    } });
  $('#fpl-chips').replaceChildren(...r.chips.map(c => h('span', { class: 'chip ' + (c.kind === 'apt' ? '' : c.kind), title: 'Remove ' + c.label, onclick: () => removeToken(c.i) }, c.label)), input);
  const t = r.total, ac = r.ac;
  const stat = (k, v, cls) => h('div', { class: 'stat' }, h('b', {}, k), h('span', { class: cls || '' }, v));
  const over = t && t.fuel > ac.fuelCap;
  $('#fpl-stats').replaceChildren(
    stat('Dist', t ? f1(t.d) + ' nm' : '--'), stat('ETE', t ? fmtDur(t.min) : '--'), stat('ETA', etaText(r)),
    stat('Fuel', t ? t.fuel.toFixed(1) + ' g' + (over ? ' · over capacity' : '') : '--', over ? 'bad' : ''),
    stat('Wind', !t ? '--' : r.windPending ? 'Loading' : r.windFailed || t.comp == null ? 'Unavailable' : Math.abs(t.comp) < .5 ? 'Calm' : `${Math.round(Math.abs(t.comp))} kt ${t.comp > 0 ? 'head' : 'tail'}`));
  if (mode === 'navlog') $('#fpl-navlog').replaceChildren(navlogTable(r));
  if (mode === 'profile' && !r.windPending) drawProfile(r);
}

function setMode(m) {
  mode = m;
  $$('#fpl-mode button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('.fpl-top').classList.toggle('hidden', m !== 'edit');
  $('#fpl-navlog').classList.toggle('hidden', m !== 'navlog');
  $('#fpl-profile').classList.toggle('hidden', m !== 'profile');
  render(current);
}

function fillAircraft() {
  $('#fpl-ac').replaceChildren(...aircraft.list().map(a => h('option', { value: a.id, selected: a.id === plan.acId }, a.name)));
}

export function initFpl() {
  const panel = $('#fpl'), btn = $('#btn-fpl');
  const show = v => { panel.classList.toggle('hidden', !v); btn.classList.toggle('on', v); };
  btn.onclick = () => show(panel.classList.contains('hidden'));
  fillAircraft(); on('aircraft', () => { fillAircraft(); setPlan({}); });
  $('#fpl-ac').onchange = e => setPlan({ acId: e.target.value });
  $('#fpl-alt').value = plan.alt; $('#fpl-alt').onchange = e => setPlan({ alt: Math.max(0, +e.target.value || 0) });
  $('#fpl-etd').value = plan.etd; $('#fpl-etd').onchange = e => setPlan({ etd: e.target.value });
  $('#fpl-reverse').onclick = reverse;
  $('#fpl-clear').onclick = () => setPlan({ text: '' });
  $('#fpl-save').onclick = () => {
    if (current.points.length < 2) return toast('Add at least two points before saving.');
    flights.save({ name: `${current.points[0].id} → ${current.points[current.points.length - 1].id}`, text: plan.text, alt: plan.alt, acId: plan.acId, etd: plan.etd, saved: Date.now() });
    toast('Flight saved. Open the Flights tab to view it.');
  };
  $$('#fpl-mode button').forEach(b => b.onclick = () => setMode(b.dataset.m));
  on('route', render);
  if (plan.text) show(true);
  new ResizeObserver(() => { if (mode === 'profile' && prof) paintProfile(); }).observe($('#profile-canvas'));
  $('#profile-canvas').onclick = e => {
    if (!prof) return;
    const rc = e.target.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top;
    const hit = prof.boxes.filter(b => x >= b.x0 && x <= b.x1 && y >= b.y1 && y <= b.y0).pop();
    prof.sel = hit || null; paintProfile();
  };
}

// ---------- profile
let prof = null, profSeq = 0;
async function drawProfile(r) {
  const my = ++profSeq, info = $('#profile-info');
  if (r.points.length < 2) { prof = null; paintProfile(); info.replaceChildren(h('div', { class: 'note' }, 'Add at least two points to see the profile.')); return; }
  info.replaceChildren(h('div', { class: 'note' }, 'Loading terrain and airspace.'));
  const total = r.total.d, n = Math.max(40, Math.min(160, Math.round(total / 1.5)));
  const samples = [];
  for (let k = 0; k <= n; k++) {
    const d = total * k / n; let i = r.legs.findIndex(l => l.cd >= d - 1e-6); if (i < 0) i = r.legs.length - 1;
    const l = r.legs[i], p = along(l.from, l.to, l.d ? Math.min(1, (d - (l.cd - l.d)) / l.d) : 0);
    samples.push({ d, lat: p.lat, lon: p.lon });
  }
  const geom = encodeURIComponent(JSON.stringify({ paths: [samples.filter((_, i) => i % 2 === 0 || i === n).map(s => [+s.lon.toFixed(4), +s.lat.toFixed(4)])], spatialReference: { wkid: 4326 } }));
  const q = (svc, where) => fetch(`${FAA_FEAT}${svc}/FeatureServer/0/query`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `where=${encodeURIComponent(where)}&geometry=${geom}&geometryType=esriGeometryPolyline&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=NAME,CLASS,TYPE_CODE,UPPER_VAL,UPPER_UOM,UPPER_CODE,LOWER_VAL,LOWER_UOM,LOWER_CODE&outSR=4326&maxAllowableOffset=0.003&f=geojson` })
    .then(x => x.json()).then(j => j.features || []).catch(() => []);
  let elev, feats;
  try { [elev, feats] = await Promise.all([elevations(samples), Promise.all([q('Class_Airspace', "CLASS IN ('B','C','D')"), q('Special_Use_Airspace', '1=1')]).then(a => a.flat())]); }
  catch { if (my === profSeq) info.replaceChildren(h('div', { class: 'note' }, 'Terrain did not load. Check your connection.')); return; }
  if (my !== profSeq) return;
  samples.forEach((s, i) => s.elev = elev[i]);
  const ft = (v, uom, code, i) => code === 'SFC' ? samples[i].elev : uom === 'FL' ? v * 100 : code === 'AGL' ? samples[i].elev + v : v;
  const spans = [];
  for (const f of feats) {
    const p = f.properties; let run = null;
    samples.forEach((s, i) => {
      const inside = inGeom(s.lon, s.lat, f.geometry);
      if (inside && !run) run = { p, i0: i, i1: i }; else if (inside) run.i1 = i;
      if ((!inside || i === n) && run) { spans.push(run); run = null; }
    });
  }
  for (const s of spans) { s.lo = Math.max(0, ft(s.p.LOWER_VAL, s.p.LOWER_UOM, s.p.LOWER_CODE, s.i0) || 0); s.hi = ft(s.p.UPPER_VAL, s.p.UPPER_UOM, s.p.UPPER_CODE, s.i0); if (!(s.hi > s.lo)) s.hi = s.lo + 500; }
  const hi = samples.reduce((b, s) => s.elev > b.elev ? s : b);
  const strike = samples.find((s, i) => i > 1 && i < n - 1 && s.elev >= plan.alt);
  prof = { samples, spans, total, alt: plan.alt, boxes: [], sel: null, dep: r.points[0].id, arr: r.points[r.points.length - 1].id };
  const clr = plan.alt - hi.elev;
  info.replaceChildren(
    h('b', {}, 'Highest point'), h('span', {}, `${Math.round(hi.elev).toLocaleString()}' MSL`),
    h('b', {}, 'Clearance'), h('span', { class: clr < 1000 ? 'bad' : clr < 2000 ? 'warn' : '' }, `${Math.round(clr).toLocaleString()}'`),
    h('b', {}, 'First strike'), h('span', { class: strike ? 'bad' : '' }, strike ? `${Math.round(strike.d)} nm` : 'None'),
    h('b', {}, 'Selected'), h('div', { id: 'prof-sel', class: 'note' }, 'Tap an airspace block.'));
  paintProfile();
}
const AS_COL = p => p.CLASS === 'B' ? '61,139,255' : p.CLASS === 'C' ? '217,70,239' : p.CLASS === 'D' ? '90,170,255' : p.TYPE_CODE === 'R' || p.TYPE_CODE === 'P' ? '239,83,80' : '160,110,220';
function paintProfile() {
  const cv = $('#profile-canvas'), W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1; cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
  if (!prof) return;
  const { samples, spans, total, alt } = prof, L = 46, T = 18, B = 20, R = 8;
  const top = Math.max(3000, Math.ceil(Math.max(alt, ...samples.map(s => s.elev)) * 1.35 / 1000) * 1000);
  const X = d => L + d / total * (W - L - R), Y = f => H - B - Math.min(f, top) / top * (H - T - B);
  c.font = '11px system-ui, sans-serif'; c.textBaseline = 'middle';
  const step = top <= 6000 ? 1000 : top <= 14000 ? 2000 : 5000;
  for (let f = 0; f <= top; f += step) { c.strokeStyle = 'rgba(255,255,255,.08)'; c.beginPath(); c.moveTo(L, Y(f)); c.lineTo(W - R, Y(f)); c.stroke(); c.fillStyle = '#93a3ae'; c.textAlign = 'right'; c.fillText(f.toLocaleString() + "'", L - 5, Y(f)); }
  const dstep = [5, 10, 20, 50, 100, 200, 500].find(s => total / s <= 9) || 1000;
  c.textAlign = 'center'; for (let d = dstep; d < total; d += dstep) c.fillText(d + ' nm', X(d), H - 9);
  prof.boxes = [];
  for (const s of spans) {
    const x0 = X(samples[s.i0].d), x1 = Math.max(x0 + 3, X(samples[s.i1].d)), y0 = Y(s.lo), y1 = Y(s.hi), col = AS_COL(s.p), sel = prof.sel && prof.sel.s === s;
    c.fillStyle = `rgba(${col},${sel ? .55 : .25})`; c.fillRect(x0, y1, x1 - x0, y0 - y1);
    c.strokeStyle = `rgba(${col},1)`; c.lineWidth = sel ? 2.5 : 1.2; c.strokeRect(x0, y1, x1 - x0, y0 - y1);
    prof.boxes.push({ x0, x1, y0, y1, s });
  }
  c.beginPath(); c.moveTo(X(0), H - B); samples.forEach(s => c.lineTo(X(s.d), Y(s.elev))); c.lineTo(X(total), H - B); c.closePath();
  c.fillStyle = '#8d8a73'; c.fill(); c.strokeStyle = '#c9c5a3'; c.lineWidth = 1; c.stroke();
  c.strokeStyle = '#e23bf0'; c.lineWidth = 2.5; c.beginPath(); c.moveTo(X(0), Y(alt)); c.lineTo(X(total), Y(alt)); c.stroke();
  c.fillStyle = '#fff'; c.textAlign = 'left'; c.font = 'bold 12px system-ui, sans-serif';
  c.fillText(alt.toLocaleString() + "'", L + 4, Y(alt) - 9); c.fillText(prof.dep, L + 4, T - 8); c.textAlign = 'right'; c.fillText(prof.arr, W - R - 2, T - 8);
  const el = $('#prof-sel');
  if (el) el.textContent = prof.sel ? `${prof.sel.s.p.NAME} · ${altText(prof.sel.s.p.LOWER_VAL, prof.sel.s.p.LOWER_UOM, prof.sel.s.p.LOWER_CODE)} – ${altText(prof.sel.s.p.UPPER_VAL, prof.sel.s.p.UPPER_UOM, prof.sel.s.p.UPPER_CODE)}${prof.sel.s.p.CLASS?.length === 1 ? ', Class ' + prof.sel.s.p.CLASS : ''}` : 'Tap an airspace block.';
}
export { fitRoute };
