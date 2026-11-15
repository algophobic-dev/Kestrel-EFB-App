// 3D terrain view: a forward-looking perspective of the terrain along the route or from the GPS position.
// Heights come from the free Mapzen terrain tiles. Terrain within 1,000 ft of your altitude is yellow, within 100 ft red.
import { $, h, on, icon } from './util.js';
import { plan, current } from './route.js';
import { along, bearing, pad3 } from './geo.js';

const N = 512, SPAN = 80, FT_NM = 6076.12, FT_PX = SPAN * FT_NM / N;   // grid size, nm across, feet per grid cell
let grid = null, loading = null, gps = null, useGps = false, playing = null, frac = 0;

const mercX = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
const mercY = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * 256 * 2 ** z; };

async function loadGrid(c) {
  const cos = Math.cos(c.lat * Math.PI / 180), mPerCell = SPAN * 1852 / N;
  const z = Math.max(7, Math.min(11, Math.round(Math.log2(156543.03 * cos / mPerCell))));
  const s = mPerCell / (156543.03 * cos / 2 ** z), X0 = mercX(c.lon, z) - N / 2 * s, Y0 = mercY(c.lat, z) - N / 2 * s;
  const tx0 = Math.floor(X0 / 256), ty0 = Math.floor(Y0 / 256), tx1 = Math.floor((X0 + N * s) / 256), ty1 = Math.floor((Y0 + N * s) / 256);
  const cv = document.createElement('canvas'); cv.width = (tx1 - tx0 + 1) * 256; cv.height = (ty1 - ty0 + 1) * 256;
  const g = cv.getContext('2d', { willReadFrequently: true });
  await Promise.all(Array.from({ length: (tx1 - tx0 + 1) * (ty1 - ty0 + 1) }, (_, k) => new Promise(res => {
    const tx = tx0 + k % (tx1 - tx0 + 1), ty = ty0 + Math.floor(k / (tx1 - tx0 + 1)), img = new Image();
    img.crossOrigin = 'anonymous'; img.onload = () => { g.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256); res(); }; img.onerror = res;
    img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`;
  })));
  const px = g.getImageData(0, 0, cv.width, cv.height).data, hts = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = Math.min(cv.width - 1, Math.max(0, Math.round(X0 + i * s - tx0 * 256))), y = Math.min(cv.height - 1, Math.max(0, Math.round(Y0 + j * s - ty0 * 256))), o = (y * cv.width + x) * 4;
    hts[j * N + i] = px[o + 3] ? Math.max(0, (px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768) * 3.28084) : 0;
  }
  return { hts, lat0: c.lat, lon0: c.lon, cos };
}
// Local east/north feet from the grid centre, and terrain height there.
const local = p => ({ e: (p.lon - grid.lon0) * 60 * FT_NM * grid.cos, n: (p.lat - grid.lat0) * 60 * FT_NM });
const height = (e, n) => { const i = (N / 2 + e / FT_PX) | 0, j = (N / 2 - n / FT_PX) | 0; return i < 0 || j < 0 || i >= N || j >= N ? 0 : grid.hts[j * N + i]; };

function camera() {
  if (useGps && gps) return { lat: gps.lat, lon: gps.lon, alt: gps.alt > 0 ? gps.alt : plan.alt, hdg: gps.trk || 0, label: 'GPS position' };
  const r = current; if (!r.total) return null;
  const t = r.total, d = t.d * frac; let i = r.legs.findIndex(l => l.cd >= d - 1e-6); if (i < 0) i = r.legs.length - 1;
  const l = r.legs[i], f = l.d ? Math.min(1, (d - (l.cd - l.d)) / l.d) : 0, p = along(l.from, l.to, f);
  const alt = t.toc != null && d < t.toc ? t.e0 + (plan.alt - t.e0) * d / t.toc : t.tod != null && d > t.tod ? plan.alt - (plan.alt - t.e1) * (d - t.tod) / Math.max(1, t.d - t.tod) : plan.alt;
  return { lat: p.lat, lon: p.lon, alt: Math.max(alt, 50), hdg: f < .999 ? bearing(p, l.to) : bearing(l.from, l.to), label: `${Math.round(d)} of ${Math.round(t.d)} nm` };
}

const rgb = (r, g, b) => 0xff000000 | (b << 16) | (g << 8) | r;
function terrainColor(hgt, alt, shade, fog) {
  // Hazard colors stay vivid at any distance; ordinary terrain fades into haze.
  if (hgt > alt - 100) return rgb(225 * Math.min(1, shade) | 0, 60, 55);
  if (hgt > alt - 1000) return rgb(232 * Math.min(1, shade) | 0, 190 * Math.min(1, shade) | 0, 45);
  let r, g, b;
  if (hgt <= 1) { r = 40; g = 82; b = 120; }
  else if (hgt < 5000) { const t = hgt / 5000; r = 62 + 78 * t; g = 112 + 8 * t; b = 58 + 22 * t; }      // green to tan
  else { const t = Math.min(1, (hgt - 5000) / 8000); r = 140 + 45 * t; g = 120 + 62 * t; b = 80 + 105 * t; }  // tan to pale rock
  const k = shade * (1 - fog);
  return rgb(r * k + 178 * fog | 0, g * k + 205 * fog | 0, b * k + 230 * fog | 0);
}

export async function draw3d() {
  const cv = $('#v3d-canvas'), info = $('#v3d-info'); if (!cv || !cv.clientWidth) return;
  const cam = camera();
  if (!cam) { info.textContent = 'Add a route, or turn on GPS, to see the 3D view.'; cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); return; }
  const far = grid ? Math.max(Math.abs(local(cam).e), Math.abs(local(cam).n)) / FT_NM : Infinity;
  if (far > SPAN / 5) {
    if (!loading) { info.textContent = 'Loading terrain.'; loading = loadGrid(cam).then(gd => { grid = gd; }).catch(() => { info.textContent = 'Terrain did not load. Check your connection.'; }).finally(() => { loading = null; if (grid) draw3d(); }); }
    if (!grid) return;
  }
  const W = Math.min(640, cv.clientWidth), H = Math.round(W * cv.clientHeight / cv.clientWidth); cv.width = W; cv.height = H;
  const c = cv.getContext('2d'), img = c.createImageData(W, H), buf = new Uint32Array(img.data.buffer);
  const horizon = Math.round(H * .46), focal = W * .87;                          // 60 degree field of view
  for (let y = 0; y < H; y++) { const t = Math.min(1, y / horizon), col = rgb(70 + 108 * t | 0, 130 + 75 * t | 0, 200 + 30 * t | 0); buf.fill(col, y * W, (y + 1) * W); }
  const a = cam.hdg * Math.PI / 180, fe = Math.sin(a), fn = Math.cos(a), re = Math.cos(a), rn = -Math.sin(a), o = local(cam);
  const ybuf = new Int32Array(W).fill(H), maxZ = SPAN * .55 * FT_NM;
  for (let z = 400, dz = 120; z < maxZ; z += dz, dz *= 1.012) {
    const hw = z * .577, e0 = o.e + fe * z - re * hw, n0 = o.n + fn * z - rn * hw, de = re * hw * 2 / W, dn = rn * hw * 2 / W, fog = Math.min(.85, (z / maxZ) ** 1.4);
    const curve = z * z / 1.37e8;                                                // earth curvature drop, feet
    for (let x = 0; x < W; x++) {
      const e = e0 + de * x, n = n0 + dn * x, hgt = height(e, n);
      let sy = ((cam.alt - hgt + curve) / z * focal + horizon) | 0; if (sy < 0) sy = 0;
      if (sy >= ybuf[x]) continue;
      const shade = Math.max(.55, Math.min(1.25, 1 + (hgt - height(e - FT_PX, n + FT_PX)) / 900));
      const col = terrainColor(hgt, cam.alt, shade, fog);
      for (let y = sy; y < ybuf[x]; y++) buf[y * W + x] = col;
      ybuf[x] = sy;
    }
  }
  c.putImageData(img, 0, 0);
  // Route line and waypoints ahead.
  const proj = (p, alt) => { const q = local(p), e = q.e - o.e, n = q.n - o.n, zf = e * fe + n * fn, xr = e * re + n * rn; return zf < 600 ? null : { x: W / 2 + xr / zf * focal, y: (cam.alt - alt) / zf * focal + horizon, zf }; };
  c.lineWidth = 2.5; c.strokeStyle = '#e23bf0'; c.font = 'bold 11px system-ui, sans-serif'; c.textAlign = 'center';
  const pts = current.points.map(p => ({ p, s: proj(p, p.kind === 'apt' ? p.elev || 0 : plan.alt) }));
  c.beginPath(); let pen = false;
  for (const { s } of pts) { if (s && s.zf < maxZ * 1.6) { pen ? c.lineTo(s.x, s.y) : c.moveTo(s.x, s.y); pen = true; } else pen = false; }
  c.stroke();
  for (const { p, s } of pts) if (s && s.zf < maxZ * 1.6 && s.x > -40 && s.x < W + 40) { c.fillStyle = '#e23bf0'; c.beginPath(); c.arc(s.x, s.y, 4, 0, 7); c.fill(); c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 3; c.strokeText(p.id, s.x, s.y - 9); c.fillText(p.id, s.x, s.y - 9); c.strokeStyle = '#e23bf0'; c.lineWidth = 2.5; }
  // Readouts.
  const agl = cam.alt - height(o.e, o.n);
  c.fillStyle = 'rgba(16,22,26,.72)'; c.fillRect(W / 2 - 46, 6, 92, 22); c.fillRect(6, 6, 96, 38);
  c.fillStyle = '#fff'; c.font = 'bold 14px system-ui, sans-serif'; c.fillText(`${pad3(cam.hdg)}°`, W / 2, 22);
  c.textAlign = 'left'; c.font = 'bold 12px system-ui, sans-serif'; c.fillText(`${Math.round(cam.alt / 10) * 10}' MSL`, 12, 21);
  c.fillStyle = agl < 500 ? '#ff6b66' : agl < 1000 ? '#f2b134' : '#cfe3ee'; c.fillText(`${Math.round(agl / 10) * 10}' AGL`, 12, 37);
  c.strokeStyle = 'rgba(255,255,255,.8)'; c.lineWidth = 2; c.beginPath(); c.moveTo(W / 2 - 34, horizon); c.lineTo(W / 2 - 10, horizon); c.moveTo(W / 2 + 10, horizon); c.lineTo(W / 2 + 34, horizon); c.stroke();
  info.textContent = cam.label + (agl < 1000 ? ' · terrain close' : '');
  $('#v3d-slider').disabled = useGps && !!gps;
}

export function init3d() {
  $('#fpl-3d').replaceChildren(
    h('canvas', { id: 'v3d-canvas' }),
    h('div', { class: 'v3d-bar' },
      h('button', { class: 'btn sm sq', id: 'v3d-play', title: 'Fly along the route', onclick: () => {
        if (playing) { clearInterval(playing); playing = null; } else { if (frac >= 1) frac = 0; playing = setInterval(() => { frac = Math.min(1, frac + .004); $('#v3d-slider').value = frac * 1000; draw3d(); if (frac >= 1) $('#v3d-play').click(); }, 90); }
        $('#v3d-play').replaceChildren(icon(playing ? 'pause' : 'play'));
      } }, icon('play')),
      h('input', { type: 'range', id: 'v3d-slider', min: 0, max: 1000, value: 0, title: 'Position along the route', oninput: e => { frac = e.target.value / 1000; draw3d(); } }),
      h('button', { class: 'btn sm', id: 'v3d-gps', title: 'View from your GPS position', onclick: e => { useGps = !useGps; e.currentTarget.classList.toggle('on', useGps); if (useGps && !gps) $('#v3d-info').textContent = 'Waiting for a GPS fix. Turn on Follow on the map.'; draw3d(); } }, 'GPS'),
      h('div', { id: 'v3d-info', class: 'note' })));
  on('gps', p => { gps = p; if (useGps && !$('#fpl-3d').classList.contains('hidden')) draw3d(); });
  new ResizeObserver(() => { if (!$('#fpl-3d').classList.contains('hidden')) draw3d(); }).observe($('#fpl-3d'));
}
