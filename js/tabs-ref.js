// Reference tabs: Airports, Plates, Imagery, Documents.
import { $, h, icon, kv, files, emit, toast, split, backBtn, uid, confirmDel, debounce } from './util.js';
import { search, airport, runways, freqs, plates, magvar, part } from './db.js';
import { metar, taf, datis, rawWx, notams, hasRelay } from './wx.js';
import { fmtLL, norm } from './geo.js';
import { addPoint } from './route.js';
import { tfrsNear, tfrRow } from './tfr.js';
import { flyTo, inspect, showPlate } from './map.js';

const recent = { list: () => kv.get('recentApts', []), add(id) { kv.set('recentApts', [id, ...recent.list().filter(x => x !== id)].slice(0, 15)); } };
const aptRow = (a, onclick, sel) => h('button', { class: 'row' + (sel ? ' sel' : ''), onclick },
  h('div', { class: 'grow' }, h('div', { class: 't' }, a.id), h('div', { class: 's' }, `${a.name} · ${a.city}${a.state ? ', ' + a.state : ''}`)));
const SURF = [[/^ASP/i, 'Asphalt'], [/^CON/i, 'Concrete'], [/^(TURF|GRASS|GRS)/i, 'Turf'], [/^(GRAVEL|GRVL)/i, 'Gravel'], [/^DIRT/i, 'Dirt'], [/^WATER/i, 'Water']];
const surface = s => !s ? 'Surface unknown' : (SURF.find(([re]) => re.test(s)) || [0, s])[1];
const card = (title, ...kids) => h('div', { class: 'card' }, h('h3', {}, title), kids);
const kvRow = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, v));

