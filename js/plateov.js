// Approach plates on the map. FAA approach plates are geo-registered PDFs: each carries a viewport
// that ties points on the page to latitude and longitude, so the plate can be placed without manual alignment.
// The PDF bytes come through the relay, because the FAA server does not allow browsers to read them directly.
import { CONFIG } from './config.js';
import { files } from './util.js';

const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const invMercY = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
// Least-squares line through (x, y) pairs.
function fit(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const a = sxy / sxx; return { a, b: my - a * mx };
}

// Returns { blob, bounds: [[south, west], [north, east]] }. `src` overrides the address (used for testing).
export async function plateImage(cycle, pdf, src) {
  const key = `plateov:${cycle}:${pdf}`, hit = await files.get(key).catch(() => null);
  if (hit) return hit;
  if (!src && !CONFIG.proxyUrl) throw new Error('Plates on the map need the relay server. See the README to set it up');
  const res = await fetch(src || `${CONFIG.proxyUrl.replace(/\/$/, '')}/plate?cycle=${cycle}&pdf=${encodeURIComponent(pdf)}`);
  if (!res.ok) throw new Error(res.status === 404 ? 'The relay is out of date. Run npx wrangler deploy in the server folder' : 'The plate did not load');
  const buf = await res.arrayBuffer(), text = new TextDecoder('latin1').decode(buf), at = text.indexOf('/VP');
  const nums = re => { const m = at < 0 ? null : text.slice(at, at + 8000).match(re); return m ? m[1].trim().split(/\s+/).map(Number) : null; };
  const bbox = nums(/\/BBox\s*\[([^\]]+)\]/), gpts = nums(/\/GPTS\s*\[([^\]]+)\]/), lpts = nums(/\/LPTS\s*\[([^\]]+)\]/);
  if (!bbox || !gpts || !lpts || gpts.length < 4 || gpts.length !== lpts.length) throw new Error('This plate has no position data, so it cannot be placed on the map');

  const pdfjs = await import('../lib/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.mjs', import.meta.url).href;
  const page = await (await pdfjs.getDocument({ data: buf.slice(0) }).promise).getPage(1);
  const vp = page.getViewport({ scale: 2.4 }), cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;

  // Page coordinates (PDF points, y up) of each registered point, then a straight-line fit to longitude and Mercator latitude.
  const xs = [], ys = [], lons = [], mys = [];
  for (let k = 0; k < gpts.length / 2; k++) {
    xs.push(bbox[0] + lpts[2 * k] * (bbox[2] - bbox[0])); ys.push(bbox[1] + lpts[2 * k + 1] * (bbox[3] - bbox[1]));
    mys.push(mercY(gpts[2 * k])); lons.push(gpts[2 * k + 1]);
  }
  const fx = fit(xs, lons), fy = fit(ys, mys), [x0, y0, x1, y1] = page.view;
  const out = { blob: await new Promise(r => cv.toBlob(r, 'image/png')), bounds: [[invMercY(fy.a * y0 + fy.b), fx.a * x0 + fx.b], [invMercY(fy.a * y1 + fy.b), fx.a * x1 + fx.b]] };
  files.put(key, out).catch(() => { });
  return out;
}
