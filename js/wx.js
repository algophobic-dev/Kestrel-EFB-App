// Weather and terrain from free, keyless sources:
// METAR/TAF/SIGMET: api.weather.gov (NWS) for US stations, aviationweather.gov through the relay elsewhere
// winds aloft and elevation: open-meteo.com
import { pressureLevel } from './geo.js';
import { CONFIG } from './config.js';

const NWS = 'https://api.weather.gov';
const cache = new Map();
async function cached(key, ttlMin, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttlMin * 6e4) return c.v;
  const v = fn(); cache.set(key, { t: Date.now(), v });
  try { return await v; } catch (e) { cache.delete(key); throw e; }
}
const z2 = n => String(Math.round(n)).padStart(2, '0');

export function category(visSM, ceilFt) {
  if (visSM == null && ceilFt == null) return null;
  const v = visSM ?? 99, c = ceilFt ?? 99999;
  return v < 1 || c < 500 ? 'LIFR' : v < 3 || c < 1000 ? 'IFR' : v <= 5 || c <= 3000 ? 'MVFR' : 'VFR';
}
const visText = sm => sm >= 6 ? (sm >= 9.9 ? '10SM' : Math.round(sm) + 'SM') : sm >= 3 ? Math.round(sm) + 'SM'
  : sm >= 1 ? (Math.round(sm * 2) / 2 + 'SM').replace('.5SM', ' 1/2SM') : sm >= .7 ? '3/4SM' : sm >= .4 ? '1/2SM' : '1/4SM';

// The NWS covers the US and its territories. Other stations come from aviationweather.gov through the relay.
const isUS = id => /^(K[A-Z0-9]{3}|P[AFGHOP][A-Z0-9]{2}|T[IJ][A-Z0-9]{2}|NSTU)$/.test(id);
const relayUrl = () => CONFIG.proxyUrl.replace(/\/$/, '');
// Requests made within a moment of each other share one relay call (the map asks for many airports at once).
let batch = null;
function worldMetar(id) {
  if (!batch) { const b = batch = { ids: new Map() }; setTimeout(() => { batch = null; flush(b); }, 120); }
  return new Promise((ok, fail) => { const list = batch.ids.get(id) || []; list.push({ ok, fail }); batch.ids.set(id, list); });
}
async function flush(b) {
  const ids = [...b.ids.keys()], got = new Map();
  try {
    for (let i = 0; i < ids.length; i += 40) {
      const r = await fetch(`${relayUrl()}/metar?ids=${ids.slice(i, i + 40).join(',')}`); if (!r.ok) throw new Error('relay ' + r.status);
      for (const m of await r.json()) got.set(m.icaoId, m);
    }
  } catch { /* leave the rest unanswered below */ }
  for (const [id, waiters] of b.ids) {
    const m = got.get(id);
    waiters.forEach(w => m ? w.ok(m) : w.fail(new Error('No observation for ' + id)));
  }
}
function fromAwc(id, m) {
  const vis = m.visib == null ? null : typeof m.visib === 'string' ? parseFloat(m.visib) + (m.visib.includes('+') ? 4 : 0) : +m.visib;
  const layers = (m.clouds || []).map(l => ({ amt: l.cover, ft: l.base ?? null }));
  const ceil = layers.find(l => ['BKN', 'OVC', 'OVX', 'VV'].includes(l.amt))?.ft ?? null;
  return { id, raw: (m.rawOb || '').replace(/^(METAR|SPECI) /, ''), time: new Date(m.obsTime * 1000), vis, ceil, layers,
    dir: typeof m.wdir === 'number' ? m.wdir : null, spd: m.wspd ?? null, gust: m.wgst ?? null, temp: m.temp ?? null, dew: m.dewp ?? null,
    alt: m.altim != null ? m.altim / 33.8639 : null, cat: m.fltCat || category(vis, ceil), decoded: false };
}

