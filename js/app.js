// App shell: tab bar, lazy tab setup, startup.
import { $, h, icon, on, kv, toast } from './util.js';
import { load } from './db.js';
import { initMap } from './map.js';
import { initFpl } from './fpl.js';
import { recompute } from './route.js';
import { Airports, Plates, Imagery, Documents } from './tabs-ref.js';
import { Flights, Logbook, Checklist, Scratch } from './tabs-fly.js';
import { More } from './more.js';

const TABS = [
  ['airports', 'Airports', Airports], ['maps', 'Maps', null], ['plates', 'Plates', Plates], ['documents', 'Documents', Documents], ['imagery', 'Imagery', Imagery],
  ['flights', 'Flights', Flights], ['scratch', 'ScratchPads', Scratch], ['checklist', 'Checklist', Checklist], ['logbook', 'Logbook', Logbook], ['more', 'More', More],
];
const started = new Set();
function show(id) {
  const t = TABS.find(x => x[0] === id); if (!t) return;
  if (t[2] && !started.has(id)) { started.add(id); t[2].init($('#v-' + id)); }
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'v-' + id));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === id));
  kv.set('tab', id);
}
$('#tabs').append(...TABS.map(([id, name]) => h('button', { 'data-t': id, onclick: () => show(id) }, icon(id), name)));

on('tab', show);
on('open-airport', id => { show('airports'); Airports.show(id); });
on('open-plates', id => { show('plates'); Plates.open(id); });

(async () => {
  show('maps');
  try { await load(); } catch { toast('Navigation data did not load. Reload the page.'); return; }
  initMap(); initFpl(); await recompute();
  const last = kv.get('tab', 'maps'); if (last !== 'maps') show(last);
  if (!kv.get('ack')) {
    const { modal } = await import('./util.js');
    modal('Planning only', h('div', {}, 'Kestrel EFB is not approved for navigation. Check all data against official sources before you fly.'), [{ label: 'I understand', run: () => kv.set('ack', 1) }]);
  }
})();

if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') navigator.serviceWorker?.register('sw.js').catch(() => { });
