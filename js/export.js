// Flight plan export: Garmin FPL, GPX route, PLN, and the route as text.
import { h, toast, modal, download } from './util.js';
import { plan, current } from './route.js';
import { fileFlightPlan } from './brief.js';

const esc = s => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const r6 = n => +n.toFixed(6);

// One entry per point, with the identifier and type other apps expect.
function waypoints() {
  let user = 0;
  return current.points.map(p => {
    const nav = p.kind === 'nav' ? (/NDB/.test(p.navType || '') ? 'NDB' : 'VOR') : null;
    const kind = p.kind === 'apt' ? 'AIRPORT' : nav || (p.kind === 'fix' ? 'INT' : 'USER');
    // Garmin identifiers are letters and digits. Positions, marked points and unusual codes become user waypoints.
    const ok = kind === 'USER' ? /^[A-Z0-9]{2,6}$/.test(p.id) : /^[A-Z0-9]{2,12}$/.test(p.id);
    if (ok) return { p, type: kind, id: p.id };
    return { p, type: 'USER', id: 'USR' + String(++user).padStart(2, '0') };
  });
}
const ends = () => [current.points[0], current.points[current.points.length - 1]];
const baseName = () => ends().map(p => p.id.replace(/[^A-Z0-9]/gi, '')).join('-');