export const metar = id => cached('m' + id, 8, async () => {
  if (!isUS(id) && CONFIG.proxyUrl) return fromAwc(id, await worldMetar(id));
  const r = await fetch(`${NWS}/stations/${id}/observations/latest`); if (!r.ok) throw new Error('No observation for ' + id);
  const p = (await r.json()).properties, val = x => x && x.value != null ? x.value : null;
  const t = new Date(p.timestamp);
  const vis = val(p.visibility) != null ? val(p.visibility) / 1609.344 : null;
  const layers = (p.cloudLayers || []).map(l => ({ amt: l.amount, ft: val(l.base) != null ? Math.round(val(l.base) * 3.28084 / 100) * 100 : null }));
  const ceil = layers.find(l => ['BKN', 'OVC', 'VV'].includes(l.amt))?.ft ?? null;
  const dir = val(p.windDirection), spd = val(p.windSpeed) != null ? val(p.windSpeed) / 1.852 : null, gust = val(p.windGust) != null ? val(p.windGust) / 1.852 : null;
  const temp = val(p.temperature), dew = val(p.dewpoint), alt = val(p.barometricPressure) != null ? val(p.barometricPressure) / 3386.389 : null;
  const tm = v => v == null ? '//' : (v < 0 ? 'M' : '') + z2(Math.abs(v));
  const raw = p.rawMessage || [id, z2(t.getUTCDate()) + z2(t.getUTCHours()) + z2(t.getUTCMinutes()) + 'Z',
    spd == null ? null : (spd < .5 ? '00000KT' : (dir == null ? 'VRB' : String(Math.round(dir)).padStart(3, '0')) + z2(spd) + (gust ? 'G' + z2(gust) : '') + 'KT'),
    vis == null ? null : visText(vis),
    ...(layers.length ? layers.map(l => l.ft == null ? l.amt : l.amt + String(l.ft / 100).padStart(3, '0')) : []),
    temp == null ? null : tm(temp) + '/' + tm(dew), alt == null ? null : 'A' + Math.round(alt * 100)].filter(Boolean).join(' ');
  return { id, raw, time: t, vis, ceil, layers, dir, spd, gust, temp, dew, alt, cat: category(vis, ceil), decoded: !p.rawMessage };
});

