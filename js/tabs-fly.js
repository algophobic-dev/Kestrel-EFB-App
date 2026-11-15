// Flying tabs: Flights (NavLog, weight and balance), Logbook, Checklist, ScratchPads.
import { $, h, icon, kv, files, on, emit, toast, split, backBtn, uid, confirmDel, modal, download, debounce } from './util.js';
import { flights, aircraft, parse, legsFor, setPlan, plan } from './route.js';
import { along, fmtDur } from './geo.js';
import { winds } from './wx.js';
import { navlogTable } from './fpl.js';
import { fitRoute } from './map.js';
import { perfPanel } from './perf.js';

const card = (title, ...kids) => h('div', { class: 'card' }, h('h3', {}, title), kids);
const kvRow = (k, v, cls) => h('div', { class: 'kv' }, h('span', {}, k), h('span', { class: cls || '' }, v));
const field = (label, input, cls) => h('label', { class: 'field ' + (cls || '') }, h('span', {}, label), input);
function printNode(title, node) {
  $('#print')?.remove();
  document.body.append(h('div', { id: 'print' }, h('h2', {}, title), node, h('p', {}, 'Planning only. Not for navigation.')));
  window.print();
}

// ---------- Flights
export const Flights = {
  init(view) {
    this.list = h('div', { class: 'list' });
    this.detail = h('div', { class: 'pane-detail' }, h('div', { class: 'empty' }, 'Choose a flight to see its NavLog and weight and balance.'));
    this.sp = split(view, h('div', { class: 'pane-list' }, h('div', { class: 'pane-head' }, h('h2', {}, 'Flights')), this.list), this.detail);
    on('flights', () => this.fill()); this.fill();
  },
  fill() {
    const l = flights.list();
    this.list.replaceChildren(...(l.length ? l.map(f => h('button', { class: 'row' + (f.id === this.cur ? ' sel' : ''), onclick: () => this.show(f.id) },
      h('div', { class: 'grow' }, h('div', { class: 't' }, f.name), h('div', { class: 's' }, `${f.text} · ${f.alt.toLocaleString()}'`))))
      : [h('div', { class: 'empty' }, 'No saved flights. On the Maps tab, enter a route and select the star to save it.')]));
  },
  async show(id) {
    const f = flights.list().find(x => x.id === id); if (!f) return;
    this.cur = id; this.fill(); this.sp.showDetail();
    const ac = aircraft.get(f.acId), nav = h('div', {}, h('div', { class: 'empty' }, 'Calculating NavLog.')), sum = h('div', {}, 'Calculating');
    const wbOut = h('div', {}), perfBox = h('div', {}, h('div', { class: 'note' }, 'Calculating.'));
    let tow = null, trip = 0, panels = [];
    f.loads ||= { fuel: ac.fuelCap, st: {} };
    const wb = ac.wb, calcWB = () => {
      if (!wb) return wbOut.replaceChildren(h('div', { class: 'note' }, 'This aircraft has no weight and balance data. Add it in More > Aircraft.'));
      let w = wb.emptyW, m = wb.emptyW * wb.emptyArm;
      for (const s of wb.stations) { const x = +f.loads.st[s.name] || 0; w += x; m += x * s.arm; }
      const fw = (+f.loads.fuel || 0) * 6; w += fw; m += fw * wb.fuelArm;
      const cg = m / w, okW = w <= wb.maxW, okCG = cg >= wb.cgFwd && cg <= wb.cgAft;
      tow = w; panels.forEach(p => p.refresh());
      wbOut.replaceChildren(kvRow('Takeoff weight', `${Math.round(w).toLocaleString()} lb of ${wb.maxW.toLocaleString()}`, okW ? 'ok' : 'bad'), kvRow('Center of gravity', `${cg.toFixed(1)} in (limits ${wb.cgFwd}–${wb.cgAft})`, okCG ? 'ok' : 'bad'),
        kvRow('Result', okW && okCG ? 'Within limits' : !okW ? `Over by ${Math.round(w - wb.maxW)} lb. Remove weight.` : 'CG out of limits. Move weight.', okW && okCG ? 'ok' : 'bad'));
      flights.list().some(x => x.id === f.id) && kv.set('flights', flights.list().map(x => x.id === f.id ? f : x));
    };
    const num = (get, set) => h('input', { type: 'number', min: 0, inputmode: 'decimal', value: get() ?? '', oninput: e => { set(e.target.value); calcWB(); } });
    this.detail.replaceChildren(h('div', { class: 'pad' },
      h('div', { class: 'hero' }, backBtn(() => this.sp.showList()), h('h1', {}, f.name), h('div', { class: 'sub' }, `${ac.name} · ${f.alt.toLocaleString()}'`),
        h('div', { class: 'acts' },
          h('button', { class: 'btn sm primary', onclick: () => { setPlan({ text: f.text, alt: f.alt, acId: f.acId, etd: f.etd || '' }).then(fitRoute); $('#fpl').classList.remove('hidden'); $('#btn-fpl').classList.add('on'); emit('tab', 'maps'); } }, 'Open on map'),
          h('button', { class: 'btn sm', onclick: () => printNode(`NavLog · ${f.name} · ${ac.name}`, nav.cloneNode(true)) }, 'Print NavLog'),
          h('button', { class: 'btn sm danger', onclick: () => confirmDel(f.name, () => { flights.remove(f.id); this.cur = null; this.sp.showList(); this.detail.replaceChildren(h('div', { class: 'empty' }, 'Flight deleted.')); }) }, 'Delete'))),
      h('div', { class: 'cards', style: 'margin-bottom:10px' },
        card('Summary', sum),
        card('Weight and balance', wb && h('div', { class: 'form', style: 'margin-bottom:8px' },
          wb.stations.map(s => field(s.name + ' (lb)', num(() => f.loads.st[s.name], v => f.loads.st[s.name] = v))), field('Fuel (gal)', num(() => f.loads.fuel, v => f.loads.fuel = v))), wbOut),
        card('Takeoff and landing', perfBox)),
      h('div', { class: 'card', style: 'padding:0;overflow:auto' }, nav)));
    calcWB();
    const { points, errors } = await parse(f.text);
    let w = null; try { w = await winds(points.slice(1).map((b, i) => along(points[i], b, .5)), f.alt); } catch { }
    if (this.cur !== id) return;
    const r = legsFor(points, ac, f.alt, w);
    nav.replaceChildren(navlogTable(r));
    trip = r.total ? r.total.fuel : 0;
    const dep = points[0], arr = points[points.length - 1];
    panels = await Promise.all([dep?.kind === 'apt' && perfPanel(dep, 'to', ac, () => tow), arr?.kind === 'apt' && arr !== dep && perfPanel(arr, 'ld', ac, () => tow ? tow - trip * 6 : null)].filter(Boolean));
    if (this.cur !== id) return;
    perfBox.replaceChildren(...(panels.length ? panels : [h('div', { class: 'note' }, 'Start and end the route at airports to see runway performance.')]),
      h('div', { class: 'note' }, 'Estimates from your baseline distances and rule-of-thumb corrections. Use your POH for the real figures.'));
    sum.replaceChildren(...[kvRow('Route', f.text), kvRow('Distance', r.total ? r.total.d.toFixed(0) + ' nm' : '--'), kvRow('Time en route', r.total ? fmtDur(r.total.min) : '--'),
      kvRow('Trip fuel', r.total ? `${r.total.fuel.toFixed(1)} gal` : '--'),
      kvRow('Taxi + reserve', r.total ? `${r.total.taxi.toFixed(1)} + ${r.total.reserve.toFixed(1)} gal (${ac.reserve ?? 45} min)` : '--'),
      kvRow('Fuel required', r.total ? `${r.total.req.toFixed(1)} gal of ${ac.fuelCap} usable` : '--', r.total && r.total.req > ac.fuelCap ? 'bad' : 'ok'),
      r.total && (+f.loads.fuel || 0) < r.total.req ? kvRow('Fuel on board', `${+f.loads.fuel || 0} gal is ${(r.total.req - (+f.loads.fuel || 0)).toFixed(1)} gal short. Add fuel.`, 'bad') : null,
      kvRow('Endurance on board', fmtDur((+f.loads.fuel || 0) / ac.burn * 60)),
      kvRow('Winds aloft', w ? 'Included' : 'Unavailable, still air used', w ? '' : 'warn'), errors.length ? kvRow('Problems', errors.join('; '), 'bad') : null,
      h('div', { class: 'note', style: 'margin-top:6px' }, 'Climb and descent use the aircraft profile when its climb and descent fields are set. Wind is applied at cruise only.')].filter(Boolean));
  },
};