// ---------- Airports
export const Airports = {
  init(view) {
    this.list = h('div', { class: 'list' });
    this.detail = h('div', { class: 'pane-detail' }, h('div', { class: 'empty' }, 'Search for an airport to see weather, runways and frequencies.'));
    this.input = h('input', { type: 'search', placeholder: 'Identifier, name or city', autocomplete: 'off', spellcheck: false, oninput: () => this.fill() });
    this.sp = split(view, h('div', { class: 'pane-list' }, h('div', { class: 'pane-head' }, this.input), this.list), this.detail);
    this.fill();
  },
  fill() {
    const q = this.input.value.trim();
    const items = q ? search(q, 40).filter(x => x.kind === 'apt') : recent.list().map(airport).filter(Boolean);
    this.list.replaceChildren(
      ...(q ? [] : [h('div', { class: 'sect' }, 'Recent')]),
      ...(items.length ? items.map(a => aptRow(a, () => this.show(a.id), a.id === this.cur)) : [h('div', { class: 'empty' }, q ? 'No airport matches. Check the spelling or try the city name.' : 'Airports you open appear here.')]));
  },
  async show(id) {
    const a = airport(id); if (!a) return toast(`${id} not found.`);
    this.cur = a.id; recent.add(a.id); this.fill(); this.sp.showDetail();
    const tag = h('span', { class: 'tag' }, a.wx ? 'Loading' : 'No weather');
    const wxBox = h('pre', { class: 'raw' }, a.wx ? 'Loading METAR.' : 'This airport does not report weather.');
    const tafBox = h('pre', { class: 'raw' }, a.wx === 2 ? 'Loading TAF.' : 'No TAF is issued for this airport.');
    const rwBox = h('div', {}, 'Loading'), fqBox = h('div', {}, 'Loading');
    const mv = magvar(a);
    const datisBox = h('pre', { class: 'raw' }), datisCard = card('D-ATIS', datisBox); datisCard.classList.add('hidden');
    // Without a NOTAM key, hand off to the FAA's own search with the identifier already on the clipboard.
    const notamId = a.wxId.length === 4 ? a.wxId : a.id;
    const notamLink = () => h('div', {},
      h('a', { class: 'btn sm primary', href: 'https://notams.aim.faa.gov/notamSearch/', target: '_blank', rel: 'noopener',
        onclick: () => { navigator.clipboard?.writeText(notamId).then(() => toast(`${notamId} copied. Paste it into the FAA search box.`)).catch(() => { }); } }, `Open FAA NOTAM Search for ${notamId}`),
      h('div', { class: 'note', style: 'margin-top:6px' }, `Copies ${notamId} so you only paste it and press Search.`));
    const notamBox = h('div', {}, hasRelay() ? 'Loading NOTAMs.' : notamLink());
    const tfrBox = h('div', {}, 'Loading TFRs.');
    const fuelNote = h('input', { type: 'text', placeholder: 'For example 100LL 6.45 self-serve', value: kv.get('fuelNotes', {})[a.id] || '', style: 'width:100%',
      onchange: e => { const n = kv.get('fuelNotes', {}); e.target.value.trim() ? n[a.id] = e.target.value.trim() : delete n[a.id]; kv.set('fuelNotes', n); toast('Fuel note saved on this device.'); } });
    let gotRaw = false;
    this.detail.replaceChildren(h('div', { class: 'pad' },
      h('div', { class: 'hero' }, backBtn(() => this.sp.showList()), h('h1', {}, a.id), tag, h('div', { class: 'sub' }, `${a.name} · ${a.city}${a.state ? ', ' + a.state : ''}`),
        h('div', { class: 'acts' },
          h('button', { class: 'btn sm', onclick: () => { emit('tab', 'maps'); flyTo(a, 11); inspect(a, a); } }, 'Show on map'),
          h('button', { class: 'btn sm', onclick: () => { addPoint(a.id); toast(`${a.id} added to route.`); } }, 'Add to route'),
          h('button', { class: 'btn sm', onclick: () => emit('open-plates', a.id) }, 'Plates'))),
      h('div', { class: 'cards' },
        card('METAR', wxBox), card('TAF', tafBox), datisCard,
        hasRelay() && card('TFRs within 30 nm', tfrBox),
        card('Airport', kvRow('Type', a.typeName), kvRow('Elevation', `${a.elev.toLocaleString()}' MSL`), kvRow('Position', fmtLL(a.lat, a.lon)),
          kvRow('Variation', `${Math.abs(mv).toFixed(0)}°${mv >= 0 ? 'E' : 'W'}`), a.local && kvRow('FAA identifier', a.local),
          ),
        card('Runways', rwBox), card('Frequencies', fqBox),
        card('Fuel', h('label', { class: 'field' }, h('span', {}, 'Your price note'), fuelNote),
          // AirNav lists US airports only; outside the US the place line holds a country name, not a state code.
          /^[A-Z]{2}$/.test(a.state || '') && h('div', { class: 'note', style: 'margin-top:6px' }, h('a', { href: `https://www.airnav.com/airport/${a.local || a.id}`, target: '_blank', rel: 'noopener' }, 'See fuel prices at airnav.com'))),
        card('NOTAMs', notamBox))));
    const cur = a.id;
    const wind = a.wx ? metar(a.wxId).then(m => {
      if (this.cur !== cur) return null;
      tag.textContent = m.cat || 'No category'; tag.className = 'tag ' + (m.cat || '');
      if (!gotRaw) wxBox.textContent = m.raw + `\n\nObserved ${m.time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` + (m.decoded ? ' · rebuilt from sensor values' : '');
      return m;
    }).catch(() => { tag.textContent = 'No weather'; wxBox.textContent = 'METAR did not load. Check your connection.'; return null; }) : Promise.resolve(null);
    if (a.wx === 2) taf(a.wxId).then(t => { if (this.cur === cur && !gotRaw) tafBox.textContent = t.raw; }).catch(() => { tafBox.textContent = 'TAF did not load.'; });
    if (a.wx) datis(a.wxId).then(list => {
      if (this.cur !== cur || !list.length) return;
      datisBox.textContent = list.map(d => (list.length > 1 ? (d.type === 'arr' ? 'ARRIVAL\n' : d.type === 'dep' ? 'DEPARTURE\n' : '') : '') + d.datis).join('\n\n');
      datisCard.classList.remove('hidden');
    }).catch(() => { });
    if (hasRelay()) {
      if (a.wx) rawWx(a.wxId).then(r => { if (this.cur !== cur) return; if (r.metar) { gotRaw = true; wxBox.textContent = r.metar; } if (r.taf) tafBox.textContent = r.taf; }).catch(() => { });
      tfrsNear(a, 30).then(list => { if (this.cur !== cur) return;
        tfrBox.replaceChildren(...(list.length ? list.map(t => tfrRow(t, t.d ? ` · ${t.d.toFixed(0)} nm away` : ' · over the airport')) : ['No TFRs within 30 nm.']));
      }).catch(() => { if (this.cur === cur) tfrBox.replaceChildren('TFRs did not load. Check your connection.'); });
      notams(notamId).then(list => { if (this.cur !== cur) return;
        notamBox.replaceChildren(...(list.length ? list.map(n => h('pre', { class: 'raw', style: 'padding:6px 0;border-bottom:1px solid var(--line)' }, n.text)) : ['No NOTAMs for this airport.']));
      }).catch(() => { if (this.cur === cur) notamBox.replaceChildren(notamLink()); });
    }
    Promise.all([runways(a.id), wind]).then(([rw, m]) => {
      if (this.cur !== cur) return;
      if (!rw.length) return rwBox.replaceChildren('No runway data.');
      rwBox.replaceChildren(...rw.map(r => {
        const comp = end => {
          if (!m || m.spd == null || m.dir == null || r[10] == null) return '';
          const hdg = end ? norm(r[10] + 180) : r[10], ang = (m.dir - hdg) * Math.PI / 180, hw = m.spd * Math.cos(ang), xw = m.spd * Math.sin(ang);
          return ` · ${Math.abs(Math.round(hw))} kt ${hw >= 0 ? 'head' : 'tail'}, ${Math.abs(Math.round(xw))} kt cross`;
        };
        return h('div', { style: 'padding:4px 0' }, h('div', { class: 'kv' }, h('span', { style: 'color:inherit;font-weight:700' }, `${r[0]}/${r[1]}`), h('span', {}, `${r[2].toLocaleString()} × ${r[3]} ft`)),
          h('div', { class: 'note' }, `${surface(r[4])}${r[5] ? ' · lighted' : ''}`),
          m && m.spd != null && r[10] != null && h('div', { class: 'note' }, `${r[0]}${comp(0)}`), m && m.spd != null && r[10] != null && h('div', { class: 'note' }, `${r[1]}${comp(1)}`));
      }));
    });
    freqs(a.id).then(fq => { if (this.cur === cur) fqBox.replaceChildren(...(fq.length ? fq.map(f => kvRow(f[1] || f[0], f[2].toFixed(3))) : ['No frequency data.'])); });
  },
};

