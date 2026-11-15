// More tab: Aircraft, Downloads (offline charts), Track logs, About.
import { h, kv, files, on, emit, toast, split, backBtn, uid, confirmDel, modal, download } from './util.js';
import { aircraft } from './route.js';
import { part, marks } from './db.js';
import { BASES, CHARTS, mapView, showTrack, flyTo } from './map.js';
import { fmtDur, fmtLL } from './geo.js';
import { syncCode, syncState, newCode, validCode, link, unlink, sync, deleteServerCopy } from './sync.js';

const card = (title, ...kids) => h('div', { class: 'card' }, h('h3', {}, title), kids);
const field = (label, input, cls) => h('label', { class: 'field ' + (cls || '') }, h('span', {}, label), input);
const TILES = 'kestrel-tiles';

function tileUrls(layer, b, z0, z1) {
  const urls = [], lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z), lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
  for (let z = z0; z <= z1; z++) {
    const x0 = lon2x(b.getWest(), z), x1 = lon2x(b.getEast(), z), y0 = lat2y(b.getNorth(), z), y1 = lat2y(b.getSouth(), z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) urls.push(layer.url.replace('{z}', z).replace('{x}', x).replace('{y}', y));
  }
  return urls;
}

export const More = {
  init(view) {
    this.detail = h('div', { class: 'pane-detail' });
    const items = [['Aircraft', () => this.aircraft()], ['Sync', () => this.sync()], ['Downloads', () => this.downloads()], ['Marked positions', () => this.marks()], ['Map content', () => this.content()], ['Track logs', () => this.tracks()], ['About', () => this.about()]];
    this.list = h('div', { class: 'list' }, items.map(([n, fn]) => h('button', { class: 'row', onclick: e => { this.list.querySelectorAll('.sel').forEach(x => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); this.sp.showDetail(); fn(); } }, h('div', { class: 'grow' }, h('div', { class: 't', style: 'font-weight:600' }, n)))));
    this.sp = split(view, h('div', { class: 'pane-list' }, h('div', { class: 'pane-head' }, h('h2', {}, 'More')), this.list), this.detail);
    on('tracks', () => this.section === 'tracks' && this.tracks());
    on('sync', () => this.section === 'sync' && this.sync());
    on('synced', () => this.section === 'aircraft' && this.aircraft());
    on('marks', () => this.section === 'marks' && this.marks());
    this.about();
  },
  head(title, ...acts) { return h('div', { class: 'hero' }, backBtn(() => this.sp.showList()), h('h1', {}, title), h('div', { class: 'acts' }, acts)); },

  // ----- Aircraft
  aircraft() {
    this.section = 'aircraft';
    const l = aircraft.list();
    this.detail.replaceChildren(h('div', { class: 'pad' }, this.head('Aircraft', h('button', { class: 'btn sm primary', onclick: () => this.editAc({ name: '', tail: '', tas: 110, burn: 8, fuelCap: 40, wb: { emptyW: 1500, emptyArm: 39, maxW: 2300, cgFwd: 35, cgAft: 47, fuelArm: 48, stations: [{ name: 'Front seats', arm: 37 }, { name: 'Rear seats', arm: 73 }, { name: 'Baggage', arm: 95 }] } }) }, 'New aircraft')),
      h('div', { class: 'cards' }, l.map(a => card(a.tail || 'Aircraft', h('div', { style: 'font-weight:700;font-size:16px;margin-bottom:4px' }, a.name),
        h('div', { class: 'note' }, `${a.tas} kt · ${a.burn} gph · ${a.fuelCap} gal usable`),
        h('div', { class: 'bar', style: 'margin-top:8px' }, h('button', { class: 'btn sm', onclick: () => this.editAc(a) }, 'Edit'),
          l.length > 1 && h('button', { class: 'btn sm danger', onclick: () => confirmDel(a.name, () => { aircraft.remove(a.id); this.aircraft(); }) }, 'Delete'))))),
      h('p', { class: 'note' }, 'Enter speeds, fuel burn and weight and balance data from your aircraft’s POH. The sample values are placeholders.')));
  },
  editAc(a) {
    const d = JSON.parse(JSON.stringify(a)), w = d.wb ||= { stations: [] };
    d.taxi ??= 1.5; d.reserve ??= 45; const pf = d.perf ||= {};
    const num = (o, k) => h('input', { type: 'number', step: 'any', min: 0, value: o[k] ?? '', oninput: e => o[k] = +e.target.value });
    const txt = (o, k, ph) => h('input', { type: 'text', value: o[k] ?? '', placeholder: ph, oninput: e => o[k] = e.target.value });
    const stations = h('textarea', { rows: 4, value: w.stations.map(s => `${s.name}, ${s.arm}`).join('\n') });
    modal(a.id ? 'Edit aircraft' : 'New aircraft', h('div', { class: 'form' },
      field('Type', txt(d, 'name', 'C172S')), field('Tail number', txt(d, 'tail', 'N12345')), field('Cruise TAS (kt)', num(d, 'tas')), field('Fuel burn (gph)', num(d, 'burn')), field('Usable fuel (gal)', num(d, 'fuelCap')), field('Taxi fuel (gal)', num(d, 'taxi')), field('Reserve (min)', num(d, 'reserve')),
      field('Climb speed (kt)', num(d, 'climbKt')), field('Climb rate (fpm)', num(d, 'climbFpm')), field('Climb burn (gph)', num(d, 'climbGph')),
      field('Descent speed (kt)', num(d, 'descKt')), field('Descent rate (fpm)', num(d, 'descFpm')), field('Descent burn (gph)', num(d, 'descGph')),
      field('Takeoff ground roll (ft)', num(pf, 'toRoll')), field('Takeoff over 50 ft (ft)', num(pf, 'to50')), field('Landing ground roll (ft)', num(pf, 'ldRoll')), field('Landing over 50 ft (ft)', num(pf, 'ld50')),
      h('div', { class: 'note wide' }, 'Distances: from your POH at sea level, standard day, max weight, paved runway, no wind.'),
      field('Empty weight (lb)', num(w, 'emptyW')), field('Empty arm (in)', num(w, 'emptyArm')), field('Max weight (lb)', num(w, 'maxW')), field('Forward CG limit (in)', num(w, 'cgFwd')), field('Aft CG limit (in)', num(w, 'cgAft')), field('Fuel arm (in)', num(w, 'fuelArm')),
      field('Loading stations. One per line: name, arm in inches.', stations, 'wide')), [{ label: 'Save', run: () => {
        if (!d.name.trim() || !(d.tas > 0) || !(d.burn > 0)) { toast('Enter a type, cruise speed and fuel burn.'); return false; }
        w.stations = stations.value.split('\n').map(s => s.split(',')).filter(p => p[0]?.trim() && isFinite(+p[1])).map(p => ({ name: p[0].trim(), arm: +p[1] }));
        if (d.id === 'sample') d.id = uid();
        aircraft.save(d); this.aircraft();
      } }]);
  },

  // ----- Downloads
  async downloads() {
    this.section = 'downloads';
    const layers = Object.fromEntries(Object.entries({ ...CHARTS, ...BASES }).filter(([, c]) => c.url && !c.online));
    const v = mapView(), sel = h('select', {}, Object.entries(layers).map(([k, l]) => h('option', { value: k, selected: k === (v.chart !== 'none' ? v.chart : layers[v.base] ? v.base : 'topo') }, l.name)));
    const zsel = h('select', {}), est = h('div', { class: 'note' }), prog = h('progress', { max: 1, value: 0, class: 'hidden' }), go = h('button', { class: 'btn primary' }, 'Download');
    // Always start at the layer's lowest zoom so the area stays visible when zoomed out offline.
    const range = () => { const l = layers[sel.value]; return [l.min, l.max]; };
    const fillZ = () => { const l = layers[sel.value], a = Math.max(l.min, Math.min(l.max, Math.floor(v.zoom))), b = l.max; zsel.replaceChildren(...Array.from({ length: Math.min(b, a + 4) - a + 1 }, (_, i) => h('option', { value: a + i, selected: a + i === Math.min(b, a + 1) }, `Up to zoom ${a + i}${a + i === b ? ' (full detail)' : ''}`))); calc(); };
    let urls = [];
    const calc = () => { urls = tileUrls(layers[sel.value], v.bounds, range()[0], +zsel.value); est.textContent = urls.length > 6000 ? `${urls.length.toLocaleString()} tiles is too many. Zoom the map in or choose a lower zoom.` : `${urls.length.toLocaleString()} tiles, about ${(urls.length * .04).toFixed(urls.length < 250 ? 1 : 0)} MB.`; go.disabled = urls.length > 6000 || !urls.length; };
    sel.onchange = fillZ; zsel.onchange = calc; fillZ();
    go.onclick = async () => {
      go.disabled = true; prog.classList.remove('hidden'); prog.max = urls.length;
      const c = await caches.open(TILES); let ok = 0, done = 0; const q = [...urls];
      await Promise.all(Array.from({ length: 6 }, async () => { while (q.length) { const u = q.shift(); try { if (!(await c.match(u))) { const r = await fetch(u, { mode: 'cors' }); if (r.ok) { await c.put(u, r); ok++; } } else ok++; } catch { } prog.value = ++done; } }));
      const b = v.bounds;
      kv.set('packs', [{ id: uid(), layer: sel.value, name: layers[sel.value].name, z0: range()[0], z1: +zsel.value, box: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], n: ok, made: Date.now() }, ...kv.get('packs', [])]);
      toast(ok === urls.length ? 'Download complete. These charts now work offline.' : `${ok} of ${urls.length} tiles saved. Some areas have no chart coverage.`);
      this.downloads();
    };
    const packs = kv.get('packs', []), pl = await part('plates'), meta = await part('meta');
    const usage = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
    const persist = async () => { const ok = await navigator.storage?.persist?.(); toast(ok ? 'Storage is protected from automatic cleanup.' : 'The browser declined. Install the app to protect storage.'); };
    this.detail.replaceChildren(h('div', { class: 'pad' }, this.head('Downloads'),
      h('div', { class: 'cards' },
        card('Download charts for the current map view', h('div', { class: 'form', style: 'margin-bottom:8px' }, field('Layer', sel), field('Detail', zsel)), est, prog,
          h('div', { class: 'bar', style: 'margin-top:8px' }, go), h('p', { class: 'note' }, 'Position the Maps tab over the area you want first. Tiles are stored on this device only. The Dark and Light base maps work online only.')),
        card('Saved chart areas', packs.length ? packs.map(p => h('div', { class: 'kv' }, h('span', { style: 'color:inherit' }, `${p.name} · ${p.n.toLocaleString()} tiles · ${new Date(p.made).toLocaleDateString()}`),
          h('button', { class: 'btn sm danger', onclick: () => confirmDel('this chart area', async () => { const c = await caches.open(TILES), L = { getSouth: () => p.box[0], getWest: () => p.box[1], getNorth: () => p.box[2], getEast: () => p.box[3] }; for (const u of tileUrls(layers[p.layer], L, p.z0, p.z1)) await c.delete(u); kv.set('packs', kv.get('packs', []).filter(x => x.id !== p.id)); this.downloads(); }) }, 'Delete')))
          : h('div', { class: 'note' }, 'No chart areas saved yet.')),
        card('On this device', h('div', { class: 'kv' }, h('span', {}, 'Navigation data built'), h('span', {}, meta.built ? new Date(meta.built).toLocaleDateString() : 'Unknown')),
          h('div', { class: 'kv' }, h('span', {}, 'Plates cycle'), h('span', {}, pl.cycle ? `${pl.cycle}, valid to ${pl.to.split(/\s+/).pop()}` : 'Unknown')),
          usage && h('div', { class: 'kv' }, h('span', {}, 'Storage used'), h('span', {}, `${(usage.usage / 1048576).toFixed(0)} MB`)),
          h('div', { class: 'bar', style: 'margin-top:8px' }, h('button', { class: 'btn sm', onclick: persist }, 'Protect storage')),
          h('p', { class: 'note' }, 'Plates are saved per airport from the Plates tab. Weather, radar and airspace need a connection.')))));
  },

  // ----- Track logs
  tracks() {
    this.section = 'tracks';
    const l = kv.get('tracks', []);
    const gpx = t => `<?xml version="1.0"?>\n<gpx version="1.1" creator="Kestrel EFB" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${new Date(t.start).toISOString()}</name><trkseg>\n${t.pts.map(p => `<trkpt lat="${p[0]}" lon="${p[1]}"><ele>${(p[2] / 3.28084).toFixed(0)}</ele><time>${new Date(p[4]).toISOString()}</time></trkpt>`).join('\n')}\n</trkseg></trk></gpx>`;
    this.detail.replaceChildren(h('div', { class: 'pad' }, this.head('Track logs'),
      l.length ? h('div', { class: 'cards' }, l.map(t => card(new Date(t.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
        h('div', { style: 'font-weight:700;font-size:16px' }, `${t.nm} nm · ${fmtDur((t.end - t.start) / 6e4)}`),
        h('div', { class: 'bar', style: 'margin-top:8px' },
          h('button', { class: 'btn sm', onclick: () => { emit('tab', 'maps'); setTimeout(() => showTrack(t), 50); } }, 'Show on map'),
          h('button', { class: 'btn sm', onclick: () => download(`track-${new Date(t.start).toISOString().slice(0, 10)}.gpx`, gpx(t), 'application/gpx+xml') }, 'Export GPX'),
          h('button', { class: 'btn sm danger', onclick: () => confirmDel('this track log', () => { kv.set('tracks', kv.get('tracks', []).filter(x => x.id !== t.id)); this.tracks(); }) }, 'Delete')))))
        : h('div', { class: 'empty' }, 'No track logs. On the Maps tab, select REC to record your flight.')));
  },

  // ----- Sync
  sync() {
    this.section = 'sync';
    const code = syncCode(), st = syncState();
    const what = 'Aircraft, flights, logbook, checklists, marked positions and fuel notes sync. Documents, downloaded charts, saved plates, ScratchPads and track logs stay on each device.';
    if (!code) {
      const inp = h('input', { type: 'text', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX', autocapitalize: 'characters', spellcheck: 'false', style: 'width:100%;text-transform:uppercase;font-family:var(--mono)' });
      const go = async (c, isNew, btn) => { btn.disabled = true; const s = await link(c, isNew); if (s.error) { unlink(); toast(s.error + '.'); btn.disabled = false; } else toast(isNew ? 'Sync is on. Enter this code on your other devices.' : 'This device is linked.'); };
      this.detail.replaceChildren(h('div', { class: 'pad' }, this.head('Sync'),
        h('div', { class: 'cards' },
          card('Start syncing', h('p', { class: 'note', style: 'margin-top:0' }, 'Create a private code, then enter it on your other devices. No email or password.'),
            h('button', { class: 'btn primary', onclick: e => go(newCode(), true, e.currentTarget) }, 'Create a sync code')),
          card('Link to another device', field('Code from your other device', inp),
            h('div', { class: 'bar', style: 'margin-top:8px' }, h('button', { class: 'btn', onclick: e => { const c = inp.value.trim().toUpperCase(); validCode(c) ? go(c, false, e.currentTarget) : toast('Enter the code as six groups of four, like ABCD-EFGH-JKLM-NPQR-STUV-WXYZ.'); } }, 'Link this device')),
            h('p', { class: 'note' }, 'Linking replaces this device’s synced items with the copy from your other devices.'))),
        h('p', { class: 'note' }, what)));
      return;
    }
    const shown = h('div', { class: 'mono', style: 'font-size:15px;font-weight:700;letter-spacing:.04em;word-break:break-all' }, '••••-••••-••••-••••-••••-••••');
    this.detail.replaceChildren(h('div', { class: 'pad' }, this.head('Sync', h('button', { class: 'btn sm primary', onclick: async e => { e.currentTarget.disabled = true; await sync(); } }, 'Sync now')),
      h('div', { class: 'cards' },
        card('Status', h('div', { class: 'kv' }, h('span', {}, 'Last synced'), h('span', {}, st.at ? new Date(st.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Not yet')),
          st.error ? h('div', { class: 'kv' }, h('span', {}, 'Problem'), h('span', { class: 'bad' }, st.error)) : h('div', { class: 'kv' }, h('span', {}, 'State'), h('span', { class: 'ok' }, 'Up to date'))),
        card('Your sync code', shown,
          h('div', { class: 'bar', style: 'margin-top:8px' },
            h('button', { class: 'btn sm', onclick: e => { const on = shown.textContent !== code; shown.textContent = on ? code : '••••-••••-••••-••••-••••-••••'; e.currentTarget.textContent = on ? 'Hide code' : 'Show code'; } }, 'Show code'),
            h('button', { class: 'btn sm', onclick: () => navigator.clipboard?.writeText(code).then(() => toast('Code copied.')).catch(() => toast('Copy did not work. Select Show code and type it.')) }, 'Copy code')),
          h('p', { class: 'note' }, 'Anyone with this code can read and change your synced data. Keep it private. It cannot be recovered if you lose it on every device.')),
        card('Stop syncing',
          h('div', { class: 'bar' },
            h('button', { class: 'btn sm', onclick: () => { unlink(); toast('This device is unlinked. Its data stays here.'); } }, 'Unlink this device'),
            h('button', { class: 'btn sm danger', onclick: () => modal('Delete the synced copy?', h('div', {}, 'This deletes the copy on the relay and unlinks this device. Data on your devices stays. You cannot undo this.'), [{ label: 'Delete', danger: true, run: async () => { try { await deleteServerCopy(); unlink(); toast('Synced copy deleted.'); } catch (e) { toast(e.message + '.'); return false; } } }]) }, 'Delete synced copy')))),
      h('p', { class: 'note' }, what + ' When two devices change the same item, the most recent change wins.')));
  },

  // ----- Marked positions
  marks() {
    this.section = 'marks';
    const l = marks.list();
    this.detail.replaceChildren(h('div', { class: 'pad' }, this.head('Marked positions'),
      l.length ? h('div', { class: 'cards' }, l.map(m => h('div', { class: 'card' }, h('h3', {}, fmtLL(m.lat, m.lon)), h('div', { style: 'font-weight:700;font-size:16px' }, m.name),
        h('div', { class: 'bar', style: 'margin-top:8px' },
          h('button', { class: 'btn sm', onclick: () => { emit('tab', 'maps'); setTimeout(() => flyTo(m, 11), 50); } }, 'Show on map'),
          h('button', { class: 'btn sm danger', onclick: () => confirmDel(m.name, () => marks.remove(m.id)) }, 'Delete')))))
        : h('div', { class: 'empty' }, 'No marked positions. On the Maps tab, tap the map and select Mark.'),
      h('p', { class: 'note' }, 'Type a marked position’s name in a route to fly to it.')));
  },

  // ----- Map content (GeoJSON or KML shown on the map)
  content() {
    this.section = 'content';
    const l = kv.get('content', []);
    const pick = h('input', { type: 'file', accept: '.geojson,.json,.kml', multiple: true, class: 'hidden', onchange: async e => {
      const list = kv.get('content', []); let n = 0;
      for (const f of e.target.files) {
        try {
          const text = await f.text(), gj = /\.kml$/i.test(f.name) ? kmlToGeoJSON(text) : JSON.parse(text);
          const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [];
          if (!feats.length) throw new Error('empty');
          const id = uid(); await files.put('content:' + id, { type: 'FeatureCollection', features: feats });
          list.unshift({ id, name: f.name.replace(/\.[^.]+$/, ''), n: feats.length, added: Date.now() }); n++;
        } catch { toast(`${f.name} has no shapes this app can read. Use GeoJSON or KML.`); }
      }
      kv.set('content', list); e.target.value = ''; emit('content'); this.content(); if (n) toast('Content added to the map.');
    } });
    const toggle = c => { kv.set('content', kv.get('content', []).map(x => x.id === c.id ? { ...x, hidden: !x.hidden } : x)); emit('content'); this.content(); };
    this.detail.replaceChildren(h('div', { class: 'pad' }, this.head('Map content', h('button', { class: 'btn sm primary', onclick: () => pick.click() }, 'Import'), pick),
      l.length ? h('div', { class: 'cards' }, l.map(c => h('div', { class: 'card' }, h('h3', {}, `${c.n} shapes · ${new Date(c.added).toLocaleDateString()}`), h('div', { style: 'font-weight:700;font-size:16px' }, c.name),
        h('div', { class: 'bar', style: 'margin-top:8px' },
          h('button', { class: 'btn sm' + (c.hidden ? '' : ' on'), onclick: () => toggle(c) }, c.hidden ? 'Hidden' : 'Shown'),
          h('button', { class: 'btn sm danger', onclick: () => confirmDel(c.name, async () => { await files.del('content:' + c.id); kv.set('content', kv.get('content', []).filter(x => x.id !== c.id)); emit('content'); this.content(); }) }, 'Delete')))))
        : h('div', { class: 'empty' }, 'No map content. Select Import to add a GeoJSON or KML file.'),
      h('p', { class: 'note' }, 'Points, lines and areas from the file are drawn on the map in amber. Files stay on this device.')));
  },

  // ----- About
  about() {
    this.section = 'about';
    this.detail.replaceChildren(h('div', { class: 'pad' }, this.head('About Kestrel EFB'),
      h('div', { class: 'cards' },
        card('Planning only', h('p', { style: 'margin:0' }, 'Kestrel EFB is not approved for navigation. Data may be out of date or wrong. Check every route, chart, weather report and NOTAM against official sources before you fly.')),
        card('Data sources', ...[['Charts, airspace, fixes, airways, plates', 'FAA'], ['Airports, runways, frequencies, navaids', 'OurAirports'], ['METAR, TAF, SIGMET', 'National Weather Service'], ['Radar', 'Iowa Environmental Mesonet'], ['Winds aloft, terrain', 'Open-Meteo'], ['Base maps', 'CARTO, OpenStreetMap, USGS']].map(([k, s]) => h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, s)))),
        card('Not included', h('p', { class: 'note', style: 'margin:0' }, 'Flight plan filing is not available. Live traffic, weather advisories and plates on the map need the relay server. NOTAMs open in the FAA search. Coverage is the United States only.')),
        card('Install', h('p', { class: 'note', style: 'margin:0' }, 'iPad and iPhone: in Safari, select Share, then Add to Home Screen. Mac and Windows: in Chrome or Edge, select the install icon in the address bar.')))));
  },
};

// Minimal KML reader: Placemark points, lines and polygons.
function kmlToGeoJSON(text) {
  const xml = new DOMParser().parseFromString(text, 'text/xml'), feats = [];
  const coords = el => (el?.textContent || '').trim().split(/\s+/).map(c => c.split(',').slice(0, 2).map(Number)).filter(c => c.length === 2 && c.every(isFinite));
  for (const pm of xml.getElementsByTagName('Placemark')) {
    const name = pm.getElementsByTagName('name')[0]?.textContent || '';
    const add = (type, coordinates) => feats.push({ type: 'Feature', properties: { name }, geometry: { type, coordinates } });
    for (const p of pm.getElementsByTagName('Point')) { const c = coords(p.getElementsByTagName('coordinates')[0]); if (c[0]) add('Point', c[0]); }
    for (const l of pm.getElementsByTagName('LineString')) { const c = coords(l.getElementsByTagName('coordinates')[0]); if (c.length > 1) add('LineString', c); }
    for (const g of pm.getElementsByTagName('Polygon')) { const c = coords(g.getElementsByTagName('outerBoundaryIs')[0]?.getElementsByTagName('coordinates')[0]); if (c.length > 2) add('Polygon', [c]); }
  }
  return { type: 'FeatureCollection', features: feats };
}
