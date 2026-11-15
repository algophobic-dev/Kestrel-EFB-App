// Kestrel EFB relay. Runs free on Cloudflare Workers.
// It fetches three things a browser cannot fetch directly, and keeps the FAA NOTAM key secret.
//   GET /wx?ids=KLEX            raw METAR and TAF text (aviationweather.gov)
//   GET /traffic?lat=&lon=&dist= live ADS-B traffic within dist nm (adsb.lol)
//   GET /plate?cycle=2611&pdf=X.PDF  one FAA plate PDF, so the app can place it on the map
//   GET /gairmet               icing, turbulence and IFR advisories as GeoJSON (aviationweather.gov)
//   GET, PUT, DELETE /sync      device sync, stored in the SYNC KV namespace under a hash of the user's private code
//   GET /notams?icao=KLEX       NOTAMs. Needs one secret set: SKYLINK_API_KEY (skylinkapi.com) or RAPIDAPI_KEY (SkyLink on RapidAPI),
//                               or FAA_CLIENT_ID and FAA_CLIENT_SECRET (FAA NOTAM API)

const json = (body, status, headers, maxAge = 0) => new Response(JSON.stringify(body), {
  status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store' },
});

// Device sync. The app sends a private code; data is stored under a hash of it, so the code is never kept here.
async function sync(req, env, cors) {
  if (!env.SYNC) return json({ error: 'Sync storage is not set up. Create the SYNC KV namespace.' }, 501, cors);
  const code = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!/^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/.test(code)) return json({ error: 'Bad sync code' }, 401, cors);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('kestrel-sync:' + code));
  const key = 'u:' + [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (req.method === 'GET') { const v = await env.SYNC.get(key); return v ? new Response(v, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }) : json({ error: 'Nothing synced yet' }, 404, cors); }
  if (req.method === 'DELETE') { await env.SYNC.delete(key); return json({ ok: true }, 200, cors); }
  if (req.method === 'PUT') {
    const body = await req.text();
    if (body.length > 900000) return json({ error: 'Too large' }, 413, cors);
    let doc; try { doc = JSON.parse(body); } catch { return json({ error: 'Bad JSON' }, 400, cors); }
    if (!doc || typeof doc.keys !== 'object') return json({ error: 'Bad document' }, 400, cors);
    await env.SYNC.put(key, JSON.stringify({ keys: doc.keys, at: Date.now() }));
    return json({ ok: true }, 200, cors);
  }
  return json({ error: 'Use GET, PUT or DELETE' }, 405, cors);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const any = allowed.includes('*'), ok = any || allowed.includes(origin);
    const cors = { 'Access-Control-Allow-Origin': any ? '*' : ok ? origin : 'null', Vary: 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, PUT, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' } });
    if (url.pathname === '/sync') return ok ? sync(req, env, cors) : json({ error: 'This origin is not allowed. Add it to ALLOWED_ORIGINS.' }, 403, cors);
    if (req.method !== 'GET') return json({ error: 'Use GET' }, 405, cors);
    if (!ok) return json({ error: 'This origin is not allowed. Add it to ALLOWED_ORIGINS.' }, 403, cors);
    const q = url.searchParams;

    try {
      if (url.pathname === '/wx') {
        const ids = (q.get('ids') || '').toUpperCase();
        if (!/^[A-Z0-9]{3,4}(,[A-Z0-9]{3,4}){0,9}$/.test(ids)) return json({ error: 'Bad ids' }, 400, cors);
        const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${ids}&format=raw&taf=true`, { headers: { 'User-Agent': 'kestrel-efb-relay' } });
        return new Response(await r.text(), { status: r.ok ? 200 : 502, headers: { ...cors, 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=120' } });
      }

      if (url.pathname === '/traffic') {
        const lat = +q.get('lat'), lon = +q.get('lon'), dist = Math.min(250, Math.max(1, +q.get('dist') || 50));
        if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return json({ error: 'Bad position' }, 400, cors);
        const r = await fetch(`https://api.adsb.lol/v2/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${Math.round(dist)}`);
        if (!r.ok) return json({ error: 'Traffic source did not answer' }, 502, cors);
        const d = await r.json();
        const ac = (d.ac || []).filter(a => a.lat != null).map(a => ({ lat: a.lat, lon: a.lon, flight: (a.flight || a.r || '').trim(), type: a.t || '', alt: a.alt_baro, track: a.track, gs: a.gs, vs: a.baro_rate ?? a.geom_rate ?? 0 }));
        return json({ ac }, 200, cors, 5);
      }

      if (url.pathname === '/plate') {
        const cycle = q.get('cycle') || '', pdf = q.get('pdf') || '';
        if (!/^\d{4}$/.test(cycle) || !/^[A-Za-z0-9_-]{1,40}\.PDF$/i.test(pdf)) return json({ error: 'Bad plate' }, 400, cors);
        const r = await fetch(`https://aeronav.faa.gov/d-tpp/${cycle}/${pdf}`);
        if (!r.ok) return json({ error: `FAA answered ${r.status}` }, 502, cors);
        return new Response(r.body, { headers: { ...cors, 'Content-Type': 'application/pdf', 'Cache-Control': 'public, max-age=86400' } });
      }

      if (url.pathname === '/gairmet') {
        const r = await fetch('https://aviationweather.gov/api/data/gairmet?format=geojson', { headers: { 'User-Agent': 'kestrel-efb-relay' } });
        return new Response(await r.text(), { status: r.ok ? 200 : 502, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' } });
      }

      if (url.pathname === '/notams') {
        const icao = (q.get('icao') || '').toUpperCase();
        if (!/^[A-Z0-9]{3,4}$/.test(icao)) return json({ error: 'Bad icao' }, 400, cors);
        // Results are kept for 30 minutes so a small monthly quota lasts.
        const cacheKey = new Request(`${url.origin}/notams-cache/${icao}`), hit = await caches.default.match(cacheKey);
        if (hit) return json(await hit.json(), 200, cors, 600);
        let items;
        if (env.SKYLINK_API_KEY || env.RAPIDAPI_KEY) {
          // SkyLink sells the same data directly and through RapidAPI; only the address and header differ.
          const r = env.SKYLINK_API_KEY
            ? await fetch(`https://data.skylinkapi.com/v3.1/notams/${icao}`, { headers: { 'x-api-key': env.SKYLINK_API_KEY } })
            : await fetch(`https://skylink-api.p.rapidapi.com/notams/${icao}`, { headers: { 'X-RapidAPI-Key': env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com' } });
          if (!r.ok) return json({ error: r.status === 429 ? 'The NOTAM quota is used up for now' : `SkyLink answered ${r.status}` }, 502, cors);
          items = ((await r.json()).notams || []).map(n => ({ id: n.notam_id || '', text: n.raw || n.body || '', start: n.effective || '', end: n.expiration || '', cls: n.scope || '' })).filter(n => n.text);
        } else if (env.FAA_CLIENT_ID && env.FAA_CLIENT_SECRET) {
          const r = await fetch(`https://external-api.faa.gov/notamapi/v1/notams?icaoLocation=${icao}&pageSize=200`, { headers: { client_id: env.FAA_CLIENT_ID, client_secret: env.FAA_CLIENT_SECRET } });
          if (!r.ok) return json({ error: `FAA NOTAM API answered ${r.status}` }, 502, cors);
          items = ((await r.json()).items || []).map(i => {
            const core = i.properties?.coreNOTAMData || {}, n = core.notam || {}, tr = (core.notamTranslation || [])[0] || {};
            return { id: n.number || n.id || '', text: n.text || tr.formattedText || tr.simpleText || '', start: n.effectiveStart || '', end: n.effectiveEnd || '', cls: n.classification || '' };
          }).filter(n => n.text);
        } else return json({ error: 'The relay has no NOTAM key yet. Add SKYLINK_API_KEY or RAPIDAPI_KEY, or FAA_CLIENT_ID and FAA_CLIENT_SECRET' }, 501, cors);
        await caches.default.put(cacheKey, new Response(JSON.stringify({ items }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' } }));
        return json({ items }, 200, cors, 600);
      }
    } catch (e) {
      return json({ error: 'Relay error: ' + e.message }, 502, cors);
    }
    return json({ ok: true, routes: ['/wx', '/traffic', '/gairmet', '/plate', '/notams'] }, url.pathname === '/' ? 200 : 404, cors);
  },
};
