// Kestrel EFB relay. Runs free on Cloudflare Workers.
// It fetches three things a browser cannot fetch directly, and keeps the FAA NOTAM key secret.
//   GET /wx?ids=KLEX            raw METAR and TAF text (aviationweather.gov)
//   GET /traffic?lat=&lon=&dist= live ADS-B traffic within dist nm (adsb.lol)
//   GET /plate?cycle=2611&pdf=X.PDF  one FAA plate PDF, so the app can place it on the map
//   GET /metar?ids=EGLL,RJTT  decoded METARs as JSON, worldwide (aviationweather.gov)
//   GET /taf?ids=EGLL         TAFs as JSON, worldwide (aviationweather.gov)
//   GET /isigmet              SIGMETs outside the US as GeoJSON (aviationweather.gov)
//   GET /pirep                 PIREPs from the last 2 hours, worldwide, as GeoJSON (aviationweather.gov)
//   GET /tfr                   active TFRs with their shapes, as GeoJSON (tfr.faa.gov)
//   GET /tfr/text?id=6/8596     one TFR's full text: times, altitudes, restrictions
//   GET /oaip/{z}/{x}/{y}.png  OpenAIP airspace map tiles. Needs one secret set: OPENAIP_KEY (openaip.net, free)
//   GET /gairmet               icing, turbulence and IFR advisories as GeoJSON (aviationweather.gov)
//   GET, PUT, DELETE /sync      device sync, stored in the SYNC KV namespace under a hash of the user's private code
//   POST /account             username and password accounts. An account holds the sync code, so signing in links a device
//   GET /notams?icao=KLEX       NOTAMs. Needs one secret set: NMS_CLIENT_ID and NMS_CLIENT_SECRET (NOTAM Management Service,
//                               optional NMS_HOST), SKYLINK_API_KEY (skylinkapi.com) or RAPIDAPI_KEY (SkyLink on RapidAPI),
//                               or FAA_CLIENT_ID and FAA_CLIENT_SECRET (older FAA NOTAM API)

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

