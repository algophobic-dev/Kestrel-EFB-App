// Preflight briefing for the current route: weather at each end, hazards along the way, winds, TFRs and NOTAMs, on one page.
import { $, h, toast } from './util.js';
import { current, plan } from './route.js';
import { dist, along, inGeom, fmtDur } from './geo.js';
import { metar, taf, rawWx, notams, hasRelay, sigmets, gairmets, pireps, pirepLevel, pirepText } from './wx.js';
import { tfrs, tfrType, tfrDetails } from './tfr.js';

const card = (title, ...kids) => h('div', { class: 'card' }, h('h3', {}, title), kids);
const note = t => h('div', { class: 'note' }, t);
const z = t => { const d = new Date(t); return isNaN(d) ? '' : `${String(d.getUTCDate()).padStart(2, '0')} ${d.toISOString().slice(11, 16).replace(':', '')}Z`; };
const span = (a, b) => `${z(a)} to ${z(b)}`;

// Points every 5 nm along the route, each with its distance from the departure.
function samples(pts) {
  const out = []; let d0 = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = dist(a, b), n = Math.max(1, Math.ceil(d / 5));
    for (let k = 0; k < n; k++) { const p = along(a, b, k / n); out.push({ lat: p.lat, lon: p.lon, at: d0 + d * k / n }); }
    d0 += d;
  }
  const last = pts[pts.length - 1]; out.push({ lat: last.lat, lon: last.lon, at: d0 });
  return out;
}
// Where along the route a shape is crossed: [first nm, last nm], or null.
function crossing(s, g) {
  const hit = s.filter(p => inGeom(p.lon, p.lat, g));
  return hit.length ? [hit[0].at, hit[hit.length - 1].at] : null;
}
const nmRange = r => r[1] - r[0] < 3 ? `at ${Math.round(r[0])} nm` : `${Math.round(r[0])} to ${Math.round(r[1])} nm`;
// Nearest route point to a position: { at, off } in nm.
function nearest(s, p) {
  let best = { at: 0, off: Infinity };
  for (const q of s) { const d = dist(q, p); if (d < best.off) best = { at: q.at, off: d }; }
  return best;
}

const PHEN = { TS: 'Thunderstorms', TSGR: 'Thunderstorms with hail', TURB: 'Turbulence', ICE: 'Icing', MTW: 'Mountain wave', VA: 'Volcanic ash', TC: 'Tropical cyclone', DS: 'Dust storm', SS: 'Sandstorm', RDOACT_CLD: 'Radioactive cloud', CB: 'Cumulonimbus' };
const QUAL = { FRQ: 'frequent', EMBD: 'embedded', OBSC: 'obscured', SQL: 'squall line', ISOL: 'isolated', SEV: 'severe', OCNL: 'occasional' };
function sigmetName(q) {
  const code = (q.phenomenon || '').split('/').pop() || q.hazard || '';
  const [a, b] = code.split('_'), main = PHEN[b || a] || PHEN[a] || code.replace(/_/g, ' ') || 'SIGMET';
  return b && QUAL[a] ? `${main}, ${QUAL[a]}` : main;
}
const ADV = { ICE: 'Icing', 'TURB-HI': 'Turbulence, high', 'TURB-LO': 'Turbulence, low', IFR: 'IFR', MT_OBSC: 'Mountain obscuration', SFC_WND: 'Strong surface wind', LLWS: 'Low-level wind shear', FZLVL: 'Freezing level', M_FZLVL: 'Multiple freezing levels' };
const lvl = v => v == null || v === '' ? '' : v === 'SFC' ? 'surface' : v === 'FZL' ? 'freezing level' : +v >= 180 ? 'FL' + v : `${(+v * 100).toLocaleString()}'`;

// Weather and NOTAMs for one end of the route.
function endCard(label, a) {
  const wx = h('pre', { class: 'raw' }, a.wx ? 'Loading METAR.' : 'No weather station at this airport.');
  const tf = h('pre', { class: 'raw', style: 'margin-top:8px' }, a.wx === 2 ? 'Loading TAF.' : '');
  const tag = h('span', { class: 'tag' }, '');
  const nt = h('div', {}, hasRelay() ? 'Loading NOTAMs.' : note('NOTAMs need the relay server.'));
  if (a.wx) {
    metar(a.wxId).then(m => { tag.textContent = m.cat || ''; tag.className = 'tag ' + (m.cat || ''); wx.textContent = m.raw; }).catch(() => { wx.textContent = 'METAR did not load.'; });
    if (a.wx === 2) taf(a.wxId).then(t => { tf.textContent = t.raw; }).catch(() => { tf.textContent = 'TAF did not load.'; });
    if (hasRelay()) rawWx(a.wxId).then(r => { if (r.metar) wx.textContent = r.metar; if (r.taf) tf.textContent = r.taf; }).catch(() => { });
  }
  if (hasRelay()) notams(a.wxId.length === 4 ? a.wxId : a.id).then(list => {
    nt.replaceChildren(list.length ? h('details', {}, h('summary', {}, `${list.length} NOTAM${list.length === 1 ? '' : 's'}`), ...list.map(n => h('pre', { class: 'raw', style: 'padding:6px 0;border-bottom:1px solid var(--line)' }, n.text))) : 'No NOTAMs.');
  }).catch(() => nt.replaceChildren(note('NOTAMs did not load.')));
  return card(`${label} · ${a.id}`, h('div', { class: 's', style: 'margin-bottom:6px' }, a.name, ' ', tag), wx, tf, h('div', { class: 'sect', style: 'margin-top:10px' }, 'NOTAMs'), nt);
}