// The NWS serves TAFs as IWXXM XML. Rebuild the familiar text groups from it.
export const taf = id => cached('t' + id, 20, async () => {
  if (!isUS(id) && CONFIG.proxyUrl) {
    const r = await fetch(`${relayUrl()}/taf?ids=${id}`), t = r.ok ? (await r.json())[0] : null;
    if (!t?.rawTAF) throw new Error('No TAF for ' + id);
    return { raw: t.rawTAF.replace(/ (FM\d{6}|BECMG|TEMPO|PROB\d{2}(?! TEMPO)|PROB\d{2} TEMPO)/g, '\n  $1'), issued: new Date(t.issueTime) };
  }
  const r = await fetch(`${NWS}/stations/${id}/tafs`); if (!r.ok) throw new Error('No TAF for ' + id);
  const first = (await r.json())['@graph']?.[0]; if (!first) throw new Error('No TAF for ' + id);
  const xml = new DOMParser().parseFromString(await (await fetch(first.id)).text(), 'text/xml');
  const all = (n, name) => [...n.getElementsByTagNameNS('*', name)];
  const one = (n, name) => all(n, name)[0];
  const ddhh = s => { const d = new Date(s); return z2(d.getUTCDate()) + z2(d.getUTCHours()); };
  const tail = el => (el?.getAttribute('xlink:href') || el?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '').split('/').pop();
  const group = f => {
    const out = [], w = one(f, 'AerodromeSurfaceWindForecast');
    if (w) {
      const d = one(w, 'meanWindDirection')?.textContent, s = one(w, 'meanWindSpeed')?.textContent, g = one(w, 'windGustSpeed')?.textContent;
      if (s != null) out.push((w.getAttribute('variableWindDirection') === 'true' || d == null ? 'VRB' : String(Math.round(+d)).padStart(3, '0')) + z2(+s) + (g ? 'G' + z2(+g) : '') + 'KT');
    }
    if (f.getAttribute('cloudAndVisibilityOK') === 'true') out.push('CAVOK');
    const v = one(f, 'prevailingVisibility');
    if (v) { const m = +v.textContent, sm = v.getAttribute('uom') === 'm' ? m / 1609.344 : m; out.push(sm >= 6 ? 'P6SM' : visText(sm)); }
    all(f, 'weather').forEach(x => { const c = tail(x); if (c) out.push(c); });
    const layers = all(f, 'CloudLayer').map(l => {
      const b = one(l, 'base'), ft = b && b.textContent ? (b.getAttribute('uom') === 'm' ? +b.textContent * 3.28084 : +b.textContent) : null;
      return tail(one(l, 'amount')) + (ft == null ? '' : String(Math.round(ft / 100)).padStart(3, '0')) + (tail(one(l, 'cloudType')) === 'CB' ? 'CB' : '');
    });
    const vv = one(f, 'verticalVisibility');
    if (vv && vv.textContent) layers.push('VV' + String(Math.round(+vv.textContent / 100)).padStart(3, '0'));
    out.push(...(layers.length ? layers : v ? ['SKC'] : []));
    return out.join(' ');
  };
  const issue = new Date(one(one(xml, 'issueTime'), 'timePosition').textContent);
  const vp = one(xml, 'validPeriod') || one(xml, 'validTime');
  const lines = [`TAF ${id} ${z2(issue.getUTCDate())}${z2(issue.getUTCHours())}${z2(issue.getUTCMinutes())}Z ${ddhh(one(vp, 'beginPosition').textContent)}/${ddhh(one(vp, 'endPosition').textContent)} ${group(one(one(xml, 'baseForecast'), 'MeteorologicalAerodromeForecast'))}`];
  for (const c of all(xml, 'changeForecast')) {
    const f = one(c, 'MeteorologicalAerodromeForecast'), ind = f.getAttribute('changeIndicator') || '';
    const b = one(f, 'beginPosition')?.textContent, e = one(f, 'endPosition')?.textContent;
    const bd = new Date(b), per = b && e ? `${ddhh(b)}/${ddhh(e)}` : '';
    const head = ind === 'FROM' ? `FM${z2(bd.getUTCDate())}${z2(bd.getUTCHours())}${z2(bd.getUTCMinutes())}`
      : ind === 'BECOMING' ? 'BECMG ' + per : ind.startsWith('TEMPORARY') ? 'TEMPO ' + per
        : ind.startsWith('PROBABILITY_30') ? 'PROB30 ' + per : ind.startsWith('PROBABILITY_40') ? 'PROB40 ' + per : ind + ' ' + per;
    lines.push('  ' + head + ' ' + group(f));
  }
  return { raw: lines.join('\n'), issued: issue };
});

// US SIGMETs from the NWS, plus the rest of the world through the relay when there is one.
export const sigmets = () => cached('sig', 10, async () => {
  const [us, world] = await Promise.all([
    fetch(`${NWS}/aviation/sigmets`).then(r => r.json()).catch(() => null),
    CONFIG.proxyUrl ? fetch(`${relayUrl()}/isigmet`).then(r => r.ok ? r.json() : null).catch(() => null) : null]);
  if (!us && !world) throw new Error('SIGMETs did not load');
  return { type: 'FeatureCollection', features: [...(us?.features || []), ...(world?.features || [])] };
});

// Winds aloft for a list of points at one altitude. Returns [{dir, spd}] (true degrees, knots).
export async function winds(points, altFt) {
  if (!points.length) return [];
  const lvl = pressureLevel(altFt), key = 'w' + lvl + points.map(p => p.lat.toFixed(1) + p.lon.toFixed(1)).join();
  return cached(key, 30, async () => {
    const out = [];
    for (let i = 0; i < points.length; i += 40) {
      const pts = points.slice(i, i + 40);
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${pts.map(p => p.lat.toFixed(2))}&longitude=${pts.map(p => p.lon.toFixed(2))}` +
        `&hourly=wind_speed_${lvl}hPa,wind_direction_${lvl}hPa&wind_speed_unit=kn&forecast_hours=1`;
      const j = await (await fetch(u)).json();
      for (const r of Array.isArray(j) ? j : [j]) out.push({ spd: r.hourly[`wind_speed_${lvl}hPa`][0] || 0, dir: r.hourly[`wind_direction_${lvl}hPa`][0] || 0 });
    }
    return out;
  });
}

// Terrain elevation in feet for a list of points.
export async function elevations(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const pts = points.slice(i, i + 100);
    const j = await (await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${pts.map(p => p.lat.toFixed(4))}&longitude=${pts.map(p => p.lon.toFixed(4))}`)).json();
    out.push(...j.elevation.map(m => Math.max(0, m) * 3.28084));
  }
  return out;
}