// Accounts. The app stretches the password before sending it (PBKDF2, salted with the username), so the password
// itself never reaches the relay. The relay keeps a salted hash of what it receives, and of the recovery code.
// NOTAM Management Service bearer token. It lasts 30 minutes; it is renewed 2 minutes early.
let nmsCache = null;
async function nmsToken(env, host) {
  if (nmsCache && nmsCache.host === host && nmsCache.until > Date.now()) return nmsCache.token;
  const r = await fetch(`${host}/v1/auth/token`, { method: 'POST', body: 'grant_type=client_credentials',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${env.NMS_CLIENT_ID}:${env.NMS_CLIENT_SECRET}`) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`NOTAM sign-in failed (${r.status})`);
  nmsCache = { host, token: j.access_token, until: Date.now() + ((+j.expires_in || 1799) - 120) * 1000 };
  return nmsCache.token;
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const CODE = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/;
function randomCode(groups) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = crypto.getRandomValues(new Uint8Array(groups * 4));
  return Array.from(r, (b, i) => (i && i % 4 === 0 ? '-' : '') + abc[b % 32]).join('');
}
// Counts attempts in the edge cache, so limits cost no storage writes. Returns true when over the limit.
async function tooMany(origin, name, limit, seconds) {
  const key = new Request(`${origin}/limit/${name}`), hit = await caches.default.match(key);
  const n = hit ? +(await hit.text()) : 0;
  if (n >= limit) return true;
  await caches.default.put(key, new Response(String(n + 1), { headers: { 'Cache-Control': `public, max-age=${seconds}` } }));
  return false;
}
async function account(req, env, cors, origin) {
  if (!env.SYNC) return json({ error: 'Account storage is not set up. Create the SYNC KV namespace.' }, 501, cors);
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405, cors);
  let b; try { b = JSON.parse((await req.text()).slice(0, 2000)); } catch { return json({ error: 'Bad JSON' }, 400, cors); }
  const user = String(b.user || '').toLowerCase(), key = String(b.key || ''), action = b.action;
  if (!/^[a-z0-9_]{3,20}$/.test(user)) return json({ error: 'Bad username' }, 400, cors);
  const id = 'acct:' + user, rec = await env.SYNC.get(id, 'json');
  const badKey = !/^[0-9a-f]{64}$/.test(key);
  const save = doc => env.SYNC.put(id, JSON.stringify(doc));

  if (action === 'signup') {
    if (badKey || !CODE.test(b.code || '')) return json({ error: 'Bad request' }, 400, cors);
    if (rec) return json({ error: 'That username is taken' }, 409, cors);
    const ip = await sha('ip:' + (req.headers.get('CF-Connecting-IP') || ''));
    if (await tooMany(origin, 'signup-' + ip, 5, 86400)) return json({ error: 'Too many new accounts from this network today' }, 429, cors);
    const salt = randomCode(4), recovery = randomCode(4);
    await save({ salt, key: await sha(salt + key), rec: await sha(salt + recovery), code: b.code, at: Date.now() });
    return json({ recovery }, 200, cors);
  }

  // Everything else proves who you are, with the password or the recovery code. Ten wrong tries lock the name for 15 minutes.
  if (await tooMany(origin, 'try-' + user, 10, 900)) return json({ error: 'Too many tries. Wait 15 minutes' }, 429, cors);
  const wrong = () => json({ error: action === 'reset' ? 'Wrong username or recovery code' : 'Wrong username or password' }, 401, cors);
  if (!rec) return wrong();
  if (action === 'reset') {
    if (badKey || rec.rec !== await sha(rec.salt + String(b.recovery || '').toUpperCase())) return wrong();
    const recovery = randomCode(4);
    await save({ ...rec, key: await sha(rec.salt + key), rec: await sha(rec.salt + recovery) });
    return json({ recovery, code: rec.code }, 200, cors);
  }
  if (badKey || rec.key !== await sha(rec.salt + key)) return wrong();
  if (action === 'signin') return json({ code: rec.code }, 200, cors);
  if (action === 'recovery') { const recovery = randomCode(4); await save({ ...rec, rec: await sha(rec.salt + recovery) }); return json({ recovery }, 200, cors); }
  if (action === 'delete') { await env.SYNC.delete('u:' + await sha('kestrel-sync:' + rec.code)); await env.SYNC.delete(id); return json({ ok: true }, 200, cors); }
  return json({ error: 'Unknown action' }, 400, cors);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const any = allowed.includes('*'), ok = any || allowed.includes(origin);
    const cors = { 'Access-Control-Allow-Origin': any ? '*' : ok ? origin : 'null', Vary: 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' } });
    if (url.pathname === '/sync') return ok ? sync(req, env, cors) : json({ error: 'This origin is not allowed. Add it to ALLOWED_ORIGINS.' }, 403, cors);
    if (url.pathname === '/account') return ok ? account(req, env, cors, url.origin) : json({ error: 'This origin is not allowed. Add it to ALLOWED_ORIGINS.' }, 403, cors);
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

      if (url.pathname === '/metar' || url.pathname === '/taf') {
        const ids = (q.get('ids') || '').toUpperCase();
        if (!/^[A-Z0-9]{4}(,[A-Z0-9]{4}){0,49}$/.test(ids)) return json({ error: 'Bad ids' }, 400, cors);
        const r = await fetch(`https://aviationweather.gov/api/data${url.pathname}?ids=${ids}&format=json`, { headers: { 'User-Agent': 'kestrel-efb-relay' } });
        const body = r.status === 204 ? '[]' : await r.text();
        return new Response(body, { status: r.ok ? 200 : 502, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${url.pathname === '/taf' ? 600 : 180}` } });
      }

      if (url.pathname === '/isigmet') {
        const r = await fetch('https://aviationweather.gov/api/data/isigmet?format=geojson', { headers: { 'User-Agent': 'kestrel-efb-relay' } });
        return new Response(await r.text(), { status: r.ok ? 200 : 502, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' } });
      }

      const tile = url.pathname.match(/^\/oaip\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/);
      if (tile) {
        if (!env.OPENAIP_KEY) return json({ error: 'The relay has no OpenAIP key yet. Add OPENAIP_KEY' }, 501, cors);
        // Tiles are kept at the edge for a day, so each one is fetched from OpenAIP once.
        const cacheKey = new Request(`${url.origin}/oaip-cache/${tile[1]}/${tile[2]}/${tile[3]}`), hit = await caches.default.match(cacheKey);
        const head = { ...cors, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' };
        if (hit) return new Response(hit.body, { headers: head });
        const r = await fetch(`https://api.tiles.openaip.net/api/data/openaip/${tile[1]}/${tile[2]}/${tile[3]}.png?apiKey=${env.OPENAIP_KEY}`);
        if (!r.ok) return json({ error: `OpenAIP answered ${r.status}` }, r.status === 404 ? 404 : 502, cors);
        const png = await r.arrayBuffer();
        await caches.default.put(cacheKey, new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } }));
        return new Response(png, { headers: head });
      }

      // PIREPs and AIREPs from the last 2 hours, worldwide, as GeoJSON.
      if (url.pathname === '/pirep') {
        const r = await fetch('https://aviationweather.gov/api/data/pirep?format=geojson&age=2&bbox=-90,-180,90,180', { headers: { 'User-Agent': 'kestrel-efb-relay' } });
        return new Response(r.status === 204 ? '{"type":"FeatureCollection","features":[]}' : await r.text(), { status: r.ok ? 200 : 502, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
      }

      // TFRs from tfr.faa.gov: the active list joined to the shapes, so expired shapes are left out.
      if (url.pathname === '/tfr') {
        const ua = { headers: { 'User-Agent': 'kestrel-efb-relay' } };
        const [list, geo] = await Promise.all([
          fetch('https://tfr.faa.gov/tfrapi/exportTfrList', ua).then(r => r.json()),
          fetch('https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=1000&outputFormat=application/json&srsname=EPSG:4326', ua).then(r => r.json())]);
        const active = new Map(list.map(t => [t.notam_id, t]));
        const features = (geo.features || []).map(f => {
          const id = (f.properties?.NOTAM_KEY || '').split('-')[0], t = active.get(id);
          return t && f.geometry ? { type: 'Feature', geometry: f.geometry, properties: { id, type: t.type || f.properties.LEGAL || '', title: t.description || f.properties.TITLE || '', facility: t.facility || '' } } : null;
        }).filter(Boolean);
        return json({ type: 'FeatureCollection', features }, 200, cors, 600);
      }
      if (url.pathname === '/tfr/text') {
        const id = q.get('id') || '';
        if (!/^\d\/\d{1,5}$/.test(id)) return json({ error: 'Bad id' }, 400, cors);
        const r = await fetch(`https://tfr.faa.gov/tfrapi/getWebText?notamId=${id}`, { headers: { 'User-Agent': 'kestrel-efb-relay' } });
        if (!r.ok) return json({ error: `TFR site answered ${r.status}` }, 502, cors);
        const raw = ((await r.json().catch(() => []))[0] || {}).text || '';
        const text = raw.replace(/<br\s*\/?>|<\/tr>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&ordm;|&#186;|&#xBA;/gi, '°')
          .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16))).replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
          .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && !/^(Top|Jump To:|Download shapefiles|ENDSECTION\d*|Affected Areas|Operating Restrictions and Requirements|Other Information)$/.test(l))
          // "Ending Date and Time :" then the value on the next line becomes one line.
          .reduce((out, l) => { const last = out[out.length - 1]; if (last && /:$/.test(last) && !/:$/.test(l) && l.length < 160) out[out.length - 1] = last.replace(/\s*:$/, ': ') + l; else out.push(l); return out; }, []).join('\n');
        return json({ id, text }, text ? 200 : 404, cors, 600);
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
        if (env.NMS_CLIENT_ID && env.NMS_CLIENT_SECRET) {
          // NOTAM Management Service (NMS-API). NMS_HOST picks the environment: staging by default, production once approved.
          const host = (env.NMS_HOST || 'https://api-staging.cgifederal-aim.com').replace(/\/$/, '');
          const r = await fetch(`${host}/nmsapi/v1/notams?location=${icao}`, { headers: { Authorization: 'Bearer ' + await nmsToken(env, host), nmsResponseFormat: 'GEOJSON' } });
          if (r.status === 401) nmsCache = null;
          if (!r.ok) return json({ error: `NOTAM service answered ${r.status}` }, 502, cors);
          const now = Date.now();
          items = ((await r.json()).data?.geojson || []).map(f => {
            const core = f.properties?.coreNOTAMData || {}, n = core.notam || {}, tr = core.notamTranslation || [];
            const local = tr.find(t => t.type === 'LOCAL_FORMAT')?.simpleText, icaoTxt = tr.find(t => t.type === 'ICAO')?.formattedText;
            // Type C is a cancellation notice, not a NOTAM in force.
            const gone = n.type === 'C' || / NOTAMC /.test(icaoTxt || '') || (n.cancelationDate && Date.parse(n.cancelationDate) < now);
            return { id: n.number || '', text: local || n.text || icaoTxt || '', start: n.effectiveStart || '', end: n.effectiveEnd || '', cls: n.classification || '', gone,
              key: (n.text || local || icaoTxt || '').replace(/\s+/g, ' ').trim(), local: !!local };
          }).filter(n => n.text && !n.gone && !(n.end && Date.parse(n.end) < now));
          // Most US NOTAMs come twice, as a domestic and an international copy of the same text. Keep one, preferring the copy in the short local form.
          items.sort((a, b) => b.local - a.local);
          const seen = new Set(); items = items.filter(n => !seen.has(n.key) && seen.add(n.key));
          // The international copy often drops the "!IAD 10/248 IAD OBST" prefix and the time range, so also match on the body alone.
          const flat = s => s.replace(/\s+/g, ' ').trim();
          const bodies = new Set();
          for (const n of items) if (n.local) {
            const w = flat(n.text).replace(/ \d{10}(EST)?-(\d{10}(EST)?|PERM)$/, '').replace(/^!\S+ \S+ /, '').split(' ');
            for (let k = 0; k <= 2 && k < w.length; k++) bodies.add(w.slice(k).join(' '));
          }
          // The domestic copy can also end with the schedule ("WED 1600-1700", "DLY SR-SS"), which the international copy keeps elsewhere.
          const byStart = new Map();
          for (const b of bodies) { const k = b.split(' ', 3).join(' '); byStart.set(k, [...(byStart.get(k) || []), b]); }
          const copy = t => bodies.has(t) || (byStart.get(t.split(' ', 3).join(' ')) || []).some(b => b.startsWith(t + ' ') && b.length - t.length <= 60);
          items = items.filter(n => n.local || !copy(flat(n.text))).map(({ gone, key, local, ...n }) => n);
        } else if (env.SKYLINK_API_KEY || env.RAPIDAPI_KEY) {
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
        } else return json({ error: 'The relay has no NOTAM key yet. Add NMS_CLIENT_ID and NMS_CLIENT_SECRET' }, 501, cors);
        await caches.default.put(cacheKey, new Response(JSON.stringify({ items }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' } }));
        return json({ items }, 200, cors, 600);
      }
    } catch (e) {
      return json({ error: 'Relay error: ' + e.message }, 502, cors);
    }
    return json({ ok: true, routes: ['/wx', '/metar', '/taf', '/isigmet', '/pirep', '/tfr', '/traffic', '/gairmet', '/plate', '/notams', '/oaip', '/sync', '/account'] }, url.pathname === '/' ? 200 : 404, cors);
  },
};