// Rows for each hazard found along the route, or one line saying there are none.
const list = (rows, none) => rows.length ? rows : [note(none)];
const row = (title, sub, extra) => h('div', { class: 'row', style: 'align-items:flex-start' }, h('div', { class: 'grow' }, h('div', { class: 't' }, title), h('div', { class: 's', style: 'white-space:normal' }, sub)), extra || null);

let seq = 0;
export async function drawBrief(box) {
  const my = ++seq, r = current, pts = r.points;
  if (pts.length < 2) { box.replaceChildren(h('div', { class: 'pad' }, note('Enter a route with a departure and a destination to see the briefing.'))); return; }
  const dep = pts[0], arr = pts[pts.length - 1], s = samples(pts), t = r.total;
  const hazards = h('div', {}, note('Checking SIGMETs and advisories.')), tfrBox = h('div', {}, note('Checking TFRs.')), pirepBox = h('div', {}, note('Checking PIREPs.'));
  const winds = r.legs.map(l => h('tr', {}, h('td', {}, `${l.from.id} – ${l.to.id}`), h('td', {}, l.wind ? `${String(Math.round(l.wind.dir)).padStart(3, '0')}° ${Math.round(l.wind.spd)} kt` : '--'), h('td', {}, `${Math.round(l.gs)} kt`), h('td', {}, `${String(Math.round(l.mh)).padStart(3, '0')}°`), h('td', {}, fmtDur(l.min))));
  box.replaceChildren(h('div', { class: 'pad brief' },
    h('div', { class: 'brief-head' },
      h('div', {}, h('div', { class: 't', style: 'font-size:16px;font-weight:700' }, `Briefing · ${dep.id} to ${arr.id}`),
        h('div', { class: 's' }, `${r.ac?.name || ''} · ${plan.alt.toLocaleString()}' · ${Math.round(t.d)} nm · ${fmtDur(t.min)} · made ${z(Date.now())}`)),
      h('div', { class: 'acts' },
        h('button', { class: 'btn sm', onclick: () => printBrief(box) }, 'Print'),
        h('button', { class: 'btn sm primary', onclick: fileFlightPlan }, 'File at 1800wxbrief.com'))),
    h('div', { class: 'cards' },
      endCard('Departure', dep), dep.id !== arr.id ? endCard('Destination', arr) : null,
      card('SIGMETs and advisories along the route', hazards),
      card('TFRs within 10 nm of the route', tfrBox),
      card('PIREPs within 40 nm, last 2 hours', pirepBox),
      card(`Winds aloft at ${plan.alt.toLocaleString()}'`, r.windPending ? note('Loading winds.') :
        h('table', { class: 'grid brief-winds' }, h('tr', {}, ...['Leg', 'Wind', 'GS', 'MH', 'Time'].map(x => h('th', {}, x))), ...winds)))));

  // SIGMETs (US and international) and G-AIRMETs crossed by the route.
  Promise.all([sigmets().catch(() => null), hasRelay() ? gairmets().catch(() => null) : null]).then(([sg, ga]) => {
    if (my !== seq) return;
    const rows = [];
    for (const f of sg?.features || []) {
      if (!f.geometry) continue; const c = crossing(s, f.geometry); if (!c) continue; const q = f.properties;
      rows.push([c[0], row(`SIGMET · ${sigmetName(q)}`, [nmRange(c), q.base != null || q.top != null ? `${q.base ? 'FL' + Math.round(q.base / 100) : 'surface'} to FL${Math.round((q.top || 0) / 100)}` : '', span(q.start || q.validTimeFrom, q.end || q.validTimeTo)].filter(Boolean).join(' · '))]);
    }
    const g = (ga?.features || []).filter(f => f.geometry && /Polygon/.test(f.geometry.type));
    const first = Math.min(...g.map(f => f.properties.forecast ?? 0));
    for (const f of g) {
      const q = f.properties; if ((q.forecast ?? 0) !== first) continue; const c = crossing(s, f.geometry); if (!c) continue;
      rows.push([c[0], row(`G-AIRMET · ${ADV[q.hazard] || q.hazard}${q.severity ? ', ' + (q.severity === 'MOD' ? 'moderate' : q.severity.toLowerCase()) : ''}`,
        [nmRange(c), q.base || q.top ? `${lvl(q.base)} to ${lvl(q.top)}` : '', q.dueTo && q.dueTo !== q.hazard ? q.dueTo : '', `valid ${z(q.validTime)}`].filter(Boolean).join(' · '))]);
    }
    hazards.replaceChildren(...list(rows.sort((a, b) => a[0] - b[0]).map(x => x[1]), sg ? 'No SIGMETs or G-AIRMETs along the route.' : 'SIGMETs did not load.'));
  });
  // TFRs near the route.
  if (!hasRelay()) tfrBox.replaceChildren(note('TFRs need the relay server.'));
  else tfrs().then(j => {
    if (my !== seq) return;
    const rows = [];
    for (const f of j.features) {
      const c = crossing(s, f.geometry);
      const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates?.[0]?.[0] || [];
      let near = c ? { at: c[0], off: 0 } : { at: 0, off: Infinity };
      if (!c && ring.length && nearest(s, { lat: ring[0][1], lon: ring[0][0] }).off < 60) for (const [lon, lat] of ring) { const n = nearest(s, { lat, lon }); if (n.off < near.off) near = n; }
      if (near.off > 10) continue; const q = f.properties;
      rows.push([near.at, row(`TFR ${q.id} · ${tfrType(q.type)}`, `${q.title} · ${c ? 'route crosses it, ' + nmRange(c) : `${near.off.toFixed(0)} nm from the route at ${Math.round(near.at)} nm`}`,
        h('button', { class: 'pill', onclick: () => tfrDetails(q) }, 'Details'))]);
    }
    tfrBox.replaceChildren(...list(rows.sort((a, b) => a[0] - b[0]).map(x => x[1]), 'No TFRs within 10 nm of the route.'));
  }).catch(() => { if (my === seq) tfrBox.replaceChildren(note('TFRs did not load.')); });
  // PIREPs near the route.
  if (!hasRelay()) pirepBox.replaceChildren(note('PIREPs need the relay server.'));
  else pireps().then(j => {
    if (my !== seq) return;
    const rows = [];
    for (const f of j.features) {
      const [lon, lat] = f.geometry.coordinates, n = nearest(s, { lat, lon }); if (n.off > 40) continue; const q = f.properties, lv = pirepLevel(q);
      rows.push([n.at, h('div', { class: 'row', style: 'align-items:flex-start' }, h('span', { class: 'dot pirep-' + (lv || 'none') }),
        h('div', { class: 'grow' }, h('div', { class: 't' }, pirepText(q) || q.airepType), h('div', { class: 's', style: 'white-space:normal' }, `${Math.round(n.at)} nm along, ${Math.round(n.off)} nm off · ${Math.round((Date.now() - Date.parse(q.obsTime)) / 6e4)} min ago · ${q.rawOb}`)))]);
    }
    pirepBox.replaceChildren(...list(rows.sort((a, b) => a[0] - b[0]).map(x => x[1]), 'No PIREPs within 40 nm of the route.'));
  }).catch(() => { if (my === seq) pirepBox.replaceChildren(note('PIREPs did not load.')); });
}