function fpl() {
  const w = waypoints(), seen = new Set();
  const gtype = t => t === 'USER' ? 'USER WAYPOINT' : t;
  const table = w.filter(x => { const k = x.id + x.type; return !seen.has(k) && seen.add(k); }).map(x => `    <waypoint>
      <identifier>${esc(x.id)}</identifier>
      <type>${gtype(x.type)}</type>
      <country-code></country-code>
      <lat>${r6(x.p.lat)}</lat>
      <lon>${r6(x.p.lon)}</lon>
      <comment>${esc(x.type === 'USER' ? x.p.id : '')}</comment>
    </waypoint>`).join('\n');
  const route = w.map(x => `    <route-point>
      <waypoint-identifier>${esc(x.id)}</waypoint-identifier>
      <waypoint-type>${gtype(x.type)}</waypoint-type>
      <waypoint-country-code></waypoint-country-code>
    </route-point>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlanv1">
  <created>${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</created>
  <waypoint-table>
${table}
  </waypoint-table>
  <route>
    <route-name>${esc(baseName().slice(0, 25))}</route-name>
    <flight-plan-index>1</flight-plan-index>
${route}
  </route>
</flight-plan>
`;
}

function gpx() {
  const pts = current.points.map(p => `    <rtept lat="${r6(p.lat)}" lon="${r6(p.lon)}"><name>${esc(p.id)}</name>${p.name ? `<desc>${esc(p.name)}</desc>` : ''}${p.kind === 'apt' && p.elev != null ? `<ele>${(p.elev / 3.28084).toFixed(0)}</ele>` : ''}</rtept>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Kestrel EFB" xmlns="http://www.topografix.com/GPX/1/1">
  <rte>
    <name>${esc(baseName())}</name>
${pts}
  </rte>
</gpx>
`;
}

// Position as degrees, minutes, seconds with altitude in feet: N39° 54' 31.80",W105° 7' 1.20",+005673.00
function lla(lat, lon, ft) {
  const dms = (v, pos, neg) => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60; return `${v >= 0 ? pos : neg}${d}° ${m}' ${s.toFixed(2)}"`; };
  const alt = Math.round(ft || 0);
  return `${dms(lat, 'N', 'S')},${dms(lon, 'E', 'W')},${alt < 0 ? '-' : '+'}${String(Math.abs(alt)).padStart(6, '0')}.00`;
}
function pln() {
  const w = waypoints(), [dep, arr] = ends(), alt = plan.alt || 0;
  const ifr = current.points.some(p => p.via);
  const type = { AIRPORT: 'Airport', VOR: 'VOR', NDB: 'NDB', INT: 'Intersection', USER: 'User' };
  const atc = w.map(x => `    <ATCWaypoint id="${esc(x.id)}">
      <ATCWaypointType>${type[x.type]}</ATCWaypointType>
      <WorldPosition>${lla(x.p.lat, x.p.lon, x.type === 'AIRPORT' ? x.p.elev : alt)}</WorldPosition>${x.type === 'USER' ? '' : `
      <ICAO><ICAOIdent>${esc(x.id)}</ICAOIdent></ICAO>`}
    </ATCWaypoint>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<SimBase.Document Type="AceXML" version="1,0">
  <Descr>AceXML Document</Descr>
  <FlightPlan.FlightPlan>
    <Title>${esc(dep.id)} to ${esc(arr.id)}</Title>
    <FPType>${ifr ? 'IFR' : 'VFR'}</FPType>
    <RouteType>${ifr ? (alt >= 18000 ? 'HighAlt' : 'LowAlt') : 'Direct'}</RouteType>
    <CruisingAlt>${alt}</CruisingAlt>
    <DepartureID>${esc(dep.id)}</DepartureID>
    <DepartureLLA>${lla(dep.lat, dep.lon, dep.elev)}</DepartureLLA>
    <DestinationID>${esc(arr.id)}</DestinationID>
    <DestinationLLA>${lla(arr.lat, arr.lon, arr.elev)}</DestinationLLA>
    <Descr>${esc(dep.id)}, ${esc(arr.id)}</Descr>
    <DepartureName>${esc(dep.name || dep.id)}</DepartureName>
    <DestinationName>${esc(arr.name || arr.id)}</DestinationName>
    <AppVersion>
      <AppVersionMajor>11</AppVersionMajor>
      <AppVersionBuild>282174</AppVersionBuild>
    </AppVersion>
${atc}
  </FlightPlan.FlightPlan>
</SimBase.Document>
`;
}

// Phones and tablets get the share sheet, so the file can go straight to another app. Computers download it.
async function save(name, text, type) {
  const file = new File([text], name, { type });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  download(name, text, type);
  toast(`${name} downloaded.`);
}

async function copyRoute() {
  const text = plan.text;
  try { await navigator.clipboard.writeText(text); toast('Route copied.'); }
  catch { modal('Route', h('div', {}, h('p', { class: 'note' }, 'Select the route and copy it.'), h('textarea', { readonly: true, rows: 3, style: 'width:100%', onfocus: e => e.target.select() }, text))); }
}

export function openExport() {
  if (current.points.length < 2) return toast('Add at least two points before exporting.');
  const row = (label, note, run) => h('div', { class: 'row', style: 'display:flex;align-items:center;gap:12px;padding:8px 0' },
    h('div', { class: 'grow', style: 'flex:1' }, h('div', { style: 'font-weight:600' }, label), h('div', { class: 'note' }, note)),
    h('button', { class: 'btn sm', onclick: () => { close(); run(); } }, label.startsWith('Copy') ? 'Copy' : label.startsWith('File') ? 'File' : 'Export'));
  const name = baseName();
  const close = modal(`Export ${current.points[0].id} to ${current.points[current.points.length - 1].id}`, h('div', {},
    row('Garmin FPL', 'For ForeFlight, Garmin Pilot, Garmin avionics and most EFB apps.', () => save(name + '.fpl', fpl(), 'application/xml')),
    row('GPX route', 'For handheld GPS units and map apps.', () => save(name + '.gpx', gpx(), 'application/gpx+xml')),
    row('PLN', 'For apps that open .pln flight plans.', () => save(name + '.pln', pln(), 'application/xml')),
    row('Copy route', plan.text, copyRoute),
    row('File at 1800wxbrief.com', 'Copies the flight plan details and opens Leidos Flight Service to file.', fileFlightPlan)));
}

// For testing and for the Mac and Windows menus.
export const exportText = { fpl, gpx, pln };