// ---------- Plates
const GROUPS = [['APD', 'Airport diagram'], ['IAP', 'Approaches'], ['DP', 'Departures'], ['ODP', 'Obstacle departures'], ['STAR', 'Arrivals'], ['MIN', 'Minimums'], ['HOT', 'Hot spots'], ['LAH', 'Land and hold short']];
export const Plates = {
  init(view) {
    this.list = h('div', { class: 'list' });
    this.detail = h('div', { class: 'pane-detail' }, h('div', { class: 'empty' }, 'Choose an airport, then a plate.'));
    this.input = h('input', { type: 'search', placeholder: 'Airport identifier or name', autocomplete: 'off', spellcheck: false, oninput: () => this.fill() });
    this.sp = split(view, h('div', { class: 'pane-list' }, h('div', { class: 'pane-head' }, this.input), this.list), this.detail);
    this.fill();
  },
  async fill() {
    const q = this.input.value.trim(), idx = (await part('plates')).a || {};
    const has = a => idx[a.id] || idx[a.id.replace(/^K/, '')];
    const items = (q ? search(q, 60).filter(x => x.kind === 'apt') : kv.get('recentPlates', []).map(airport).filter(Boolean)).filter(has);
    this.list.replaceChildren(...(q ? [] : [h('div', { class: 'sect' }, 'Recent')]),
      ...(items.length ? items.map(a => aptRow(a, () => this.open(a.id))) : [h('div', { class: 'empty' }, q ? 'No airport with published procedures matches.' : 'Airports whose plates you open appear here.')]));
  },
  async open(id) {
    const a = airport(id); if (!a) return;
    const p = await plates(a.id);
    kv.set('recentPlates', [a.id, ...kv.get('recentPlates', []).filter(x => x !== a.id)].slice(0, 12));
    const url = pdf => `https://aeronav.faa.gov/d-tpp/${p.cycle}/${pdf}`;
    const known = new Set(GROUPS.map(g => g[0]));
    const groups = [...GROUPS, ['', 'Other']].map(([code, name]) => [name, p.list.filter(x => code ? x[0] === code : !known.has(x[0]))]).filter(g => g[1].length);
    const saveAll = async btn => {
      btn.disabled = true; const c = await caches.open('kestrel-plates'); let n = 0;
      for (const x of p.list) { try { await c.put(url(x[2]), await fetch(url(x[2]), { mode: 'no-cors' })); n++; } catch { } btn.textContent = `Saving ${n}/${p.list.length}`; }
      btn.textContent = 'Saved offline'; toast(`${n} of ${p.list.length} plates saved on this device.`);
    };
    this.list.replaceChildren(
      h('div', { class: 'pane-head' }, h('button', { class: 'btn sq', title: 'Back to airport search', onclick: () => this.fill() }, icon('back')), h('h2', {}, a.id), h('button', { class: 'btn sm', onclick: e => saveAll(e.target) }, 'Save offline')),
      h('div', { class: 'note', style: 'padding:0 12px 6px' }, `FAA cycle ${p.cycle} · valid ${p.from.split(/\s+/).pop()} to ${p.to.split(/\s+/).pop()}`),
      ...groups.flatMap(([name, list]) => [h('div', { class: 'sect' }, name), ...list.map(x => h('button', { class: 'row', onclick: e => { this.list.querySelectorAll('.sel').forEach(n => n.classList.remove('sel')); e.currentTarget.classList.add('sel'); this.view(a, x, url(x[2])); } }, h('div', { class: 'grow' }, h('div', { class: 't', style: 'font-weight:600' }, x[1]))))]));
    if (!p.list.length) this.list.append(h('div', { class: 'empty' }, /^[A-Z]{2}$/.test(a.state || '') ? 'No published procedures for this airport.' : 'Plates come from the FAA and cover US airports only.'));
  },
  view(a, x, url) {
    this.sp.showDetail();
    this.detail.replaceChildren(
      h('div', { class: 'pane-head' }, backBtn(() => this.sp.showList()), h('h2', {}, `${a.id} · ${x[1]}`),
        h('button', { class: 'btn sm', title: 'Place this plate on the map', onclick: async e => {
          const b = e.currentTarget, [, cycle, pdf] = url.match(/d-tpp\/(\d+)\/(.+)$/); b.disabled = true; b.textContent = 'Placing';
          try { await showPlate(`${a.id} ${x[1]}`, cycle, pdf); emit('tab', 'maps'); } catch (err) { toast(err.message + '.'); }
          b.disabled = false; b.textContent = 'Show on map';
        } }, 'Show on map'),
        h('a', { class: 'btn sm', href: url, target: '_blank', rel: 'noopener' }, 'Open in new tab')),
      h('iframe', { class: 'viewer', src: url + '#view=FitH', title: x[1] }));
  },
};

