// Device sync with a private code. No email, no password.
// Each synced item (aircraft, flights, logbook, checklists, marked positions, fuel notes) carries the time it last
// changed; when two devices disagree, the most recent change wins for that item. Data is stored on the relay
// under a hash of the code, so the code itself is never stored there.
import { kv, emit, toast, debounce } from './util.js';
import { CONFIG } from './config.js';

const KEYS = ['aircraft', 'flights', 'logbook', 'checklists', 'marks', 'fuelNotes'];
const EVENTS = { aircraft: 'aircraft', flights: 'flights', marks: 'marks' };
const relay = () => CONFIG.proxyUrl.replace(/\/$/, '');

export const syncCode = () => kv.get('syncCode', '');
export const syncState = () => kv.get('syncState', { at: 0, error: '' });
const stamps = () => kv.get('syncStamps', {});
export const validCode = c => /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/.test(c);
export function newCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = crypto.getRandomValues(new Uint8Array(24));   // no 0, O, 1 or I
  return Array.from(r, (b, i) => (i && i % 4 === 0 ? '-' : '') + abc[b % 32]).join('');
}

// Record the change time of every synced item as it is saved, then push shortly after.
const push = debounce(() => sync(), 2500);
kv.changed = k => { if (!KEYS.includes(k)) return; const s = stamps(); s[k] = Date.now(); kv.setQuiet('syncStamps', s); if (syncCode()) push(); };

let busy = null;
export function sync() { return busy ||= run().finally(() => { busy = null; }); }
async function run() {
  const code = syncCode(); if (!code) return;
  const done = error => { kv.setQuiet('syncState', { at: error ? syncState().at : Date.now(), error: error || '' }); emit('sync'); };
  if (!CONFIG.proxyUrl) return done('Sync needs the relay server');
  const head = { Authorization: 'Bearer ' + code };
  try {
    const r = await fetch(relay() + '/sync', { headers: head });
    if (r.status === 501 || r.status === 405) return done('The relay has no sync storage yet. See the README');
    if (!r.ok && r.status !== 404) return done('The relay answered ' + r.status);
    const remote = r.status === 404 ? {} : (await r.json()).keys || {};
    const local = stamps(), out = {}, pulled = [];
    let pushNeeded = false;
    for (const k of KEYS) {
      const lt = local[k] || 0, rem = remote[k], has = localStorage.getItem('kestrel.' + k) != null;
      if (rem && rem.t > lt) { kv.setQuiet(k, rem.v); local[k] = rem.t; out[k] = rem; pulled.push(k); }       // the other device is newer
      else if (has) { out[k] = { t: lt || Date.now(), v: kv.get(k) }; local[k] = out[k].t; if (!rem || rem.t < out[k].t) pushNeeded = true; }
      else if (rem) out[k] = rem;
    }
    kv.setQuiet('syncStamps', local);
    if (pushNeeded) {
      const w = await fetch(relay() + '/sync', { method: 'PUT', headers: { ...head, 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: out }) });
      if (!w.ok) return done(w.status === 413 ? 'Your data is too large to sync' : 'The relay answered ' + w.status);
    }
    done();
    if (pulled.length) { pulled.forEach(k => EVENTS[k] && emit(EVENTS[k])); emit('synced'); toast('Changes from another device were applied.'); }
  } catch { done('No connection. Sync will retry'); }
}

export async function link(code, isNew) {
  kv.setQuiet('syncCode', code);
  // A new code starts from this device's data. Joining an existing code lets the synced copy win.
  kv.setQuiet('syncStamps', isNew ? Object.fromEntries(KEYS.filter(k => localStorage.getItem('kestrel.' + k) != null).map(k => [k, Date.now()])) : {});
  await sync(); return syncState();
}
export function unlink() { ['syncCode', 'syncStamps', 'syncState'].forEach(k => localStorage.removeItem('kestrel.' + k)); emit('sync'); }
export async function deleteServerCopy() {
  const r = await fetch(relay() + '/sync', { method: 'DELETE', headers: { Authorization: 'Bearer ' + syncCode() } });
  if (!r.ok && r.status !== 404) throw new Error('The relay answered ' + r.status);
}

export function initSync() {
  if (syncCode()) sync();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && syncCode() && Date.now() - syncState().at > 60000) sync(); });
}
