// Hooks for the Mac app's menu bar. The native menus call these by name.
// They also work from the browser console, e.g. Kestrel.tab('plates').
import { $, h, emit, toast } from './util.js';
import { setPlan, reverse, current, plan } from './route.js';
import { setOverlay, setChart, setBase, fitRoute, map } from './map.js';
import { navlogTable } from './fpl.js';
import { sync, syncCode } from './sync.js';

const showFpl = () => { if ($('#fpl').classList.contains('hidden')) $('#btn-fpl').click(); };
const onMap = fn => { emit('tab', 'maps'); return fn(); };

window.Kestrel = {
  tab: id => emit('tab', id),
  // Flight plan panel
  toggleFpl: () => onMap(() => $('#btn-fpl').click()),
  mode: m => onMap(() => { showFpl(); document.querySelector(`#fpl-mode button[data-m="${m}"]`)?.click(); }),
  newPlan: () => onMap(() => { showFpl(); setPlan({ text: '' }); $('#fpl-chips input')?.focus(); }),
  savePlan: () => onMap(() => { showFpl(); $('#fpl-save').click(); }),
  reverse: () => onMap(() => { showFpl(); reverse(); }),
  routes: () => onMap(() => { showFpl(); $('#fpl-routes').click(); }),
  procedures: () => onMap(() => { showFpl(); $('#fpl-proc').click(); }),
  centre: () => onMap(fitRoute),
  search: () => onMap(() => $('#map-search').focus()),
  // Map
  zoom: d => onMap(() => d > 0 ? map.zoomIn(1) : map.zoomOut(1)),
  layer: key => onMap(() => setOverlay(key)),
  chart: key => onMap(() => setChart(key)),
  base: key => onMap(() => setBase(key)),
  follow: () => onMap(() => $('#tool-follow').click()),
  record: () => onMap(() => $('#tool-rec').click()),
  // Other
  syncNow: () => syncCode() ? sync().then(() => toast('Sync finished.')) : (emit('tab', 'more'), toast('Sync is off. Turn it on under More > Sync.')),
  // Lay out the current NavLog for printing. Returns false when there is nothing to print.
  preparePrint() {
    if (current.legs.length < 1) { toast('Enter a route with at least two points to print a NavLog.'); return false; }
    $('#print')?.remove();
    const pts = current.points;
    document.body.append(h('div', { id: 'print' }, h('h2', {}, `NavLog · ${pts[0].id} to ${pts[pts.length - 1].id} · ${current.ac.name} · ${plan.alt.toLocaleString()}'`), navlogTable(current), h('p', {}, 'Planning only. Not for navigation.')));
    return true;
  },
};