// ---------- Imagery
const AWC = 'https://aviationweather.gov/data/products/', WPC = 'https://www.wpc.ncep.noaa.gov/';
const IMAGERY = [
  ['Surface analysis and prognostics', [['Current surface analysis', WPC + 'sfc/namussfcwbg.gif'], ['12-hour prog', WPC + 'basicwx/92fndfd.gif'], ['24-hour prog', WPC + 'basicwx/94fndfd.gif'], ['36-hour prog', WPC + 'basicwx/96fndfd.gif'], ['48-hour prog', WPC + 'basicwx/98fndfd.gif']]],
  ['Radar and satellite', [['National radar', 'https://radar.weather.gov/ridge/standard/CONUS_0.gif'], ['National radar loop', 'https://radar.weather.gov/ridge/standard/CONUS_loop.gif'], ['Satellite, visible color', 'https://cdn.star.nesdis.noaa.gov/GOES19/ABI/CONUS/GEOCOLOR/1250x750.jpg'], ['Satellite, infrared', 'https://cdn.star.nesdis.noaa.gov/GOES19/ABI/CONUS/13/1250x750.jpg']]],
  ['Graphical forecasts', [['Clouds, 3-hour', AWC + 'gfa/F03_gfa_clouds_us.png'], ['Clouds, 6-hour', AWC + 'gfa/F06_gfa_clouds_us.png'], ['Surface, 3-hour', AWC + 'gfa/F03_gfa_sfc_us.png']]],
  ['Icing', [['Current icing severity', AWC + 'icing/F00_cip_max_sev.gif'], ['Icing forecast, 3-hour', AWC + 'icing/F03_fip_max_sev.gif']]],
  ['Winds aloft', [['5,000 ft, 6-hour', AWC + 'fax/F06_wind_050_a.gif'], ['10,000 ft, 6-hour', AWC + 'fax/F06_wind_100_a.gif']]],
];
export const Imagery = {
  init(view) {
    this.detail = h('div', { class: 'pane-detail' }, h('div', { class: 'empty' }, 'Choose a product to view it.'));
    const list = h('div', { class: 'list' }, IMAGERY.flatMap(([g, items]) => [h('div', { class: 'sect' }, g), ...items.map(([name, url]) => h('button', { class: 'row', onclick: e => {
      list.querySelectorAll('.sel').forEach(n => n.classList.remove('sel')); e.currentTarget.classList.add('sel'); sp.showDetail();
      const img = h('img', { alt: name, src: url + '?t=' + Math.floor(Date.now() / 6e5), onerror: () => img.replaceWith(h('div', { class: 'empty' }, 'This image did not load. Check your connection and try again.')) });
      this.detail.replaceChildren(h('div', { class: 'pane-head' }, backBtn(() => sp.showList()), h('h2', {}, name), h('a', { class: 'btn sm', href: url, target: '_blank', rel: 'noopener' }, 'Open in new tab')), h('div', { class: 'imgview' }, img));
    } }, h('div', { class: 'grow' }, h('div', { class: 't', style: 'font-weight:600' }, name))))]));
    const sp = split(view, h('div', { class: 'pane-list' }, h('div', { class: 'pane-head' }, h('h2', {}, 'Imagery')), list), this.detail);
  },
};

