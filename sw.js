// Offline support. App files and data: network first, cache fallback.
// Chart tiles and plates: served from the device when downloaded, else network.
const SHELL = 'kestrel-shell-v14';
const FILES = ['./', 'index.html', 'css/app.css', 'lib/leaflet.js', 'lib/leaflet.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/app.js', 'js/config.js', 'js/util.js', 'js/geo.js', 'js/db.js', 'js/wx.js', 'js/route.js', 'js/map.js', 'js/fpl.js', 'js/export.js', 'js/perf.js', 'js/autoroute.js', 'js/view3d.js', 'js/plateov.js', 'js/sync.js', 'js/desktop.js', 'js/tabs-ref.js', 'js/tabs-fly.js', 'js/more.js',
  'data/airports.json', 'data/navaids.json', 'data/fixes.json', 'data/runways.json', 'data/freqs.json', 'data/airways.json', 'data/plates.json', 'data/procs.json', 'data/meta.json'];
const STORED = /tiles\.arcgis\.com|basemap\.nationalmap\.gov|aeronav\.faa\.gov/;

self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then(c => Promise.allSettled(FILES.map(f => c.add(f))))); });
self.addEventListener('activate', e => e.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(k => Promise.all(k.filter(n => n.startsWith('kestrel-shell-') && n !== SHELL).map(n => caches.delete(n))))])));

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin === location.origin) {
    // Revalidate with the server so a new release is never hidden by the browser's HTTP cache.
    e.respondWith(fetch(req.url, { cache: 'no-cache' }).then(res => { if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); } return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  } else if (STORED.test(url.hostname)) {
    e.respondWith(caches.match(url.href.split('#')[0]).then(r => r || fetch(req)));
  }
});