// D-ATIS text for the airports that publish it (atis.info). Returns [] when there is none.
export const datis = id => cached('d' + id, 5, async () => { const j = await (await fetch(`https://atis.info/api/${id}`)).json(); return Array.isArray(j) ? j : []; });

// ---- Relay server (optional, see server/): raw METAR/TAF text and NOTAMs.
const relay = () => CONFIG.proxyUrl.replace(/\/$/, '');
export const hasRelay = () => !!CONFIG.proxyUrl;
export const rawWx = id => cached('r' + id, 5, async () => {
  const r = await fetch(`${relay()}/wx?ids=${id}`); if (!r.ok) throw new Error('Relay did not answer');
  const t = await r.text(), i = t.indexOf('TAF ');
  return { metar: (i < 0 ? t : t.slice(0, i)).replace(/^(METAR|SPECI) /, '').trim(), taf: i < 0 ? '' : t.slice(i).trim().replace(/(PROB\d{2})\s*\n\s*TEMPO/g, '$1 TEMPO').replace(/ +\n/g, '\n') };
});
export const notams = id => cached('n' + id, 10, async () => {
  const r = await fetch(`${relay()}/notams?icao=${id}`), j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'NOTAMs did not load');
  return j.items || [];
});
export const traffic = async (lat, lon, dist) => (await (await fetch(`${relay()}/traffic?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&dist=${Math.round(dist)}`)).json()).ac || [];

// G-AIRMETs (icing, turbulence, IFR) through the relay.
export const gairmets = () => cached('gairmet', 10, async () => {
  const r = await fetch(`${relay()}/gairmet`);
  if (!r.ok) throw new Error(r.status === 404 ? 'The relay is out of date. Run npx wrangler deploy in the server folder' : 'Advisories did not load');
  return r.json();
});

// PIREPs and AIREPs from the last 2 hours, through the relay.
export const pireps = () => cached('pirep', 5, async () => {
  const r = await fetch(`${relay()}/pirep`);
  if (!r.ok) throw new Error(r.status === 404 ? 'The relay is out of date. Run npx wrangler deploy in the server folder' : 'PIREPs did not load');
  return r.json();
});
// Worst turbulence or icing in a report: sev, mod, lgt, neg, or '' when it reports neither.
const LEVEL = { NEG: 'neg', TRC: 'lgt', LGT: 'lgt', 'TRC-LGT': 'lgt', 'LGT-MOD': 'mod', MOD: 'mod', 'MOD-SEV': 'sev', SEV: 'sev', 'SEV-EXTM': 'sev', EXTM: 'sev' };
const RANK = ['', 'neg', 'lgt', 'mod', 'sev'];
export function pirepLevel(q) {
  let best = q.airepType === 'Urgent PIREP' ? 'sev' : '';
  for (const v of [q.tbInt1, q.tbInt2, q.icgInt1, q.icgInt2]) { const l = LEVEL[v] || ''; if (RANK.indexOf(l) > RANK.indexOf(best)) best = l; }
  return best;
}
// One plain line: altitude, aircraft, then what was reported.
export function pirepText(q) {
  const alt = q.fltlvl == null ? '' : q.fltlvl === 0 ? 'Surface' : q.fltlvl >= 180 ? 'FL' + q.fltlvl : `${(q.fltlvl * 100).toLocaleString()}'`;
  const wx = [q.tbInt1 && `turbulence ${q.tbInt1.toLowerCase()}${q.tbType1 ? ' ' + q.tbType1.toLowerCase() : ''}`, q.icgInt1 && `icing ${q.icgInt1.toLowerCase()}${q.icgType1 ? ' ' + q.icgType1.toLowerCase() : ''}`,
    q.temp != null && `${q.temp}°C`, q.wspd != null && q.wdir != null && `wind ${String(q.wdir).padStart(3, '0')}° ${q.wspd} kt`].filter(Boolean);
  return [q.airepType === 'Urgent PIREP' ? 'URGENT' : '', alt, q.acType, wx.join(', ')].filter(Boolean).join(' · ');
}