// ---------- Documents
const CATALOG = [
  ['Aeronautical Information Manual', 'https://www.faa.gov/air_traffic/publications/atpubs/aim_html/'],
  ['Pilot’s Handbook of Aeronautical Knowledge', 'https://www.faa.gov/regulations_policies/handbooks_manuals/aviation/phak'],
  ['Aeronautical Chart Users’ Guide', 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/aero_guide/'],
  ['Chart Supplements', 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dafd/'],
  ['NOTAM Search', 'https://notams.aim.faa.gov/notamSearch/'],
  ['Temporary Flight Restrictions', 'https://tfr.faa.gov/'],
];
export const Documents = {
  init(view) {
    this.list = h('div', { class: 'list' });
    this.detail = h('div', { class: 'pane-detail' }, h('div', { class: 'empty' }, 'Import a PDF or image to keep it on this device.'));
    const pick = h('input', { type: 'file', accept: 'application/pdf,image/*', multiple: true, class: 'hidden', onchange: async e => {
      const docs = kv.get('docs', []);
      for (const f of e.target.files) { const id = uid(); await files.put('doc:' + id, f); docs.unshift({ id, name: f.name, type: f.type, size: f.size, added: Date.now() }); }
      kv.set('docs', docs); e.target.value = ''; this.fill(); toast('Document saved on this device.');
    } });
    this.sp = split(view, h('div', { class: 'pane-list' }, h('div', { class: 'pane-head' }, h('h2', {}, 'Documents'), h('button', { class: 'btn sm primary', onclick: () => pick.click() }, 'Import'), pick), this.list), this.detail);
    this.fill();
  },
  fill() {
    const docs = kv.get('docs', []);
    this.list.replaceChildren(h('div', { class: 'sect' }, 'On this device'),
      ...(docs.length ? docs.map(d => h('button', { class: 'row', onclick: () => this.open(d) }, h('div', { class: 'grow' }, h('div', { class: 't', style: 'font-weight:600' }, d.name), h('div', { class: 's' }, `${(d.size / 1048576).toFixed(1)} MB · added ${new Date(d.added).toLocaleDateString()}`))))
        : [h('div', { class: 'empty' }, 'No documents yet. Select Import to add a PDF or image.')]),
      h('div', { class: 'sect' }, 'FAA publications (open faa.gov)'),
      ...CATALOG.map(([n, u]) => h('a', { class: 'row', href: u, target: '_blank', rel: 'noopener', style: 'color:inherit;text-decoration:none' }, h('div', { class: 'grow' }, h('div', { class: 't', style: 'font-weight:600' }, n)))));
  },
  async open(d) {
    const blob = await files.get('doc:' + d.id); if (!blob) return toast('This document is missing. Import it again.');
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob); this.sp.showDetail();
    this.detail.replaceChildren(
      h('div', { class: 'pane-head' }, backBtn(() => this.sp.showList()), h('h2', {}, d.name),
        h('button', { class: 'btn sm danger', onclick: () => confirmDel(d.name, async () => { await files.del('doc:' + d.id); kv.set('docs', kv.get('docs', []).filter(x => x.id !== d.id)); this.fill(); this.sp.showList(); this.detail.replaceChildren(h('div', { class: 'empty' }, 'Document deleted.')); }) }, 'Delete')),
      d.type.startsWith('image/') ? h('div', { class: 'imgview' }, h('img', { src: this.url, alt: d.name })) : h('iframe', { class: 'viewer', src: this.url, title: d.name }));
  },
};
