# Kestrel EFB

A free flight-planning app for US pilots. It runs in the browser and installs on Mac, Windows, iPad and iPhone.

Provided as is, with no warranty. Data comes from public sources and is not verified.

## What it does

| Tab | Function |
|---|---|
| Maps | FAA VFR sectional, terminal, IFR low and high charts. Airports, navaids, fixes, Class B/C/D and special use airspace. Animated radar, flight category dots, SIGMETs, obstacles, terrain hazard coloring, runway and taxiway charts when zoomed in, and with the relay live traffic and icing, turbulence and IFR advisories. Tap anywhere to add a point to the route or mark a position. GPS position and track log recording. |
| Flight plan (FPL) | Type a route (`KLUK HYK V97 CVG KCVG`). Airways, SIDs, STARs and approaches expand to their fixes (`KAPA WNGSS1 CHNGY ...`), or pick them with the Procedure button. Climb and descent are modeled from the aircraft profile. The Routes button suggests airway routes. The 3D view flies the route over terrain. NavLog with winds aloft, heading, time and fuel. Profile view of terrain and airspace along the route. |
| Airports | METAR, TAF, D-ATIS, runways with wind components, frequencies, NOTAMs (with the relay), a fuel price note and link. |
| Plates | Current FAA approach plates, departures, arrivals and airport diagrams. Save an airport's plates for offline use. Show on map places an approach plate on the map (with the relay). |
| Imagery | Prog charts, surface analysis, radar, satellite, icing, winds aloft. |
| Flights | Saved flights, printable NavLog, weight and balance, takeoff and landing distance estimates. |
| ScratchPads, Checklist, Logbook, Documents | Handwritten notes with ATIS and CRAFT templates, checklists with speech, a logbook with CSV export, imported PDFs. |
| More | Aircraft profiles, offline chart downloads, marked positions, imported map content (GeoJSON, KML), track logs with GPX export. |

Not included: flight plan filing. Coverage is the United States only.

## Put it on GitHub

There is no build step. The repository is the app.

1. Create a repository and upload every file and folder in this directory.
2. In the repository, open **Settings > Pages**, set the source to the `main` branch and the root folder, and save.
3. Open the address GitHub shows. Install it from there:
   - iPad and iPhone: in Safari, select Share, then Add to Home Screen.
   - Mac and Windows: in Chrome or Edge, select the install icon in the address bar.

To run it on your own computer instead:

```bash
python3 -m http.server 8765
```

Then open `http://localhost:8765`.

## Mac app

`mac/Kestrel-EFB.dmg` is a native Mac app: the same app in its own window, with a menu bar (File, View, Map, Flight) and keyboard shortcuts. It runs on Apple silicon and Intel Macs with macOS 12 or later.

1. Open the DMG and drag Kestrel EFB to Applications.
2. The first time, right-click the app and choose Open. It is not notarized by Apple, so a plain double-click is blocked on other Macs.

The app loads the live site, so it needs a connection and always shows the latest version. To rebuild it after changing `mac/main.swift`:

```bash
bash mac/build.sh
```

## Keep the data current

Navigation data and the plates index follow the FAA 28-day cycle. To refresh them:

```bash
node tools/build-data.mjs
```

The included GitHub Action (`.github/workflows/update-data.yml`) runs this weekly and commits the result. It needs no secrets.

## Relay server (optional, free)

Live traffic, NOTAMs and raw METAR/TAF text cannot be fetched by a browser directly. The small relay in `server/` fetches them for the app. It runs on the Cloudflare Workers free plan (100,000 requests a day). The app works without it; those three features stay off.

1. Create a free account at cloudflare.com.
2. Deploy the relay:

```bash
cd server
npx wrangler login
npx wrangler deploy
```

3. Copy the address it prints (like `https://kestrel-relay.yourname.workers.dev`) into `proxyUrl` in `js/config.js`, then upload that file.
4. In `server/wrangler.toml`, set `ALLOWED_ORIGINS` to your site's address so other sites cannot use your relay, then deploy again.

Traffic and raw weather work as soon as the relay is deployed. NOTAMs also need a key, from either source.

SkyLink API (skylinkapi.com): apply for the free trial (1,000 requests a month, personal use, reviewed within about a week), then store the key and deploy again:

```bash
npx wrangler secret put SKYLINK_API_KEY
```

If your SkyLink key comes from RapidAPI instead, store it as `RAPIDAPI_KEY`.

Or the FAA, which requires a MyAccess identity check:

1. Register at the FAA API portal (api.faa.gov) and request access to the NOTAM API. It is free; approval can take a few days.
2. Store the two values the FAA gives you as secrets. They never go in the repository:

```bash
npx wrangler secret put FAA_CLIENT_ID
npx wrangler secret put FAA_CLIENT_SECRET
```

## Device sync (optional)

Sync keeps aircraft, flights, logbook, checklists, marked positions and fuel notes the same on all your devices, using a private code instead of an account. It stores the data in a free Cloudflare KV namespace on the relay. Create the namespace once, answer yes when Wrangler offers to add it to `wrangler.toml`, then deploy:

```bash
cd server
npx wrangler kv namespace create SYNC
npx wrangler deploy
```

Then open More > Sync in the app and select Create a sync code.

## Map key

`js/config.js` holds a CARTO basemaps key for the Dark and Light base maps. The key is sent with every tile request, so anyone who opens the site or the repository can read it. Leave it empty to use the keyless fallback maps. The Topographic and Satellite base maps and all FAA charts need no key and can be downloaded for offline use.

## Data sources

All free, with no paid API.

| Data | Source |
|---|---|
| Charts, airspace, fixes, airways, plates | FAA |
| Airports, runways, frequencies, navaids | OurAirports (public domain) |
| METAR, TAF, SIGMET | National Weather Service |
| Radar | Iowa Environmental Mesonet |
| Winds aloft, terrain elevation | Open-Meteo |
| Terrain hazard tiles | Mapzen terrain tiles on AWS |
| D-ATIS | atis.info |
| Live traffic (through the relay) | adsb.lol |
| Base maps | CARTO and OpenStreetMap, USGS |
| Map library | Leaflet (in `lib/`) |