// ---------- Logbook
const LOG_FIELDS = [['date', 'Date', 'date'], ['ac', 'Aircraft', 'text'], ['from', 'From', 'text'], ['to', 'To', 'text'], ['total', 'Total time', 'number'], ['pic', 'PIC', 'number'], ['night', 'Night', 'number'], ['inst', 'Instrument', 'number'], ['xc', 'Cross country', 'number'], ['ldg', 'Landings', 'number']];
export const Logbook = {
  init(view) { this.view = view; on('tracks', () => this.draw()); this.draw(); },
  edit(entry) {
    const e = entry ? { ...entry } : { id: uid(), date: new Date().toISOString().slice(0, 10), ac: aircraft.get(plan.acId).tail || '' };
    const form = h('div', { class: 'form' }, LOG_FIELDS.map(([k, label, type]) => field(label, h('input', { type, step: type === 'number' ? (k === 'ldg' ? 1 : .1) : null, min: 0, value: e[k] ?? '', oninput: ev => e[k] = type === 'number' ? +ev.target.value : ev.target.value.toUpperCase() }))),
      field('Remarks', h('textarea', { rows: 2, value: e.rem || '', oninput: ev => e.rem = ev.target.value }), 'wide'));
    modal(entry ? 'Edit entry' : 'New entry', form, [{ label: 'Save', run: () => {
      if (!e.date || !(e.total > 0)) { toast('Enter a date and a total time.'); return false; }
      kv.set('logbook', [e, ...kv.get('logbook', []).filter(x => x.id !== e.id)].sort((a, b) => b.date.localeCompare(a.date))); this.draw();
    } }]);
  },
  draw() {
    const l = kv.get('logbook', []), sum = k => l.reduce((s, e) => s + (+e[k] || 0), 0);
    this.view.replaceChildren(h('div', { class: 'pane-detail' }, h('div', { class: 'pad' },
      h('div', { class: 'hero' }, h('h1', {}, 'Logbook'), h('div', { class: 'acts' },
        h('button', { class: 'btn sm primary', onclick: () => this.edit() }, 'New entry'),
        h('button', { class: 'btn sm', disabled: !l.length, onclick: () => download('logbook.csv', [LOG_FIELDS.map(f => f[1]).concat('Remarks').join(','), ...l.map(e => LOG_FIELDS.map(f => e[f[0]] ?? '').concat('"' + (e.rem || '').replace(/"/g, '""') + '"').join(','))].join('\n'), 'text/csv') }, 'Export CSV'))),
      h('div', { class: 'cards', style: 'margin-bottom:10px' }, card('Totals', kvRow('Total time', sum('total').toFixed(1)), kvRow('PIC', sum('pic').toFixed(1)), kvRow('Night', sum('night').toFixed(1)), kvRow('Instrument', sum('inst').toFixed(1)), kvRow('Cross country', sum('xc').toFixed(1)), kvRow('Landings', sum('ldg')))),
      l.length ? h('div', { class: 'card', style: 'padding:0;overflow:auto' }, h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ['Date', 'Aircraft', 'Route', 'Total', 'PIC', 'Night', 'Inst', 'XC', 'Ldg'].map(t => h('th', {}, t)))),
        h('tbody', {}, l.map(e => h('tr', { class: 'click', title: 'Edit entry', onclick: () => this.rowMenu(e) }, h('td', {}, e.date), h('td', {}, e.ac || ''), h('td', {}, `${e.from || ''} → ${e.to || ''}`),
          ...['total', 'pic', 'night', 'inst', 'xc'].map(k => h('td', {}, e[k] ? (+e[k]).toFixed(1) : '')), h('td', {}, e.ldg || ''))))))
        : h('div', { class: 'empty' }, 'No entries. Select New entry to log a flight.'))));
  },
  rowMenu(e) {
    modal(`${e.date} · ${e.from || ''} → ${e.to || ''}`, h('div', {}, e.rem || 'No remarks.'), [
      { label: 'Delete', danger: true, run: () => { kv.set('logbook', kv.get('logbook', []).filter(x => x.id !== e.id)); this.draw(); } },
      { label: 'Edit', run: () => { setTimeout(() => this.edit(e)); } }]);
  },
};

// ---------- Checklist
const SAMPLE_CL = `# Before start
Preflight inspection : Complete
Seats and belts : Adjusted, locked
Brakes : Set
Avionics : Off
Fuel selector : Both
# Engine start
Mixture : Rich
Master switch : On
Beacon : On
Propeller area : Clear
Ignition : Start
Oil pressure : Check
# Before takeoff
Flight controls : Free and correct
Instruments : Set
Run-up : Complete
Flaps : Set
Transponder : Altitude
Lights : As required`;
export const Checklist = {
  lists: () => { const l = kv.get('checklists'); return l && l.length ? l : [{ id: 'sample', name: 'Sample (replace with your POH)', text: SAMPLE_CL }]; },
  init(view) {
    this.list = h('div', { class: 'list' });
    this.detail = h('div', { class: 'pane-detail' }, h('div', { class: 'empty' }, 'Choose a checklist.'));
    this.sp = split(view, h('div', { class: 'pane-list' }, h('div', { class: 'pane-head' }, h('h2', {}, 'Checklists'), h('button', { class: 'btn sm primary', onclick: () => this.edit({ id: uid(), name: '', text: '# Section\nItem : Response' }) }, 'New')), this.list), this.detail);
    this.fill();
  },
  fill() { this.list.replaceChildren(...this.lists().map(c => h('button', { class: 'row' + (c.id === this.cur?.id ? ' sel' : ''), onclick: () => this.open(c) }, h('div', { class: 'grow' }, h('div', { class: 't', style: 'font-weight:600' }, c.name))))); },
  edit(c) {
    const name = h('input', { type: 'text', value: c.name, placeholder: 'Checklist name' }), text = h('textarea', { rows: 14, value: c.text, style: 'font-family:var(--mono);font-size:13px' });
    modal(c.name ? 'Edit checklist' : 'New checklist', h('div', { class: 'form' }, field('Name', name, 'wide'), field('Items. Start a section with #. Write each item as Item : Response.', text, 'wide')), [{ label: 'Save', run: () => {
      if (!name.value.trim()) { toast('Enter a name.'); return false; }
      const n = { id: c.id, name: name.value.trim(), text: text.value };
      kv.set('checklists', [...this.lists().filter(x => x.id !== c.id), n]); this.fill(); this.open(n);
    } }]);
  },
  say(t) { if (!this.speak || !window.speechSynthesis) return; speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(t)); },
  open(c) {
    this.cur = c; this.fill(); this.sp.showDetail(); this.done = new Set();
    const items = c.text.split('\n').map(s => s.trim()).filter(Boolean).map((s, i) => s.startsWith('#') ? { sec: s.replace(/^#+\s*/, '') } : { i, c: s.split(':')[0].trim(), r: s.split(':').slice(1).join(':').trim() });
    const body = h('div', { class: 'list' });
    const next = () => items.find(x => !x.sec && !this.done.has(x.i));
    const draw = () => {
      const cur = next();
      body.replaceChildren(...items.map(x => x.sec ? h('div', { class: 'cl-sec' }, x.sec) : h('button', { class: 'cl-item' + (this.done.has(x.i) ? ' done' : '') + (x === cur ? ' cur' : ''), onclick: () => {
        this.done.has(x.i) ? this.done.delete(x.i) : this.done.add(x.i); draw();
        const n = next(); if (this.done.has(x.i)) this.say(n ? `${n.c}. ${n.r}` : 'Checklist complete');
      } }, h('span', { class: 'c' }, x.c), h('span', { class: 'r' }, x.r))),
        ...(cur ? [] : [h('div', { class: 'empty ok' }, 'Checklist complete.')]));
    };
    const spk = h('button', { class: 'btn sm' + (this.speak ? ' on' : ''), title: 'Read each item aloud', onclick: () => {
      if (!window.speechSynthesis) return toast('This browser cannot speak text.');
      this.speak = !this.speak; spk.classList.toggle('on', this.speak);
      const n = next(); if (this.speak && n) this.say(`${n.c}. ${n.r}`); else speechSynthesis.cancel();
    } }, icon('speak'), 'Speak');
    this.detail.replaceChildren(
      h('div', { class: 'pane-head' }, backBtn(() => this.sp.showList()), h('h2', {}, c.name), spk,
        h('button', { class: 'btn sm', onclick: () => { this.done.clear(); draw(); } }, 'Reset'), h('button', { class: 'btn sm', onclick: () => this.edit(c) }, 'Edit'),
        h('button', { class: 'btn sm danger', onclick: () => confirmDel(c.name, () => { kv.set('checklists', this.lists().filter(x => x.id !== c.id)); this.cur = null; this.fill(); this.sp.showList(); this.detail.replaceChildren(h('div', { class: 'empty' }, 'Checklist deleted.')); }) }, 'Delete')),
      body);
    draw();
  },
};

// ---------- ScratchPads
const TEMPLATES = { Blank: [], ATIS: ['Airport', 'Info', 'Time', 'Wind', 'Visibility', 'Sky', 'Temp / Dew', 'Altimeter', 'Runway', 'Remarks'], CRAFT: ['Clearance limit', 'Route', 'Altitude', 'Frequency', 'Transponder'] };
export const Scratch = {
  init(view) {
    this.list = h('div', { class: 'list' });
    this.detail = h('div', { class: 'pane-detail' }, h('div', { class: 'empty' }, 'Choose a ScratchPad or create one.'));
    this.sp = split(view, h('div', { class: 'pane-list' }, h('div', { class: 'pane-head' }, h('h2', {}, 'ScratchPads'),
      Object.keys(TEMPLATES).map(t => h('button', { class: 'btn sm', title: `New ${t} ScratchPad`, onclick: () => { const p = { id: uid(), tpl: t, made: Date.now() }; kv.set('pads', [p, ...kv.get('pads', [])]); this.fill(); this.open(p); } }, '+ ' + t))), this.list), this.detail);
    this.fill();
  },
  fill() {
    const l = kv.get('pads', []);
    this.list.replaceChildren(...(l.length ? l.map(p => h('button', { class: 'row' + (p.id === this.cur ? ' sel' : ''), onclick: () => this.open(p) }, h('div', { class: 'grow' }, h('div', { class: 't', style: 'font-weight:600' }, p.tpl), h('div', { class: 's' }, new Date(p.made).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })))))
      : [h('div', { class: 'empty' }, 'No ScratchPads. Select a template above to start one.')]));
  },
  async open(p) {
    this.cur = p.id; this.fill(); this.sp.showDetail();
    const cv = h('canvas'), wrap = h('div', { class: 'pad-wrap' }, cv);
    let strokes = (await files.get('pad:' + p.id)) || [], cur = null;
    const persist = debounce(() => files.put('pad:' + p.id, strokes), 600);
    const paint = () => {
      const W = wrap.clientWidth, H = wrap.clientHeight, d = window.devicePixelRatio || 1; if (!W) return;
      cv.width = W * d; cv.height = H * d; const c = cv.getContext('2d'); c.scale(d, d);
      const rows = TEMPLATES[p.tpl] || [], rh = rows.length ? Math.min(90, H / rows.length) : 0;
      c.font = '600 12px system-ui, sans-serif'; c.fillStyle = '#7b8791'; c.strokeStyle = '#d3d3c8'; c.lineWidth = 1;
      rows.forEach((r, i) => { c.fillText(r.toUpperCase(), 10, i * rh + 18); c.beginPath(); c.moveTo(0, (i + 1) * rh); c.lineTo(W, (i + 1) * rh); c.stroke(); });
      c.strokeStyle = '#14202a'; c.lineWidth = 2.4; c.lineCap = c.lineJoin = 'round';
      for (const s of strokes) { c.beginPath(); s.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); if (s.length === 1) c.lineTo(s[0][0] + .1, s[0][1]); c.stroke(); }
    };
    const pt = e => { const r = cv.getBoundingClientRect(); return [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)]; };
    cv.onpointerdown = e => { cv.setPointerCapture(e.pointerId); cur = [pt(e)]; strokes.push(cur); paint(); };
    cv.onpointermove = e => { if (cur) { cur.push(pt(e)); paint(); } };
    cv.onpointerup = cv.onpointercancel = () => { cur = null; persist(); };
    this.ro?.disconnect(); this.ro = new ResizeObserver(paint); this.ro.observe(wrap);
    this.detail.replaceChildren(
      h('div', { class: 'pane-head' }, backBtn(() => this.sp.showList()), h('h2', {}, p.tpl),
        h('button', { class: 'btn sm', onclick: () => { strokes.pop(); paint(); persist(); } }, 'Undo'),
        h('button', { class: 'btn sm', onclick: () => { strokes = []; paint(); persist(); } }, 'Clear'),
        h('button', { class: 'btn sm danger', onclick: () => confirmDel('this ScratchPad', async () => { await files.del('pad:' + p.id); kv.set('pads', kv.get('pads', []).filter(x => x.id !== p.id)); this.cur = null; this.fill(); this.sp.showList(); this.detail.replaceChildren(h('div', { class: 'empty' }, 'ScratchPad deleted.')); }) }, 'Delete')),
      wrap);
    paint();
  },
};