// Print the briefing as it is on screen, with every NOTAM list opened.
function printBrief(box) {
  $('#print')?.remove();
  const copy = box.firstChild.cloneNode(true);
  copy.querySelectorAll('details').forEach(d => d.open = true);
  copy.querySelectorAll('button').forEach(b => b.remove());
  document.body.append(h('div', { id: 'print' }, copy));
  window.print();
}

// Filing: Kestrel cannot file directly (that needs a Flight Service vendor agreement), so it copies the details and opens 1800wxbrief.com.
export async function fileFlightPlan() {
  const pts = current.points;
  if (pts.length < 2) return toast('Enter a route with a departure and a destination first.');
  const r = current, mid = plan.text.split(' ').slice(1, -1).join(' ') || 'DCT';
  const text = [`Departure: ${pts[0].id}`, `Destination: ${pts[pts.length - 1].id}`, `Route: ${mid}`, `Altitude: ${plan.alt}`,
    `True airspeed: ${Math.round(r.ac?.tas || 0)} kt`, `Time enroute: ${fmtDur(r.total.min)}`, `Fuel endurance with full tanks: ${fmtDur((r.ac?.fuelCap || 0) / (r.ac?.burn || 1) * 60)}`, `Aircraft: ${r.ac?.name || ''}`].join('\n');
  try { await navigator.clipboard.writeText(text); toast('Flight plan details copied. Paste them into the form on 1800wxbrief.com.'); } catch { toast('Opening 1800wxbrief.com. The route is ' + plan.text + '.'); }
  window.open('https://www.1800wxbrief.com/', '_blank', 'noopener');
}
