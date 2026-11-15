// Kestrel EFB relay. Runs free on Cloudflare Workers.
// It fetches three things a browser cannot fetch directly, and keeps the FAA NOTAM key secret.
//   GET /wx?ids=KLEX            raw METAR and TAF text (aviationweather.gov)
//   GET /traffic?lat=&lon=&dist= live ADS-B traffic within dist nm (adsb.lol)
//   GET /notams?icao=KLEX       NOTAMs (FAA NOTAM API; needs FAA_CLIENT_ID and FAA_CLIENT_SECRET secrets)

const json = (body, status, headers, maxAge = 0) => new Response(JSON.stringify(body), {
  status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store' },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const any = allowed.includes('*'), ok = any || allowed.includes(origin);
    const cors = { 'Access-Control-Allow-Origin': any ? '*' : ok ? origin : 'null', Vary: 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
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

      if (url.pathname === '/notams') {
        const icao = (q.get('icao') || '').toUpperCase();
        if (!/^[A-Z0-9]{3,4}$/.test(icao)) return json({ error: 'Bad icao' }, 400, cors);
        if (!env.FAA_CLIENT_ID || !env.FAA_CLIENT_SECRET) return json({ error: 'The relay has no FAA NOTAM key yet. Add FAA_CLIENT_ID and FAA_CLIENT_SECRET.' }, 501, cors);
        const r = await fetch(`https://external-api.faa.gov/notamapi/v1/notams?icaoLocation=${icao}&pageSize=200`, { headers: { client_id: env.FAA_CLIENT_ID, client_secret: env.FAA_CLIENT_SECRET } });
        if (!r.ok) return json({ error: `FAA NOTAM API answered ${r.status}` }, 502, cors);
        const d = await r.json();
        const items = (d.items || []).map(i => {
          const core = i.properties?.coreNOTAMData || {}, n = core.notam || {};
          const tr = (core.notamTranslation || [])[0] || {};
          return { id: n.number || n.id || '', text: n.text || tr.formattedText || tr.simpleText || '', start: n.effectiveStart || '', end: n.effectiveEnd || '', cls: n.classification || '' };
        }).filter(n => n.text);
        return json({ items }, 200, cors, 300);
      }
    } catch (e) {
      return json({ error: 'Relay error: ' + e.message }, 502, cors);
    }
    return json({ ok: true, routes: ['/wx', '/traffic', '/notams'] }, url.pathname === '/' ? 200 : 404, cors);
  },
};
