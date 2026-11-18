// ADS-B receivers (Stratux, Sentry, and others that send GDL90 over Wi-Fi on UDP port 4000).
// A browser cannot open a UDP port, so the Mac and Windows apps listen and pass each packet here as base64.
// Decodes the heartbeat, ownship position and traffic reports. FIS-B weather uplinks are not decoded.
import { emit, toast } from './util.js';

// CRC-16-CCITT table from the GDL90 spec.
const CRC = new Uint16Array(256);
for (let i = 0; i < 256; i++) { let c = i << 8; for (let b = 0; b < 8; b++) c = (c << 1) ^ (c & 0x8000 ? 0x1021 : 0); CRC[i] = c & 0xffff; }
const crcOf = (m, n) => { let c = 0; for (let i = 0; i < n; i++) c = CRC[c >> 8] ^ ((c << 8) & 0xffff) ^ m[i]; return c; };

const s24 = (m, i) => { const v = (m[i] << 16) | (m[i + 1] << 8) | m[i + 2]; return v & 0x800000 ? v - 0x1000000 : v; };
// Ownship (0x0A) and traffic (0x14) reports share one layout.
function report(m) {
  const lat = s24(m, 5) * 180 / 0x800000, lon = s24(m, 8) * 180 / 0x800000;
  const altRaw = (m[11] << 4) | (m[12] >> 4), misc = m[12] & 0x0f, nic = m[13] >> 4;
  const hv = (m[14] << 4) | (m[15] >> 4); let vv = ((m[15] & 0x0f) << 8) | m[16]; if (vv & 0x800) vv -= 0x1000;
  const flight = String.fromCharCode(...m.slice(19, 27)).replace(/[^ -~]/g, '').trim();
  return { addr: (m[2] << 16) | (m[3] << 8) | m[4], lat, lon, alt: altRaw === 0xfff ? null : altRaw * 25 - 1000,
    airborne: !!(misc & 8), gs: hv === 0xfff ? null : hv, vs: vv === -2048 ? null : vv * 64, track: (misc & 3) ? m[17] * 360 / 256 : null,
    flight, emitter: m[18], valid: nic > 0 && !(lat === 0 && lon === 0) };
}

export const rx = { at: 0, gps: false, own: null, geoAlt: null, traffic: new Map() };
let lostTimer = null, emitTimer = null;
function handle(m) {
  const id = m[0];
  if (id === 0x00) { rx.gps = !!(m[1] & 0x80); return; }
  if (id === 0x0b) { const a = (m[1] << 8) | m[2]; rx.geoAlt = (a & 0x8000 ? a - 0x10000 : a) * 5; return; }
  if (id === 0x0a) { const r = report(m); rx.own = r.valid ? { ...r, t: Date.now() } : null; return; }
  if (id === 0x14) { const r = report(m); if (r.valid) rx.traffic.set(r.addr, { ...r, t: Date.now() }); }
}

// One UDP packet, which may hold several GDL90 frames.
export function feed(b64) {
  let bytes; try { bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); } catch { return; }
  let frame = null, esc = false, good = 0;
  for (const b of bytes) {
    if (b === 0x7e) { if (frame && frame.length > 2) { const n = frame.length - 2; if (crcOf(frame, n) === (frame[n] | (frame[n + 1] << 8))) { handle(Uint8Array.from(frame.slice(0, n))); good++; } } frame = []; esc = false; continue; }
    if (!frame) continue;
    if (b === 0x7d) { esc = true; continue; }
    frame.push(esc ? b ^ 0x20 : b); esc = false;
  }
  if (!good) return;
  if (!rx.at) toast('ADS-B receiver connected.');
  rx.at = Date.now();
  // Drop traffic not heard for 20 seconds.
  for (const [k, a] of rx.traffic) if (rx.at - a.t > 2e4) rx.traffic.delete(k);
  clearTimeout(lostTimer); lostTimer = setTimeout(() => { rx.at = 0; rx.own = null; rx.traffic.clear(); emit('adsb', rx); toast('ADS-B receiver lost. Check the Wi-Fi connection.'); }, 1e4);
  // Redraw at most once a second.
  if (!emitTimer) emitTimer = setTimeout(() => { emitTimer = null; emit('adsb', rx); }, 1000);
}
export const connected = () => rx.at && Date.now() - rx.at < 1e4;

// Builds GDL90 frames. Used by the test page and by anyone checking the decoder without a receiver.
export function frameOf(msg) {
  const c = crcOf(msg, msg.length), body = [...msg, c & 0xff, c >> 8], out = [0x7e];
  for (const b of body) b === 0x7e || b === 0x7d ? out.push(0x7d, b ^ 0x20) : out.push(b);
  out.push(0x7e); return out;
}
